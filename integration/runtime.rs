//! Runs the unmodified Alkanes indexer, host functions, balance accounting,
//! transaction routing and wasmi engine. This is not the SDK's host model.
use alkanes::{indexer::index_block, tests::helpers, view, vm::fuel::FuelTank};
use alkanes_support::{
    cellpack::Cellpack,
    id::AlkaneId,
    parcel::AlkaneTransferParcel,
    response::CallResponse,
    trace::{Trace, TraceEvent},
    utils::string_to_u128_list,
};
use bitcoin::{Block, OutPoint};
use metashrew_core::{
    index_pointer::IndexPointer,
    stdio::{stdout, Write},
};
use metashrew_support::index_pointer::KeyValuePointer;
use protorune_support::balance_sheet::ProtoruneRuneId;
use std::{collections::BTreeMap, io::Cursor};
use wasm_bindgen_test::wasm_bindgen_test;
// Result lines for integration/run.mjs. metashrew v9 (alkanes-rs v3) compiles
// its println! to nothing unless the debug-log feature is on, so the harness
// writes through metashrew's stdout directly, as println! does on earlier
// revisions.
macro_rules! report {
    ($($t:tt)*) => {{
        use std::fmt::Write as _;
        writeln!(metashrew_core::stdio::stdout(), $($t)*).unwrap();
    }};
}
#[cfg(feature="examples")]
mod examples;
#[cfg(feature="custody")]
mod custody;

