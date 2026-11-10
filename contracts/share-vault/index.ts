import { Contract, state, init, method, view, assert, type AlkaneId, type u128 } from "../../sdk/authoring.ts";
import { height } from "../../sdk/index.ts";
import { mulDivUp } from "../../sdk/u128.ts";

// ERC-4626-style vault over one underlying alkane. Shares are this contract's
// own alkane: depositing the underlying issues them, redeeming takes them back
// into the vault's custody (out of circulation) and pays out underlying.
//
// The share price comes from stored totals, never from balances: `managed` is
// the underlying the shares are entitled to and `issued` is the circulating
// share supply. Underlying that reaches the vault any other way (a donation)
// sits in custody without moving the price until the authority deliberately
// harvests it. Unrelated incoming assets are returned with the response.
//
// Harvested yield vests linearly, like Yearn v2's lockedProfit. A harvest adds
// its gain to `managed` but also locks it, and the lock decays evenly over
// D = `vestingBlocks` blocks from the harvest height H. Conversions price
// against the unlocked part only:
//   locked(h) = ceil(L * r / D), r = max(0, H + D - h), L = locked at harvest
//   E(h)      = managed - locked(h)
// Without this, a deposit placed just before a visible harvest and redeemed
// just after would take its pro-rata cut of yield earned while it was not
// invested. Now that deposit buys and sells at the pre-harvest price, so it
// earns only what vests while it is actually held, exactly like any other
// holder, and an existing holder keeps the yield that vests over its holding.
// This only covers yield that accrued within D blocks of the harvest: a
// deposit held k blocks across a harvest earns k / D of its pro-rata share,
// so D should be at least the interval between harvests (see initialize).
// Redemptions price against E(h), the lock rounded up, and deposits against
// E+(h) = managed - floor(L * r / D) >= E(h), the lock rounded down. A
// smaller E pays out less and a larger one issues fewer shares, so the
// rounding favors the vault both ways. Whatever is still locked keeps vesting
// to whoever holds shares as it unlocks: the remaining holders, later
// depositors and, if nobody is left, the virtual shares below.
//
// Conversions use a virtual offset of 1 asset and 1000 shares (a three-digit
// decimals offset, as in OpenZeppelin's ERC4626):
//   shares = floor(assets * (issued + 1000) / (E + 1))
//   assets = floor(shares * (E + 1) / (issued + 1000))
// Both round down, so every conversion favors the vault, and previews use the
// same functions as the methods, so they are exact. The virtual shares own a
// slice of any value added without issuing shares (rounding remainders,
// harvested yield): raising the price per share by d leaves 1000*d with them.
// Harvest therefore requires a million circulating shares, which caps their
// slice of a harvest at 1000 / 1,001,000 < 0.1%. A victim's deposit loses
// less than one share to rounding, so inflating the price first costs an
// attacker about 1000 times what the victim can lose. Donations cannot move
// the price at all, so the classic first-depositor attack (donate to make one
// share worth more than the next deposit) has no lever.
//
// Invariants at block height h, with A = managed, S = issued, V = 1000
// virtual shares and E(h) = A - locked(h):
//   I1  S <= V * E(h): the price never falls below the initial 1/1000 asset.
//   I2  custody(underlying) >= A, custody being the vault's host balance.
//   I3  S = shares outside the vault (issued by deposits, minus redeemed).
//   I4  A + 1 and S + V fit in u128, so conversions, which use E + 1 <=
//       A + 1, can never overflow.
//   I5  locked(h) <= A, so E(h) never underflows.
// Block heights never decrease, and between operations locked(h) only falls
// as h grows, so E(h) only rises: once I1 and I5 hold after an operation they
// hold at every later height. Each method below re-proves them at its own
// height h, where E means E(h).
// I1 bounds every redemption: for s <= S, s(E+1) <= SE + S <= SE + VE =
// E(S+V), so redeem pays at most E <= A, and the vault is left satisfying I1
// and I5 again (see redeem). Redeeming all circulating shares one call at a
// time can therefore never claim more than A, and by I2 never more than the
// vault holds. Locked yield is still in A, so it stays fully backed.
export default class ShareVault extends Contract {
  @state({ key: "/asset" }) private underlying!: AlkaneId;
  @state({ key: "/authority" }) private authority!: AlkaneId;
  // Underlying owed to shareholders, including yield that is still vesting;
  // harvesting folds excess custody into it.
  @state({ key: "/managed" }) private managed: u128 = 0n;
  // Circulating shares. Redeemed shares stay in the vault's own balance.
  @state({ key: "/issued" }) private issued: u128 = 0n;
  // L and H above: the amount locked by the last harvest and its height. The
  // current lock is derived from them (see locked), never stored decayed.
  @state({ key: "/lockedProfit" }) private harvestLocked: u128 = 0n;
  @state({ key: "/harvestHeight" }) private harvestHeight: u128 = 0n;
  // D above, fixed at initialization.
  @state({ key: "/vestingBlocks" }) private vesting: u128 = 0n;

