//! Paired fuel measurements using the real scriptc runtime, SDK and WAT bridge.
//! Every sample gets a fresh instance; only explicit setup is excluded from fuel.
use anyhow::{anyhow, bail, ensure, Result};
use std::{fmt::Write, path::PathBuf};
use wasmi_check::engine;
mod common;
use common::{measure, Call, Case, Fixture};

fn cache_checksum(n: u32) -> u32 {
    let mut bytes = n.to_le_bytes().to_vec();
    for i in 0..n {
        bytes.extend(16u32.to_le_bytes());
        bytes.extend(u128::from(i).to_le_bytes());
        bytes.extend(16u32.to_le_bytes());
        bytes.extend((u128::from(i) + 1).to_le_bytes());
    }
    bytes.iter().fold(0u32, |hash, b| {
        hash.wrapping_mul(33).wrapping_add(u32::from(*b))
    })
}

fn delta(a: u64, b: u64) -> i128 {
    i128::from(b) - i128::from(a)
}

fn main() -> Result<()> {
    let mut iterations = 20;
    let mut root = PathBuf::from(".");
    let mut grow = true;
    let mut output = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--iterations" => iterations = args.next().ok_or(anyhow!("--iterations N"))?.parse()?,
            "--root" => root = PathBuf::from(args.next().ok_or(anyhow!("--root DIR"))?),
            "--no-grow" => grow = false,
            "--output" => {
                output = Some(PathBuf::from(args.next().ok_or(anyhow!("--output FILE"))?))
            }
            _ => bail!("unknown argument {arg}"),
        }
    }
    ensure!(iterations > 0, "iterations must be positive");
    let engine = engine();
    let load = |name| {
        Fixture::load(
            &engine,
            root.join(format!("dist/isolation/{name}.wasm")),
            grow,
        )
    };
    let minimal = load("minimal")?;
    let sdk = load("probes")?;
    let native = load("native")?;
    let mut report = String::new();
    writeln!(report, "# Fuel isolation results\n")?;
    writeln!(report, "wasmi 0.37.2; {iterations} repetitions per row, each on a fresh instance. Memory grow: {}. Every result and fuel repetition is checked. Initialization and fixture preparation are excluded from warm rows.\n", if grow { "512 pages" } else { "skipped" })?;
    writeln!(
        report,
        "```text\n{}```\n",
        std::fs::read_to_string(root.join("dist/isolation/BUILD.txt"))?
    )?;
    writeln!(report, "## Startup and empty execution\n")?;
    writeln!(report, "| fixture | initialization | cold empty execute | initialized empty execute | initialized scalar no-op |")?;
    writeln!(report, "|---|---:|---:|---:|---:|")?;
    for (name, fixture) in [
        ("native Rust, no SDK", &native),
        ("scriptc, no SDK", &minimal),
        ("scriptc + SDK (one method)", &sdk),
    ] {
        let init = measure(
            fixture,
            &Case {
                call: Call::Init,
                warm: false,
                prepare: None,
                payload: 0,
                expected: 0,
            },
            iterations,
        )?;
        let cold = measure(
            fixture,
            &Case {
                call: Call::Execute,
                warm: false,
                prepare: None,
                payload: 0,
                expected: 0,
            },
            iterations,
        )?;
        let warm = measure(
            fixture,
            &Case {
                call: Call::Execute,
                warm: true,
                prepare: None,
                payload: 0,
                expected: 0,
            },
            iterations,
        )?;
        let noop = measure(fixture, &Case::probe("noop", 7, 7), iterations)?;
        writeln!(report, "| {name} | {init} | {cold} | {warm} | {noop} |")?;
    }

    let bare = measure(&sdk, &Case::probe("pipeline_bare", 0, 20), iterations)?;
    let pipeline = measure(&sdk, &Case::probe("pipeline_sdk", 0, 20), iterations)?;
    writeln!(report, "\nSame initialized SDK module, prepared context and identical empty response: byte response control **{bare}**, SDK execution pipeline **{pipeline}**, added SDK pipeline fuel **{:+}**. This excludes host context loading and the WAT entry/return adapter.\n", delta(bare, pipeline))?;

    // Validate high limbs separately; scalar benchmark checksums are only u32.
    measure(&sdk, &Case::probe("verify_encoding", 0, 6), 1)?;

    writeln!(
        report,
        "\n## Arithmetic (no storage, encoding or SDK dispatch)\n"
    )?;
    writeln!(report, "| iterations | native f64 | scriptc number | native u128 | scriptc bigint | native checked u128 | scriptc checkedAdd | SDK check delta in TS |")?;
    writeln!(report, "|---:|---:|---:|---:|---:|---:|---:|---:|")?;
    for n in [0, 1, 100, 1_000, 10_000] {
        let k = u128::from(n);
        let expected = (k * k.saturating_sub(1) * (2 * k).saturating_sub(1) / 6) as u32;
        let mut fuels = Vec::new();
        for name in ["number_math", "bigint_math", "checked_math"] {
            for fixture in [&native, &sdk] {
                fuels.push(measure(
                    fixture,
                    &Case::probe(name, n, expected),
                    iterations,
                )?);
            }
        }
        writeln!(
            report,
            "| {n} | {} | {} | {} | {} | {} | {} | {:+} |",
            fuels[0],
            fuels[1],
            fuels[2],
            fuels[3],
            fuels[4],
            fuels[5],
            delta(fuels[3], fuels[5])
        )?;
    }

    writeln!(
        report,
        "\n## u128 encoding (same bigint accumulation, with/without SDK byte roundtrip)\n"
    )?;
    writeln!(report, "| values | native control | native roundtrip | native delta | TS control | TS SDK roundtrip | TS delta |")?;
    writeln!(report, "|---:|---:|---:|---:|---:|---:|---:|")?;
    for n in [0u32, 1, 100, 1_000] {
        let expected = (u64::from(n) * u64::from(n.saturating_sub(1)) / 2) as u32;
        let mut fuels = Vec::new();
        for fixture in [&native, &sdk] {
            for name in ["encoding_control", "encoding_roundtrip"] {
                fuels.push(measure(
                    fixture,
                    &Case::probe(name, n, expected),
                    iterations,
                )?);
            }
        }
        writeln!(
            report,
            "| {n} | {} | {} | {:+} | {} | {} | {:+} |",
            fuels[0],
            fuels[1],
            delta(fuels[0], fuels[1]),
            fuels[2],
            fuels[3],
            delta(fuels[2], fuels[3])
        )?;
    }

    writeln!(
        report,
        "\n## Host result transport (actual production WAT bridge and SDK)\n"
    )?;
    writeln!(
        report,
        "| payload bytes | request into adapter scratch | SDK copy into Uint8Array | copy delta |"
    )?;
    writeln!(report, "|---:|---:|---:|---:|")?;
    for n in [0, 1, 3, 4, 5, 16, 64, 256, 4_096] {
        let mut fuels = Vec::new();
        for name in ["host_request", "host_copy", "verify_host_copy"] {
            let mut case = Case::probe(name, n, n);
            case.payload = n;
            let fuel = measure(
                &sdk,
                &case,
                if name == "verify_host_copy" {
                    1
                } else {
                    iterations
                },
            )?;
            fuels.push(fuel);
        }
        writeln!(
            report,
            "| {n} | {} | {} | {:+} |",
            fuels[0],
            fuels[1],
            delta(fuels[0], fuels[1])
        )?;
    }

    writeln!(
        report,
        "\n## Storage key conversion and write cache (prepared 16-byte keys/values)\n"
    )?;
    writeln!(report, "| entries | key length control | toHex + length | hex delta | direct serialization | SDK cache + serialization | cache delta |")?;
    writeln!(report, "|---:|---:|---:|---:|---:|---:|---:|")?;
    for n in [0, 1, 10, 100, 1_000] {
        let mut fuels = Vec::new();
        for name in [
            "key_bytes",
            "key_hex",
            "serialize_only",
            "cache_and_serialize",
        ] {
            let expected = if name.starts_with("key_") {
                n * 16
            } else {
                cache_checksum(n)
            };
            let mut case = Case::probe(name, n, expected);
            case.prepare = Some(n);
            fuels.push(measure(&sdk, &case, iterations)?);
        }
        writeln!(
            report,
            "| {n} | {} | {} | {:+} | {} | {} | {:+} |",
            fuels[0],
            fuels[1],
            delta(fuels[0], fuels[1]),
            fuels[2],
            fuels[3],
            delta(fuels[2], fuels[3])
        )?;
    }
    writeln!(report, "\nDeltas are paired differences, not additive percentages of existing counter/token calls. `toHex` is part of the cache delta; do not add it again. SDK deltas include the cost of executing that SDK code through scriptc. The native fixture is a standalone lower bound, not alkanes-runtime. Native arithmetic/encoding uses black_box to retain the work. No production host surcharges or wall-clock claims. See bench/ISOLATION.md for methodology and limits.")?;
    if let Some(path) = output {
        std::fs::write(path, &report)?;
    }
    print!("{report}");
    Ok(())
}
