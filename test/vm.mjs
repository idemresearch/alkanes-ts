// A small in-process model of the alkanes VM host (alkanes-rs src/vm), for
// testing contracts without running an indexer. It implements every env.*
// host function with the same memory layout and return conventions, a fresh
// instance per call, storage that commits only on success, and nested
// extcalls with rollback. Alkane balances follow the canonical transfer rules
// (alkanes-rs src/utils.rs): a top-level message credits the target with its
// incoming parcel and debits its response transfers; call/staticcall move the
// incoming parcel caller -> callee and the response callee -> caller;
// delegatecall moves nothing. A debit beyond the balance fails unless the asset
// is the debtor's own ID, which mints it. Every balance change rolls back with
// the storage checkpoint. Fuel accounting is not modeled.

const REVERT = [0x08, 0xc3, 0x79, 0xa0];

export const u128 = {
  encode(value) {
    const out = new Uint8Array(16);
    let v = BigInt(value);
    for (let i = 0; i < 16; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  },
  decode(bytes, offset = 0) {
    let v = 0n;
    for (let i = Math.min(offset + 16, bytes.length) - 1; i >= offset; i--) {
      v = (v << 8n) | BigInt(bytes[i]);
    }
    return v;
  },
  list(values) {
    return concat(values.map((v) => u128.encode(v)));
  },
};

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const hex = (b) => Buffer.from(b).toString("hex");
const idKey = (id) => `${id.block}:${id.tx}`;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  remaining() {
    return this.bytes.length - this.offset;
  }
  u128() {
    if (this.remaining() < 16) throw new Error("short read");
    const v = u128.decode(this.bytes, this.offset);
    this.offset += 16;
    return v;
  }
  u32() {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return v;
  }
  take(n) {
    const v = this.bytes.slice(this.offset, this.offset + n);
    if (v.length !== n) throw new Error("short read");
    this.offset += n;
    return v;
  }
  rest() {
    return this.take(this.remaining());
  }
}

function readParcel(r) {
  const n = Number(r.u128());
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: { block: r.u128(), tx: r.u128() }, value: r.u128() });
  }
  return out;
}

function encodeParcel(parcel) {
  return u128.list([parcel.length, ...parcel.flatMap((t) => [t.id.block, t.id.tx, t.value])]);
}

function readStorageMap(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const key = r.take(r.u32());
    out.push([key, r.take(r.u32())]);
  }
  return out;
}

class RevertError extends Error {}

export class AlkanesVM {
  // balances: false skips host-level balance movement, for tests that isolate
  // a contract's own parcel handling with parcels the indexer could not credit.
  constructor({ height = 880000n, balances = true } = {}) {
    this.height = BigInt(height);
    this.enforceBalances = balances;
    // Precompiled contracts at [800000000, tx] (alkanes-rs host_functions.rs
    // _handle_special_extcall): block header, coinbase transaction, diesel
    // mint count and total miner fee for the block being indexed.
    this.precompiles = new Map([
      [0n, () => new Uint8Array(80)],
      [1n, () => new Uint8Array(0)],
      [2n, () => u128.encode(0n)],
      [3n, () => u128.encode(0n)],
    ]);
    this.sequence = 0n;
    this.modules = new Map(); // idKey -> WebAssembly.Module
    this.storage = new Map(); // idKey -> Map<hex key, Uint8Array>
    this.balances = new Map(); // `${who}/${what}` -> bigint
    this.logs = [];
  }

  deploy(id, wasm) {
    this.modules.set(idKey(id), new WebAssembly.Module(wasm));
    return id;
  }

  setBalance(who, what, value) {
    this.balances.set(`${idKey(who)}/${idKey(what)}`, BigInt(value));
  }

  storageOf(id) {
    let s = this.storage.get(idKey(id));
    if (!s) this.storage.set(idKey(id), (s = new Map()));
    return s;
  }

  snapshot() {
    return new Map([...this.storage].map(([k, v]) => [k, new Map(v)]));
  }

  // Runs `__meta` and returns the parsed ABI.
  meta(id) {
    const { exports, read } = this.instantiate(id, this.newFrame(id, { block: 0n, tx: 0n }, [], []));
    return JSON.parse(Buffer.from(read(exports.__meta())).toString("utf8"));
  }

