import { Contract, method, type u128 } from "../../sdk/authoring.ts";
import { AlkaneId } from "../../sdk/types.ts";

// Audit test double: answers AmmPool's swap opcode by paying 500 units of the
// router's own alkane (2:20) from custody and refunding the input. It checks
// that the router never mints its own ID or keeps custody of it.
export default class SelfIdPool extends Contract {
  @method({ opcode: 3, incomingAssets: "forward" })
  swap(_minOut: u128): u128 {
    this.assets.send(new AlkaneId(2n, 20n), 500n);
    return 500n;
  }
}
