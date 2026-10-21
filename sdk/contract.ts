// Opcode dispatch and the __execute / __meta entry points, equivalent to
// alkanes-runtime's declare_alkane! and MessageDispatch.

import { ByteWriter, concat, utf8 } from "./bytes.ts";
import { hostAbort } from "./host.ts";
import { resetStorage, serializeStorage } from "./runtime.ts";
import { AlkaneId, AlkaneTransferParcel, CallResponse, Context, revertData } from "./types.ts";

// The u128 inputs that follow the opcode.
export class Inputs {
  constructor(private readonly values: bigint[]) {}

  get length(): number {
    return this.values.length;
  }

  u128(index: number): bigint {
    const v = this.values[index];
    if (v === undefined) throw new Error("missing input " + index.toString());
    return v;
  }

  // Two consecutive inputs as an AlkaneId.
  id(index: number): AlkaneId {
    return new AlkaneId(this.u128(index), this.u128(index + 1));
  }

  all(): bigint[] {
    return this.values.slice();
  }
}

export type Handler = (ctx: Context, inputs: Inputs) => CallResponse;

export class Param {
  constructor(
    public readonly name: string,
    public readonly type: string,
  ) {}
}

export function param(name: string, type: string = "u128"): Param {
  return new Param(name, type);
}

export class Method {
  constructor(
    public readonly opcode: bigint,
    public readonly name: string,
    public readonly params: Param[],
    public readonly returns: string,
    public readonly handler: Handler,
  ) {}
}

export class Contract {
  private readonly order: Method[] = [];
  private fallbackHandler: Handler | null = null;

  constructor(public readonly name: string) {}

  method(opcode: number, name: string, params: Param[], returns: string, handler: Handler): Contract {
    const m = new Method(BigInt(opcode), name, params, returns, handler);
    this.order.push(m);
    return this;
  }

  fallback(handler: Handler): Contract {
    this.fallbackHandler = handler;
    return this;
  }

  dispatch(ctx: Context): CallResponse {
    if (ctx.inputs.length === 0) throw new Error("No opcode provided");
    const opcode = ctx.inputs[0];
    const args = new Inputs(ctx.inputs.slice(1));
    // Contracts usually expose a handful of methods. Comparing their integer
    // opcodes avoids allocating decimal strings and building a map per instance.
    // Walk backwards so registering an opcode again retains last-handler wins.
    for (let i = this.order.length - 1; i >= 0; i--) {
      const m = this.order[i];
      if (m.opcode === opcode) {
        if (args.length < m.params.length) {
          throw new Error(m.name + " expects " + m.params.length.toString() + " inputs");
        }
        return m.handler(ctx, args);
      }
    }
    const fallback = this.fallbackHandler;
    if (fallback !== null) return fallback(ctx, args);
    throw new Error("Unrecognized opcode " + opcode.toString());
  }

  abi(): string {
    const methods: string[] = [];
    for (const m of this.order) {
      const params: string[] = [];
      for (const p of m.params) params.push(JSON.stringify({ type: p.type, name: p.name }));
      methods.push(
        "{ " +
          '"name": ' + JSON.stringify(m.name) +
          ', "opcode": ' + m.opcode.toString() +
          ', "params": [' + params.join(", ") + "]" +
          ', "returns": ' + JSON.stringify(m.returns) +
          " }",
      );
    }
    return '{ "contract": ' + JSON.stringify(this.name) + ', "methods": [' + methods.join(", ") + "] }";
  }
}

// ExtendedCallResponse: alkanes parcel, storage map, then raw data.
function extendedResponse(alkanes: AlkaneTransferParcel, storage: Uint8Array, data: Uint8Array): Uint8Array {
  return concat([alkanes.serialize(), storage, data]);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function executeContract(contract: Contract, contextBytes: Uint8Array): Uint8Array {
  resetStorage();
  try {
    const response = contract.dispatch(Context.parse(contextBytes));
    return extendedResponse(response.alkanes, serializeStorage(), response.data);
  } catch (e) {
    // Like handle_error: flag the failure to the host, which rolls back state
    // and surfaces the message after the revert selector.
    hostAbort();
    const empty = new ByteWriter().u32(0).finish();
    return extendedResponse(new AlkaneTransferParcel(), empty, revertData("Error: " + errorMessage(e)));
  }
}

export function contractMeta(contract: Contract): Uint8Array {
  return utf8(contract.abi());
}
