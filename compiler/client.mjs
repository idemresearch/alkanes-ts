import { resolve } from "node:path";

export function generateClient(manifest, runtimePath) {
  const method = (m, mode) => {
    const parameters = m.params.length ? `args: { ${m.params.map((p) => `${p.name}: bigint`).join("; ")} }` : "";
    const inputs = `[${m.opcode}n${m.params.map((p) => `, args.${p.name}`).join("")}]`;
    const request = `prepare(this.target, ${inputs})`;
    const result = m.returns === "u128" ? "decodeU128(response)" : m.returns === "void" ? "undefined" : "response";
    return mode === "prepare"
      ? `[${JSON.stringify(m.name)}]: (${parameters}): PreparedCall => ${request}`
      : `[${JSON.stringify(m.name)}]: async (${parameters}) => { const response = await this.transport.simulate(${request}); return ${mode === "simulate" ? `{ ...response, value: ${result} }` : result}; }`;
  };
  return `// Generated from the same manifest as dispatch. Do not edit.\nimport { prepare, decodeU128, type AlkaneId, type PreparedCall, type Transport } from ${JSON.stringify(resolve(runtimePath))};
export class ${manifest.contract}Client {
  constructor(private readonly transport: Transport, private readonly target: AlkaneId) {}
  readonly read = { ${manifest.methods.filter((m) => m.view).map((m) => method(m, "read")).join(",\n")} };
  readonly simulate = { ${manifest.methods.map((m) => method(m, "simulate")).join(",\n")} };
  readonly prepare = { ${manifest.methods.filter((m) => !m.view).map((m) => method(m, "prepare")).join(",\n")} };
}
`;
}