  // Executes a top-level message. Resolves to { alkanes, data } or throws
  // "ALKANES: revert: ..." after rolling back, like AlkanesInstance::execute.
  call({ target, inputs, caller = { block: 0n, tx: 0n }, incoming = [], vout = 0n }) {
    const saved = this.snapshot();
    const balances = new Map(this.balances);
    try {
      this.credit(target, incoming);
      const response = this.execute(this.newFrame(target, caller, inputs, incoming, vout));
      // Top-level outgoing transfers leave the contract for the transaction's
      // outputs (not modeled as an account here).
      this.debit(target, response.alkanes);
      return response;
    } catch (e) {
      this.storage = saved;
      this.balances = balances;
      throw e;
    }
  }

  balanceOf(who, what) {
    return this.balances.get(`${idKey(who)}/${idKey(what)}`) ?? 0n;
  }

  credit(who, parcel) {
    if (!this.enforceBalances || (who.block === 0n && who.tx === 0n)) return;
    for (const t of parcel) {
      const key = `${idKey(who)}/${idKey(t.id)}`;
      const value = (this.balances.get(key) ?? 0n) + BigInt(t.value);
      if (value >= 1n << 128n) throw new RevertError("balance overflow during credit_balances");
      this.balances.set(key, value);
    }
  }

  // checked_debit_with_minting: an alkane may always pay out its own ID.
  debit(who, parcel) {
    if (!this.enforceBalances || (who.block === 0n && who.tx === 0n)) return;
    for (const t of parcel) {
      const key = `${idKey(who)}/${idKey(t.id)}`;
      let balance = this.balances.get(key) ?? 0n;
      const value = BigInt(t.value);
      if (balance < value) {
        if (t.id.block !== who.block || t.id.tx !== who.tx) {
          throw new RevertError(`balance underflow, transferring(${idKey(t.id)} ${value}), from(${idKey(who)}), balance(${balance})`);
        }
        balance = value;
      }
      this.balances.set(key, balance - value);
    }
  }

  // transfer_from: each entry is debited from `from`, then credited to `to`.
  transfer(parcel, from, to) {
    if (to.block === 0n && to.tx === 0n) return;
    for (const t of parcel) {
      this.debit(from, [t]);
      this.credit(to, [t]);
    }
  }

  // Client transport adapter: successful mutations are rolled back too.
  simulate(request) {
    const saved = this.snapshot();
    const logs = this.logs.slice();
    const balances = new Map(this.balances);
    const sequence = this.sequence;
    try { return this.call(request); }
    finally {
      this.storage = saved;
      this.logs = logs;
      this.balances = balances;
      this.sequence = sequence;
    }
  }

  newFrame(myself, caller, inputs, incoming, vout = 0n) {
    return { myself, caller, inputs: inputs.map(BigInt), incoming, vout: BigInt(vout), returndata: new Uint8Array(0) };
  }

  serializeContext(frame) {
    return concat([
      u128.list([frame.myself.block, frame.myself.tx, frame.caller.block, frame.caller.tx, frame.vout]),
      encodeParcel(frame.incoming),
      u128.list(frame.inputs),
    ]);
  }

  instantiate(id, frame) {
    const module = this.modules.get(idKey(id));
    if (!module) throw new RevertError(`no contract at ${idKey(id)}`);
    let memory;
    const mem = () => new Uint8Array(memory.buffer);
    const read = (ptr) => {
      const len = new DataView(memory.buffer).getUint32(ptr - 4, true);
      return mem().slice(ptr, ptr + len);
    };
    const write = (ptr, bytes) => {
      new DataView(memory.buffer).setUint32(ptr - 4, bytes.length, true);
      mem().set(bytes, ptr);
      return ptr;
    };
    const storage = () => this.storageOf(frame.myself);
    const extcall = (kind) => (cellpackPtr, alkanesPtr, checkpointPtr, _fuel) =>
      this.extcall(kind, frame, read(cellpackPtr), read(alkanesPtr), read(checkpointPtr));
    const env = {
      abort: () => {
        frame.failed = true;
      },
      __log: (ptr) => this.logs.push(Buffer.from(read(ptr)).toString("utf8")),
      __request_storage: (k) => (storage().get(hex(read(k))) ?? new Uint8Array(0)).length,
      __load_storage: (k, v) => write(v, storage().get(hex(read(k))) ?? new Uint8Array(0)),
      __balance: (who, what, out) => {
        const w = new Reader(read(who));
        const t = new Reader(read(what));
        const key = `${w.u128()}:${w.u128()}/${t.u128()}:${t.u128()}`;
        // Canonical __balance returns the stored bytes: empty if never set.
        write(out, this.balances.has(key) ? u128.encode(this.balances.get(key)) : new Uint8Array(0));
      },
      __request_context: () => this.serializeContext(frame).length,
      __load_context: (out) => write(out, this.serializeContext(frame)),
      __sequence: (out) => write(out, u128.encode(this.sequence)),
      __fuel: (out) => write(out, new Uint8Array(new BigUint64Array([100_000_000n]).buffer)),
      __height: (out) => write(out, new Uint8Array(new BigUint64Array([this.height]).buffer)),
      __returndatacopy: (out) => write(out, frame.returndata),
      __request_transaction: () => 0,
      __load_transaction: (out) => write(out, new Uint8Array(0)),
      __request_block: () => 0,
      __load_block: (out) => write(out, new Uint8Array(0)),
      __call: extcall("call"),
      __delegatecall: extcall("delegatecall"),
      __staticcall: extcall("staticcall"),
    };
    const instance = new WebAssembly.Instance(module, { env });
    memory = instance.exports.memory;
    return { exports: instance.exports, read };
  }

