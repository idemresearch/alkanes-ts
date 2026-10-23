# CappedToken

The [contract](../contracts/capped-token/index.ts) uses the restricted Alkanes frontend with stock scriptc 0.4.2 as its backend:

```ts
import {
  Contract, state, init, method, view, assert,
  type AlkaneId, type u128,
} from "../../sdk/authoring.ts";

export default class CappedToken extends Contract {
  @state({ key: "/authority" }) private authority!: AlkaneId;
  @state({ key: "/cap" }) private cap: u128 = 0n;
  @state({ key: "/supply" }) private supply: u128 = 0n;

  @init({ opcode: 0 })
  initialize(authority: AlkaneId, cap: u128): void {
    assert(cap > 0n, "INVALID_CAP");
    this.authority = authority;
    this.cap = cap;
  }

  @method({ opcode: 77, incomingAssets: "forward" })
  mint(amount: u128): u128 {
    this.auth.require(this.authority);
    assert(amount > 0n, "INVALID_AMOUNT");
    assert(amount <= this.cap - this.supply, "CAP_EXCEEDED");
    this.supply += amount;
    this.assets.mintSelf(amount);
    return this.supply;
  }

  @view({ opcode: 101 }) totalSupply(): u128 { return this.supply; }
  @view({ opcode: 102 }) getAuthority(): AlkaneId { return this.authority; }
  @view({ opcode: 103 }) getCap(): u128 { return this.cap; }
}
```

`@init` succeeds once. Every other entrypoint requires initialization; mutations hold a reentry lock until completion. Both flags are persistent and participate in host rollback. Failed CREATE+init also rolls back the deployed binary. Required ID fields have compile-time definite-assignment checks and runtime storage-length checks. Storage defaults do not write, including during views.

The cap check uses remaining supply so a request beyond the cap consistently returns `CAP_EXCEEDED`, including when supply is `u128::MAX`. Checked subtraction and addition still reject invalid arithmetic. The auth interaction completes before reading supply for the update.

Authorization requires a positive balance of the configured auth asset in the original incoming parcel, with a unit still available in the ledger. Self issuance and later mutation of the context cannot manufacture that proof. Unless the authority is this contract itself, the SDK sends one unit to that authority's opcode 1 and requires return data exactly `[1]`. Possession alone does not authenticate an external authority. In the pinned upstream revision, the standard auth binary returns **two** units after receiving one; the ledger credits the actual response. No assumption about a fixed returned balance is baked into the contract.

The ledger normalizes duplicate incoming IDs, debits extcall transfers, credits successful returns, adds self issuance, and emits all remaining assets once. Incoming assets and minted units with the same ID merge using checked arithmetic. It tracks this invocation's assets, not previously retained contract custody. Bitcoin output routing remains the responsibility of the surrounding transaction.

The tested runtime aborts callers after a failed external call even when source catches the SDK error. This also makes an attempted reentrant auth callback abort the whole invocation. Uncaught local failures roll back the caller, successful nested auth effects, assets and lifecycle flags together.

## Generated client

```ts
import { CappedTokenClient } from "../dist/CappedTokenClient.ts";

const authority = { block: 4n, tx: 9001n };
const token = new CappedTokenClient(transport, { block: 2n, tx: 1n });
const supply: bigint = await token.read.totalSupply();
const owner: { block: bigint; tx: bigint } = await token.read.getAuthority();

const plan = token.call.mint({ amount: 100n })
  .withAssets([{ id: authority, value: 1n }]);
const preview = await plan.simulate();
// preview.value: decoded supply; preview.data and preview.alkanes: full response.
const psbt = await plan.build({ wallet, builder });

const deployment = CappedTokenClient.deploy(transport, wasm, {
  authority,
  cap: 1_000_000n,
});
const request = deployment.prepare();
// CREATE target 1:0; initializer opcode 0 + ID's two limbs + cap; Wasm included.
const deployPsbt = await deployment.build({ wallet, builder });
```

