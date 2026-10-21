# Contract authoring prototype

Counter now uses a compiler-supported class frontend. scriptc 0.4.0 remains the Wasm backend. No scriptc fork is required. The frontend is deliberately a restricted language prototype; the public package name and complete contract API remain provisional.

```ts
import { Contract, state, method, view, type u128 } from "../../sdk/authoring.ts";

export default class Counter extends Contract {
  static readonly incomingAssets = "reject";

  @state({ key: "/count" })
  private count: u128 = 0n;

  @method({ opcode: 1 })
  increment(by: u128): u128 {
    this.count += by;
    return this.count;
  }

  @view({ opcode: 2 })
  getCount(): u128 {
    return this.count;
  }
}
```

The repository uses relative imports while the package is private; `@alkanes/contract` is the intended published authoring entry point. The full Counter retains opcodes 0–6, `/count`, `/initialized`, and its existing ABI names. `getCount` uses `abiName: "get_count"` to preserve existing callers.

## Defined semantics

| Source | Behavior |
|---|---|
| `@state({ key }) field: u128 = literal` | A getter loads that explicit storage key; a setter buffers a checked 16-byte little-endian value. Renaming the field preserves its key. Duplicate declared keys fail compilation. |
| Initializer | A read of absent/empty storage returns the literal without writing. Stored zero is distinct from absence. Existing values survive fresh instances. Nonempty values of the wrong byte length fail. Initializers never run as storage assignments. |
| Ordinary field | Temporary, initialized for each execution. Literal defaults and `new StoragePointer("literal")` are supported. Initializers with other calls are rejected so they cannot mutate before the view guard is installed. |
| `u128` | A compiler semantic type represented by bigint in this version. Bigint arithmetic in contract bodies is lowered to checked operations, including inferred locals and nested intermediate expressions. Merely branding a bigint would not provide these semantics. |
| Arithmetic | `+ - * / %`, bit operations, shifts, compound assignments, and standalone `++/--` are supported. Negative results, values above `2^128-1`, division by zero, and shifts outside 0–127 throw. Thus `(MAX + 1n) - 1n` fails at the addition. `~` flips exactly 128 bits. |
| Explicit wide/wrapping operations | `wrappingAdd`, `wrappingSub` and `mulDiv` in `sdk/u128.ts`. `mulDiv(a,b,d)` uses an exact wider product, floors division, then checks the quotient. Ordinary `a*b/d` still checks the multiplication first. |
| `@view` | A conservative effect analysis follows direct local helper calls. Persistent writes, mutating SDK calls and calls to an exposed `@method` fail compilation. Recursion is handled by graph traversal. Unknown/indirect calls are rejected. Runtime guards also protect storage and the SDK host boundary for call/delegatecall. `staticcall` is allowed. Logs are allowed. Views cannot return transfers. |
| Opcode | Explicit u128 literal, matched directly with bigint comparisons. Duplicate opcodes and ABI names fail compilation. Large selectors require bigint literals. |
| ABI name | Defaults to the source method name. `abiName` preserves an existing external name independently of source renames. |
| Return | `u128` encodes exactly 16 little-endian bytes; `void` encodes no data. Explicit `CallResponse` supports SDK responses and transfers. |

Checked failures are TypeScript exceptions. An uncaught exception aborts the call and the host discards its storage changes; source `try/catch` can handle an exception explicitly. Compound field assignment evaluates the old value before evaluating the right-hand side, matching TypeScript evaluation order. Repeated field reads remain explicit storage reads; no optimizer assumes that a helper or external call cannot change storage.

Explicit `number` arithmetic remains TypeScript number arithmetic. Counter keeps a separately proven exact numeric fast path for sums up to 300,000. The frontend does not prove arbitrary floating-point code safe or automatically convert u128 loops to numbers.

## Incoming assets

The default policy is **reject**. Counter declares it explicitly: a primitive return never silently discards incoming assets. A rejection happens before method execution.

`static readonly incomingAssets = "forward"` permits incoming assets on methods. Primitive/void results forward the incoming parcel. An explicit `CallResponse` defines its own parcel, so asset-aware methods must handle incoming assets themselves. Views reject incoming assets under either policy and cannot return transfers.

This is an execution/response policy, not a model of asset custody, minting authorization or Bitcoin transaction construction. The test hosts do not enforce production alkane balances. The legacy Token still uses its existing explicit SDK response handling.

