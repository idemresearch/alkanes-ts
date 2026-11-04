# Contract authoring prototype

Counter and CappedToken use a compiler-supported class frontend. scriptc 0.4.7 remains the Wasm backend. No scriptc fork is required. Eligible contracts use [fixed-width lowering](WORD_LOWERING.md): scriptc compiles the methods and metered Wasm helpers implement the integer/storage/asset SDK. The [extended word SDK](EXAMPLES_OPTIMIZATION.md) supports Counter's loops/raw storage and the static fluent Token. Unsupported syntax uses the original checked bigint backend. The frontend is deliberately a restricted language prototype; the public package name and complete contract API remain provisional. [CappedToken](CAPPED_TOKEN.md) adds one-time initialization, typed IDs, auth verification, tracked assets and deployment plans.

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
| `@state({ key }) field!: AlkaneId` | Required 32-byte state: block and tx are consecutive little-endian u128s. `@init` must directly assign it on every successful path. Reads reject missing/malformed state. IDs are immutable values; replace the field to change its value. |
| Initializer | A read of absent/empty storage returns the literal without writing. Stored zero is distinct from absence. Existing values survive fresh instances. Nonempty values of the wrong byte length fail. Initializers never run as storage assignments. |
| `@init({ opcode })` | One initializer per contract, returning void. Its first successful execution marks the contract ready; other entrypoints require readiness. Failure rolls back initialization, including code creation when deployed atomically. Direct internal calls to an initializer are rejected. |
| Ordinary field | Temporary, initialized for each execution. Literal defaults and `new StoragePointer("literal")` are supported. Initializers with other calls are rejected so they cannot mutate before the view guard is installed. |
| `u128` | A compiler semantic type. Both fixed-width and general bigint lowering check every supported operation, including nested intermediates. Fixed-width values are immutable word handles internally; public types and clients remain bigint. Merely branding a bigint would not provide these semantics. |
| Arithmetic | `+ - * / %`, bit operations, shifts, compound assignments, and standalone `++/--` are supported. Negative results, values above `2^128-1`, division by zero, and shifts outside 0–127 throw. Thus `(MAX + 1n) - 1n` fails at the addition. `~` flips exactly 128 bits. |
| Explicit wide/wrapping operations | `wrappingAdd`, `wrappingSub` and `mulDiv` in `sdk/u128.ts`. `mulDiv(a,b,d)` uses an exact wider product, floors division, then checks the quotient. Ordinary `a*b/d` still checks the multiplication first. |
| `@view` | A conservative effect analysis follows direct local helper calls. Persistent writes, mutating SDK calls and calls to an exposed `@method` fail compilation. Recursion is handled by graph traversal. Unknown/indirect calls are rejected. Runtime guards also protect storage and the SDK host boundary for call/delegatecall. Untracked contracts without `@init` may use `staticcall`; a tracked static-call API is not implemented yet. Logs are allowed. Views cannot return transfers. |
| Opcode | Explicit u128 literal, matched directly with bigint comparisons. Duplicate opcodes and ABI names fail compilation. Large selectors require bigint literals. |
| ABI name | Defaults to the source method name. `abiName` preserves an existing external name independently of source renames. |
| Return | `u128` encodes exactly 16 little-endian bytes; `AlkaneId` encodes 32 bytes; `void` encodes no data. Explicit `CallResponse` supports untracked SDK contracts. Tracked contracts return values; the compiler builds their asset response. |

Checked failures are TypeScript exceptions. Source `try/catch` can handle local arithmetic/assertion errors. An uncaught exception aborts the call and rolls back storage and asset effects. In the tested Alkanes revision, a failed external call also marks its caller as failed: catching the SDK exception does **not** recover the invocation. This includes a rejected reentrant callback.

Compound field assignment evaluates the old value before evaluating the right-hand side, matching TypeScript evaluation order. Repeated field reads remain explicit storage reads. Successful mutating external calls invalidate the caller's storage cache because the host commits its checkpoint and a callback may change its state. Static calls preserve that cache because the host rolls back their checkpoint.

Contracts with `@init` use reserved `/__alkanes/init` and `/__alkanes/lock` keys. Initialization and all later mutations reject reentry; views reject entry while a mutation is active. Required ID state has conservative definite-assignment checks for straight-line code, blocks and if/else. Loops, try/switch and helper-based initialization of required fields are not inferred. Initialized contracts use typed state instead of raw `StoragePointer` fields/constructors. Declared state keys cannot use the reserved prefix.

