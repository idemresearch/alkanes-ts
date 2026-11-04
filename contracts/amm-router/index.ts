import { Contract, method, assert, type AlkaneId, type u128 } from "../../sdk/authoring.ts";
import { AlkaneTransferParcel, Cellpack } from "../../sdk/types.ts";
import { height } from "../../sdk/runtime.ts";

// Exact-input swaps routed through one or two AmmPool contracts
// (contracts/amm-pool, opcode 3 `swap(minOut)`).
//
// The router is stateless and never keeps custody. Each hop is a
// ledger-reconciled this.assets.call: the input leaves the invocation ledger,
// and only the transfers the pool actually returned are credited back. Hop
// output is measured as that ledger delta, never decoded from the pool's
// response data, so a pool that misreports its output cannot inflate what the
// router forwards or the amount checked against minOut.
//
// Whatever remains in the ledger is returned to the caller: the final output,
// unrelated incoming assets and any of the caller's own intermediate-token
// balance that arrived with the call. The router's balances therefore stay
// zero. Any failure (a pool revert, which aborts the router, or a router
// check) reverts the whole route, including hops that already succeeded.
//
// Pools are caller-chosen, untrusted IDs, restricted only to the blocks that
// hold deployed contracts (see hop). No @init or reentrancy lock is
// needed: there is no state to protect, and a reentrant invocation has its own
// ledger whose incoming assets it returns, so it cannot touch this one.
//
// Integrators: the u128 result is the final hop's measured output, the amount
// minOut bounds. It is not the amount of tokenOut in the response parcel,
// which also carries any tokenOut that arrived with the call and any other
// asset a pool returned. In a cycle (tokenIn == tokenOut) those mix: a pool-1
// refund of the input comes back as tokenOut but is not part of the result.
// A contract calling the router must therefore measure what it received as
// its own ledger delta (this.assets.call credits exactly the returned
// transfers) and a cycle's gain as that delta minus the input, never from the
// response data.
export default class AmmRouter extends Contract {
  // Two hops: tokenIn -[pool1]-> tokenMid -[pool2]-> tokenOut. The input is
  // the entire incoming amount of tokenIn. tokenIn may equal tokenOut (a cycle
  // through two pools, or out and back through one). `deadline` is the last
  // block height at which the route may execute.
  @method({ opcode: 1, incomingAssets: "forward" })
  swap2(tokenIn: AlkaneId, pool1: AlkaneId, tokenMid: AlkaneId, pool2: AlkaneId, tokenOut: AlkaneId, minOut: u128, deadline: u128): u128 {
    // minOut bounds the price a route accepts, not when it runs. A signed
    // route can wait unconfirmed for many blocks while the market moves, then
    // confirm at the worst price minOut still allows; a stale route in the
    // mempool is also an easy sandwich target. Checking the deadline before
    // any call means an expired route moves nothing.
    assert(height() <= deadline, "EXPIRED");
    const amountIn = this.assets.received(tokenIn);
    assert(amountIn > 0n, "INSUFFICIENT_INPUT");
    const amountMid = this.hop(pool1, tokenIn, amountIn, tokenMid);
    const amountOut = this.hop(pool2, tokenMid, amountMid, tokenOut);
    assert(amountOut >= minOut, "SLIPPAGE");
    return amountOut;
  }

  // One hop: tokenIn -[pool]-> tokenOut, with the same deadline and
  // accounting as swap2.
  @method({ opcode: 2, incomingAssets: "forward" })
  swap1(tokenIn: AlkaneId, pool: AlkaneId, tokenOut: AlkaneId, minOut: u128, deadline: u128): u128 {
    assert(height() <= deadline, "EXPIRED");
    const amountIn = this.assets.received(tokenIn);
    assert(amountIn > 0n, "INSUFFICIENT_INPUT");
    const amountOut = this.hop(pool, tokenIn, amountIn, tokenOut);
    assert(amountOut >= minOut, "SLIPPAGE");
    return amountOut;
  }

  // Pays `amountIn` of tokenIn from the ledger to `pool` and returns how much
  // tokenOut the pool actually transferred back. Requiring distinct tokens
  // means the call cannot debit tokenOut, so the ledger delta is exactly the
  // pool's tokenOut transfer: any tokenOut already in the ledger stays put.
  // Every hop passes the pool minOut 0; the route's minOut is checked once, on
  // the final measured delta. A pool may also return other assets (an AmmPool
  // returns none on a successful swap); those stay in the ledger and go back
  // to the caller.
  private hop(pool: AlkaneId, tokenIn: AlkaneId, amountIn: u128, tokenOut: AlkaneId): u128 {
    // An AmmPool is an ordinary deployed contract, which the host places at
    // [2, n] or [4, n] (alkanes-support id.rs is_created). Other targets are
    // not pools: [1, 0], [3, n], [5, n] and [6, n] are deployment cellpacks
    // that would create a new contract and hand it the input, block
    // 800000000 holds precompiles, which never move assets, and the host's
    // system alkanes (such as frBTC at [32, 0]) are not AmmPools. Ledger-delta
    // measurement already stops such a target from inflating the output; this
    // check also stops the route from paying the input to one.
    assert(pool.block === 2n || pool.block === 4n, "INVALID_POOL");
    assert(!tokenIn.equals(tokenOut), "IDENTICAL_TOKENS");
    const before = this.assets.available(tokenOut);
    // The fuel argument is a constant (Number.MAX_SAFE_INTEGER) instead of a
    // per-hop fuel() read. The canonical host ignores it: handle_extcall in
    // alkanes-rs crates/alkanes/src/vm/host_functions.rs takes it as an unused
    // `_start_fuel` and runs the callee with all of the caller's remaining
    // fuel, charging back what the callee used; the test VM and the wasmi
    // harness ignore it as well. So reading fuel() bought nothing, and this,
    // the largest value the f64 host boundary carries exactly, would still
    // mean "everything left" to a host that did treat it as a cap.
    this.assets.call(new Cellpack(pool, [3n, 0n]), new AlkaneTransferParcel().pay(tokenIn, amountIn), 9_007_199_254_740_991);
    const amountOut = this.assets.available(tokenOut) - before;
    assert(amountOut > 0n, "INSUFFICIENT_HOP_OUTPUT");
    return amountOut;
  }
}
