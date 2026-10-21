import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { compileContract } from "./index.mjs";
for (const name of readdirSync("contracts")) compileContract({ filename: resolve("contracts", name, "index.ts") });
