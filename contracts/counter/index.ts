import { CallResponse, Contract, StoragePointer, checkedAdd, height, log, param } from "../../sdk/index.ts";

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
  });
