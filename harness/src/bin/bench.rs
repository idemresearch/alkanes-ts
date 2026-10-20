//! Benchmarks the TypeScript contracts (dist/) against their Rust twins built
//! with alkanes-runtime (bench/dist/) on the wasmi 0.37.2 alkanes host model.
//!
//! For each scenario both implementations run the same setup calls, then the
//! measured call is repeated from the same starting state. Fuel is
//! deterministic. Wall time is split into instantiation (including growing
//! memory to 512 pages, as the indexer does) and running the export, each the
//! median over all iterations. Results print as a Markdown report.
//!
//! Usage: bench [--iterations N] [--root DIR] [--no-grow]
//!
//! --no-grow skips the 512-page memory grow. wasmi zero-fills grown pages
//! eagerly, which dominates instantiation time and makes first touches of
//! that memory fault in, so this isolates the contracts' own execution cost.

use anyhow::{anyhow, Result};
use flate2::{write::GzEncoder, Compression};
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};
use wasmi::Module;
use wasmi_check::{engine, AlkaneId, Outcome, World, START_FUEL};

const COUNTER: AlkaneId = (2, 1);
const TOKEN: AlkaneId = (2, 2);
const USER: AlkaneId = (2, 100);

#[derive(Clone, Copy)]
enum Call {
    Execute(AlkaneId, &'static [u128]),
    Meta(AlkaneId),
}

struct Scenario {
    name: &'static str,
    setup: &'static [Call],
    call: Call,
}

const INIT_COUNTER: Call = Call::Execute(COUNTER, &[0]);
const INIT_TOKEN: Call = Call::Execute(TOKEN, &[0, 1000]);

const SCENARIOS: &[Scenario] = &[
    Scenario { name: "counter `__meta`", setup: &[], call: Call::Meta(COUNTER) },
    Scenario { name: "counter initialize", setup: &[], call: INIT_COUNTER },
    Scenario { name: "counter increment", setup: &[INIT_COUNTER], call: Call::Execute(COUNTER, &[1, 5]) },
    Scenario { name: "counter get_count", setup: &[INIT_COUNTER], call: Call::Execute(COUNTER, &[2]) },
    Scenario { name: "counter revert (write, then throw)", setup: &[INIT_COUNTER], call: Call::Execute(COUNTER, &[3]) },
    Scenario { name: "counter get_height + log", setup: &[], call: Call::Execute(COUNTER, &[4]) },
    Scenario { name: "counter unknown opcode", setup: &[], call: Call::Execute(COUNTER, &[99]) },
    Scenario { name: "counter sum(n=100)", setup: &[], call: Call::Execute(COUNTER, &[5, 100]) },
    Scenario { name: "counter sum(n=10,000)", setup: &[], call: Call::Execute(COUNTER, &[5, 10_000]) },
    Scenario { name: "counter fill(n=10)", setup: &[], call: Call::Execute(COUNTER, &[6, 10]) },
    Scenario { name: "counter fill(n=1,000)", setup: &[], call: Call::Execute(COUNTER, &[6, 1_000]) },
    Scenario { name: "token `__meta`", setup: &[], call: Call::Meta(TOKEN) },
    Scenario { name: "token initialize", setup: &[], call: INIT_TOKEN },
    Scenario { name: "token mint (owner)", setup: &[INIT_TOKEN], call: Call::Execute(TOKEN, &[77, 50]) },
    Scenario { name: "token get_name", setup: &[], call: Call::Execute(TOKEN, &[99]) },
    Scenario { name: "token get_total_supply", setup: &[INIT_TOKEN], call: Call::Execute(TOKEN, &[101]) },
    Scenario {
        name: "token → counter extcall",
        setup: &[INIT_COUNTER, Call::Execute(COUNTER, &[1, 41])],
        call: Call::Execute(TOKEN, &[200, COUNTER.0, COUNTER.1, 2]),
    },
];

struct Impl {
    name: &'static str,
    counter: PathBuf,
    token: PathBuf,
}

struct Measured {
    fuel: u64,
    instantiate: Duration,
    execute: Duration,
    result: Result<Vec<u8>, String>,
}

fn run(world: &Rc<World>, call: Call) -> Outcome {
    match call {
        Call::Execute(target, inputs) => world.execute(target, USER, inputs),
        Call::Meta(target) => world.meta(target),
    }
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

fn gzip_len(bytes: &[u8]) -> Result<usize> {
    let mut e = GzEncoder::new(Vec::new(), Compression::best());
    e.write_all(bytes)?;
    Ok(e.finish()?.len())
}

fn world_for(imp: &Impl, grow: bool) -> Result<Rc<World>> {
    let mut world = World::new(engine())?;
    world.set_grow_memory(grow);
    let counter = Module::new(&world.engine, &std::fs::read(&imp.counter)?[..])?;
    let token = Module::new(&world.engine, &std::fs::read(&imp.token)?[..])?;
    world.deploy(COUNTER, counter);
    world.deploy(TOKEN, token);
    Ok(world)
}

fn measure(imp: &Impl, scenario: &Scenario, iterations: usize, grow: bool) -> Result<Measured> {
    let world = world_for(imp, grow)?;
    for &call in scenario.setup {
        if let Err(e) = run(&world, call).result {
            return Err(anyhow!("{}: setup failed for {}: {e}", imp.name, scenario.name));
        }
    }
    let start = world.snapshot();
    let mut instantiate = Vec::with_capacity(iterations);
    let mut execute = Vec::with_capacity(iterations);
    let mut first: Option<(u64, Result<Vec<u8>, String>)> = None;
    for _ in 0..iterations {
        world.restore(start.clone());
        let out = run(&world, scenario.call);
        let (i, e) = world.timing.get();
        instantiate.push(i);
        execute.push(e);
        let result = out.result.map(|r| r.data);
        match &first {
            None => first = Some((out.fuel_used, result)),
            Some((fuel, _)) if *fuel != out.fuel_used => {
                return Err(anyhow!("{}: nondeterministic fuel in {}", imp.name, scenario.name));
            }
            _ => {}
        }
    }
    let (fuel, result) = first.unwrap();
    Ok(Measured { fuel, instantiate: median(instantiate), execute: median(execute), result })
}

fn compile_time(engine: &wasmi::Engine, wasm: &[u8], iterations: usize) -> Result<Duration> {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let t = Instant::now();
        Module::new(engine, wasm)?;
        samples.push(t.elapsed());
    }
    Ok(median(samples))
}

fn us(d: Duration) -> String {
    format!("{:.1}", d.as_secs_f64() * 1e6)
}

fn ratio(ts: f64, rust: f64) -> String {
    format!("{:.1}×", ts / rust)
}

fn describe(result: &Result<Vec<u8>, String>) -> String {
    match result {
        Ok(data) if data.is_empty() => "ok".into(),
        Ok(data) if data.starts_with(b"{") => format!("ABI, {} bytes", data.len()),
        Ok(data) if data.iter().all(|b| b.is_ascii_graphic() || *b == b' ') => {
            format!("{:?}", String::from_utf8_lossy(data))
        }
        Ok(data) if data.len() == 16 => format!("u128 {}", u128::from_le_bytes(data[..].try_into().unwrap())),
        Ok(data) => format!("{} bytes", data.len()),
        Err(e) => format!("revert {e:?}"),
    }
}

fn main() -> Result<()> {
    let mut iterations = 200usize;
    let mut root = PathBuf::from(".");
    let mut grow = true;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--iterations" => iterations = args.next().ok_or(anyhow!("--iterations N"))?.parse()?,
            "--root" => root = PathBuf::from(args.next().ok_or(anyhow!("--root DIR"))?),
            "--no-grow" => grow = false,
            other => return Err(anyhow!("unknown argument {other}")),
        }
    }
    let rust = Impl {
        name: "alkanes-rs",
        counter: root.join("bench/dist/rust-counter.wasm"),
        token: root.join("bench/dist/rust-token.wasm"),
    };
    let ts = Impl { name: "alkanes-ts", counter: root.join("dist/counter.wasm"), token: root.join("dist/token.wasm") };

    println!("## Binary size and compile time\n");
    println!("Compile time is the median `Module::new` over {iterations} runs.\n");
    println!("| contract | alkanes-rs | alkanes-ts | ratio | rs gzip | ts gzip | ratio | rs compile µs | ts compile µs | ratio |");
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    let engine = engine();
    for (label, r, t) in [("counter", &rust.counter, &ts.counter), ("token", &rust.token, &ts.token)] {
        let (rb, tb) = (std::fs::read(r)?, std::fs::read(t)?);
        let (rg, tg) = (gzip_len(&rb)?, gzip_len(&tb)?);
        let (rc, tc) = (compile_time(&engine, &rb, iterations)?, compile_time(&engine, &tb, iterations)?);
        println!(
            "| {label} | {} | {} | {} | {rg} | {tg} | {} | {} | {} | {} |",
            rb.len(),
            tb.len(),
            ratio(tb.len() as f64, rb.len() as f64),
            ratio(tg as f64, rg as f64),
            us(rc),
            us(tc),
            ratio(tc.as_secs_f64(), rc.as_secs_f64()),
        );
    }

    println!("\n## Per-call cost\n");
    println!(
        "Fuel is wasmi instruction fuel (start budget {START_FUEL}). Times are medians over {iterations} runs: \
         *exec* runs the export (nested extcalls included), *inst* instantiates{}.\n",
        if grow { " and grows memory to 512 pages, as the indexer does" } else { " (memory grow skipped: --no-grow)" }
    );
    println!("| scenario | rs fuel | ts fuel | ratio | rs exec µs | ts exec µs | ratio | rs inst µs | ts inst µs | result |");
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    let mut mismatches = Vec::new();
    for s in SCENARIOS {
        let r = measure(&rust, s, iterations, grow)?;
        let t = measure(&ts, s, iterations, grow)?;
        let same = match (&r.result, &t.result) {
            (Ok(a), Ok(b)) => a == b || (a.starts_with(b"{") && b.starts_with(b"{")),
            (Err(_), Err(_)) => true,
            _ => false,
        };
        let result = if same && describe(&r.result) == describe(&t.result) {
            describe(&r.result)
        } else {
            if !same {
                mismatches.push(s.name);
            }
            format!("rs: {} / ts: {}", describe(&r.result), describe(&t.result))
        };
        println!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            s.name,
            r.fuel,
            t.fuel,
            ratio(t.fuel as f64, r.fuel as f64),
            us(r.execute),
            us(t.execute),
            ratio(t.execute.as_secs_f64(), r.execute.as_secs_f64()),
            us(r.instantiate),
            us(t.instantiate),
            result,
        );
    }
    if !mismatches.is_empty() {
        return Err(anyhow!("implementations disagree on: {}", mismatches.join(", ")));
    }
    Ok(())
}
