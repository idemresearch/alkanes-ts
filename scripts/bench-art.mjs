#!/usr/bin/env node
// Renders the README fuel chart from the saved canonical-indexer reports.
//
//   node scripts/bench-art.mjs
//
// Reads bench/CANONICAL_V3_EXAMPLES.md and bench/CANONICAL_V3_CAPPED_TOKEN.md
// and writes docs/assets/fuel.svg. Numbers are never typed in by hand: rerun
// this after refreshing either report.
//
// One file serves both themes: the colors are CSS classes with a
// prefers-color-scheme override, and the chart draws its own card background,
// so it stays legible wherever it is embedded. Plain markdown image syntax
// works in private repositories, where <picture> sources do not resolve.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

// Returns the rows of the first table after `heading` (or the first table in
// the file when `heading` is null), keyed by the first column.
function table(markdown, heading) {
  let text = markdown;
  if (heading) {
    const at = text.indexOf(`\n${heading}\n`);
    if (at < 0) throw new Error(`missing section ${heading}`);
    text = text.slice(at);
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("|"));
  if (start < 0) throw new Error(`no table after ${heading ?? "start"}`);
  const rows = [];
  for (let i = start; i < lines.length && lines[i].startsWith("|"); i++) {
    rows.push(lines[i].split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  const [header, , ...body] = rows;
  return { header, rows: new Map(body.map((row) => [row[0], row])) };
}

function fuel(t, scenario, column) {
  const row = t.rows.get(scenario);
  if (!row) throw new Error(`missing scenario ${scenario}`);
  const index = t.header.indexOf(column);
  if (index < 0) throw new Error(`missing column ${column}`);
  const value = Number(row[index]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`bad fuel for ${scenario}`);
  return value;
}

const examples = read("bench/CANONICAL_V3_EXAMPLES.md");
const capped = read("bench/CANONICAL_V3_CAPPED_TOKEN.md");
const counter = table(examples, "## Counter");
const token = table(examples, "## Token");
const cap = table(capped, null);

const EX_TS = "typescript fuel";
const EX_RS = "rust-o3-lto-wasm-opt fuel";
const CAP_TS = "TS fuel";
const CAP_RS = "Rust + wasm-opt O3 fuel";

const data = [
  ["Counter", "read", fuel(counter, "read", EX_TS), fuel(counter, "read", EX_RS)],
  ["Counter", "increment", fuel(counter, "increment", EX_TS), fuel(counter, "increment", EX_RS)],
  ["Token", "mint", fuel(token, "mint", EX_TS), fuel(token, "mint", EX_RS)],
  ["Token", "cross-contract call", fuel(token, "forward-call", EX_TS), fuel(token, "forward-call", EX_RS)],
  ["CappedToken", "supply view", fuel(cap, "supply", CAP_TS), fuel(cap, "supply", CAP_RS)],
  ["CappedToken", "mint with auth", fuel(cap, "mint+auth", CAP_TS), fuel(cap, "mint+auth", CAP_RS)],
].map(([contract, call, ts, rust]) => ({ contract, call, ts, rust }));

// Validated categorical slots 1 and 2 (blue, orange) for each surface.
const themes = {
  light: {
    surface: "#fcfcfb",
    border: "#e4e3df",
    primary: "#0b0b0b",
    secondary: "#52514e",
    muted: "#8a8984",
    ts: "#2a78d6",
    rust: "#eb6834",
  },
  dark: {
    surface: "#1a1a19",
    border: "#2e2e2c",
    primary: "#f0efec",
    secondary: "#c3c2b7",
    muted: "#8f8e86",
    ts: "#3987e5",
    rust: "#d95926",
  },
};

const rules = (c) =>
  `.card{fill:${c.surface};stroke:${c.border}}.rule{stroke:${c.border}}` +
  `.primary{fill:${c.primary}}.secondary{fill:${c.secondary}}.muted{fill:${c.muted}}` +
  `.ts{fill:${c.ts}}.rust{fill:${c.rust}}`;
const css = `${rules(themes.light)}@media (prefers-color-scheme: dark){${rules(themes.dark)}}`;

const W = 880;
const PAD = 40;
const LABEL_W = 210;
const RATIO_W = 104;
const VALUE_W = 70;
const BAR_X = PAD + LABEL_W;
const BAR_W = W - PAD - RATIO_W - VALUE_W - BAR_X;
const BAR_H = 12;
const GAP = 2;
const ROW_H = 2 * BAR_H + GAP + 30;
const TOP = 132;
const H = TOP + data.length * ROW_H + 58;

const n = (value) => value.toLocaleString("en-US");
const ratio = (row) => (row.rust / row.ts).toFixed(1);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// A horizontal bar whose data end (right) has 4px rounded corners and whose
// baseline end (left) stays square.
function bar(x, y, w, h, cls) {
  const r = Math.min(4, w / 2, h / 2);
  return `<path d="M${x},${y} h${(w - r).toFixed(2)} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${(w - r).toFixed(2)} z" class="${cls}"/>`;
}

function render() {
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">`,
    `<title id="title">Fuel per call: alkanes-ts against optimized Rust</title>`,
    `<style>${css}</style>`,
    `<desc id="desc">${data.map((d) => `${d.contract} ${d.call}: TypeScript ${n(d.ts)} fuel, Rust ${n(d.rust)} fuel, ${ratio(d)} times less`).join("; ")}.</desc>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" class="card"/>`,
    `<text x="${PAD}" y="52" font-family="${SANS}" font-size="22" font-weight="600" class="primary">Fuel per call on the canonical Alkanes indexer</text>`,
    `<text x="${PAD}" y="78" font-family="${SANS}" font-size="14" class="secondary">alkanes-rs v3.0.0-rc.4 · wasmi 0.37.2 · host and storage charges included · lower is better</text>`,
  );
  // Legend.
  const ly = 108;
  out.push(
    bar(PAD, ly - 9, 14, 10, "ts"),
    `<text x="${PAD + 22}" y="${ly}" font-family="${SANS}" font-size="13" class="secondary">TypeScript (scriptc 0.4.7)</text>`,
    bar(PAD + 210, ly - 9, 14, 10, "rust"),
    `<text x="${PAD + 232}" y="${ly}" font-family="${SANS}" font-size="13" class="secondary">Rust O3, fat LTO, wasm-opt O3</text>`,
    `<text x="${W - PAD}" y="${ly}" text-anchor="end" font-family="${SANS}" font-size="13" class="muted">less fuel</text>`,
  );

  data.forEach((d, i) => {
    const y = TOP + i * ROW_H;
    const rustW = BAR_W;
    const tsW = (d.ts / d.rust) * BAR_W;
    const mid = y + BAR_H + GAP / 2;
    out.push(
      `<text x="${PAD}" y="${mid - 3}" font-family="${SANS}" font-size="14" font-weight="600" class="primary">${esc(d.contract)}</text>`,
      `<text x="${PAD}" y="${mid + 15}" font-family="${SANS}" font-size="13" class="secondary">${esc(d.call)}</text>`,
      bar(BAR_X, y, tsW, BAR_H, "ts"),
      `<text x="${BAR_X + tsW + 8}" y="${y + BAR_H - 1}" font-family="${MONO}" font-size="12" class="secondary">${n(d.ts)}</text>`,
      bar(BAR_X, y + BAR_H + GAP, rustW, BAR_H, "rust"),
      `<text x="${BAR_X + rustW + 8}" y="${y + 2 * BAR_H + GAP - 1}" font-family="${MONO}" font-size="12" class="secondary">${n(d.rust)}</text>`,
      `<text x="${W - PAD}" y="${mid + 8}" text-anchor="end" font-family="${MONO}" font-size="22" font-weight="700" class="primary">${ratio(d)}×</text>`,
    );
  });

  const fy = TOP + data.length * ROW_H + 18;
  out.push(
    `<line x1="${PAD}" y1="${fy - 12}" x2="${W - PAD}" y2="${fy - 12}" class="rule"/>`,
    `<text x="${PAD}" y="${fy + 12}" font-family="${SANS}" font-size="12" class="muted">Bars are scaled to each call's Rust fuel. Same indexer, auth binary, and response checks for both. Data: bench/CANONICAL_V3_*.md</text>`,
    `</svg>`,
  );
  return out.join("\n") + "\n";
}

const outDir = join(root, "docs", "assets");
mkdirSync(outDir, { recursive: true });
const path = join(outDir, "fuel.svg");
writeFileSync(path, render());
console.log(`wrote ${path.slice(root.length + 1)}`);
for (const d of data) {
  console.log(`${d.contract} ${d.call}: ${n(d.ts)} vs ${n(d.rust)} (${ratio(d)}x)`);
}
