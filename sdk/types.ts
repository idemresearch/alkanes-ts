// Wire types from alkanes-support, with the same serialization.

import { ByteReader, ByteWriter, concat, fromUtf8, utf8 } from "./bytes.ts";

export class AlkaneId {
  constructor(
    public readonly block: bigint,
    public readonly tx: bigint,
  ) {}

  static read(r: ByteReader): AlkaneId {
    const block = r.u128();
    return new AlkaneId(block, r.u128());
  }

  write(w: ByteWriter): void {
    w.u128(this.block).u128(this.tx);
  }

  serialize(): Uint8Array {
    return new ByteWriter().u128(this.block).u128(this.tx).finish();
  }

  equals(other: AlkaneId): boolean {
    return this.block === other.block && this.tx === other.tx;
  }

  toString(): string {
    return this.block.toString() + ":" + this.tx.toString();
  }
}

export class AlkaneTransfer {
  constructor(
    public readonly id: AlkaneId,
    public readonly value: bigint,
  ) {}
}

// Serialized as a u128 count followed by (block, tx, value) triples.
export class AlkaneTransferParcel {
  constructor(public readonly transfers: AlkaneTransfer[] = []) {}

  static read(r: ByteReader): AlkaneTransferParcel {
    const count = Number(r.u128());
    const transfers: AlkaneTransfer[] = [];
    for (let i = 0; i < count; i++) {
      const id = AlkaneId.read(r);
      transfers.push(new AlkaneTransfer(id, r.u128()));
    }
    return new AlkaneTransferParcel(transfers);
  }

  pay(id: AlkaneId, value: bigint): AlkaneTransferParcel {
    this.transfers.push(new AlkaneTransfer(id, value));
    return this;
  }

  write(w: ByteWriter): void {
    w.u128(BigInt(this.transfers.length));
    for (const t of this.transfers) {
      t.id.write(w);
      w.u128(t.value);
    }
  }

  serialize(): Uint8Array {
    const w = new ByteWriter();
    this.write(w);
    return w.finish();
  }
}

// Serialized as a sequence of u128s: target block, target tx, inputs...
export class Cellpack {
  constructor(
    public readonly target: AlkaneId,
    public readonly inputs: bigint[],
  ) {}

  serialize(): Uint8Array {
    const w = new ByteWriter();
    this.target.write(w);
    for (const v of this.inputs) w.u128(v);
    return w.finish();
  }
}

export class Context {
  constructor(
    public readonly myself: AlkaneId,
    public readonly caller: AlkaneId,
    public readonly vout: bigint,
    public readonly incomingAlkanes: AlkaneTransferParcel,
    public readonly inputs: bigint[],
  ) {}

  static parse(data: Uint8Array): Context {
    const r = new ByteReader(data);
    const myself = AlkaneId.read(r);
    const caller = AlkaneId.read(r);
    const vout = r.u128();
    const incoming = AlkaneTransferParcel.read(r);
    const inputs: bigint[] = [];
    while (r.remaining() > 0) inputs.push(r.u128());
    return new Context(myself, caller, vout, incoming, inputs);
  }
}

export class CallResponse {
  constructor(
    public alkanes: AlkaneTransferParcel = new AlkaneTransferParcel(),
    public data: Uint8Array = new Uint8Array(0),
  ) {}

  // Returns the incoming alkanes to the caller, like CallResponse::forward.
  static forward(incoming: AlkaneTransferParcel): CallResponse {
    return new CallResponse(new AlkaneTransferParcel(incoming.transfers.slice()));
  }

  static parse(data: Uint8Array): CallResponse {
    const r = new ByteReader(data);
    const alkanes = AlkaneTransferParcel.read(r);
    return new CallResponse(alkanes, r.rest());
  }

  withData(data: Uint8Array): CallResponse {
    this.data = data;
    return this;
  }

  withU128(value: bigint): CallResponse {
    this.data = new ByteWriter().u128(value).finish();
    return this;
  }

  withString(value: string): CallResponse {
    this.data = utf8(value);
    return this;
  }
}

// Solidity's Error(string) selector, which alkanes uses to mark revert data.
export const REVERT_SELECTOR = new Uint8Array([0x08, 0xc3, 0x79, 0xa0]);

export function isRevertData(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === REVERT_SELECTOR[0] &&
    data[1] === REVERT_SELECTOR[1] &&
    data[2] === REVERT_SELECTOR[2] &&
    data[3] === REVERT_SELECTOR[3]
  );
}

export function revertData(message: string): Uint8Array {
  return concat([REVERT_SELECTOR, utf8(message)]);
}

export function revertMessage(data: Uint8Array): string {
  return fromUtf8(data.slice(4));
}