const TS: &[u8] = include_bytes!("./capped-token.wasm");
#[cfg(feature = "baseline")]
const BEFORE: &[u8] = include_bytes!("./capped-token-before.wasm");
const RUST: &[u8] = include_bytes!("./rust-capped-token.wasm");
const OPT: &[u8] = include_bytes!("./rust-capped-token-opt.wasm");
const AUTH: &[u8] = include_bytes!("./auth.wasm");
const MOCK: &[u8] = include_bytes!("./test-auth.wasm");
const INIT_PROBE: &[u8] = include_bytes!("./init-probe.wasm");
const CACHE_CALLER: &[u8] = include_bytes!("./cache-caller.wasm");
const CACHE_CALLEE: &[u8] = include_bytes!("./cache-callee.wasm");
const WORD: &[u8] = include_bytes!("./word.wasm");
fn token() -> AlkaneId {
    AlkaneId { block: 2, tx: 1 }
}
fn authority() -> AlkaneId {
    AlkaneId { block: 4, tx: 9001 }
}
fn cp(id: AlkaneId, inputs: Vec<u128>) -> Cellpack {
    Cellpack { target: id, inputs }
}
fn client(name: &str) -> Cellpack {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("./client-vectors.json")).unwrap();
    Cellpack::parse(&mut Cursor::new(
        hex::decode(vectors[name].as_str().unwrap()).unwrap(),
    ))
    .unwrap()
}
fn block(binary: &[u8], message: Cellpack, input: Option<OutPoint>, height: u32) -> Block {
    let pair = helpers::BinaryAndCellpack::new(binary.to_vec(), message);
    let mut block = if let Some(previous) = input {
        helpers::init_with_cellpack_pairs_w_input(vec![pair], previous)
    } else {
        helpers::init_with_cellpack_pairs(vec![pair])
    };
    // Give otherwise identical fixture transactions distinct txids.
    block.txdata[1].lock_time = bitcoin::absolute::LockTime::from_consensus(height - 1);
    block
}
fn outpoint(block: &Block, vout: u32) -> OutPoint {
    OutPoint {
        txid: block.txdata[1].compute_txid(),
        vout,
    }
}
fn events(block: &Block) -> Vec<TraceEvent> {
    let trace: Trace = view::trace(&outpoint(block, 3))
        .unwrap()
        .try_into()
        .unwrap();
    let events = trace.0.lock().unwrap().clone();
    events
}
#[derive(Debug)]
struct Execution {
    result: Result<CallResponse, String>,
    fuel: u64,
    micros: f64,
    events: Vec<TraceEvent>,
}
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=performance,js_name=now)]
    fn now() -> f64;
}
fn index(block: &Block, height: u32) -> Execution {
    let start = now();
    index_block(block, height).unwrap();
    let micros = (now() - start) * 1000.0;
    let trace = events(block);
    let result = trace
        .iter()
        .rev()
        .find_map(|event| match event {
            TraceEvent::ReturnContext(r) => Some(Ok(CallResponse {
                alkanes: r.inner.alkanes.clone(),
                data: r.inner.data.clone(),
            })),
            TraceEvent::RevertContext(r) => {
                Some(Err(String::from_utf8_lossy(&r.inner.data).into_owned()))
            }
            _ => None,
        })
        .expect("missing outer return/revert trace");
    // This revision drops fuel_used when serializing exit traces. Entry fuel
    // survives serialization. Each fixture block has one invocation, so its
    // allocation minus the canonical FuelTank remainder is the actual charge.
    // Failure drains the allocation; benchmark scenarios only measure success.
    let allocated = trace
        .iter()
        .find_map(|event| match event {
            TraceEvent::EnterCall(context) => Some(context.fuel),
            _ => None,
        })
        .expect("missing outer fuel allocation");
    let fuel = allocated.checked_sub(FuelTank::start_fuel()).unwrap();
    if result.is_ok() {
        assert!(fuel > 0, "successful invocation must consume fuel");
    }
    Execution {
        result,
        fuel,
        micros,
        events: trace,
    }
}
fn storage(id: &AlkaneId, key: &str) -> Vec<u8> {
    IndexPointer::from_keyword("/alkanes/")
        .select(&id.clone().into())
        .keyword("/storage/")
        .select(&key.as_bytes().to_vec())
        .get()
        .as_ref()
        .clone()
}
fn snapshot() -> BTreeMap<String, Vec<u8>> {
    let mut result = BTreeMap::new();
    for key in [
        "/__alkanes/init",
        "/__alkanes/lock",
        "/authority",
        "/cap",
        "/supply",
    ] {
        result.insert(key.into(), storage(&token(), key));
    }
    for key in ["/mode", "/calls"] {
        result.insert(format!("auth{key}"), storage(&authority(), key));
    }
    result
}
fn number(response: &CallResponse) -> u128 {
    u128::from_le_bytes(response.data.as_slice().try_into().unwrap())
}
fn balance(block: &Block, id: AlkaneId) -> u128 {
    helpers::get_last_outpoint_sheet(block)
        .unwrap()
        .get_cached(&ProtoruneRuneId {
            block: id.block,
            tx: id.tx,
        })
}
fn auth_init(mode: Option<u128>) -> Vec<u128> {
    if let Some(mode) = mode {
        return vec![0, mode];
    }
    let mut inputs = vec![0];
    inputs.extend(string_to_u128_list("Test Auth".into()));
    inputs.extend(string_to_u128_list("AUTH".into()));
    inputs.push(1);
    inputs
}
fn setup(binary: &[u8], mode: Option<u128>, cap: u128) -> (OutPoint, Execution) {
    helpers::clear();
    let mut deploy = client("deploy");
    deploy.inputs[3] = cap;
    let deployment = block(binary, deploy, None, 880000);
    let execution = index(&deployment, 880000);
    assert!(execution.result.is_ok(), "deploy: {:?}", execution);
    assert_eq!(
        IndexPointer::from_keyword("/alkanes/sequence").get_value::<u128>(),
        2
    );
    helpers::assert_binary_deployed_to_id(token(), binary.to_vec()).unwrap();
    let auth = block(
        if mode.is_some() { MOCK } else { AUTH },
        cp(AlkaneId { block: 3, tx: 9001 }, auth_init(mode)),
        None,
        880001,
    );
    assert!(index(&auth, 880001).result.is_ok());
    assert_eq!(balance(&auth, authority()), 1);
    (outpoint(&auth, 0), execution)
}
fn assert_revert(execution: Execution, code: &str) {
    let error = execution.result.expect_err("expected invocation failure");
    assert!(error.contains(code), "{error:?} missing {code}");
}

