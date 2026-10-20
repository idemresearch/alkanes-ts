//! Runs a contract under wasmi 0.37.2 configured the way alkanes-rs configures
//! it (fuel metering on, no start function, memory grown to 512 pages), with
//! the same `env` host functions. It checks that a built contract loads and
//! executes in the real engine and reports the fuel each call consumes.
//!
//! Usage: wasmi-check <contract.wasm> [--meta] [opcode,input,...]...
//! Each positional argument is one call; storage persists between calls and is
//! rolled back when a call reverts. Extcalls report failure.

use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use wasmi::*;

const START_FUEL: u64 = 100_000_000;
const REVERT: [u8; 4] = [0x08, 0xc3, 0x79, 0xa0];

#[derive(Default)]
struct State {
    context: Vec<u8>,
    storage: HashMap<Vec<u8>, Vec<u8>>,
    failed: bool,
    logs: Vec<String>,
    returndata: Vec<u8>,
}

fn memory(caller: &Caller<'_, State>) -> Memory {
    caller.get_export("memory").and_then(Extern::into_memory).expect("memory export")
}

fn read_ab(caller: &Caller<'_, State>, ptr: i32) -> Vec<u8> {
    let data = memory(caller).data(caller);
    let ptr = ptr as usize;
    let len = u32::from_le_bytes(data[ptr - 4..ptr].try_into().unwrap()) as usize;
    data[ptr..ptr + len].to_vec()
}

fn write_ab(caller: &mut Caller<'_, State>, ptr: i32, value: &[u8]) -> i32 {
    let mem = memory(caller);
    mem.write(&mut *caller, ptr as usize - 4, &(value.len() as u32).to_le_bytes()).unwrap();
    mem.write(&mut *caller, ptr as usize, value).unwrap();
    ptr
}

fn linker(engine: &Engine) -> Result<Linker<State>> {
    let mut l = Linker::<State>::new(engine);
    l.func_wrap("env", "abort", |mut c: Caller<'_, State>, _: i32, _: i32, _: i32, _: i32| {
        c.data_mut().failed = true;
    })?;
    l.func_wrap("env", "__log", |mut c: Caller<'_, State>, v: i32| {
        let msg = String::from_utf8_lossy(&read_ab(&c, v)).to_string();
        c.data_mut().logs.push(msg);
    })?;
    l.func_wrap("env", "__request_storage", |c: Caller<'_, State>, k: i32| -> i32 {
        let key = read_ab(&c, k);
        c.data().storage.get(&key).map_or(0, |v| v.len() as i32)
    })?;
    l.func_wrap("env", "__load_storage", |mut c: Caller<'_, State>, k: i32, v: i32| -> i32 {
        let key = read_ab(&c, k);
        let value = c.data().storage.get(&key).cloned().unwrap_or_default();
        write_ab(&mut c, v, &value)
    })?;
    l.func_wrap("env", "__balance", |mut c: Caller<'_, State>, _: i32, _: i32, out: i32| {
        write_ab(&mut c, out, &[0u8; 16]);
    })?;
    l.func_wrap("env", "__request_context", |c: Caller<'_, State>| -> i32 {
        c.data().context.len() as i32
    })?;
    l.func_wrap("env", "__load_context", |mut c: Caller<'_, State>, out: i32| -> i32 {
        let ctx = c.data().context.clone();
        write_ab(&mut c, out, &ctx)
    })?;
    l.func_wrap("env", "__sequence", |mut c: Caller<'_, State>, out: i32| {
        write_ab(&mut c, out, &0u128.to_le_bytes());
    })?;
    l.func_wrap("env", "__fuel", |mut c: Caller<'_, State>, out: i32| {
        let fuel = c.get_fuel().unwrap();
        write_ab(&mut c, out, &fuel.to_le_bytes());
    })?;
    l.func_wrap("env", "__height", |mut c: Caller<'_, State>, out: i32| {
        write_ab(&mut c, out, &900_000u64.to_le_bytes());
    })?;
    l.func_wrap("env", "__returndatacopy", |mut c: Caller<'_, State>, out: i32| {
        let data = c.data().returndata.clone();
        write_ab(&mut c, out, &data);
    })?;
    l.func_wrap("env", "__request_transaction", |_: Caller<'_, State>| -> i32 { 0 })?;
    l.func_wrap("env", "__load_transaction", |mut c: Caller<'_, State>, out: i32| {
        write_ab(&mut c, out, &[]);
    })?;
    l.func_wrap("env", "__request_block", |_: Caller<'_, State>| -> i32 { 0 })?;
    l.func_wrap("env", "__load_block", |mut c: Caller<'_, State>, out: i32| {
        write_ab(&mut c, out, &[]);
    })?;
    for name in ["__call", "__staticcall", "__delegatecall"] {
        l.func_wrap("env", name, |mut c: Caller<'_, State>, _: i32, _: i32, _: i32, _: i64| -> i32 {
            let mut data = vec![0u8; 16];
            data.extend(REVERT);
            data.extend(b"extcalls are not modeled by wasmi-check");
            let len = data.len() as i32;
            c.data_mut().returndata = data;
            -len
        })?;
    }
    Ok(l)
}