  // The authority is an auth-token contract (this.auth.require); it is the
  // only party that can fold excess custody into the share price.
  @init({ opcode: 0 })
  initialize(asset: AlkaneId, authority: AlkaneId, vestingBlocks: u128): void {
    // The vault can always mint its own ID, so it cannot be held as custody.
    // As the vault's ID, the authority would admit every shareholder; as the
    // underlying, the auth call would send it to the token's own opcode 1.
    assert(!asset.equals(this.context.myself), "INVALID_ASSET");
    assert(!authority.equals(this.context.myself) && !authority.equals(asset), "INVALID_AUTHORITY");
    // D divides in locked(), so it must be nonzero. D is the deployer's
    // choice and should be at least the interval between harvests: a
    // deposit held k blocks across a harvest earns k / D of its pro-rata share
    // of that harvest. With D = 1, a deposit made just before a harvest takes
    // nearly its full share one block later; one block only stops a
    // same-block round trip. The upper bound, about 20 years of blocks,
    // rejects a mistyped period that would lock yield away from every holder
    // for good.
    assert(vestingBlocks >= 1n && vestingBlocks <= 1_051_200n, "INVALID_VESTING");
    this.underlying = asset;
    this.authority = authority;
    this.vesting = vestingBlocks;
  }

  // Deposits all incoming underlying and issues shares, rounded down, priced
  // against E+ >= E. I1: S + s <= S + x(S+V)/(E+ + 1) <= S + x(S+V)/(E+1) <=
  // VE + Vx, because S+V <= V(E+1) by I1, and the deposit leaves the lock
  // alone, so E grows by exactly x.
  // I5: A grows and locked(h) does not change.
  @method({ opcode: 1, incomingAssets: "forward" })
  deposit(minShares: u128): u128 {
    const underlying = this.underlying;
    const assets = this.assets.received(underlying);
    assert(assets > 0n, "ZERO_ASSETS");
    // Each state read is a host call, so the totals are read once.
    const managed = this.managed;
    const issued = this.issued;
    // I4 is checked on each new total, in the same order as previewDeposit,
    // which returns 0 exactly when one of the next three checks fails.
    assert(assets <= this.assetRoom(managed), "VAULT_FULL");
    const shares = this.toShares(assets, managed - this.locked(false), issued);
    assert(shares > 0n, "ZERO_SHARES");
    assert(shares <= this.shareRoom(issued), "VAULT_FULL");
    assert(shares >= minShares, "SLIPPAGE");
    // I2: custody and managed both grow by exactly `assets`.
    this.assets.retain(underlying, assets);
    this.managed = managed + assets;
    this.issued = issued + shares;
    this.assets.mintSelf(shares);
    return shares;
  }

  // Redeems all incoming shares for underlying, rounded down.
  // I1: with a <= s(E+1)/(S+V), V*a - s <= s(VE - S)/(S+V) <= VE - S, so
  // S - s <= V(E - a), and E falls by exactly a because the lock is unchanged.
  // I5: a <= E (see the header), so A - a >= A - E = locked(h). The checked
  // subtractions below are a backstop: by I3 s <= S, and by I1 a <= E <= A.
  @method({ opcode: 2, incomingAssets: "forward" })
  redeem(minAssets: u128): u128 {
    const myself = this.context.myself;
    const shares = this.assets.received(myself);
    assert(shares > 0n, "ZERO_SHARES");
    const managed = this.managed;
    const issued = this.issued;
    const assets = this.toAssets(shares, managed - this.locked(true), issued);
    assert(assets > 0n, "ZERO_ASSETS");
    assert(assets >= minAssets, "SLIPPAGE");
    // I3: the shares leave circulation into the vault's own balance.
    this.assets.retain(myself, shares);
    this.issued = issued - shares;
    this.managed = managed - assets;
    // I2: custody and managed both shrink by exactly `assets`. send() fails
    // with INSUFFICIENT_CUSTODY if custody were ever short.
    this.assets.send(this.underlying, assets);
    return assets;
  }

  // Authority-only: keeps any underlying sent with this call as yield, then
  // folds all custody beyond `managed` (that yield plus any donations) into
  // `managed` and locks it, so it vests over the next D blocks. Returns the
  // amount folded. State is read after the auth call, which commits a
  // checkpoint.
  //
  // It requires a million circulating shares, which keeps the virtual
  // shares' slice of the gain, 1000 / (S + 1000), under 0.1%. Any S > 0 would
  // let a griefer strand nearly all of it with them by leaving one dust share
  // in an empty vault. The revert returns the yield sent with the call along
  // with the rest of the parcel.
  //
  // Whatever of the previous lock has not vested yet is locked again with the
  // gain and vests over the full new period, so a second harvest during
  // vesting delays that remainder but never releases it early. Harvests every
  // k < D blocks therefore decay an old lock geometrically rather than
  // linearly, and the rounded-up lock can hold a residue of about D / k units
  // for as long as they continue. Only the authority harvests.
  // I1: S and E are unchanged at height h: the new A is custody and the new
  // lock is locked(h) + gain = locked(h) + custody - A, so custody - new lock
  // = A - locked(h). I5: the new lock is at most A + gain = custody, the new A.
  // I2: A rises only up to custody.
  @method({ opcode: 3, incomingAssets: "forward" })
  harvest(): u128 {
    this.auth.require(this.authority);
    const issued = this.issued;
    assert(issued >= 1_000_000n, "INSUFFICIENT_SHARES");
    const underlying = this.underlying;
    const sent = this.assets.received(underlying);
    if (sent > 0n) this.assets.retain(underlying, sent);
    const managed = this.managed;
    const custody = this.assets.held(underlying);
    const gain = custody - managed;
    // I4: issued is unchanged, so only managed + 1 needs room.
    assert(gain <= this.assetRoom(managed), "VAULT_FULL");
    // locked() reads the previous lock, so it runs before the lock is replaced.
    const stillLocked = this.locked(true);
    this.managed = custody;
    this.harvestLocked = stillLocked + gain;
    this.harvestHeight = height();
    return gain;
  }

