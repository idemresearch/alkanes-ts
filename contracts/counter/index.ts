import { CallResponse, Contract, StoragePointer, checkedAdd, height, log, param, u128ToBytes } from "../../sdk/index.ts";

const initialized = new StoragePointer("/initialized");
const count = new StoragePointer("/count");

export default new Contract("Counter")
  .method(0, "initialize", [], "void", () => {
    if (!initialized.isEmpty()) throw new Error("already initialized");
    initialized.set(new Uint8Array([1]));
    count.setU128(0n);
    return new CallResponse();
  })
  .method(1, "increment", [param("by")], "u128", (_ctx, args) => {
    const next = checkedAdd(count.getU128(), args.u128(0));
    count.setU128(next);
    return new CallResponse().withU128(next);
  })
  .method(2, "get_count", [], "u128", () => new CallResponse().withU128(count.getU128()))
  .method(3, "increment_then_fail", [], "void", () => {
    count.setU128(count.getU128() + 1n);
    throw new Error("intentional failure");
  })
  .method(4, "height", [], "u128", () => {
    const h = height();
    log("counter: block height is " + h.toString());
    return new CallResponse().withU128(h);
  })
  // Benchmark workloads: u128 arithmetic in a loop, and many storage writes.
  .method(5, "sum", [param("n")], "u128", (_ctx, args) => {
    const n = args.u128(0);
    let total = 0n;
    for (let i = 0n; i < n; i++) total = checkedAdd(total, i * i);
    return new CallResponse().withU128(total);
  })
  .method(6, "fill", [param("n")], "void", (_ctx, args) => {
    const n = args.u128(0);
    const slots = new StoragePointer("/slots/");
    for (let i = 0n; i < n; i++) slots.select(u128ToBytes(i)).setU128(i);
    return new CallResponse();
  });
