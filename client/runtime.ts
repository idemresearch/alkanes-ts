// Off-chain transport boundary. simulate() must use a snapshot and must never
// submit a transaction. Signing stays with applications.
export interface AlkaneId { block: bigint; tx: bigint }
export interface Transfer { id: AlkaneId; value: bigint }
export interface CallRequest { target: AlkaneId; inputs: bigint[] }
export interface PreparedCall extends CallRequest { cellpack: Uint8Array }
export interface Response { data: Uint8Array; alkanes: Transfer[] }
export interface Simulation<T> extends Response { value: T }
export interface Transport { simulate(request: CallRequest): Promise<Response> }
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