  // Runs __execute for `frame` and commits its storage writes on success.
  execute(frame) {
    const { exports, read } = this.instantiate(frame.myself, frame);
    let raw;
    try {
      raw = read(exports.__execute());
    } catch (e) {
      throw new RevertError(`ALKANES: revert: ${e.message}`);
    }
    const r = new Reader(raw);
    const alkanes = readParcel(r);
    const writes = readStorageMap(r);
    const data = r.rest();
    if (frame.failed) {
      const isRevert = data.length >= 4 && REVERT.every((b, i) => data[i] === b);
      const message = isRevert ? Buffer.from(data.slice(4)).toString("utf8") : "";
      throw new RevertError(`ALKANES: revert${message ? `: ${message}` : ""}`);
    }
    const storage = this.storageOf(frame.myself);
    for (const [k, v] of writes) storage.set(hex(k), v);
    return { alkanes, data };
  }

  extcall(kind, frame, cellpackBytes, alkanesBytes, checkpointBytes) {
    const cp = new Reader(cellpackBytes);
    const target = { block: cp.u128(), tx: cp.u128() };
    const inputs = [];
    while (cp.remaining() >= 16) inputs.push(cp.u128());
    const incoming = readParcel(new Reader(alkanesBytes));
    if (target.block === 800000000n) {
      // Answered by the host: no checkpoint, no storage piping, no transfers.
      const precompile = this.precompiles.get(target.tx);
      if (!precompile) {
        frame.failed = true;
        frame.returndata = concat([encodeParcel([]), new Uint8Array(REVERT), Buffer.from(`Unknown precompiled contract: [${target.block}, ${target.tx}]`)]);
        return -frame.returndata.length;
      }
      frame.returndata = concat([encodeParcel([]), precompile()]);
      return frame.returndata.length;
    }
    const saved = this.snapshot();
    const balances = new Map(this.balances);
    // The caller's uncommitted writes become visible to the callee first.
    const own = this.storageOf(frame.myself);
    for (const [k, v] of readStorageMap(new Reader(checkpointBytes))) own.set(hex(k), v);

    const callee =
      kind === "delegatecall"
        ? { ...this.newFrame(frame.myself, frame.caller, inputs, incoming), code: target }
        : this.newFrame(target, frame.myself, inputs, incoming);
    try {
      if (kind !== "delegatecall") this.transfer(incoming, frame.myself, target);
      const { alkanes, data } =
        kind === "delegatecall" ? this.executeDelegate(callee, target) : this.execute(callee);
      if (kind !== "delegatecall") this.transfer(alkanes, target, frame.myself);
      if (kind === "staticcall") {
        this.storage = saved;
        this.balances = balances;
      }
      frame.returndata = concat([encodeParcel(alkanes), data]);
      return frame.returndata.length;
    } catch (e) {
      this.storage = saved;
      this.balances = balances;
      // The canonical host aborts the caller when an extcall fails, even if
      // its source catches the SDK exception and returns a normal response.
      frame.failed = true;
      const message = e instanceof RevertError ? e.message : String(e);
      frame.returndata = concat([encodeParcel([]), new Uint8Array(REVERT), Buffer.from(message)]);
      return -frame.returndata.length;
    }
  }

  // Delegatecall runs `code`'s module against the caller's identity/storage.
  executeDelegate(frame, code) {
    const module = this.modules.get(idKey(code));
    const key = idKey(frame.myself);
    const original = this.modules.get(key);
    this.modules.set(key, module);
    try {
      return this.execute(frame);
    } finally {
      this.modules.set(key, original);
    }
  }
}