#[wasm_bindgen_test]
fn real_auth_clients_balances_and_rollback() {
    let mut reference = None;
    for binary in [TS, RUST, OPT] {
        let (input, _) = setup(binary, None, 1000);
        let mut results = vec![];
        for (name, expected) in [
            ("supply", vec![0; 16]),
            ("authority", authority().into()),
            ("cap", 1000u128.to_le_bytes().to_vec()),
        ] {
            let query = block(&[], client(name), None, 880002);
            let output = index(&query, 880002).result.unwrap();
            assert_eq!(output.data, expected);
            assert!(output.alkanes.0.is_empty());
            results.push(output);
        }
        let mint = block(&[], client("mint"), Some(input), 880003);
        let execution = index(&mint, 880003);
        let minted = execution.result.unwrap();
        assert_eq!(number(&minted), 5);
        assert_eq!(balance(&mint, token()), 5);
        assert_eq!(balance(&mint, authority()), 2);
        // The actual upstream auth binary returns two units after receiving one.
        assert!(execution.events.iter().any(|e|matches!(e,TraceEvent::EnterCall(c) if c.inner.myself==authority()&&c.inner.inputs.first()==Some(&1)&&c.inner.incoming_alkanes.0.len()==1&&c.inner.incoming_alkanes.0[0].value==1)));
        results.push(minted);
        let before = snapshot();
        let failed = block(
            &[],
            cp(token(), vec![77, 1000]),
            Some(outpoint(&mint, 0)),
            880004,
        );
        assert_revert(index(&failed, 880004), "CAP_EXCEEDED");
        assert_eq!(
            snapshot(),
            before,
            "caller and auth effects must roll back together"
        );
        assert_eq!(balance(&failed, token()), 5);
        assert_eq!(
            balance(&failed, authority()),
            2,
            "failed auth interaction must not leak issuance"
        );
        let again = block(&[], client("mint"), Some(outpoint(&failed, 0)), 880005);
        let returned = index(&again, 880005).result.unwrap();
        assert_eq!(number(&returned), 10);
        assert_eq!(balance(&again, token()), 10);
        assert_eq!(balance(&again, authority()), 3);
        results.push(returned);
        let current = (results, snapshot());
        if let Some(ref baseline) = reference {
            assert_eq!(&current, baseline);
        } else {
            reference = Some(current);
        }
    }
}

#[wasm_bindgen_test]
fn authentication_failures_and_reentry() {
    // (implementation, mode) -> outer revert message
    let mut reverts = BTreeMap::new();
    for (name, binary) in [("TS", TS), ("Rust", OPT)] {
        for mode in [1, 2, 3] {
            let (input, _) = setup(binary, Some(mode), 1000);
            let before = snapshot();
            let mint = block(&[], client("mint"), Some(input), 880002);
            let execution = index(&mint, 880002);
            if mode == 3 {
                assert!(execution.result.is_err());
                assert!(execution.events.iter().any(|e|matches!(e,TraceEvent::RevertContext(r) if String::from_utf8_lossy(&r.inner.data).contains("REENTRANT_CALL"))));
            } else {
                reverts.insert((name, mode), execution.result.expect_err("expected invocation failure"));
            }
            assert_eq!(snapshot(), before);
            assert_eq!(balance(&mint, authority()), 1);
        }
    }
    // alkanes-rs v3 reports a failed authentication extcall as fuel
    // exhaustion of the caller instead of the callee's revert message. That
    // is an indexer property, so it must hold for both implementations.
    let drained = |error: &String| cfg!(feature = "v3") && error.contains("all fuel consumed by WebAssembly");
    for mode in [1, 2] {
        let code = if mode == 1 { "AUTH_REJECTED" } else { "AUTH_FAILURE" };
        let (ts, rust) = (&reverts[&("TS", mode)], &reverts[&("Rust", mode)]);
        for error in [ts, rust] {
            assert!(error.contains(code) || (mode == 2 && drained(error)), "{error:?} missing {code}");
        }
        assert_eq!(drained(ts), drained(rust), "TS and Rust fail differently in mode {mode}: {ts:?} / {rust:?}");
    }
}