`transport`, `wallet`, `builder` and `wasm` above are application inputs. `Transport.simulate(PreparedCall)` must execute against a snapshot, reject failed/reverted invocations, and never submit. `TransactionBuilder<Wallet, PSBT>.build(request, wallet)` must encode the cellpack, incoming assets and any deployment Wasm into an appropriate transaction. The SDK ships these typed boundaries and the plans, not a production RPC/wallet/PSBT implementation. Signing and broadcasting remain with the application.

Plans copy inputs, IDs, assets and Wasm on construction and when handed to an adapter. `withAssets` returns a fresh plan. It is absent as a callable TypeScript capability on entrypoints that reject assets, with a runtime guard for JavaScript callers. ABI, manifest, dispatch and client derive from the same contract declaration.

| Entry | Opcode | Inputs after opcode | Return | Incoming assets |
|---|---:|---|---|---|
| initialize | 0 | authority block, authority tx, cap | void | reject |
| mint | 77 | amount | u128 | forward remaining balances |
| totalSupply | 101 | none | u128 | reject |
| getAuthority | 102 | none | AlkaneId | reject |
| getCap | 103 | none | u128 | reject |

All input slots are little-endian u128s. A returned ID is exactly 32 bytes. Explicit keys and opcodes are compatibility commitments; renaming a field preserves its key.

## Verification and benchmarking

```sh
npm run typecheck
npm test
ALKANES_RS=/path/to/alkanes-rs npm run test:runtime
ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations 30
```

The runtime runner requires the recorded upstream checkout, Rust 1.86.0 for contract fixtures, Rust stable with the wasm32-unknown-unknown target for the indexer, and wasm-bindgen-test-runner 0.2.127. Node 24+, Zig (0.17.0 in the current reports) and npm dependencies are also required. The runner uses `integration/Cargo.lock`, copies its work into `build/`, and leaves upstream sources unchanged. Build scripts use repository-local Zig caches when needed.

The [integration results](../integration/RESULTS.md) record the upstream revision, lock hash, runner/toolchain and Wasm hashes. Tests call `alkanes::indexer::index_block` with deployment envelopes and actual UTXO balances. They cover real standard-auth calls, typed ID state, duplicate/failed init, atomic deployment failure, cap/max-u128 edges, auth failures, reentry, nested rollback and successful callback cache invalidation. TS and optimized Rust must match complete responses and declared persistent state.

The [optimization benchmark](../bench/CAPPED_TOKEN_OPTIMIZATION_RESULTS.md) compares both TS representations with Rust O3/fat-LTO and Rust plus wasm-opt O3. It measures actual runtime fuel and local indexing time for deployment/init, authenticated mint, a mint above 96 bits, and all three views. Three warmups per variant precede measured repetitions, with rotating variant order. Each repetition verifies response/state parity. This measures the local release-built wasm-bindgen/Node indexer, including module compilation and instantiation, not production network latency. Fresh deployment timing also includes chain bootstrap; mint and views use initialized chain state.

The [initial implementation](../bench/CAPPED_TOKEN_RESULTS.md) used 253,280 mint fuel and took 10.13 ms versus 197,787 fuel and 6.85 ms for optimized Rust. [Fixed-width lowering](WORD_LOWERING.md) retains this exact authored contract and now uses 108,865 mint fuel versus 197,787 for optimized Rust, with median indexing time 5.71 ms versus 6.90 ms in the paired run. That is 45% less fuel and 17% less time. Wide mint and all three views also beat that baseline in both metrics. The checks include full-range arithmetic and the actual standard-auth Wasm.

The compiler still has a deliberately restricted syntax, provisional package layout, and no editor language-service extension. See [authoring semantics and limits](AUTHORING.md). Deployment tests run in-process against the canonical indexer; they do not broadcast to a live Bitcoin regtest node.
