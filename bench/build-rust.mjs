#!/usr/bin/env node
// Build comparison crates locally, without modifying the alkanes-rs checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.ALKANES_RS) throw new Error("set ALKANES_RS to an alkanes-rs checkout");
const upstream = resolve(process.env.ALKANES_RS);
const work = join(root, "build/rust-comparison");
const out = join(root, "bench/dist");
const read = (path) => readFileSync(path, "utf8");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const command = (name, args, cwd = root) => execFileSync(name, args, { cwd, encoding: "utf8" }).trim();
const toolchain = /channel\s*=\s*"([^"]+)"/.exec(read(join(upstream, "rust-toolchain.toml")))?.[1];
if (!toolchain) throw new Error("upstream Rust toolchain is not pinned");
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
for (const name of ["counter", "token"]) {
  const crate = join(work, name);
  mkdirSync(join(crate, "src"), { recursive: true });
  let source = read(join(root, "bench/rust", name, "src/lib.rs"));
  if (name === "counter") {
    const needle = "    fn sum(&self, n: u128) -> Result<CallResponse> {\n        self.reject_assets()?;\n";
    if (source.split(needle).length !== 2) throw new Error("Rust sum fixture changed");
    source = source.replace(needle, needle + read(join(root, "bench/rust/numeric-fast-path.rs")));
  }
  writeFileSync(join(crate, "src/lib.rs"), source);
  const dependencies = ["alkanes-support", "alkanes-runtime", "metashrew-support"]
    .map((dep) => `${dep} = { path = ${JSON.stringify(join(upstream, "crates", dep))} }`).join("\n");
  writeFileSync(join(crate, "Cargo.toml"), `[package]
name = "alkanes-bench-${name}"
version = "0.0.0"
edition = "2021"
[lib]
crate-type = ["cdylib"]
[features]
numeric-fast-path = []
[dependencies]
${dependencies}
anyhow = "1.0.90"
`);
}
writeFileSync(join(work, "Cargo.toml"), `[workspace]
members = ["counter", "token"]
resolver = "2"
[profile.release]
lto = "fat"
codegen-units = 1
opt-level = 3
panic = "abort"
`);
// Cargo retains the upstream versions while adapting the workspace membership.
copyFileSync(join(upstream, "Cargo.lock"), join(work, "Cargo.lock"));
const metadata = [
  `alkanes-rs revision: ${command("git", ["rev-parse", "HEAD"], upstream)}`,
  `alkanes-rs tracked changes: ${command("git", ["status", "--porcelain", "--untracked-files=no"], upstream) ? "yes" : "no"}`,
  `upstream Cargo.lock SHA-256: ${sha256(join(upstream, "Cargo.lock"))}`,
  `Rust: ${command("rustc", [`+${toolchain}`, "--version"])}`,
  "profile: opt-level=3, lto=fat, codegen-units=1, panic=abort",
  `wasm-opt: ${command(join(root,'node_modules/.bin/wasm-opt'),['--version'])}`,
];
for (const numeric of [false, true]) {
  execFileSync("cargo", [`+${toolchain}`, "build", "--release", "--target", "wasm32-unknown-unknown",
    "--manifest-path", join(work, "Cargo.toml"), ...(numeric ? ["--features", "numeric-fast-path"] : [])],
  { cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(work, "target") } });
  const directory = numeric ? join(out, "numeric-fast-path") : out;
  mkdirSync(directory, { recursive: true });
  for (const name of ["counter", "token"]) {
    const file = join(directory, `rust-${name}.wasm`);
    copyFileSync(join(work, "target/wasm32-unknown-unknown/release", `alkanes_bench_${name}.wasm`), file);
    metadata.push(`${numeric ? "numeric-fast-path/" : ""}rust-${name}.wasm SHA-256: ${sha256(file)}`);
    const optimized=join(directory,`rust-${name}-opt.wasm`);
    execFileSync(join(root,'node_modules/.bin/wasm-opt'),['--mvp-features','--enable-bulk-memory','--enable-sign-ext','--enable-nontrapping-float-to-int','--enable-mutable-globals','-O3',file,'-o',optimized],{stdio:'inherit'});
    metadata.push(`${numeric ? "numeric-fast-path/" : ""}rust-${name}-opt.wasm SHA-256: ${sha256(optimized)}`);
  }
}
metadata.push(`comparison Cargo.lock SHA-256: ${sha256(join(work, "Cargo.lock"))}`);
writeFileSync(join(out, "BUILD.txt"), metadata.join("\n") + "\n");
process.stdout.write(metadata.join("\n") + "\n");