#[wasm_bindgen_test]
fn initialization_and_numeric_boundaries() {
    for binary in [TS, OPT] {
        for (inputs, error) in [
            (vec![101], "NOT_INITIALIZED"),
            (vec![0, 4, 9001, 0], "INVALID_CAP"),
        ] {
            helpers::clear();
            let deployment = block(
                binary,
                cp(AlkaneId { block: 1, tx: 0 }, inputs),
                None,
                880000,
            );
            assert_revert(index(&deployment, 880000), error);
            helpers::assert_token_id_has_no_deployment(token()).unwrap();
        }
        let (input, _) = setup(binary, Some(0), u128::MAX);
        let before = snapshot();
        let repeat = block(&[], client("initialize"), None, 880002);
        assert_revert(index(&repeat, 880002), "ALREADY_INITIALIZED");
        assert_eq!(snapshot(), before);
        let missing = block(&[], client("mint"), None, 880003);
        assert_revert(index(&missing, 880003), "AUTH_ASSET_REQUIRED");
        assert_eq!(snapshot(), before);
        let badview = block(&[], client("supply"), Some(input), 880004);
        assert_revert(index(&badview, 880004), "rejects incoming assets");
        assert_eq!(balance(&badview, authority()), 1);
        let zero = block(
            &[],
            cp(token(), vec![77, 0]),
            Some(outpoint(&badview, 0)),
            880005,
        );
        assert_revert(index(&zero, 880005), "INVALID_AMOUNT");
        assert_eq!(snapshot(), before);
        let maximum = block(
            &[],
            cp(token(), vec![77, u128::MAX]),
            Some(outpoint(&zero, 0)),
            880006,
        );
        assert_eq!(number(&index(&maximum, 880006).result.unwrap()), u128::MAX);
        assert_eq!(balance(&maximum, token()), u128::MAX);
        let before = snapshot();
        let overflow = block(
            &[],
            cp(token(), vec![77, 1]),
            Some(outpoint(&maximum, 0)),
            880007,
        );
        assert_revert(index(&overflow, 880007), "CAP_EXCEEDED");
        assert_eq!(snapshot(), before);
        assert_eq!(balance(&overflow, token()), u128::MAX);
    }
}

#[wasm_bindgen_test]
fn initialization_reentry_is_blocked() {
    helpers::clear();
    let auth = block(
        MOCK,
        cp(AlkaneId { block: 3, tx: 9001 }, auth_init(Some(4))),
        None,
        880000,
    );
    assert!(index(&auth, 880000).result.is_ok());
    let probe = block(
        INIT_PROBE,
        cp(AlkaneId { block: 1, tx: 0 }, vec![0, 4, 9001]),
        Some(outpoint(&auth, 0)),
        880001,
    );
    let result = index(&probe, 880001);
    assert!(result.result.is_err());
    assert!(result.events.iter().any(|e|matches!(e,TraceEvent::RevertContext(r) if String::from_utf8_lossy(&r.inner.data).contains("ALREADY_INITIALIZED"))));
    assert!(storage(&token(), "/__alkanes/init").is_empty());
    assert!(storage(&token(), "/authority").is_empty());
    assert!(storage(&authority(), "/calls").is_empty());
    assert_eq!(balance(&probe, authority()), 1);
    helpers::assert_token_id_has_no_deployment(token()).unwrap();
}

