import { Contract, state, method, view, type u128 } from "../../sdk/authoring.ts";
import { wrappingAdd, mulDiv } from "../../sdk/u128.ts";

export default class Semantics extends Contract {
  static readonly incomingAssets = "forward";
  @state({ key: "/stable" }) private value: u128 = 17n;
  private temporary: u128 = 0n;
  @view({ opcode: 0 }) read(): u128 { return this.readHelper(); }
  private readHelper(): u128 { return this.value; }
  @method({ opcode: 1 }) write(value: u128): void { this.value = value; }
  @method({ opcode: 2 }) increment(by: u128): u128 { this.value += by; return this.value; }
  @view({ opcode: 3 }) intermediate(a: u128, b: u128): u128 { return (a + b) - b; }
  @view({ opcode: 4 }) subtract(a: u128, b: u128): u128 { return a - b; }
  @view({ opcode: 5 }) multiply(a: u128, b: u128): u128 { return a * b; }
  @view({ opcode: 6 }) divide(a: u128, b: u128): u128 { return a / b; }
  @view({ opcode: 7 }) modulo(a: u128, b: u128): u128 { return a % b; }
  @view({ opcode: 8 }) wrap(a: u128, b: u128): u128 { return wrappingAdd(a, b); }
  @view({ opcode: 9 }) wide(a: u128, b: u128, d: u128): u128 { return mulDiv(a, b, d); }
  @view({ opcode: 10 }) shift(a: u128, b: u128): u128 { return a << b; }
  @view({ opcode: 11 }) invert(a: u128): u128 { return ~a; }
  @method({ opcode: 12 }) fail(): void { this.value = 99n; throw new Error("rollback"); }
  @view({ opcode: 13 }) temp(): u128 { this.temporary += 1n; return this.temporary; }
  @method({ opcode: 14 }) evaluationOrder(): u128 { this.value += this.replace(); return this.value; }
  private replace(): u128 { this.value = 100n; return 2n; }
  @view({ opcode: 15 }) intersection(a: u128, b: u128): u128 {
    const x: u128 & {} = a;
    const y: u128 & {} = b;
    return (x + y) - y;
  }
  @view({ opcode: 170141183460469231731687303715884105728n }) fullWidthOpcode(): u128 { return 9n; }
}
