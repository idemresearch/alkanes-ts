import { Contract, state, init, method, view, assert, type u128 } from "../../sdk/authoring.ts";
import { AlkaneId, height } from "../../sdk/index.ts";

// Treasury for any alkane, controlled by an auth token and a timelock. Anyone
// may deposit; withdrawals take two authenticated steps separated by a fixed
// delay in blocks: schedule, then execute once the delay has passed and before
// a fixed grace window closes. The delay gives everyone watching the chain
// time to see a withdrawal coming, and the authority can still cancel it.
//
// Custody is the host balance itself: this.assets.held(id) is the treasury's
// balance of id minus whatever this invocation has not yet decided to keep.
// Nothing per-asset is stored, so there are no stored totals to drift from
// actual balances. Only deposits grow custody (every other entrypoint refunds
// its incoming parcel), and only execute shrinks it.
//
// At most one withdrawal is pending, and pendingAmount is the flag: zero means
// none. pendingAsset and pendingReadyAt are meaningful only while it is
// nonzero. Clearing the slot writes just the amount (each storage write costs
// several thousand fuel); the views report 0:0 and 0 for an empty slot.
//
// Timelock invariant: assets leave custody only through execute, which pays
// the withdrawal recorded by a schedule at some height s, and only at a height
// h with s + delay = readyAt <= h < readyAt + grace. So every payout was
// visible in the pending slot for at least `delay` blocks, and a schedule
// cannot stay armed indefinitely: once the grace window closes it is expired
// and can never execute (Compound's Timelock GRACE_PERIOD). Without the
// window, a withdrawal scheduled long ago, even while the treasury held
// nothing, would take a later deposit in the block it arrives, with no notice.
// A deposit made while a withdrawal is inside its window can still leave in
// the same block; the views show that window to depositors beforehand. An
// expired withdrawal stays in the slot, and the views still report it, until
// it is cancelled or replaced by a new schedule, which starts a full delay of
// its own.
//
// Payout semantics (standard auth-token behavior): execute pays the caller,
// that is, whoever presents a unit of the authority token in that call. A
// schedule names no recipient. If the token changes hands while a withdrawal
// is pending, the new holder receives the payout. Holding the token is the
// authority; the timelock only delays it.
//
// Reachability: the host reports height as a u64, so height() < 2^64. With
// delay and grace each at most 1_051_200 blocks (about 20 years of 10-minute
// blocks), readyAt + grace < 2^64 + 2 * 1_051_200 < 2^128: the checked u128
// additions in schedule and execute never overflow. The window opens at most
// 1_051_200 blocks after the schedule and closes at most 2 * 1_051_200 blocks
// after it, so every withdrawal scheduled below height 2^64 - 2 * 1_051_200
// (on any real chain) becomes executable, and later expires, at a height the
// chain will reach. An unbounded delay could push readyAt past any u64 height
// and lock deposits forever. One scheduled within that margin of the last u64
// height could only be cancelled.
//
// The treasury never issues its own alkane, so its own ID is never a valid
// deposit, withdrawal or authority. Its authority token is never custody
// either: deposit refuses it, so its held balance stays 0 and schedule
// refuses it as a withdrawal asset too.
export default class TimelockTreasury extends Contract {
  @state({ key: "/authority" }) private authority!: AlkaneId;
  @state({ key: "/delay" }) private delay: u128 = 0n;
  // 1..1_051_200 once initialized; the length of the execution window.
  @state({ key: "/grace" }) private grace: u128 = 0n;
  @state({ key: "/pending/asset" }) private pendingAsset!: AlkaneId;
  @state({ key: "/pending/amount" }) private pendingAmount: u128 = 0n;
  @state({ key: "/pending/ready" }) private pendingReadyAt: u128 = 0n;

  // A delay of 0 still needs both steps but lets them share a block. A grace
  // of 1 allows execution only in the readyAt block itself.
  //
  // The deployer proves control of the authority by presenting a unit of it.
  // The unit goes through the same auth call as every withdrawal step and
  // comes back with the response. An ID that cannot authenticate now is
  // refused, so deposits are never stranded behind it. That covers a block-2
  // ID that CREATE will never reach, and also an ID that nobody has deployed
  // yet, which whoever deploys it first would control.
  @init({ opcode: 0, incomingAssets: "forward" })
  initialize(authority: AlkaneId, delay: u128, grace: u128): void {
    // Deployed alkanes live only at block 2 (CREATE, clones, factories) or 4
    // (reserved IDs). Any other ID can never hold code, so no call could ever
    // return the [1] that authentication requires, and deposits would be
    // unrecoverable.
    assert(authority.block === 2n || authority.block === 4n, "INVALID_AUTHORITY");
    // This treasury's own token never exists, so it could never authenticate.
    assert(!authority.equals(this.context.myself), "SELF_AUTHORITY");
    // Bounds that make every readyAt and readyAt + grace reachable and keep
    // their checked sums far from u128 overflow (the reachability note above).
    // A grace of 0 would leave an empty window: nothing could ever execute.
    assert(delay <= 1_051_200n, "DELAY_TOO_LONG");
    assert(grace >= 1n && grace <= 1_051_200n, "INVALID_GRACE");
    this.auth.require(authority);
    this.authority = authority;
    this.delay = delay;
    this.grace = grace;
    // Required ID state must be assigned here; it stays unused until schedule.
    this.pendingAsset = new AlkaneId(0n, 0n);
  }