Explicit `number` arithmetic remains TypeScript number arithmetic. Counter keeps a separately proven exact numeric fast path for sums up to 300,000. The frontend does not prove arbitrary floating-point code safe or automatically convert u128 loops to numbers.

## Incoming assets

The default policy is **reject**. Counter declares it explicitly: a primitive return never silently discards incoming assets. A rejection happens before method execution.

`@method({ opcode, incomingAssets: "forward" })` permits incoming assets for that entrypoint. `static readonly incomingAssets = "forward"` sets the class default. Views always reject incoming assets and cannot return transfers.

Using `this.assets` or `this.auth` enables an invocation-local asset ledger. It merges incoming balances with checked arithmetic, debits transfers sent through `this.assets.call`, credits the call's actual returned transfers, and forwards all remaining balances once. `this.assets.mintSelf(amount)` credits issuance of this contract's own ID. `this.auth.require(id)` checks for an incoming auth asset and, for a different contract's ID, sends one unit to opcode 1 and checks the returned data is exactly `[1]`. This is the Alkanes auth-token protocol, not address comparison.

### Custody

By default the ledger returns everything it holds, so a contract that forgets to account for an incoming asset refunds it. Contracts that keep assets across invocations, such as pools, vaults and treasuries, move value between the ledger and the contract's **custody**, meaning its persistent Alkanes balance:

| Call | Effect |
|---|---|
| `this.assets.received(id)` | Total of `id` in the invocation's original incoming parcel, including duplicate entries. Unaffected by later ledger changes. |
| `this.assets.retain(id, amount)` | Moves `amount` from the ledger into custody, so it is not returned. Fails with `INSUFFICIENT_LEDGER`. For the contract's own ID this takes shares out of circulation. |
| `this.assets.held(id)` | Spendable custody of another asset: the host balance (`env.__balance`) minus the ledger. It equals prior holdings plus amounts retained minus amounts sent in this invocation. The contract's own ID fails with `SELF_CUSTODY_UNSUPPORTED`; use `mintSelf` for issuance. |
| `this.assets.send(id, amount)` | Moves `amount` from custody into the ledger, paying it to the caller with the response. Fails with `INSUFFICIENT_CUSTODY`, or `SELF_SEND_USE_MINT_SELF` for the contract's own ID. |

`retain` and `send` are mutations, so views cannot call them. `received` and `held` are reads. The identity behind `held` follows the canonical host. Incoming assets and call returns are credited to the contract's balance before its code runs, and the response is debited afterwards (`checked_debit_with_minting`: only the contract's own ID can be paid beyond its balance). Host balance minus ledger is therefore exactly the custody that is still unspent.

Store the totals a contract relies on, such as pool reserves or vault assets, instead of reading balances for pricing. Anyone can send assets to a contract, so balance-derived prices could be moved by donations. `held` is for safety checks and for deliberately folding surplus custody into stored totals.

A top-level caller is always `[0,0]`, so contracts cannot identify users by caller ID. Positions are represented by tokens (pool LP shares, vault shares), and privileged operations use auth tokens.

The ledger covers incoming assets, issuance, call returns and explicit custody moves. Initialized/tracked contracts reject raw runtime storage/call/reset APIs that would bypass lifecycle or accounting. Tracked contracts reject explicit `CallResponse` entrypoint returns to keep one response owner. An accounting failure after a successful external call makes the ledger unusable even if source catches the exception.

Without tracked assets, primitive/void results preserve the earlier forwarding behavior. Explicit `CallResponse` owns the whole parcel and requires manual accounting. The legacy Token retains that API. The JS VM (`test/vm.mjs`) and the standalone wasmi host (`harness/`) model execution, rollback and canonical alkane balance movement. Top-level parcels are credited to the target and its response is debited. call/staticcall move assets in both directions, delegatecall moves none, and `__balance` returns the stored bytes. The CappedToken integration suite separately verifies balance enforcement and transaction routing in the canonical indexer.

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

Only views appear in `read`; only methods/initializers appear in `call` and `prepare`; every entry appears in `simulate`. `call` constructs an immutable plan with `withAssets`, `simulate`, `prepare`, and `build({ wallet, builder })`. Asset attachment is type-checked against the entrypoint policy and guarded at runtime. Simulations preserve data and outgoing transfers alongside the decoded value. Arguments are checked before encoding: u128 values use bigint, and IDs use `{ block: bigint, tx: bigint }`. Return decoders require exact byte lengths.

