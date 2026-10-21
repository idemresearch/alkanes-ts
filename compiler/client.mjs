import { resolve } from "node:path";

export function generateClient(manifest, runtimePath) {
  const method = (m, mode) => {
    const parameters = m.params.length ? `args: { ${m.params.map((p) => `${p.name}: ${p.type === "AlkaneId" ? "AlkaneId" : "bigint"}`).join("; ")} }` : "";
    const inputs = `[${m.opcode}n${m.params.map((p) => p.type === "AlkaneId" ? `, args.${p.name}.block, args.${p.name}.tx` : `, args.${p.name}`).join("")}]`;
    const request = `prepare(this.target, ${inputs})`;
    const result = m.returns === "u128" ? "decodeU128(response)" : m.returns === "AlkaneId" ? "decodeAlkaneId(response)" : m.returns === "void" ? "undefined" : "response";
    if (mode === "call") return `[${JSON.stringify(m.name)}]: (${parameters}) => new CallPlan(this.transport, ${request}, (response) => ${result}, ${m.incomingAssets === "forward"})`;
    if (mode === "deploy") return `static deploy(transport: Transport, wasm: Uint8Array${parameters ? ", " + parameters : ""}) {
    return new CallPlan(transport, { ...prepare({block:1n,tx:0n}, ${inputs}), wasm }, (response) => undefined, ${m.incomingAssets === "forward"});
  }`;
    return mode === "prepare"
      ? `[${JSON.stringify(m.name)}]: (${parameters}): PreparedCall => ${request}`
      : `[${JSON.stringify(m.name)}]: async (${parameters}) => { const response = await this.transport.simulate(${request}); return ${mode === "simulate" ? `{ ...response, value: ${result} }` : result}; }`;
  };
  return `// Generated from the same manifest as dispatch. Do not edit.\nimport { prepare, decodeU128, decodeAlkaneId, CallPlan, type AlkaneId, type PreparedCall, type Transport } from ${JSON.stringify(resolve(runtimePath))};
export class ${manifest.contract}Client {
  constructor(private readonly transport: Transport, private readonly target: AlkaneId) {}
  ${manifest.methods.filter((m) => m.init).map((m) => method(m,"deploy")).join("\n")}
  readonly read = { ${manifest.methods.filter((m) => m.view).map((m) => method(m, "read")).join(",\n")} };
  readonly call = { ${manifest.methods.filter((m) => !m.view).map((m) => method(m, "call")).join(",\n")} };
  readonly simulate = { ${manifest.methods.map((m) => method(m, "simulate")).join(",\n")} };
  readonly prepare = { ${manifest.methods.filter((m) => !m.view).map((m) => method(m, "prepare")).join(",\n")} };
}
`;
}
