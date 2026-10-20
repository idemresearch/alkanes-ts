// A minimal owned fungible alkane. The deployer receives the initial supply
// and is the only caller allowed to mint more.

import {
  AlkaneId,
  AlkaneTransferParcel,
  CallResponse,
  Cellpack,
  Context,
  Contract,
  StoragePointer,
  bytesEqual,
  call,
  checkedAdd,
  param,
} from "../../sdk/index.ts";

const NAME = "TypeScript Token";
const SYMBOL = "TST";

const totalSupply = new StoragePointer("/totalsupply");
const owner = new StoragePointer("/owner");

function onlyOwner(ctx: Context): void {
  if (!bytesEqual(owner.get(), ctx.caller.serialize())) {
    throw new Error("caller is not the owner");
  }
}

function mint(ctx: Context, amount: bigint): CallResponse {
  totalSupply.setU128(checkedAdd(totalSupply.getU128(), amount));
  const response = CallResponse.forward(ctx.incomingAlkanes);
  response.alkanes.pay(ctx.myself, amount);
  return response;
}

export default new Contract("TypeScriptToken")
  .method(0, "initialize", [param("supply")], "void", (ctx, args) => {
    if (!owner.isEmpty()) throw new Error("already initialized");
    owner.set(ctx.caller.serialize());
    return mint(ctx, args.u128(0));
  })
  .method(77, "mint", [param("amount")], "void", (ctx, args) => {
    onlyOwner(ctx);
    return mint(ctx, args.u128(0));
  })
  .method(99, "get_name", [], "String", (ctx) => CallResponse.forward(ctx.incomingAlkanes).withString(NAME))
  .method(100, "get_symbol", [], "String", (ctx) => CallResponse.forward(ctx.incomingAlkanes).withString(SYMBOL))
  .method(101, "get_total_supply", [], "u128", (ctx) =>
    CallResponse.forward(ctx.incomingAlkanes).withU128(totalSupply.getU128()),
  )
  // Calls `opcode` on another alkane and returns its data, to exercise extcalls.
  .method(
    200,
    "forward_call",
    [param("block"), param("tx"), param("opcode")],
    "Vec<u8>",
    (ctx, args) => {
      const target = args.id(0);
      const inner = call(new Cellpack(target, [args.u128(2)]), new AlkaneTransferParcel(), 1_000_000);
      return CallResponse.forward(ctx.incomingAlkanes).withData(inner.data);
    },
  );