For initialized contracts, `CappedTokenClient.deploy(transport, wasm, args)` prepares CREATE target `1:0` with the initializer inputs and Wasm in one request. An application-supplied transaction builder must include both in the same deployment envelope. The actual-runtime tests consume generated client cellpacks for deployment, mint and views.

The transport owns caller context, simulation snapshots and connection details. `test/vm.mjs` supplies a snapshot-backed adapter test. The builder interface accepts an application's wallet/PSBT implementation; this repository does not yet ship a production RPC, wallet, PSBT builder, signer or broadcaster. Generated TypeScript imports currently reference this checkout, so distribution/relocation of generated packages is also follow-up work.

## Supported subset and diagnostics

One named default class must extend `Contract`. ABI parameters are required `u128` or `AlkaneId` values, and return types are `u128`, `AlkaneId`, `void` or untracked `CallResponse`. State fields support u128 with literal bigint defaults and required AlkaneId values. Helpers are direct class methods. Runtime imports come from the SDK; compiling arbitrary user helper modules is not implemented yet.

Constructors, custom accessors, additional inheritance, generics on methods/classes, async/generators, unsafe casts/`any`, escaping `this`, dynamic calls, bigint exponentiation, complex compound-assignment targets and value-producing postfix increment are rejected. Views also reject writes through object/array aliases: a byte buffer returned by an SDK storage read can alias a buffered write, so such mutations cannot be assumed local. Unsupported constructs produce diagnostics instead of silently retaining unchecked semantics. SDK implementation code is trusted and is not rewritten by the authoring compiler.

`npm run typecheck` runs TypeScript plus Alkanes diagnostics. `npm run build` runs those Alkanes checks before invoking scriptc. Diagnostics include source file, line and column. Plain editor TypeScript currently sees `u128` as bigint: a language-service plugin is still needed to surface Alkanes effect/range diagnostics live. Marker decorators throw if executed without the frontend; transpiling the original source as ordinary JavaScript is not a supported test path.

`npm test` rebuilds production contracts, builds semantic/auth fixtures through the same frontend/linker, then runs compiler rejection tests, generated-client type/runtime tests, and Wasm host-model behavior tests. The semantics fixture also runs in wasmi 0.37.2. `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime` additionally runs the unmodified canonical indexer, including deployment envelopes, real auth, balances, rollback, and TS/Rust parity. See the [recorded integration result](../integration/RESULTS.md).

## API validation still needed

Counter validates scalar state, arithmetic, dispatch, effects and the client path. CappedToken now validates initialization, ID state, mint authorization, forwarding and issuance against the canonical indexer. These do not settle the full contract language. Before freezing a public API, implement and run:

| Contract | Questions it must answer |
|---|---|
| Token extensions | Typed keyed balances, transfers/retained custody and richer generated response/error types. The legacy Token is retained as a behavior reference. |
| Authenticated withdrawal | Caller identity, persistent authorization, actual retained balances, outgoing transfers, and delegatecall identity. |
| AMM swap | Incoming asset validation, reserves versus actual balances, fees/slippage, exact wider multiplication (`mulDiv` is available), external call failures and transaction atomicity. |

Those require extending the asset-aware execution design. The frontend remains a restricted prototype and has not been audited as a production security boundary.

## Measurements

See `bench/FRONTEND_FUEL_RESULTS.md` for the comparison with commit `3762cad`, and `bench/FRONTEND_SPEED_RESULTS.md` for optimized Rust. Both record artifact hashes. Counter metadata is now static and its runtime method registry is gone; reads/increments/sums use less fuel. Fully checked bigint iteration adds cost to the storage-fill loop. The matched Rust numeric sum still runs faster in wall time. Instruction fuel excludes production host surcharges.

The [CappedToken optimization comparison](../bench/CAPPED_TOKEN_OPTIMIZATION_RESULTS.md) runs both TS representations and optimized Rust through the actual Alkanes indexer, including a wide mint. Its fuel includes host/storage charges and nested auth execution. Timings measure local block indexing, including module compilation and instantiation. [Isolation measurements](../bench/CAPPED_TOKEN_ISOLATION_RESULTS.md) separately identify compilation, startup and SDK execution costs; the [initial CappedToken report](../bench/CAPPED_TOKEN_RESULTS.md) records the previous implementation.
