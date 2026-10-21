// Restricted Alkanes authoring frontend. The emitted TypeScript is the only
// input to scriptc and to semantic tests; decorators never execute at runtime.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSDK = resolve(root, "sdk");
const MAX = (1n << 128n) - 1n;
const printer = ts.createPrinter();
const modifiers = (node) => (node.modifiers ?? []).filter((m) => !ts.isDecorator(m));
const decorators = (node) => ts.getDecorators(node) ?? [];
const nameOf = (node) => ts.isIdentifier(node) ? node.text : undefined;

export function compileContract({ filename, source = readFileSync(filename, "utf8"), sdkDirectory = defaultSDK }) {
  filename = resolve(filename);
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const contract = parsed.statements.find((s) => ts.isClassDeclaration(s) &&
    s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  const fail = (node, message) => {
    const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    throw new Error(`${filename}:${line + 1}:${character + 1}: ALK1001 ${message}`);
  };
  if (!contract) {
    const marker = parsed.statements.find((s) => ts.isImportDeclaration(s) &&
      resolve(dirname(filename), s.moduleSpecifier.text) === resolve(sdkDirectory, "authoring.ts"));
    if (marker) fail(marker, "authoring contracts require a named default-exported class");
    return null; // Fluent SDK contracts remain supported.
  }
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true,
    allowImportingTsExtensions: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...rest) => resolve(path) === filename ? parsed : getSourceFile(path, ...rest);
  const program = ts.createProgram([filename], options, host);
  const checker = program.getTypeChecker();
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => "\n",
  }));
  const bigType = (type) => {
    if (type.flags & ts.TypeFlags.BigIntLike) return true;
    if (type.isIntersection()) return type.types.some(bigType);
    if (type.isUnion()) return type.types.every(bigType);
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? bigType(constraint) : false;
    }
    return false;
  };
  const isBig = (node) => bigType(checker.getTypeAtLocation(node));
  const imports = [];
  let markerImport = false;
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const path = resolve(dirname(filename), statement.moduleSpecifier.text);
      if (path === resolve(sdkDirectory, "authoring.ts")) {
        markerImport = true;
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const binding of statement.importClause.namedBindings.elements) {
            if (binding.propertyName) fail(binding, "authoring imports cannot be aliased in v1");
          }
        }
        continue;
      }
      if (!["index.ts", "u128.ts", "types.ts", "bytes.ts", "runtime.ts"].some((f) => path === resolve(sdkDirectory, f))) {
        fail(statement, "v1 contract imports must come from the Alkanes SDK; user modules need compilation support first");
      }
      imports.push({ statement, path });
    } else if (statement !== contract) {
      fail(statement, "v1 accepts imports and one default-exported contract class; put helpers on the class");
    }
  }
  const heritage = contract.heritageClauses?.[0];
  const base = heritage?.types[0];
  let baseSymbol = base && checker.getSymbolAtLocation(base.expression);
  if (baseSymbol?.flags & ts.SymbolFlags.Alias) baseSymbol = checker.getAliasedSymbol(baseSymbol);
  if (!markerImport || contract.heritageClauses?.length !== 1 || heritage.token !== ts.SyntaxKind.ExtendsKeyword ||
      heritage.types.length !== 1 || base.typeArguments || !baseSymbol?.declarations?.some((d) =>
        resolve(d.getSourceFile().fileName) === resolve(sdkDirectory, "authoring.ts") && ts.isClassDeclaration(d) && d.name?.text === "Contract")) {
    fail(contract, "expected class extending Contract from sdk/authoring.ts");
  }
  if (!contract.name || decorators(contract).length || contract.typeParameters) fail(contract, "expected a named, non-generic contract class");
  const name = contract.name.text;
  if (name.startsWith("__alk")) fail(contract.name, "reserved compiler identifier");
  const fields = new Map();
  const methods = new Map();
  const exposed = [];
  let incomingAssets = "reject";
  const literalOptions = (decorator, allowed) => {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) {
      fail(decorator, "decorator options must be an object literal");
    }
    const result = {};
    for (const prop of call.arguments[0].properties) {
      const key = prop.name && nameOf(prop.name);
      if (!ts.isPropertyAssignment(prop) || !allowed.includes(key) || key in result) fail(prop, "unsupported or duplicate decorator option");
      result[key] = prop.initializer;
    }
    return result;
  };
  const uintLiteral = (node) => {
    if (!node || !(ts.isBigIntLiteral(node) || ts.isNumericLiteral(node))) fail(node ?? contract, "expected a literal u128 opcode/default");
    if (ts.isNumericLiteral(node) && !Number.isSafeInteger(Number(node.text))) fail(node, "use a bigint literal for large opcodes");
    const value = BigInt(node.text.replaceAll("_", "").replace(/n$/, ""));
    if (value < 0n || value > MAX) fail(node, "u128 literal out of range");
    return value;
  };
  const isU128 = (node) => node?.getText(parsed) === "u128";
  const keys = new Set();
  const opcodes = new Set();
  const abiNames = new Set();
  for (const member of contract.members) {
    const memberName = member.name && nameOf(member.name);
    if (!memberName || memberName.startsWith("__alk") || memberName === "context") fail(member, "unsupported or reserved member name");
    if (methods.has(memberName) || fields.has(memberName)) fail(member, "duplicate contract member");
    if (ts.isPropertyDeclaration(member)) {
      if (modifiers(member).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
        if (memberName !== "incomingAssets" || decorators(member).length || !member.initializer ||
            !ts.isStringLiteral(member.initializer) || !["reject", "forward"].includes(member.initializer.text)) {
          fail(member, 'the only static field is incomingAssets = "reject" or "forward"');
        }
        incomingAssets = member.initializer.text;
        continue;
      }
      if (decorators(member).length) {
        const ds = decorators(member);
        if (ds.length !== 1 || !ts.isCallExpression(ds[0].expression) || ds[0].expression.expression.getText(parsed) !== "state") fail(member, "expected @state");
        if (!isU128(member.type) || !member.initializer || !ts.isBigIntLiteral(member.initializer)) fail(member, "v1 state fields require u128 and a bigint literal default");
        if (member.questionToken || member.exclamationToken || modifiers(member).some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)) fail(member, "state must be a mutable, initialized field");
        const { key } = literalOptions(ds[0], ["key"]);
        if (!key || !ts.isStringLiteral(key) || !key.text.length) fail(member, "state requires an explicit nonempty literal key");
        if (keys.has(key.text)) fail(member, `duplicate storage key ${key.text}`);
        keys.add(key.text);
        fields.set(memberName, { member, key: key.text, default: uintLiteral(member.initializer) });
      } else {
        if (!member.initializer) fail(member, "temporary fields require initializers");
        const init = member.initializer;
        if (!(ts.isLiteralExpression(init) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(init.kind) ||
            (ts.isNewExpression(init) && init.expression.getText(parsed) === "StoragePointer" && init.arguments?.length === 1 && ts.isStringLiteral(init.arguments[0])))) {
          fail(init, "temporary initializers must be literals or new StoragePointer with a literal key");
        }
        fields.set(memberName, { member });
      }
    } else if (ts.isMethodDeclaration(member)) {
      if (!member.body || member.typeParameters || member.asteriskToken || member.questionToken || modifiers(member).some((m) => [ts.SyntaxKind.StaticKeyword, ts.SyntaxKind.AsyncKeyword].includes(m.kind))) fail(member, "unsupported method declaration");
      const info = { member, name: memberName, edges: new Set(), effects: [] };
      methods.set(memberName, info);
      const ds = decorators(member);
      if (ds.length) {
        if (modifiers(member).some((m) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind))) fail(member, "exposed methods must be public");
        const decorator = ds[0];
        const kind = ts.isCallExpression(decorator.expression) && decorator.expression.expression.getText(parsed);
        if (ds.length !== 1 || !["method", "view"].includes(kind)) fail(member, "expected @method or @view");
        const { opcode, abiName } = literalOptions(decorator, ["opcode", "abiName"]);
        info.opcode = uintLiteral(opcode).toString();
        info.view = kind === "view";
        if (abiName && !ts.isStringLiteral(abiName)) fail(abiName, "abiName must be a string literal");
        info.abiName = abiName?.text ?? memberName;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(info.abiName)) fail(member, "invalid ABI name");
        if (opcodes.has(info.opcode)) fail(member, `duplicate opcode ${info.opcode}`);
        if (abiNames.has(info.abiName)) fail(member, `duplicate ABI name ${info.abiName}`);
        opcodes.add(info.opcode); abiNames.add(info.abiName);
        info.params = member.parameters.map((p) => {
          if (!ts.isIdentifier(p.name) || !isU128(p.type) || p.initializer || p.questionToken || p.dotDotDotToken) fail(p, "ABI parameters must be required u128 values");
          return p.name.text;
        });
        const returns = member.type?.getText(parsed);
        if (!["u128", "void", "CallResponse"].includes(returns)) fail(member, "ABI returns must be u128, void or CallResponse");
        info.returns = returns;
        exposed.push(info);
      }
    } else fail(member, "constructors, accessors and index signatures are not supported in v1");
  }
  if (!exposed.length) fail(contract, "contract needs an exposed method");

  // Effect summaries are computed over the whole local call graph, including
  // private helpers. Unknown calls fail closed when reachable from a view.
  const pureSDK = new Set(["height", "log", "balance", "sequence", "fuel", "transaction", "block", "load", "staticcall", "readU128s",
    "u128ToBytes", "bytesToU128", "utf8", "fromUtf8", "toHex", "bytesEqual", "concat", "checkedAdd", "checkedSub",
    "get", "getU128", "getString", "isEmpty", "select", "keyword", "serialize", "equals", "toString", "withData", "withU128", "withString",
    "checked", "add", "sub", "mul", "div", "mod", "bitAnd", "bitOr", "bitXor", "shl", "shr", "bitNot", "wrappingAdd", "wrappingSub", "mulDiv"]);
  const symbolOf = (node) => {
    const sym = checker.getSymbolAtLocation(node);
    return sym && (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
  };
  const assignment = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const stateAccess = (node) => ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && fields.get(node.name.text)?.key !== undefined;
  for (const info of methods.values()) {
    const scan = (node) => {
      if (ts.isIdentifier(node) && symbolOf(node) === checker.getSymbolAtLocation(contract.name)) fail(node, "the contract class cannot be used as a runtime value in v1");
      if (node.kind === ts.SyntaxKind.ThisKeyword && !ts.isPropertyAccessExpression(node.parent)) fail(node, "this cannot escape or use dynamic property access");
      if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && methods.has(node.name.text) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)) fail(node, "contract methods must be called directly");
      const written = assignment(node) ? node.left :
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : null;
      if (written) {
        if (stateAccess(written)) info.effects.push([node, "persistent write"]);
        else if (!ts.isIdentifier(written) && !(ts.isPropertyAccessExpression(written) && written.expression.kind === ts.SyntaxKind.ThisKeyword)) {
          // SDK reads can return byte buffers that alias a buffered storage
          // entry. Do not infer that an arbitrary object/array write is local.
          info.effects.push([node, "write through an object/array alias"]);
        }
      }
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && methods.has(node.expression.name.text)) {
          info.edges.add(node.expression.name.text);
        } else {
          const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          const sym = symbolOf(target);
          const declarations = sym?.declarations ?? [];
          const sdkCall = declarations.some((d) => resolve(dirname(d.getSourceFile().fileName)) === resolve(sdkDirectory));
          const trusted = sdkCall && pureSDK.has(sym.name);
          const builtin = declarations.some((d) => /typescript\/lib\/lib\..*\.d\.ts$/.test(d.getSourceFile().fileName)) &&
            ["BigInt", "Number", "toString"].includes(sym.name);
          if (!sdkCall && !builtin) fail(node, "v1 calls must target a contract helper or a supported SDK/builtin function");
          if (!trusted && !builtin) info.effects.push([node, `unverified or mutating call ${node.expression.getText(parsed)}`]);
        }
      }
      if (ts.isNewExpression(node)) {
        const sym = symbolOf(node.expression);
        if (!["StoragePointer", "Uint8Array", "Error", "CallResponse", "AlkaneId", "AlkaneTransferParcel", "Cellpack"].includes(sym?.name)) fail(node, "unsupported constructor");
      }
      ts.forEachChild(node, scan);
    };
    scan(info.member.body);
  }
  const checkView = (info, seen = new Set(), path = []) => {
    if (seen.has(info.name)) return;
    seen.add(info.name);
    if (info.effects.length) fail(info.effects[0][0], `@view ${path.concat(info.name).join(" -> ")}: ${info.effects[0][1]}`);
    for (const edge of info.edges) {
      const helper = methods.get(edge);
      if (helper.opcode !== undefined && !helper.view) fail(info.member, `@view cannot call @method ${edge}`);
      checkView(helper, seen, path.concat(info.name));
    }
  };
  for (const info of exposed) if (info.view) checkView(info);

  const operators = new Map([
    [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "sub"], [ts.SyntaxKind.AsteriskToken, "mul"],
    [ts.SyntaxKind.SlashToken, "div"], [ts.SyntaxKind.PercentToken, "mod"], [ts.SyntaxKind.AmpersandToken, "bitAnd"],
    [ts.SyntaxKind.BarToken, "bitOr"], [ts.SyntaxKind.CaretToken, "bitXor"], [ts.SyntaxKind.LessThanLessThanToken, "shl"], [ts.SyntaxKind.GreaterThanGreaterThanToken, "shr"],
  ]);
  const compound = new Map([
    [ts.SyntaxKind.PlusEqualsToken, "add"], [ts.SyntaxKind.MinusEqualsToken, "sub"], [ts.SyntaxKind.AsteriskEqualsToken, "mul"],
    [ts.SyntaxKind.SlashEqualsToken, "div"], [ts.SyntaxKind.PercentEqualsToken, "mod"], [ts.SyntaxKind.AmpersandEqualsToken, "bitAnd"],
    [ts.SyntaxKind.BarEqualsToken, "bitOr"], [ts.SyntaxKind.CaretEqualsToken, "bitXor"], [ts.SyntaxKind.LessThanLessThanEqualsToken, "shl"], [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, "shr"],
  ]);
  const f = ts.factory;
  const mathCall = (name, args) => f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier("__alk_math"), name), undefined, args);
  const checkValue = (node) => mathCall("checked", [node]);
  const simpleLHS = (node) => ts.isIdentifier(node) || (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword);
  const transform = (node) => {
    const result = ts.transform(node, [(context) => {
      const visit = (n) => {
        if (n.kind === ts.SyntaxKind.AnyKeyword || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isDeleteExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n)) fail(n, "unsafe casts, any, delete and asynchronous code are outside the v1 subset");
        if (n.kind === ts.SyntaxKind.SuperKeyword) fail(n, "super calls are outside the v1 subset");
        if (ts.isIdentifier(n) && n.text.startsWith("__alk")) fail(n, "reserved compiler identifier");
        if (ts.isBigIntLiteral(n)) { uintLiteral(n); return n; }
        if (ts.isTypeReferenceNode(n) && n.typeName.getText(parsed) === "u128") return f.createKeywordTypeNode(ts.SyntaxKind.BigIntKeyword);
        if (ts.isBinaryExpression(n) && (isBig(n.left) || isBig(n.right))) {
          const op = n.operatorToken.kind;
          if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.PlusEqualsToken].includes(op) && !isBig(n)) return ts.visitEachChild(n, visit, context);
          if (operators.has(op)) return mathCall(operators.get(op), [ts.visitNode(n.left, visit), ts.visitNode(n.right, visit)]);
          if (compound.has(op)) {
            if (!simpleLHS(n.left)) fail(n.left, "u128 compound assignments require a local variable or this.field");
            return f.createAssignment(ts.visitNode(n.left, visit), mathCall(compound.get(op), [ts.visitNode(n.left, visit), ts.visitNode(n.right, visit)]));
          }
          if (op === ts.SyntaxKind.AsteriskAsteriskToken || op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) fail(n, "u128 exponentiation is not supported in v1");
          if (op === ts.SyntaxKind.EqualsToken) return f.createAssignment(ts.visitNode(n.left, visit), checkValue(ts.visitNode(n.right, visit)));
        }
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && isBig(n.operand)) {
          const value = ts.visitNode(n.operand, visit);
          if (n.operator === ts.SyntaxKind.TildeToken) return mathCall("bitNot", [value]);
          if (n.operator === ts.SyntaxKind.MinusToken) return mathCall("sub", [f.createBigIntLiteral("0n"), value]);
          if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) {
            if (!simpleLHS(n.operand) || !(ts.isExpressionStatement(n.parent) || (ts.isForStatement(n.parent) && n.parent.incrementor === n))) fail(n, "u128 ++/-- is supported only as a standalone statement or for incrementor");
            return f.createAssignment(value, mathCall(n.operator === ts.SyntaxKind.PlusPlusToken ? "add" : "sub", [value, f.createBigIntLiteral("1n")]));
          }
        }
        if (ts.isCallExpression(n) && isBig(n)) return checkValue(ts.visitEachChild(n, visit, context));
        if (ts.isVariableDeclaration(n) && n.initializer && isBig(n.name)) {
          return f.updateVariableDeclaration(n, n.name, n.exclamationToken, n.type ? ts.visitNode(n.type, visit) : undefined, checkValue(ts.visitNode(n.initializer, visit)));
        }
        return ts.visitEachChild(n, visit, context);
      };
      return (n) => ts.visitNode(n, visit);
    }]);
    const output = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], parsed);
    result.dispose();
    return output;
  };
  const members = [];
  for (const [field, info] of fields) {
    if (info.key === undefined) members.push(transform(info.member));
    else members.push(`private get ${field}(): bigint {
    const bytes = __alk_state_${field}.get();
    if (bytes.length === 0) return ${info.default}n;
    if (bytes.length !== 16) throw new Error(${JSON.stringify("invalid u128 storage: " + info.key)});
    return __alk_bytesToU128(bytes);
  }
  private set ${field}(value: bigint) { __alk_state_${field}.setU128(__alk_math.checked(value)); }`);
  }
  for (const { member } of methods.values()) {
    members.push(transform(f.updateMethodDeclaration(member, modifiers(member), member.asteriskToken, member.name,
      member.questionToken, member.typeParameters, member.parameters, member.type, member.body)));
  }
  const abi = '{ "contract": ' + JSON.stringify(name) + ', "methods": [' + exposed.map((m) =>
    '{ "name": ' + JSON.stringify(m.abiName) + ', "opcode": ' + m.opcode + ', "params": [' + m.params.map((p) =>
      JSON.stringify({ type: "u128", name: p })).join(", ") + '], "returns": ' + JSON.stringify(m.returns === "CallResponse" ? "bytes" : m.returns) + ' }').join(", ") + '] }';
  const states = [...fields].filter(([, f]) => f.key !== undefined).map(([field, f]) => ({ field, key: f.key, type: "u128", default: f.default.toString() }));
  const manifest = { format: 1, contract: name, incomingAssets, state: states, methods: exposed.map((m) => ({
    name: m.name, abiName: m.abiName, opcode: m.opcode, view: m.view, params: m.params.map((name) => ({ name, type: "u128" })), returns: m.returns,
  })) };
  // Output uses absolute SDK imports so benchmark copies can select their own
  // SDK implementation without changing compiler semantics.
  const importSDK = (file) => JSON.stringify(resolve(sdkDirectory, file));
  const lowered = `// Generated by the Alkanes frontend. Do not edit.\n${imports.map(({ statement, path }) =>
    printer.printNode(ts.EmitHint.Unspecified, f.updateImportDeclaration(statement, statement.modifiers, statement.importClause, f.createStringLiteral(path), statement.attributes), parsed)).join("\n")}
import * as __alk_math from ${importSDK("u128.ts")};
import { StoragePointer as __alk_StoragePointer } from ${importSDK("runtime.ts")};
import { bytesToU128 as __alk_bytesToU128, utf8 as __alk_utf8 } from ${importSDK("bytes.ts")};
import { Context as __alk_Context, CallResponse as __alk_CallResponse } from ${importSDK("types.ts")};
import { setReadOnly as __alk_setReadOnly } from ${importSDK("effects.ts")};
import { executeDispatch as __alk_executeDispatch } from ${importSDK("contract.ts")};
${states.map((s) => `const __alk_state_${s.field} = new __alk_StoragePointer(${JSON.stringify(s.key)});`).join("\n")}
class ${name} {
  constructor(public readonly context: __alk_Context) {}
  ${members.join("\n")}
}
function __alk_dispatch(context: __alk_Context): __alk_CallResponse {
  if (context.inputs.length === 0) throw new Error("No opcode provided");
  ${incomingAssets === "reject" ? 'if (context.incomingAlkanes.transfers.length !== 0) throw new Error("contract rejects incoming assets");' : ""}
  const opcode = context.inputs[0];
  const contract = new ${name}(context);
  ${exposed.map((m) => `if (opcode === ${m.opcode}n) {
    if (context.inputs.length < ${m.params.length + 1}) throw new Error(${JSON.stringify(m.abiName + " expects " + m.params.length + " inputs")});
    ${m.params.map((_, i) => `const __alk_arg${i} = context.inputs[${i + 1}]; if (__alk_arg${i} === undefined) throw new Error("missing input");`).join("\n")}
    __alk_setReadOnly(${m.view});
    try {
      ${incomingAssets === "forward" && m.view ? 'if (context.incomingAlkanes.transfers.length !== 0) throw new Error("view rejects incoming assets");' : ""}
      ${m.returns === "void" ? "" : "const value = "}contract.${m.name}(${m.params.map((_, i) => `__alk_arg${i}`).join(", ")});
      ${m.returns === "CallResponse" ? `${m.view ? 'if (value.alkanes.transfers.length !== 0) throw new Error("view cannot transfer assets");' : ""}return value;` :
        `return ${incomingAssets === "forward" && !m.view ? "__alk_CallResponse.forward(context.incomingAlkanes)" : "new __alk_CallResponse()"}${m.returns === "u128" ? ".withU128(__alk_math.checked(value))" : ""};`}
    } finally { __alk_setReadOnly(false); }
  }`).join("\n")}
  throw new Error("Unrecognized opcode " + opcode.toString());
}
export function execute(context: Uint8Array): Uint8Array { return __alk_executeDispatch(__alk_dispatch, context); }
export function meta(): Uint8Array { return __alk_utf8(${JSON.stringify(abi)}); }
`;
  return { lowered, abi, manifest };
}
