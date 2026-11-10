import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { compileContract } from "./index.mjs";
for (const name of readdirSync("contracts")) {
  const compiled = compileContract({ filename: resolve("contracts", name, "index.ts") });
  for (const warning of compiled?.warnings ?? []) console.warn(warning);
}
