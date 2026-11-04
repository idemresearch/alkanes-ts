//! Runs a contract under the wasmi 0.37.2 alkanes host model in lib.rs and
//! prints each call's result and fuel.
//!
//! Usage: wasmi-check <contract.wasm> [--deploy block:tx=other.wasm]... [--target block:tx]
//!                    [--meta] [opcode,input,...[@block:tx=value+...]]...
//! Each positional argument is one call to the contract, deployed at 2:1 and
//! called by 0:0, optionally with an incoming parcel after `@`. Storage and
//! alkane balances persist between calls and roll back on revert.
//!
//! `--deploy` adds another contract for cross-contract calls; every deployment
//! happens before the first call. `--target` sends the following calls (and
//! `--meta`) to another deployed contract. A call's fuel includes the fuel its
//! nested callees burn.

use anyhow::{anyhow, Result};
use wasmi::Module;
use wasmi_check::{engine, AlkaneId, World};

fn parse_id(s: &str) -> Result<AlkaneId> {
    let (block, tx) = s.split_once(':').ok_or(anyhow!("{s}: expected block:tx"))?;
    Ok((block.parse()?, tx.parse()?))
}

enum Step {
    Target(AlkaneId),
    Meta,
    Call(String),
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.first().ok_or(anyhow!("usage: wasmi-check <contract.wasm> [--deploy block:tx=file.wasm]... [--target block:tx] [--meta] [inputs]..."))?;
    let wasm = std::fs::read(path)?;
    let mut world = World::new(engine())?;
    let module = Module::new(&world.engine, &wasm[..])?;
    world.deploy((2, 1), module);
    println!("loaded {} ({} bytes) under wasmi 0.37.2", path, wasm.len());

    let mut steps = Vec::new();
    let mut rest = args[1..].iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--deploy" => {
                let spec = rest.next().ok_or(anyhow!("--deploy needs block:tx=file.wasm"))?;
                let (id, file) = spec.split_once('=').ok_or(anyhow!("--deploy {spec}: expected block:tx=file.wasm"))?;
                let bytes = std::fs::read(file)?;
                let module = Module::new(&world.engine, &bytes[..])?;
                world.deploy(parse_id(id)?, module);
                println!("deployed {file} ({} bytes) at {id}", bytes.len());
            }
            "--target" => steps.push(Step::Target(parse_id(rest.next().ok_or(anyhow!("--target needs block:tx"))?)?)),
            "--meta" => steps.push(Step::Meta),
            _ => steps.push(Step::Call(arg.clone())),
        }
    }

    let mut target: AlkaneId = (2, 1);
    for step in &steps {
        world.logs.borrow_mut().clear();
        let arg = match step {
            Step::Target(id) => {
                target = *id;
                println!("target {}:{}", id.0, id.1);
                continue;
            }
            Step::Meta => {
                let out = world.meta(target);
                let abi = out.result.map(|r| String::from_utf8_lossy(&r.data).to_string());
                println!("__meta  fuel={:<9} {}", out.fuel_used, abi.unwrap_or_else(|e| format!("TRAP {e}")));
                continue;
            }
            Step::Call(arg) => arg,
        };
        let (call, parcel) = arg.split_once('@').unwrap_or((arg, ""));
        let inputs: Vec<u128> = call.split(',').map(|s| s.trim().parse()).collect::<Result<_, _>>()?;
        let incoming = parcel
            .split('+')
            .filter(|t| !t.is_empty())
            .map(|t| -> Result<((u128, u128), u128)> {
                let (id, value) = t.split_once('=').ok_or(anyhow!("transfer {t}: expected block:tx=value"))?;
                let (block, tx) = id.split_once(':').ok_or(anyhow!("transfer {t}: expected block:tx"))?;
                Ok(((block.parse()?, tx.parse()?), value.parse()?))
            })
            .collect::<Result<Vec<_>>>()?;
        let out = world.execute_with(target, (0, 0), &inputs, &incoming);
        let logs = world.logs.borrow();
        let logs = if logs.is_empty() { String::new() } else { format!(" logs={:?}", *logs) };
        match out.result {
            Ok(r) => {
                let value = if r.data.len() == 16 {
                    format!(" u128={}", u128::from_le_bytes(r.data[..].try_into()?))
                } else {
                    String::new()
                };
                let hex: String = r.data.iter().map(|b| format!("{b:02x}")).collect();
                let alkanes: Vec<String> = r.alkanes.iter().map(|((b, t), v)| format!("{b}:{t}={v}")).collect();
                println!("[{arg}]  fuel={:<9} ok alkanes={} [{}] data={hex}{value}{logs}", out.fuel_used, r.alkanes.len(), alkanes.join(" "));
            }
            Err(e) => println!("[{arg}]  fuel={:<9} REVERT {e:?}{logs}", out.fuel_used),
        }
    }
    Ok(())
}
