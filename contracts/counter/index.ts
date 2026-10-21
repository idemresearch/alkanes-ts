import { Contract, state, method, view, type u128 } from "../../sdk/authoring.ts";
import { StoragePointer, height, log, u128ToBytes } from "../../sdk/index.ts";

export default class Counter extends Contract {
  static readonly incomingAssets = "reject";

  @state({ key: "/count" })
  private count: u128 = 0n;

  // Temporary pointer; preserve the existing initialized-byte layout.
  private readonly initialized = new StoragePointer("/initialized");

  @method({ opcode: 0 })
  initialize(): void {
    if (!this.initialized.isEmpty()) throw new Error("already initialized");
    this.initialized.set(new Uint8Array([1]));
    this.count = 0n;
  }

  @method({ opcode: 1 })
  increment(by: u128): u128 {
    this.count += by;
    return this.count;
  }

  @view({ opcode: 2, abiName: "get_count" })
  getCount(): u128 {
    return this.count;
  }

  @method({ opcode: 3, abiName: "increment_then_fail" })
  incrementThenFail(): void {
    this.count += 1n;
    throw new Error("intentional failure");
  }

  @view({ opcode: 4 })
  height(): u128 {
    const h = height();
    log("counter: block height is " + h.toString());
    return h;
  }

  @view({ opcode: 5 })
  sum(n: u128): u128 {
    // Squares and partial sums are exact below 2^53 in this proven range.
    if (n <= 300_000n) {
      const bound = Number(n) | 0;
      let total = 0;
      for (let i = 0; i < bound; i = (i + 1) | 0) total += i * i;
      return BigInt(total);
    }
    let total: u128 = 0n;
    for (let i: u128 = 0n; i < n; i++) total += i * i;
    return total;
  }

  @method({ opcode: 6 })
  fill(n: u128): void {
    const slots = new StoragePointer("/slots/");
    for (let i: u128 = 0n; i < n; i++) slots.select(u128ToBytes(i)).setU128(i);
  }
}