struct Outcome {
    result: Result<Vec<u8>>,
    fuel_used: u64,
}

fn run(engine: &Engine, module: &Module, state: State, export: &str) -> (Outcome, State) {
    let mut store = Store::new(engine, state);
    store.set_fuel(START_FUEL).unwrap();
    let result = (|| -> Result<Vec<u8>> {
        let instance = linker(engine)?.instantiate(&mut store, module)?.ensure_no_start(&mut store)?;
        let mem = instance.get_memory(&store, "memory").ok_or(anyhow!("no memory export"))?;
        let pages = mem.size(&store);
        if pages < 512 {
            mem.grow(&mut store, 512 - pages)?;
        }
        let func = instance.get_typed_func::<(), i32>(&store, export)?;
        let ptr = func.call(&mut store, ())? as usize;
        let data = mem.data(&store);
        let len = u32::from_le_bytes(data[ptr - 4..ptr].try_into()?) as usize;
        Ok(data[ptr..ptr + len].to_vec())
    })();
    let fuel_used = START_FUEL - store.get_fuel().unwrap();
    (Outcome { result, fuel_used }, store.into_data())
}

fn u128s(values: &[u128]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn take<'a>(data: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if data.len() < n {
        bail!("response truncated");
    }
    let (head, rest) = data.split_at(n);
    *data = rest;
    Ok(head)
}

/// Splits an ExtendedCallResponse into (alkane transfer count, storage writes, data).
fn parse_response(mut data: &[u8]) -> Result<(u128, Vec<(Vec<u8>, Vec<u8>)>, Vec<u8>)> {
    let count = u128::from_le_bytes(take(&mut data, 16)?.try_into()?);
    take(&mut data, 48 * count as usize)?;
    let pairs = u32::from_le_bytes(take(&mut data, 4)?.try_into()?);
    let mut writes = Vec::new();
    for _ in 0..pairs {
        let klen = u32::from_le_bytes(take(&mut data, 4)?.try_into()?) as usize;
        let key = take(&mut data, klen)?.to_vec();
        let vlen = u32::from_le_bytes(take(&mut data, 4)?.try_into()?) as usize;
        writes.push((key, take(&mut data, vlen)?.to_vec()));
    }
    Ok((count, writes, data.to_vec()))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.first().ok_or(anyhow!("usage: wasmi-check <contract.wasm> [--meta] [inputs]..."))?;
    let wasm = std::fs::read(path)?;
    let mut config = Config::default();
    config.consume_fuel(true);
    let engine = Engine::new(&config);
    let module = Module::new(&engine, &wasm[..])?;
    println!("loaded {} ({} bytes) under wasmi 0.37.2", path, wasm.len());

    let mut storage = HashMap::new();
    for arg in &args[1..] {
        if arg == "--meta" {
            let (out, _) = run(&engine, &module, State::default(), "__meta");
            println!("__meta  fuel={:<9} {}", out.fuel_used, String::from_utf8_lossy(&out.result?));
            continue;
        }
        let inputs: Vec<u128> = arg.split(',').map(|s| s.trim().parse()).collect::<Result<_, _>>()?;
        let mut context = u128s(&[2, 1, 0, 0, 0, 0]); // myself 2:1, caller 0:0, vout 0, no alkanes
        context.extend(u128s(&inputs));
        let state = State { context, storage: storage.clone(), ..Default::default() };
        let (out, state) = run(&engine, &module, state, "__execute");
        let logs = if state.logs.is_empty() { String::new() } else { format!(" logs={:?}", state.logs) };
        let outcome = out.result.and_then(|raw| parse_response(&raw));
        match outcome {
            Ok((_, _, data)) if state.failed => {
                let message = if data.starts_with(&REVERT) {
                    String::from_utf8_lossy(&data[4..]).to_string()
                } else {
                    String::new()
                };
                println!("[{arg}]  fuel={:<9} REVERT {message:?}{logs}", out.fuel_used);
            }
            Ok((alkanes, writes, data)) => {
                for (k, v) in writes {
                    storage.insert(k, v);
                }
                let value = if data.len() == 16 {
                    format!(" u128={}", u128::from_le_bytes(data[..].try_into()?))
                } else {
                    String::new()
                };
                let hex: String = data.iter().map(|b| format!("{b:02x}")).collect();
                println!("[{arg}]  fuel={:<9} ok alkanes={alkanes} data={hex}{value}{logs}", out.fuel_used);
            }
            Err(e) => println!("[{arg}]  fuel={:<9} TRAP {e}{logs}", out.fuel_used),
        }
    }
    Ok(())
}
