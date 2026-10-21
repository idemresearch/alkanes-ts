// Off-chain transport boundary. simulate() must use a snapshot and must never
// submit a transaction. Signing stays with applications.
export interface AlkaneId { block: bigint; tx: bigint }
export interface Transfer { id: AlkaneId; value: bigint }
export interface CallRequest { target: AlkaneId; inputs: bigint[]; incoming?: Transfer[] }
export interface PreparedCall extends CallRequest { cellpack: Uint8Array; wasm?: Uint8Array }
export interface Response { data: Uint8Array; alkanes: Transfer[] }
export interface Simulation<T> extends Response { value: T }
// Reject on a reverted/failed invocation; Response represents success only.
export interface Transport { simulate(request: PreparedCall): Promise<Response> }
export interface TransactionBuilder<Wallet, PSBT> { build(request: PreparedCall, wallet: Wallet): Promise<PSBT> }
const MAX = (1n << 128n) - 1n;

export function uint128(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX) throw new Error("expected u128 bigint");
  return value;
}
export function prepare(target: AlkaneId, inputs: bigint[]): PreparedCall {
  const values = [uint128(target.block), uint128(target.tx), ...inputs.map(uint128)];
  const cellpack = new Uint8Array(values.length * 16);
  const view = new DataView(cellpack.buffer);
  values.forEach((value, index) => {
    view.setBigUint64(index * 16, value & ((1n << 64n) - 1n), true);
    view.setBigUint64(index * 16 + 8, value >> 64n, true);
  });
  return { target: { ...target }, inputs: inputs.slice(), cellpack };
}
export function decodeU128(response: Response): bigint {
  if (response.data.length !== 16) throw new Error("expected 16-byte u128 return data");
  const view = new DataView(response.data.buffer, response.data.byteOffset, 16);
  return view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);
}

export function decodeAlkaneId(response: Response): AlkaneId {
  if (response.data.length !== 32) throw new Error("expected 32-byte AlkaneId return data");
  return { block:decodeU128({ ...response, data:response.data.slice(0,16) }), tx:decodeU128({ ...response, data:response.data.slice(16) }) };
}

function copyRequest(request: PreparedCall): PreparedCall {
  return { ...prepare(request.target, request.inputs),
    ...(request.incoming ? {incoming:request.incoming.map((t) => ({id:{block:uint128(t.id.block),tx:uint128(t.id.tx)},value:uint128(t.value)}))} : {}),
    ...(request.wasm ? {wasm:new Uint8Array(request.wasm)} : {}) };
}

// A plan has no signing or broadcasting side effects. Each operation passes
// fresh copies to the application transport/builder so previews stay reusable.
export class CallPlan<T, AssetsAllowed extends boolean = true> {
  private readonly request: PreparedCall;
  constructor(private readonly transport: Transport, request: PreparedCall, private readonly decode: (response:Response) => T,
    private readonly allowAssets: AssetsAllowed = true as AssetsAllowed) {
    this.request = copyRequest(request);
  }
  withAssets(this: CallPlan<T, true>, incoming: Transfer[]): CallPlan<T, true> {
    if (!this.allowAssets) throw new Error("entrypoint rejects incoming assets");
    return new CallPlan(this.transport, {...this.request,incoming}, this.decode, true);
  }
  prepare(): PreparedCall { return copyRequest(this.request); }
  async simulate(): Promise<Simulation<T>> {
    const response = await this.transport.simulate(this.prepare());
    return {...response,value:this.decode(response)};
  }
  build<Wallet, PSBT>(options: {wallet:Wallet;builder:TransactionBuilder<Wallet,PSBT>}): Promise<PSBT> {
    return options.builder.build(this.prepare(),options.wallet);
  }
}
