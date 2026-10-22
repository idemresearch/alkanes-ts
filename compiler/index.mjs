// Restricted Alkanes authoring frontend. The emitted TypeScript is the only
// input to scriptc and to semantic tests; decorators never execute at runtime.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lowerWords } from "./word.mjs";
import { lowerSDK, lowerFluent } from "./word-sdk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSDK = resolve(root, "sdk");
const MAX = (1n << 128n) - 1n;
const printer = ts.createPrinter();
const modifiers = (node) => (node.modifiers ?? []).filter((m) => !ts.isDecorator(m));
const decorators = (node) => ts.getDecorators(node) ?? [];
const nameOf = (node) => ts.isIdentifier(node) ? node.text : undefined;

export function compileContract({ filename, source = readFileSync(filename, "utf8"), sdkDirectory = defaultSDK, wordLowering = false }) {
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
    return wordLowering ? lowerFluent({filename,source,sdkDirectory}) : null;
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
        // assert is a runtime primitive; the other bindings are compiler
        // markers or types and disappear from generated code.
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.elements.some((b) => b.name.text === "assert")) {
          imports.push({ statement: ts.factory.updateImportDeclaration(statement, statement.modifiers,
            ts.factory.updateImportClause(statement.importClause, false, undefined,
              ts.factory.createNamedImports([ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier("assert"))])),
            statement.moduleSpecifier, statement.attributes), path });
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
    if (!memberName || memberName.startsWith("__alk") || ["context", "assets", "auth"].includes(memberName)) fail(member, "unsupported or reserved member name");
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
        const type = member.type?.getText(parsed);
        if (!["u128", "AlkaneId"].includes(type)) fail(member, "state fields require u128 or AlkaneId");
        if (type === "u128" && (!member.initializer || !ts.isBigIntLiteral(member.initializer))) fail(member, "u128 state fields require a bigint literal default");
        if (type === "AlkaneId" && (member.initializer || !member.exclamationToken)) fail(member, "AlkaneId state must be a required field (field!: AlkaneId), assigned by @init");
        if (member.questionToken || (type === "u128" && member.exclamationToken) || modifiers(member).some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)) fail(member, "state must be a mutable field");
        const { key } = literalOptions(ds[0], ["key"]);
        if (!key || !ts.isStringLiteral(key) || !key.text.length) fail(member, "state requires an explicit nonempty literal key");
        if (keys.has(key.text)) fail(member, `duplicate storage key ${key.text}`);
        if (key.text.startsWith("/__alkanes/")) fail(member, "storage key is reserved for compiler lifecycle state");
        keys.add(key.text);
        fields.set(memberName, { member, key: key.text, type, default: type === "u128" ? uintLiteral(member.initializer) : null });
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
        if (ds.length !== 1 || !["method", "view", "init"].includes(kind)) fail(member, "expected @method, @view or @init");
        const { opcode, abiName, incomingAssets: assetPolicy } = literalOptions(decorator, ["opcode", "abiName", "incomingAssets"]);
        info.opcode = uintLiteral(opcode).toString();
        info.view = kind === "view";
        info.init = kind === "init";
        if (assetPolicy && (!ts.isStringLiteral(assetPolicy) || !["reject", "forward"].includes(assetPolicy.text))) fail(assetPolicy, 'incomingAssets must be "reject" or "forward"');
        if (info.view && assetPolicy?.text === "forward") fail(assetPolicy, "views reject incoming assets");
        info.incomingAssets = assetPolicy?.text;
        if (abiName && !ts.isStringLiteral(abiName)) fail(abiName, "abiName must be a string literal");
        info.abiName = abiName?.text ?? memberName;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(info.abiName)) fail(member, "invalid ABI name");
        if (opcodes.has(info.opcode)) fail(member, `duplicate opcode ${info.opcode}`);
        if (abiNames.has(info.abiName)) fail(member, `duplicate ABI name ${info.abiName}`);
        opcodes.add(info.opcode); abiNames.add(info.abiName);
        let slot = 1;
        info.params = member.parameters.map((p) => {
          const type = p.type?.getText(parsed);
          if (!ts.isIdentifier(p.name) || !["u128", "AlkaneId"].includes(type) || p.initializer || p.questionToken || p.dotDotDotToken) fail(p, "ABI parameters must be required u128 or AlkaneId values");
          const param = {name:p.name.text, type, slot};
          slot += type === "AlkaneId" ? 2 : 1;
          return param;
        });
        info.slots = slot;
        const returns = member.type?.getText(parsed);
        if (!["u128", "AlkaneId", "void", "CallResponse"].includes(returns)) fail(member, "ABI returns must be u128, AlkaneId, void or CallResponse");
        if (info.init && returns !== "void") fail(member, "@init must return void");
        info.returns = returns;
        exposed.push(info);
      }
    } else fail(member, "constructors, accessors and index signatures are not supported in v1");
  }
  if (!exposed.length) fail(contract, "contract needs an exposed method");
  const initializers = exposed.filter((m) => m.init);
  if (initializers.length > 1) fail(initializers[1].member, "only one @init is allowed");
  const initializer = initializers[0];
  const required = [...fields].filter(([, f]) => f.type === "AlkaneId").map(([name]) => name);
  if (required.length && !initializer) fail(contract, "required AlkaneId state needs @init");
  for (const m of exposed) m.incomingAssets ??= incomingAssets;
  if (initializer && required.length) {
    // Definite assignment on normal init exits. Loops/try/switch and helper
    // writes are deliberately not guessed at; direct assignments and if/else
    // cover the initial language subset, with runtime validation as a backstop.
    const checkExit = (set, node) => {
      const missing = required.filter((name) => !set.has(name));
      if (missing.length) fail(node, `@init must assign required state on every successful path: ${missing.join(", ")}`);
    };
    const flow = (statements, initial) => {
      let set = new Set(initial);
      for (const statement of statements) {
        if (ts.isThrowStatement(statement)) return null;
        if (ts.isReturnStatement(statement)) { checkExit(set, statement); return null; }
        if (ts.isIfStatement(statement)) {
          const branch = (s) => flow(ts.isBlock(s) ? s.statements : [s], set);
          const a = branch(statement.thenStatement), b = statement.elseStatement ? branch(statement.elseStatement) : new Set(set);
          if (a === null && b === null) return null;
          set = a === null ? b : b === null ? a : new Set([...a].filter((name) => b.has(name)));
        } else if (ts.isBlock(statement)) {
          set = flow(statement.statements, set);
          if (set === null) return null;
        } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
          const expression = statement.expression;
          if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(expression.left) &&
              expression.left.expression.kind === ts.SyntaxKind.ThisKeyword && required.includes(expression.left.name.text)) set.add(expression.left.name.text);
        } else if (!(ts.isExpressionStatement(statement) || ts.isVariableStatement(statement) || ts.isEmptyStatement(statement))) {
          fail(statement, "required-state @init supports straight-line statements and if/else; unsupported control flow cannot prove initialization");
        }
      }
      return set;
    };
    const end = flow(initializer.member.body.statements, new Set());
    if (end !== null) checkExit(end, initializer.member);
  }
  let usesAssets = false;
  let usesAuth = false;
  const rawCalls = [];

  // Effect summaries are computed over the whole local call graph, including
  // private helpers. Unknown calls fail closed when reachable from a view.
  const pureSDK = new Set(["height", "log", "balance", "sequence", "fuel", "transaction", "block", "load", "staticcall", "readU128s",
    "u128ToBytes", "bytesToU128", "utf8", "fromUtf8", "toHex", "bytesEqual", "concat", "checkedAdd", "checkedSub",
    "get", "getU128", "getString", "isEmpty", "select", "keyword", "serialize", "equals", "toString", "withData", "withU128", "withString",
    "assert", "available", "checked", "add", "sub", "mul", "div", "mod", "bitAnd", "bitOr", "bitXor", "shl", "shr", "bitNot", "wrappingAdd", "wrappingSub", "mulDiv"]);
  const symbolOf = (node) => {
    const sym = checker.getSymbolAtLocation(node);
    return sym && (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
  };
  const assignment = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const stateAccess = (node) => ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && fields.get(node.name.text)?.key !== undefined;
  for (const info of methods.values()) {
    const scan = (node) => {
      if (ts.isElementAccessExpression(node)) {
        const symbol=checker.getTypeAtLocation(node.expression).getSymbol();
        if (symbol?.declarations?.some((d)=>ts.isClassDeclaration(d)&&resolve(dirname(d.getSourceFile().fileName))===resolve(sdkDirectory))) {
          fail(node,"SDK objects require declared property access; computed access can bypass capability privacy");
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        if (node.name.text === "assets") usesAssets = true;
        if (node.name.text === "auth") { usesAssets = true; usesAuth = true; }
      }
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
          if (methods.get(node.expression.name.text).init) fail(node, "@init can only be invoked through its guarded entrypoint");
          info.edges.add(node.expression.name.text);
        } else {
          const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          const sym = symbolOf(target);
          const declarations = sym?.declarations ?? [];
          const sdkCall = declarations.some((d) => resolve(dirname(d.getSourceFile().fileName)) === resolve(sdkDirectory));
          if (sdkCall && ["call", "delegatecall", "staticcall", "load", "store", "resetStorage"].includes(sym.name) &&
              declarations.some((d) => d.getSourceFile().fileName.endsWith("/runtime.ts"))) rawCalls.push(node);
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
        if (initializer && sym?.name === "StoragePointer") fail(node, "@init contracts use typed state; raw storage can alias reserved lifecycle keys");
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
  if (initializer) for (const info of fields.values()) if (!info.key && ts.isNewExpression(info.member.initializer)) fail(info.member, "@init contracts use typed state, not raw StoragePointer fields");
  if ((usesAssets || initializer) && rawCalls.length) fail(rawCalls[0], "initialized/tracked contracts must use typed state and this.assets.call; raw runtime calls bypass accounting");
  if (usesAssets) for (const m of exposed) if (m.returns === "CallResponse") fail(m.member, "tracked assets require primitive/void returns; the compiler constructs the asset response");

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
        if (ts.isTypeReferenceNode(n) && n.typeName.getText(parsed) === "AlkaneId") return f.createTypeReferenceNode("__alk_AlkaneId", undefined);
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
    else if (info.type === "AlkaneId") members.push(`private get ${field}(): __alk_AlkaneId {
    const bytes = __alk_state_${field}.get();
    if (bytes.length !== 32) throw new Error(${JSON.stringify("uninitialized or invalid AlkaneId state: " + info.key)});
    return new __alk_AlkaneId(__alk_bytesToU128(bytes), __alk_bytesToU128(bytes, 16));
  }
  private set ${field}(value: __alk_AlkaneId) { __alk_state_${field}.set(value.serialize()); }`);
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
      JSON.stringify({ type: p.type, name: p.name })).join(", ") + '], "returns": ' + JSON.stringify(m.returns === "CallResponse" ? "bytes" : m.returns) + ' }').join(", ") + '] }';
  const states = [...fields].filter(([, f]) => f.key !== undefined).map(([field, f]) => ({ field, key: f.key, type: f.type, default: f.default === null ? null : f.default.toString() }));
  const manifest = { format: 2, contract: name, incomingAssets, initialized: !!initializer, trackedAssets: usesAssets, state: states, methods: exposed.map((m) => ({
    name: m.name, abiName: m.abiName, opcode: m.opcode, view: m.view, init: m.init, incomingAssets: m.incomingAssets, params: m.params.map(({name, type}) => ({ name, type })), returns: m.returns,
  })) };
  // Output uses absolute SDK imports so benchmark copies can select their own
  // SDK implementation without changing compiler semantics.
  const importSDK = (file) => JSON.stringify(resolve(sdkDirectory, file));
  const lowered = `// Generated by the Alkanes frontend. Do not edit.\n${imports.map(({ statement, path }) =>
    printer.printNode(ts.EmitHint.Unspecified, f.updateImportDeclaration(statement, statement.modifiers, statement.importClause, f.createStringLiteral(path), statement.attributes), parsed)).join("\n")}
import * as __alk_math from ${importSDK("u128.ts")};
import { StoragePointer as __alk_StoragePointer } from ${importSDK("runtime.ts")};
import { bytesToU128 as __alk_bytesToU128, utf8 as __alk_utf8 } from ${importSDK("bytes.ts")};
import { Context as __alk_Context, CallResponse as __alk_CallResponse, AlkaneId as __alk_AlkaneId } from ${importSDK("types.ts")};
import { setReadOnly as __alk_setReadOnly } from ${importSDK("effects.ts")};
import { executeDispatch as __alk_executeDispatch } from ${importSDK("contract.ts")};
${usesAssets ? `import { Assets as __alk_Assets${usesAuth ? ", Auth as __alk_Auth" : ""} } from ${importSDK("assets.ts")};` : ""}
${initializer ? `import { beginInvocation as __alk_begin, finishInvocation as __alk_finish } from ${importSDK("lifecycle.ts")};` : ""}
${states.map((s) => `const __alk_state_${s.field} = new __alk_StoragePointer(${JSON.stringify(s.key)});`).join("\n")}
class ${name} {
  ${usesAuth ? "public readonly auth: __alk_Auth;" : ""}
  constructor(public readonly context: __alk_Context${usesAssets ? ", public readonly assets: __alk_Assets" : ""}) {${usesAuth ? " this.auth = new __alk_Auth(assets);" : ""}}
  ${members.join("\n")}
}
function __alk_dispatch(context: __alk_Context): __alk_CallResponse {
  if (context.inputs.length === 0) throw new Error("No opcode provided");
  const opcode = context.inputs[0];
  ${usesAssets ? "const assets = new __alk_Assets(context);" : ""}
  const contract = new ${name}(context${usesAssets ? ", assets" : ""});
  ${exposed.map((m) => `if (opcode === ${m.opcode}n) {
    if (context.inputs.length < ${m.slots}) throw new Error(${JSON.stringify(m.abiName + " expects " + (m.slots - 1) + " inputs")});
    ${m.incomingAssets === "reject" || m.view ? `if (context.incomingAlkanes.transfers.length !== 0) throw new Error(${JSON.stringify(m.view && m.incomingAssets === "forward" ? "view rejects incoming assets" : "contract rejects incoming assets")});` : ""}
    ${Array.from({length:m.slots-1}, (_, i) => `const __alk_arg${i} = context.inputs[${i + 1}]; if (__alk_arg${i} === undefined) throw new Error("missing input");`).join("\n")}
    ${initializer ? `__alk_begin(${m.init}, ${m.view});` : ""}
    __alk_setReadOnly(${m.view});
    try {
      ${m.returns === "void" ? "" : "const value = "}contract.${m.name}(${m.params.map((p) => p.type === "AlkaneId" ? `new __alk_AlkaneId(__alk_arg${p.slot-1}, __alk_arg${p.slot})` : `__alk_arg${p.slot-1}`).join(", ")});
      ${m.init ? required.map((field) => `if (__alk_state_${field}.get().length !== 32) throw new Error("required state missing");`).join("\n") : ""}
      ${initializer ? `__alk_finish(${m.init}, ${m.view});` : ""}
      ${m.returns === "CallResponse" ? `${m.view ? 'if (value.alkanes.transfers.length !== 0) throw new Error("view cannot transfer assets");' : ""}return value;` :
        usesAssets ? `return assets.finish(${m.returns === "void" ? "new Uint8Array(0)" : m.returns === "u128" ? "new __alk_CallResponse().withU128(__alk_math.checked(value)).data" : "value.serialize()"});` :
        `return ${m.incomingAssets === "forward" && !m.view ? "__alk_CallResponse.forward(context.incomingAlkanes)" : "new __alk_CallResponse()"}${m.returns === "u128" ? ".withU128(__alk_math.checked(value))" : m.returns === "AlkaneId" ? ".withData(value.serialize())" : ""};`}
    } finally { __alk_setReadOnly(false); }
  }`).join("\n")}
  throw new Error("Unrecognized opcode " + opcode.toString());
}
export function execute(context: Uint8Array): Uint8Array { return __alk_executeDispatch(__alk_dispatch, context); }
export function meta(): Uint8Array { return __alk_utf8(${JSON.stringify(abi)}); }
`;
  const word=wordLowering?lowerWords({filename,source,manifest,abi,sdkDirectory}):null;
  const sdk=wordLowering&&!word?lowerSDK({filename,source:lowered,manifest,abi,sdkDirectory}):null;
  manifest.lowering=word?'word-v1':sdk?'word-sdk-v1':'bigint';
  return { lowered:word??sdk??lowered, abi, manifest, word:word?true:sdk?'sdk':false };
}
