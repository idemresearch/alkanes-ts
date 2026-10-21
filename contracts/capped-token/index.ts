import { Contract, state, init, method, view, assert, type AlkaneId, type u128 } from "../../sdk/authoring.ts";

export default class CappedToken extends Contract {
  @state({ key: "/authority" }) private authority!: AlkaneId;
  @state({ key: "/cap" }) private cap: u128 = 0n;
  @state({ key: "/supply" }) private supply: u128 = 0n;

  @init({ opcode: 0 })
  initialize(authority: AlkaneId, cap: u128): void {
    assert(cap > 0n, "INVALID_CAP");
    this.authority = authority;
    this.cap = cap;
  }

  @method({ opcode: 77, incomingAssets: "forward" })
  mint(amount: u128): u128 {
    this.auth.require(this.authority);
    assert(amount > 0n, "INVALID_AMOUNT");
    assert(amount <= this.cap - this.supply, "CAP_EXCEEDED");
    this.supply += amount;
    this.assets.mintSelf(amount);
    return this.supply;
  }

  @view({ opcode: 101 })
  totalSupply(): u128 { return this.supply; }

  @view({ opcode: 102 })
  getAuthority(): AlkaneId { return this.authority; }

  @view({ opcode: 103 })
  getCap(): u128 { return this.cap; }
}
