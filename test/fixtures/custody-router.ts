// Audit fixture: a router that holds custody of pool outputs and LP shares,
// exercising received/held/retain/send together with this.assets.call into a
// callee (AmmPool) that sends assets back.
import { Contract, state, init, method, view, assert, type AlkaneId, type u128 } from "../../sdk/authoring.ts";
import { AlkaneId as Id, AlkaneTransferParcel, Cellpack } from "../../sdk/types.ts";
import { fuel } from "../../sdk/runtime.ts";

export default class CustodyRouter extends Contract {
  @state({ key: "/pool" }) private pool!: AlkaneId;
  @state({ key: "/t0" }) private t0!: AlkaneId;
  @state({ key: "/t1" }) private t1!: AlkaneId;
  @state({ key: "/note" }) private note: u128 = 0n;

  @init({ opcode: 0 })
  initialize(pool: AlkaneId, t0: AlkaneId, t1: AlkaneId): void {
    this.pool = pool;
    this.t0 = t0;
    this.t1 = t1;
  }

  // Swaps all incoming token0 through the pool, keeps `keep` of the token1
  // output in custody and returns the rest. held(t1) must not change across
  // the call: call returns enter the ledger, not custody.
  @method({ opcode: 1, incomingAssets: "forward" })
  swapKeep(keep: u128): u128 {
    const amount = this.assets.received(this.t0);
    const before = this.assets.held(this.t1);
    this.assets.call(new Cellpack(this.pool, [3n, 0n]), new AlkaneTransferParcel().pay(this.t0, amount), Number(fuel()));
    assert(this.assets.held(this.t1) === before, "CALL_CHANGED_HELD");
    this.assets.retain(this.t1, keep);
    return this.assets.held(this.t1);
  }

  // Pays token1 custody to the caller. Incoming token1 must not count.
  @method({ opcode: 2, incomingAssets: "forward" })
  withdraw(amount: u128): u128 {
    this.assets.send(this.t1, amount);
    return this.assets.held(this.t1);
  }

  // Spends token1 custody into a pool swap; the token0 output goes to the caller.
  @method({ opcode: 3 })
  swapFromCustody(amount: u128): u128 {
    this.assets.send(this.t1, amount);
    this.assets.call(new Cellpack(this.pool, [3n, 0n]), new AlkaneTransferParcel().pay(this.t1, amount), Number(fuel()));
    return this.assets.held(this.t1);
  }

  // Adds all incoming token0/token1 as liquidity and keeps the LP in custody.
  @method({ opcode: 4, incomingAssets: "forward" })
  addKeepLP(): u128 {
    const a0 = this.assets.received(this.t0);
    const a1 = this.assets.received(this.t1);
    this.assets.call(new Cellpack(this.pool, [1n, 0n]),
      new AlkaneTransferParcel().pay(this.t0, a0).pay(this.t1, a1), Number(fuel()));
    this.assets.retain(this.pool, this.assets.available(this.pool));
    return this.assets.held(this.pool);
  }

  // Redeems LP from custody; both pool tokens go to the caller.
  @method({ opcode: 5 })
  removeFromCustody(lp: u128): u128 {
    this.assets.send(this.pool, lp);
    this.assets.call(new Cellpack(this.pool, [2n, 0n, 0n]), new AlkaneTransferParcel().pay(this.pool, lp), Number(fuel()));
    return this.assets.held(this.pool);
  }

  // Writes state, then makes a call to the 8e8 block-header precompile.
  @method({ opcode: 6 })
  writeThenPrecompile(): u128 {
    this.note = 7n;
    this.assets.call(new Cellpack(new Id(800000000n, 0n), []), new AlkaneTransferParcel(), Number(fuel()));
    return this.note;
  }

  // Sends all incoming token0 along with a precompile call.
  @method({ opcode: 7, incomingAssets: "forward" })
  payPrecompile(): u128 {
    const amount = this.assets.received(this.t0);
    this.assets.call(new Cellpack(new Id(800000000n, 0n), []), new AlkaneTransferParcel().pay(this.t0, amount), Number(fuel()));
    return this.assets.held(this.t0);
  }

  @view({ opcode: 10 })
  heldT1(): u128 { return this.assets.held(this.t1); }

  @view({ opcode: 11 })
  getNote(): u128 { return this.note; }
}