#[wasm_bindgen_test]
fn successful_callbacks_invalidate_the_caller_storage_cache() {
    helpers::clear();
    for (i, binary) in [CACHE_CALLER, CACHE_CALLEE].into_iter().enumerate() {
        let deployment = block(
            binary,
            cp(AlkaneId { block: 1, tx: 0 }, vec![9]),
            None,
            880000 + i as u32,
        );
        assert!(index(&deployment, 880000 + i as u32).result.is_ok());
    }
    let execute = block(&[], cp(token(), vec![0, 2, 2]), None, 880002);
    assert_eq!(number(&index(&execute, 880002).result.unwrap()), 2);
    assert_eq!(storage(&token(), "/value"), 2u128.to_le_bytes());
}

#[wasm_bindgen_test]
fn native_words_preserve_wide_values_checked_operations_and_self_auth() {
    helpers::clear();
    let wide = AlkaneId {
        block: (1u128 << 127) + 0x1122334455667788,
        tx: (1u128 << 96) + 123,
    };
    let deployment = block(
        WORD,
        cp(AlkaneId { block: 1, tx: 0 }, vec![0, wide.block, wide.tx]),
        None,
        880000,
    );
    assert!(index(&deployment, 880000).result.is_ok());
    assert!(
        storage(&token(), "/value").is_empty(),
        "defaults must not write"
    );
    let read = block(&[], cp(token(), vec![3]), None, 880001);
    assert_eq!(number(&index(&read, 880001).result.unwrap()), 17);
    assert!(storage(&token(), "/value").is_empty());
    let id = block(&[], cp(token(), vec![4]), None, 880002);
    assert_eq!(
        index(&id, 880002).result.unwrap().data,
        Vec::<u8>::from(wide)
    );
    let maximum = block(&[], cp(token(), vec![1, u128::MAX - 17]), None, 880003);
    assert_eq!(number(&index(&maximum, 880003).result.unwrap()), u128::MAX);
    let overflow = block(&[], cp(token(), vec![1, 1]), None, 880004);
    assert_revert(index(&overflow, 880004), "u128 overflow");
    assert_eq!(storage(&token(), "/value"), u128::MAX.to_le_bytes());
    let zero = block(&[], cp(token(), vec![2, u128::MAX]), None, 880005);
    assert_eq!(number(&index(&zero, 880005).result.unwrap()), 0);
    for (i, inputs, error) in [
        (0, vec![2, 1], "u128 underflow"),
        (1, vec![5], "word rollback"),
        (2, vec![6], "u128 overflow"),
    ] {
        let failed = block(&[], cp(token(), inputs), None, 880006 + i);
        assert_revert(index(&failed, 880006 + i), error);
        assert_eq!(storage(&token(), "/value"), 0u128.to_le_bytes());
    }
    let high = block(&[], cp(token(), vec![1u128 << 127]), None, 880009);
    assert_eq!(number(&index(&high, 880009).result.unwrap()), 42);
    let unknown = block(&[], cp(token(), vec![u128::MAX]), None, 880010);
    assert_revert(
        index(&unknown, 880010),
        &format!("Unrecognized opcode {}", u128::MAX),
    );
    for (i, flag) in [0, 1].into_iter().enumerate() {
        let conditional = block(&[], cp(token(), vec![12, flag]), None, 880020 + i as u32);
        assert_eq!(
            number(&index(&conditional, 880020 + i as u32).result.unwrap()),
            flag + 1
        );
    }
    let forged = block(&[], cp(token(), vec![11, 2, 1]), None, 880022);
    assert_revert(index(&forged, 880022), "AUTH_ASSET_REQUIRED");
    assert_eq!(
        balance(&forged, token()),
        0,
        "self issuance cannot satisfy auth proof"
    );
    let issued = block(&[], cp(token(), vec![9, 1]), None, 880023);
    assert!(index(&issued, 880023).result.is_ok());
    assert_eq!(balance(&issued, token()), 1);
    let authenticated = block(
        &[],
        cp(token(), vec![8, 2, 1]),
        Some(outpoint(&issued, 0)),
        880024,
    );
    let execution = index(&authenticated, 880024);
    assert!(execution.result.is_ok());
    assert_eq!(balance(&authenticated, token()), 1);
    assert_eq!(
        execution
            .events
            .iter()
            .filter(|e| matches!(e, TraceEvent::EnterCall(_)))
            .count(),
        1,
        "self auth must not extcall"
    );
}

