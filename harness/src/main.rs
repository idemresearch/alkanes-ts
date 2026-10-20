//! Runs a contract under the wasmi 0.37.2 alkanes host model in lib.rs and
//! prints each call's result and fuel.
//!
//! Usage: wasmi-check <contract.wasm> [--meta] [opcode,input,...]...
//! Each positional argument is one call to the contract, deployed at 2:1 and
//! called by 0:0. Storage persists between calls and rolls back on revert.

use anyhow::{anyhow, Result};
use wasmi::Module;
use wasmi_check::{engine, World};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.first().ok_or(anyhow!("usage: wasmi-check <contract.wasm> [--meta] [inputs]..."))?;
    let wasm = std::fs::read(path)?;
    let mut world = World::new(engine())?;
    let module = Module::new(&world.engine, &wasm[..])?;
    world.deploy((2, 1), module);
    println!("loaded {} ({} bytes) under wasmi 0.37.2", path, wasm.len());

    for arg in &args[1..] {
        world.logs.borrow_mut().clear();
        if arg == "--meta" {
            let out = world.meta((2, 1));
            let abi = out.result.map(|r| String::from_utf8_lossy(&r.data).to_string());
            println!("__meta  fuel={:<9} {}", out.fuel_used, abi.unwrap_or_else(|e| format!("TRAP {e}")));
            continue;
        }
        let inputs: Vec<u128> = arg.split(',').map(|s| s.trim().parse()).collect::<Result<_, _>>()?;
        let out = world.execute((2, 1), (0, 0), &inputs);
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
                println!("[{arg}]  fuel={:<9} ok alkanes={} data={hex}{value}{logs}", out.fuel_used, r.alkanes.len());
            }
            Err(e) => println!("[{arg}]  fuel={:<9} REVERT {e:?}{logs}", out.fuel_used),
        }
    }
    Ok(())
}
