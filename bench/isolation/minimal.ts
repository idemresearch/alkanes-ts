// No SDK imports: the scriptc runtime + production ABI adapter floor.
export function execute(_context: Uint8Array): Uint8Array {
  return new Uint8Array(20); // empty parcel (u128), empty storage map (u32)
}

export function meta(): Uint8Array {
  return new Uint8Array(0);
}

export function noop(n: number): number {
  return n;
}