  // Keeps every incoming unit of `asset` and refunds everything else in the
  // parcel. Returns the amount kept; the held view reports the new total.
  // Unauthenticated: anyone may add funds.
  @method({ opcode: 1, incomingAssets: "forward" })
  deposit(asset: AlkaneId): u128 {
    assert(!asset.equals(this.context.myself), "SELF_ASSET");
    // Auth tokens are often a single unit. Once in custody it could only leave
    // through an execute, which itself needs a unit presented, so depositing
    // the last one would lock the treasury for good. Refusing it here also
    // keeps the invariant that the authority token is never custody.
    assert(!asset.equals(this.authority), "AUTHORITY_ASSET");
    const amount = this.assets.received(asset);
    assert(amount > 0n, "NOTHING_DEPOSITED");
    this.assets.retain(asset, amount);
    return amount;
  }

  // Records the single pending withdrawal; returns the height from which it
  // can be executed. Custody is checked at execution, not here, so deposits
  // that arrive during the delay can fund it. A withdrawal that may still
  // execute is never silently overwritten: replacing it requires an explicit
  // cancel. An expired one can never execute, so a new schedule replaces it.
  @method({ opcode: 2, incomingAssets: "forward" })
  schedule(asset: AlkaneId, amount: u128): u128 {
    const authority = this.authority;
    this.auth.require(authority);
    assert(!asset.equals(this.context.myself), "SELF_ASSET");
    // The authority token is never custody (deposit refuses it), so such a
    // withdrawal could never be paid; reject it up front.
    assert(!asset.equals(authority), "AUTHORITY_ASSET");
    assert(amount > 0n, "INVALID_AMOUNT");
    const now = height();
    if (this.pendingAmount !== 0n) assert(now >= this.pendingReadyAt + this.grace, "WITHDRAWAL_PENDING");
    // Cannot overflow: now < 2^64 and delay <= 1_051_200.
    const readyAt = now + this.delay;
    this.pendingAsset = asset;
    this.pendingAmount = amount;
    this.pendingReadyAt = readyAt;
    return readyAt;
  }

  // Pays the pending withdrawal to the caller, the holder presenting the auth
  // unit, while readyAt <= height() < readyAt + grace, and clears the slot. If
  // custody cannot cover it the whole call reverts and the withdrawal stays
  // pending, to be executed within the window after more deposits, cancelled,
  // or replaced once expired.
  @method({ opcode: 3, incomingAssets: "forward" })
  execute(): u128 {
    this.auth.require(this.authority);
    const amount = this.pendingAmount;
    assert(amount > 0n, "NO_PENDING_WITHDRAWAL");
    const readyAt = this.pendingReadyAt;
    const now = height();
    assert(now >= readyAt, "TIMELOCK_ACTIVE");
    // Cannot overflow: readyAt < 2^64 + 1_051_200 and grace <= 1_051_200.
    assert(now < readyAt + this.grace, "WITHDRAWAL_EXPIRED");
    this.pendingAmount = 0n;
    // Reverts with INSUFFICIENT_CUSTODY when held(asset) < amount. Units of
    // the asset in this call's own parcel are ledger, not custody.
    this.assets.send(this.pendingAsset, amount);
    return amount;
  }

  // Drops the pending withdrawal, expired or not, without moving any assets.
  @method({ opcode: 4, incomingAssets: "forward" })
  cancel(): void {
    this.auth.require(this.authority);
    assert(this.pendingAmount > 0n, "NO_PENDING_WITHDRAWAL");
    this.pendingAmount = 0n;
  }

  // 0:0 when nothing is pending. An expired withdrawal is still reported.
  @view({ opcode: 10 })
  getPendingAsset(): AlkaneId { return this.pendingAmount === 0n ? new AlkaneId(0n, 0n) : this.pendingAsset; }

  // 0 when nothing is pending.
  @view({ opcode: 11 })
  getPendingAmount(): u128 { return this.pendingAmount; }

  // 0 when nothing is pending. Executable while readyAt <= height <
  // readyAt + getGrace().
  @view({ opcode: 12 })
  getPendingReadyAt(): u128 { return this.pendingAmount === 0n ? 0n : this.pendingReadyAt; }

  // Views reject incoming assets, so the ledger is empty and this is the
  // treasury's whole balance of `asset`. Reverts for the treasury's own ID.
  @view({ opcode: 13 })
  held(asset: AlkaneId): u128 { return this.assets.held(asset); }

  @view({ opcode: 14 })
  getDelay(): u128 { return this.delay; }

  @view({ opcode: 15 })
  getAuthority(): AlkaneId { return this.authority; }

  @view({ opcode: 16 })
  getGrace(): u128 { return this.grace; }
}