#[cfg(feature = "benchmark")]
#[wasm_bindgen_test]
fn benchmark_capped_token() {
    let iterations: usize = include_str!("./iterations.txt").trim().parse().unwrap();
    const WARMUP: usize = 3;
    let mut reference: Option<Vec<(CallResponse, BTreeMap<String, Vec<u8>>)>> = None;
    let mut reference_wide = None;
    let mut variants = vec![
        ("typescript", TS),
        ("rust-o3-lto", RUST),
        ("rust-o3-lto-wasm-opt", OPT),
    ];
    #[cfg(feature = "baseline")]
    variants.push(("typescript-before", BEFORE));
    let mut samples = BTreeMap::<(&str, &str), Vec<(u64, f64)>>::new();
    for iteration in 0..iterations + WARMUP {
        // Rotate order to distribute warmup/thermal effects across variants.
        for offset in 0..variants.len() {
            let (name, binary) = variants[(iteration + offset) % variants.len()];
            let mut record = |method, execution: &Execution| {
                if iteration >= WARMUP {
                    samples
                        .entry((name, method))
                        .or_default()
                        .push((execution.fuel, execution.micros));
                }
            };
            let (input, init) = setup(binary, None, 1000);
            record("deploy+init", &init);
            let mut outputs = vec![(init.result.unwrap(), snapshot())];
            let mint = block(&[], client("mint"), Some(input), 880002);
            let executed = index(&mint, 880002);
            record("mint+auth", &executed);
            outputs.push((executed.result.unwrap(), snapshot()));
            for (i, method) in ["supply", "authority", "cap"].into_iter().enumerate() {
                let query = block(&[], client(method), None, 880003 + i as u32);
                let executed = index(&query, 880003 + i as u32);
                record(method, &executed);
                outputs.push((executed.result.unwrap(), snapshot()));
            }
            if let Some(ref baseline) = reference {
                assert_eq!(&outputs, baseline);
            } else {
                reference = Some(outputs);
            }
            // A separate, reachable MAX-cap deployment prevents the numeric
            // representation comparison from relying only on small values.
            let (input, _) = setup(binary, None, u128::MAX);
            let amount = (1u128 << 96) + 5;
            let mut request = client("mint");
            request.inputs[1] = amount;
            let wide = block(&[], request, Some(input), 880002);
            let executed = index(&wide, 880002);
            if iteration >= WARMUP {
                samples
                    .entry((name, "mint+auth-wide"))
                    .or_default()
                    .push((executed.fuel, executed.micros));
            }
            let response = executed.result.unwrap();
            assert_eq!(number(&response), amount);
            assert_eq!(balance(&wide, token()), amount);
            assert_eq!(balance(&wide, authority()), 2);
            let output = (response, snapshot());
            if let Some(ref baseline) = reference_wide {
                assert_eq!(&output, baseline);
            } else {
                reference_wide = Some(output);
            }
        }
    }
    for ((name, method), mut values) in samples {
        assert!(values.iter().all(|v| v.0 == values[0].0));
        values.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let median = if iterations % 2 == 0 {
            (values[iterations / 2 - 1].1 + values[iterations / 2].1) / 2.0
        } else {
            values[iterations / 2].1
        };
        report!(
            "ALKANES_TS_BENCH {}",
            serde_json::json!({"variant":name,"method":method,"iterations":iterations,"fuel":values[0].0,"median_us":median})
        );
    }
}