  // The part of the last harvest's lock that has not vested at the current
  // height, L * r / D. It is rounded up for redemptions, harvest and the
  // lockedProfit view (E rounds down) and down for deposits (E rounds up), so
  // each favors the vault. Either result is at most the stored lock, and the
  // products are exact, so it cannot overflow. Heights never decrease on
  // chain; an earlier height would count as the harvest height, which still
  // keeps the result at most the stored lock.
  private locked(roundUp: boolean): u128 {
    const lockedAtHarvest = this.harvestLocked;
    // Zero until the first harvest that folds anything; skips the remaining
    // reads and the host call.
    if (lockedAtHarvest === 0n) return 0n;
    const vesting = this.vesting;
    const start = this.harvestHeight;
    const now = height();
    const elapsed = now > start ? now - start : 0n;
    if (elapsed >= vesting) return 0n;
    const remaining = vesting - elapsed;
    return roundUp ? mulDivUp(lockedAtHarvest, remaining, vesting) : lockedAtHarvest * remaining / vesting;
  }

  // Shares issued for `assets` given the effective totals, rounded down
  // (favors the vault). The product is exact; only a quotient above u128
  // (more than about 2^128 / 1000 assets at the initial price) overflows.
  private toShares(assets: u128, effective: u128, issued: u128): u128 {
    return assets * (issued + 1000n) / (effective + 1n);
  }

  // Underlying paid for `shares` (at most `issued`) given the effective
  // totals, rounded down (favors the vault).
  private toAssets(shares: u128, effective: u128, issued: u128): u128 {
    return shares * (effective + 1n) / (issued + 1000n);
  }

  // I4 headroom: the most that can be added to managed while managed + 1
  // still fits, and to issued while issued + 1000 still fits. Without it,
  // every later conversion, redemption and preview would overflow. Both are
  // subtractions that I4 keeps nonnegative, so a check against them cannot
  // overflow whatever the amount.
  private assetRoom(managed: u128): u128 { return 0xffffffffffffffffffffffffffffffffn - 1n - managed; }
  private shareRoom(issued: u128): u128 { return 0xffffffffffffffffffffffffffffffffn - 1000n - issued; }

  // Includes yield that is still vesting; conversions use totalAssets minus
  // lockedProfit.
  @view({ opcode: 10 })
  totalAssets(): u128 { return this.managed; }

  @view({ opcode: 11 })
  totalShares(): u128 { return this.issued; }

  // Exactly what deposit would issue now. 0 means deposit would revert,
  // with VAULT_FULL or ZERO_SHARES (checked in deposit's order), or with
  // ZERO_ASSETS for 0. Like deposit, it reverts with u128 overflow when the
  // share count itself exceeds u128. One case it cannot see: the host credits
  // the deposit to the vault's balance before the vault runs, and refuses one
  // that would push that balance past u128. Custody exceeds managed by any
  // unharvested donation, so a deposit can then revert in the host even
  // though this preview is nonzero.
  @view({ opcode: 12 })
  previewDeposit(assets: u128): u128 {
    const managed = this.managed;
    const issued = this.issued;
    if (assets > this.assetRoom(managed)) return 0n;
    const shares = this.toShares(assets, managed - this.locked(false), issued);
    return shares <= this.shareRoom(issued) ? shares : 0n;
  }

  // Exactly what redeem would pay now (0 means redeem would revert).
  @view({ opcode: 13 })
  previewRedeem(shares: u128): u128 {
    const managed = this.managed;
    return this.toAssets(shares, managed - this.locked(true), this.issued);
  }

  @view({ opcode: 14 })
  asset(): AlkaneId { return this.underlying; }

  @view({ opcode: 15 })
  getAuthority(): AlkaneId { return this.authority; }

  // Custody that the next harvest would fold into totalAssets.
  @view({ opcode: 16 })
  pendingHarvest(): u128 { return this.assets.held(this.underlying) - this.managed; }

  // Harvested yield that has not vested yet at the current height.
  @view({ opcode: 17 })
  lockedProfit(): u128 { return this.locked(true); }

  @view({ opcode: 18 })
  vestingBlocks(): u128 { return this.vesting; }
}
