//! Compare type contracts and SDK algorithms without modifying production code.
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
    bytes
        .iter()
        .fold(0u32, |h, b| h.wrapping_mul(33).wrapping_add(u32::from(*b)))
}

fn change(before: u64, after: u64) -> String {
    format!(
        "{:+} ({:+.1}%)",
        i128::from(after) - i128::from(before),
        (after as f64 / before as f64 - 1.0) * 100.0
    )
}

fn main() -> Result<()> {
    let mut iterations = 20usize;
    let mut root = PathBuf::from(".");
    let mut versions = None;
    let mut grow = true;
    let mut output = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--iterations" => iterations = args.next().ok_or(anyhow!("--iterations N"))?.parse()?,
            "--root" => root = PathBuf::from(args.next().ok_or(anyhow!("--root DIR"))?),
            "--versions" => versions = Some(args.next().ok_or(anyhow!("--versions 0.3.6,0.4.0"))?),
            "--no-grow" => grow = false,
            "--output" => {
                output = Some(PathBuf::from(args.next().ok_or(anyhow!("--output FILE"))?))
            }
            _ => bail!("unknown argument {arg}"),
        }
    }
    ensure!(iterations > 0, "iterations must be positive");
    let versions = match versions {
        Some(versions) => versions,
        None => std::fs::read_to_string(root.join("dist/optimization/CURRENT"))?
            .trim()
            .to_owned(),
    };
    let engine = engine();
    let mut report = String::new();
    writeln!(report, "# scriptc optimization experiments\n")?;
    writeln!(report, "wasmi 0.37.2; {iterations} fresh-instance repetitions per row; memory growth: {}. Every scalar result and fuel repetition is checked. Prepared inputs and explicit initialization are excluded from warm measurements. The baseline restores the legacy codecs; the codec variant uses the current production algorithms.\n", if grow { "512 pages" } else { "skipped" })?;
    for version in versions.split(',') {
        let directory = root.join("dist/optimization").join(version);
        let load =
            |name: &str| Fixture::load(&engine, directory.join(format!("{name}.wasm")), grow);
        writeln!(
            report,
            "## scriptc {version}\n\n```text\n{}```\n",
            std::fs::read_to_string(directory.join("BUILD.txt"))?
        )?;
        writeln!(
            report,
            "### Compatibility checks\n\n{}",
            std::fs::read_to_string(directory.join("COMPATIBILITY.md"))?
        )?;
        let contracts = load("contracts")?;
        let arrays = if std::fs::read_to_string(directory.join("FEATURES.txt"))?.contains("Int32[]")
        {
            Some(load("arrays")?)
        } else {
            None
        };
        writeln!(report, "### Annotation-only pairs in the same module\n")?;
        writeln!(
            report,
            "| contract | workload size | plain | annotated | change |\n|---|---:|---:|---:|---:|"
        )?;
        for n in [0u32, 1, 100, 1_000, 10_000] {
            let integer_hash = (0..n).fold(0u32, |h, i| {
                h.wrapping_mul(33)
                    .wrapping_add(i.wrapping_mul(7919).wrapping_add(17))
            });
            let mixed = (0..n).fold(0u32, |h, _| h.wrapping_mul(33).wrapping_add(7));
            let sum = (u64::from(n) * u64::from(n.saturating_sub(1)) / 2) as u32;
            let table = [3u32, 7, 11, 19];
            let table_sum = (0..n).map(|i| table[(i & 3) as usize]).sum();
            for (label, plain, annotated, expected) in [
                (
                    "Int32 scalar slots",
                    "plain_integer_array",
                    "contracted_integer_array",
                    integer_hash,
                ),
                ("NoThrow", "plain_no_throw", "contracted_no_throw", mixed),
                ("Acyclic", "plain_acyclic", "contracted_acyclic", sum),
                (
                    "Immutable table",
                    "plain_immutable",
                    "contracted_immutable",
                    table_sum,
                ),
            ] {
                let mut a = Case::probe(plain, n, expected);
                let mut b = Case::probe(annotated, n, expected);
                a.prepare = Some(n);
                b.prepare = Some(n);
                let (before, after) = (
                    measure(&contracts, &a, iterations)?,
                    measure(&contracts, &b, iterations)?,
                );
                writeln!(
                    report,
                    "| {label} | {n} | {before} | {after} | {} |",
                    change(before, after)
                )?;
            }
            if let Some(fixture) = &arrays {
                let mut a = Case::probe("plain_integer_array", n, integer_hash);
                let mut b = Case::probe("contracted_integer_array", n, integer_hash);
                a.prepare = Some(n);
                b.prepare = Some(n);
                let (before, after) = (
                    measure(fixture, &a, iterations)?,
                    measure(fixture, &b, iterations)?,
                );
                writeln!(
                    report,
                    "| Int32[] + scalar slots | {n} | {before} | {after} | {} |",
                    change(before, after)
                )?;
            }
        }
        let fixtures = [load("baseline")?, load("annotations")?, load("codecs")?];
        writeln!(
            report,
            "\n### SDK copies: baseline, annotations only, annotations + codec algorithms\n"
        )?;
        writeln!(report, "| workload | baseline | annotations | annotation change | codecs | codec change vs baseline |\n|---|---:|---:|---:|---:|---:|")?;
        let rows = [
            ("cold empty execute", Call::Execute, false, None, 0, 0),
            ("initialized empty execute", Call::Execute, true, None, 0, 0),
            (
                "SDK pipeline (prepared context)",
                Call::Probe("pipeline_sdk", 0),
                true,
                None,
                0,
                20,
            ),
            (
                "hex keys, n=1,000",
                Call::Probe("key_hex", 1_000),
                true,
                Some(1_000),
                0,
                16_000,
            ),
            (
                "write cache + serialization, n=1,000",
                Call::Probe("cache_and_serialize", 1_000),
                true,
                Some(1_000),
                0,
                cache_checksum(1_000),
            ),
            (
                "u128 roundtrip, n=1,000",
                Call::Probe("encoding_roundtrip", 1_000),
                true,
                None,
                0,
                499_500,
            ),
            (
                "checked bigint sum, n=10,000",
                Call::Probe("checked_math", 10_000),
                true,
                None,
                0,
                (10_000u128 * 9_999 * 19_999 / 6) as u32,
            ),
            (
                "host copy, 16 bytes",
                Call::Probe("host_copy", 16),
                true,
                None,
                16,
                16,
            ),
        ];
        for (label, call, warm, prepare, payload, expected) in rows {
            let case = Case {
                call,
                warm,
                prepare,
                payload,
                expected,
            };
            let fuels = fixtures
                .iter()
                .map(|f| measure(f, &case, iterations))
                .collect::<Result<Vec<_>>>()?;
            writeln!(
                report,
                "| {label} | {} | {} | {} | {} | {} |",
                fuels[0],
                fuels[1],
                change(fuels[0], fuels[1]),
                fuels[2],
                change(fuels[0], fuels[2])
            )?;
        }
        for fixture in &fixtures {
            measure(fixture, &Case::probe("verify_encoding", 0, 6), 1)?;
        }
    }
    writeln!(report, "\nContract annotations may enforce proofs the compiler already infers. The scalar Int32 pair uses the same explicit wrapping operations on both paths; it does not test Int32[] storage. SDK annotations mark AlkaneId as Acyclic and bytesEqual as NoThrow. The codec variant additionally replaces per-nibble string construction with ASCII-byte encoding, and per-byte bigint u128 encoding/decoding with two DataView u64 limbs (retaining the short-input fallback). These are SDK algorithms, not compiler patches. The readonly linked-node probe tests a separate Acyclic inference limitation. No production host surcharges are modeled. See bench/OPTIMIZATION.md.")?;
    if let Some(path) = output {
        std::fs::write(path, &report)?;
    }
    print!("{report}");
    Ok(())
}
