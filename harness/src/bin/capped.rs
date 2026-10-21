//! CappedToken isolation: compilation, instance setup, scriptc initialization,
//! and export execution. Fuel here excludes canonical host surcharges.
use anyhow::{ensure, Result};
use std::{path::PathBuf, time::Instant};
use wasmi::Module;
use wasmi_check::{engine, World, START_FUEL};
mod common;
use common::{measure, Call, Case, Fixture};
fn median(v: &mut Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}
fn main() -> Result<()> {
    let paths: Vec<_> = std::env::args().skip(1).map(PathBuf::from).collect();
    let mut reference = None;
    println!("| module | bytes | compile µs | startup fuel | init fuel | mint fuel | supply fuel | mint instance µs | mint export µs | supply instance µs | supply export µs |");
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for path in paths {
        let wasm = std::fs::read(&path)?;
        let e = engine();
        let mut compile = vec![];
        for _ in 0..30 {
            let start = Instant::now();
            let _ = Module::new(&engine(), &wasm[..])?;
            compile.push(start.elapsed().as_secs_f64() * 1e6);
        }
        let startup = if path.to_string_lossy().contains("capped-opt") {
            let f = Fixture::load(&e, path.clone(), false)?;
            measure(
                &f,
                &Case {
                    call: Call::Init,
                    warm: false,
                    prepare: None,
                    payload: 0,
                    expected: 0,
                },
                3,
            )?
        } else {
            0
        };
        if ["floor", "empty"]
            .iter()
            .any(|name| path.file_stem().unwrap() == *name)
            || path
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .starts_with("layer-")
        {
            let f = Fixture::load(&e, path.clone(), false)?;
            let cold = measure(
                &f,
                &Case {
                    call: Call::Execute,
                    warm: false,
                    prepare: None,
                    payload: 0,
                    expected: 0,
                },
                3,
            )?;
            let warm = measure(
                &f,
                &Case {
                    call: Call::Execute,
                    warm: true,
                    prepare: None,
                    payload: 0,
                    expected: 0,
                },
                3,
            )?;
            println!(
                "| {} | {} | {:.1} | {} | {} cold / {} warm empty | — | — | — | — | — | — |",
                path.display(),
                wasm.len(),
                median(&mut compile),
                startup,
                cold,
                warm
            );
            continue;
        }
        let mut world = World::new(e)?;
        world.set_grow_memory(false);
        world.deploy((2, 1), Module::new(&world.engine, &wasm[..])?);
        let auth = std::fs::read("dist/capped-opt/auth.wasm")?;
        world.deploy((4, 9001), Module::new(&world.engine, &auth[..])?);
        let init = world.execute((2, 1), (0, 0), &[0, 4, 9001, 1000]);
        ensure!(init.result.is_ok(), "{:?}", init.result);
        let mut name = [0; 16];
        name[..9].copy_from_slice(b"Test Auth");
        let mut symbol = [0; 16];
        symbol[..4].copy_from_slice(b"AUTH");
        ensure!(world
            .execute(
                (4, 9001),
                (0, 0),
                &[0, u128::from_le_bytes(name), u128::from_le_bytes(symbol), 1]
            )
            .result
            .is_ok());
        let state = world.snapshot();
        let mut fuels = vec![];
        let mut timings = vec![];
        let mut results = vec![];
        for inputs in [&[77u128, 5][..], &[101u128][..]] {
            let mut inst = vec![];
            let mut export = vec![];
            let mut first = None;
            for _ in 0..50 {
                world.restore(state.clone());
                let incoming = if inputs[0] == 77 {
                    vec![((4, 9001), 1)]
                } else {
                    vec![]
                };
                let executed =
                    world.execute_as((2, 1), (2, 1), (0, 0), inputs, &incoming, START_FUEL);
                ensure!(executed.result.is_ok(), "{:?}", executed.result);
                let current = (
                    executed.fuel_used,
                    executed.result.clone(),
                    world.snapshot(),
                );
                if let Some(ref prior) = first {
                    ensure!(&current == prior, "unstable result/fuel");
                } else {
                    first = Some(current);
                }
                let (i, x) = world.timing.get();
                inst.push(i.as_secs_f64() * 1e6);
                export.push(x.as_secs_f64() * 1e6);
            }
            let (fuel, response, state) = first.unwrap();
            fuels.push(fuel);
            results.push((response, state));
            timings.push((median(&mut inst), median(&mut export)));
        }
        if let Some(ref expected) = reference {
            ensure!(&results == expected, "response/state parity failed");
        } else {
            reference = Some(results);
        }
        println!(
            "| {} | {} | {:.1} | {} | {} | {} | {} | {:.1} | {:.1} | {:.1} | {:.1} |",
            path.display(),
            wasm.len(),
            median(&mut compile),
            startup,
            init.fuel_used,
            fuels[0],
            fuels[1],
            timings[0].0,
            timings[0].1,
            timings[1].0,
            timings[1].1
        );
    }
    Ok(())
}
