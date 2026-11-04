import { Contract, method, type u128 } from "../../sdk/authoring.ts";
import { AlkaneId, AlkaneTransferParcel, Cellpack } from "../../sdk/types.ts";
import { fuel, height } from "../../sdk/runtime.ts";

// Router test double for AmmPool's swap opcode that reenters its caller. It
// sends all incoming 2:1 back into the calling router's swap1 through the A/B
// pool at 2:10, and returns whatever that produced to the outer router. The
// inner route's deadline is the current height, the inclusive bound.
export default class ReentrantPool extends Contract {
  @method({ opcode: 3, incomingAssets: "forward" })
  swap(minOut: u128): u128 {
    const tokenIn = new AlkaneId(2n, 1n);
    const amount = this.assets.received(tokenIn);
    this.assets.call(new Cellpack(this.context.caller, [2n, 2n, 1n, 2n, 10n, 2n, 2n, minOut, height()]),
      new AlkaneTransferParcel().pay(tokenIn, amount), Number(fuel()));
    return amount;
  }
}
