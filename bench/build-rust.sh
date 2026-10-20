#!/usr/bin/env bash
# Builds the Rust twins in bench/rust/ the way alkanes-rs builds its std
# contracts: as workspace members, with the workspace's pinned toolchain,
# Cargo.lock and release profile, for wasm32-unknown-unknown.
#
#   ALKANES_RS=/path/to/alkanes-rs bench/build-rust.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${ALKANES_RS:?set ALKANES_RS to an alkanes-rs checkout}"
out="$here/dist"
mkdir -p "$out"

for name in counter token; do
  crate="$ALKANES_RS/crates/alkanes-bench-$name"
  rm -rf "$crate"
  cp -r "$here/rust/$name" "$crate"
  if ! grep -q "\"crates/alkanes-bench-$name\"" "$ALKANES_RS/Cargo.toml"; then
    sed -i "0,/^members = \[/s//members = [\n    \"crates\/alkanes-bench-$name\",/" "$ALKANES_RS/Cargo.toml"
  fi
done

(cd "$ALKANES_RS" && cargo build --release --target wasm32-unknown-unknown \
  -p alkanes-bench-counter -p alkanes-bench-token)

for name in counter token; do
  cp "$ALKANES_RS/target/wasm32-unknown-unknown/release/alkanes_bench_$name.wasm" "$out/rust-$name.wasm"
  echo "bench/dist/rust-$name.wasm $(wc -c < "$out/rust-$name.wasm") bytes"
done
