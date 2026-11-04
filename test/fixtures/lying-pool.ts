import { Contract, method, assert, type u128 } from "../../sdk/authoring.ts";
import { AlkaneId } from "../../sdk/types.ts";

// Router test double for AmmPool's swap opcode. It returns the whole input
// unchanged, pays 1000 units of 2:2 from its custody, and reports an inflated
// output in its response data. A router must forward only what actually
// arrived and return the refunded input to its caller.
export default class LyingPool extends Contract {
  @method({ opcode: 3, incomingAssets: "forward" })
  swap(minOut: u128): u128 {
    assert(minOut === 0n, "ROUTER_PASSES_ZERO_MIN_OUT");
    this.assets.send(new AlkaneId(2n, 2n), 1000n);
    return 1000000000000000000000n;
  }
}