## Generated artifacts and clients

`npm run build -- counter` writes:

- `build/counter/entry.ts`: lowered source with direct opcode branches, field accessors and checked operators; this exact file goes to scriptc.
- `dist/counter.wasm` and `.wasm.gz`.
- `dist/counter.abi.json`: compatibility ABI, also embedded as a constant in `__meta`.
- `dist/counter.manifest.json`: field keys/defaults, view flags, incoming policy, and decimal-string opcodes without JSON number precision loss.
- `dist/CounterClient.ts`: typed client generated from that same manifest.

```ts
import { CounterClient } from "./dist/CounterClient.ts";

// The application supplies a transport that simulates against a snapshot.
const client = new CounterClient(transport, { block: 2n, tx: 1n });
const count: bigint = await client.read.getCount();
const simulated = await client.simulate.increment({ by: 5n });
// simulated.value is bigint; data and alkanes preserve the complete response.
const prepared = client.prepare.increment({ by: 5n });
// prepared.target, prepared.inputs and prepared.cellpack go to the app's
// transaction builder. This does not sign or broadcast anything.
```

Only views appear in `read`; only methods appear in `prepare`; every entry appears in `simulate`. Simulations preserve data and outgoing transfers alongside the decoded value. Arguments are bigint, checked before encoding. u128 returns require exactly 16 bytes. The transport owns caller context, simulation snapshots and connection details. `test/vm.mjs` supplies a snapshot-backed adapter test; there is no production RPC/wallet transport yet. Generated TypeScript imports currently reference this checkout, so distribution/relocation of generated packages is also follow-up work.

## Supported subset and diagnostics

One named default class must extend `Contract`. ABI parameters are required `u128` values, and return types are `u128`, `void` or `CallResponse`. State fields currently support only u128 with literal bigint defaults. Helpers are direct class methods. Runtime imports come from the SDK; compiling arbitrary user helper modules is not implemented yet.

Constructors, custom accessors, additional inheritance, generics on methods/classes, async/generators, unsafe casts/`any`, escaping `this`, dynamic calls, bigint exponentiation, complex compound-assignment targets and value-producing postfix increment are rejected. Views also reject writes through object/array aliases: a byte buffer returned by an SDK storage read can alias a buffered write, so such mutations cannot be assumed local. Unsupported constructs produce diagnostics instead of silently retaining unchecked semantics. SDK implementation code is trusted and is not rewritten by the authoring compiler.

`npm run typecheck` runs TypeScript plus Alkanes diagnostics. `npm run build` runs those Alkanes checks before invoking scriptc. Diagnostics include source file, line and column. Plain editor TypeScript currently sees `u128` as bigint: a language-service plugin is still needed to surface Alkanes effect/range diagnostics live. Marker decorators throw if executed without the frontend; transpiling the original source as ordinary JavaScript is not a supported test path.

`npm test` rebuilds production contracts, builds the semantic fixture through the same frontend/linker, then runs compiler rejection tests, generated-client type/runtime tests, and actual Wasm behavior tests. The semantics fixture also runs in wasmi 0.37.2.

## API validation still needed

Counter validates scalar state, arithmetic, dispatch, effects and the client path. It does not settle the full contract language. Before freezing a public API, implement and run these against the canonical indexer:

| Contract | Questions it must answer |
|---|---|
| Token | Typed keyed balances, initialization/owner representation, mint authorization, incoming parcel forwarding and generated response types. The legacy Token is retained as a behavior reference. |
| Authenticated withdrawal | Caller identity, persistent authorization, actual retained balances, outgoing transfers, and delegatecall identity. |
| AMM swap | Incoming asset validation, reserves versus actual balances, fees/slippage, exact wider multiplication (`mulDiv` is available), external call failures and transaction atomicity. |

Those require an asset-aware end-to-end design, not just more decorators. The current frontend and host models are a Counter-first prototype, not a production security boundary.

## Measurements

See `bench/FRONTEND_FUEL_RESULTS.md` for the comparison with commit `3762cad`, and `bench/FRONTEND_SPEED_RESULTS.md` for optimized Rust. Both record artifact hashes. Counter metadata is now static and its runtime method registry is gone; reads/increments/sums use less fuel. Fully checked bigint iteration adds cost to the storage-fill loop. The matched Rust numeric sum still runs faster in wall time. Instruction fuel excludes production host surcharges.
