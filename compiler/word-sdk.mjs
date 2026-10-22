// Word-backed SDK lowering for the checked frontend and a narrow fluent API.
// This is an AST/type-directed representation change, never a contract template.
import ts from 'typescript';
import {resolve,dirname} from 'node:path';
const printer=ts.createPrinter();
const exports=new Set(['StoragePointer','height','log','u128ToBytes','bytesToU128','bytesEqual','checkedAdd',
  'AlkaneId','AlkaneTransferParcel','CallResponse','Cellpack','Context','Inputs','setReadOnly','executeDispatch','utf8','call']);
const math=new Set(['checked','add','sub','mul']);
const methods=new Set(['get','getU128','set','setU128','isEmpty','select','serialize','equals','pay','forward','withData','withU128','withString','u128','id','slice']);
const comparison=new Map([['===',2],['!==',3],['<',4],['<=',5],['>',6],['>=',7]]);
export function lowerSDK({filename,source,abi,sdkDirectory}){
  const unsupported=Symbol('unsupported SDK subset'),no=()=>{if(process.env.ALKANES_DEBUG_LOWERING)console.error(new Error('SDK lowering fallback').stack);throw unsupported;};
  try{
    const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
    const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,allowImportingTsExtensions:true,skipLibCheck:true,types:[]};
    const host=ts.createCompilerHost(options),read=host.getSourceFile.bind(host);
    host.getSourceFile=(path,...rest)=>resolve(path)===resolve(filename)?file:read(path,...rest);
    const program=ts.createProgram([filename],options,host),checker=program.getTypeChecker();
    const diagnostics=ts.getPreEmitDiagnostics(program);
    if(diagnostics.length){if(process.env.ALKANES_DEBUG_LOWERING)console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>dirname(filename),getCanonicalFileName:p=>p,getNewLine:()=> '\n'}));no();}
    const f=ts.factory,localCalls=new Set(),aliases=new Map(),namespaces=new Set();
    const isBigType=t=>!!(t.flags&ts.TypeFlags.BigIntLike)||(t.isIntersection()&&t.types.some(isBigType));
    const big=n=>isBigType(checker.getTypeAtLocation(n));
    const string=n=>!!(checker.getTypeAtLocation(n).flags&ts.TypeFlags.StringLike);
    const pathFor=node=>resolve(dirname(filename),node.moduleSpecifier.text);
    for(const node of file.statements){
      if(ts.isImportDeclaration(node)){
        if(!['index.ts','types.ts','bytes.ts','runtime.ts','effects.ts','contract.ts','u128.ts'].some(p=>pathFor(node)===resolve(sdkDirectory,p)))no();
        const bindings=node.importClause?.namedBindings;
        if(ts.isNamedImports(bindings)){for(const item of bindings.elements){const name=item.propertyName?.text??item.name.text;if(!exports.has(name)||(name==='Inputs'&&!item.name.text.startsWith('__alk_')))no();aliases.set(item.name.text,name);}}
        else if(ts.isNamespaceImport(bindings)&&pathFor(node)===resolve(sdkDirectory,'u128.ts'))namespaces.add(bindings.name.text);
        else no();
      }
      if(ts.isFunctionDeclaration(node)&&node.name)localCalls.add(node.name.text);
      if(ts.isClassDeclaration(node))for(const m of node.members)if(ts.isMethodDeclaration(m))methods.has(m.name.getText(file))||localCalls.add(m.name.getText(file));
    }
    const scan=node=>{
      if(ts.isCatchClause(node)||ts.isAwaitExpression(node)||ts.isYieldExpression(node)||ts.isDeleteExpression(node)||ts.isTypeOfExpression(node)||ts.isTypeAssertionExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node)||ts.isObjectLiteralExpression(node)||ts.isTemplateExpression(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isFunctionExpression(node)||ts.isForInStatement(node)||ts.isForOfStatement(node))no();
      if(ts.isBigIntLiteral(node)){
        let parent=node.parent;while(parent&&!ts.isFunctionLike(parent))parent=parent.parent;if(!parent)no();
      }
      if(ts.isCallExpression(node)){
        const callee=node.expression;
        if(ts.isIdentifier(callee)){
          if(!aliases.has(callee.text)&&!localCalls.has(callee.text)&&!['BigInt','Number'].includes(callee.text))no();
          if(aliases.get(callee.text)==='call'){
            const budget=node.arguments[2];
            if(node.arguments.length!==3||!ts.isNumericLiteral(budget)||!Number.isSafeInteger(Number(budget.text))||Number(budget.text)<0)no();
          }
        }else if(ts.isPropertyAccessExpression(callee)){
          if(ts.isIdentifier(callee.expression)&&namespaces.has(callee.expression.text)){if(!math.has(callee.name.text))no();}
          else if(callee.name.text==='toString'){if(!big(callee.expression)||node.arguments.length)no();}
          else if(!methods.has(callee.name.text)&&!localCalls.has(callee.name.text))no();
        }else if(!ts.isArrowFunction(callee)&&!ts.isParenthesizedExpression(callee))no();
      }
      if(ts.isPropertyAccessExpression(node)&&string(node.expression))no();
      if(ts.isElementAccessExpression(node)&&!checker.isArrayType(checker.getTypeAtLocation(node.expression))&&!checker.isTupleType(checker.getTypeAtLocation(node.expression)))no();
      if(ts.isBinaryExpression(node)){
        const op=node.operatorToken.getText(file);
        if((string(node.left)||string(node.right))&&!(op==='+'&&string(node.left)&&string(node.right)))no();
        if(big(node.left)!==big(node.right)&&comparison.has(op)&&node.right.getText(file)!=='undefined'&&node.left.getText(file)!=='undefined')no();
        if(['&&','||'].includes(op)&&(big(node.left)||big(node.right)||string(node.left)||string(node.right)))no();
      }
      const condition=ts.isIfStatement(node)||ts.isWhileStatement(node)||ts.isDoStatement(node)||ts.isConditionalExpression(node)?node.expression??node.condition:ts.isForStatement(node)?node.condition:null;
      if(condition&&(big(condition)||string(condition)))no();
      if((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&(big(node.operand)||string(node.operand)))no();
      if(ts.isSwitchStatement(node)&&(big(node.expression)||string(node.expression)))no();
      if(ts.isNewExpression(node)){
        const name=node.expression.getText(file);
        if(name==='Uint8Array'){if(node.arguments?.length!==1||!ts.isArrayLiteralExpression(node.arguments[0])||node.arguments[0].elements.some(e=>!ts.isNumericLiteral(e)))no();}
        else if(name==='Error'){if(!ts.isThrowStatement(node.parent)||node.arguments?.length!==1)no();}
        else if(!aliases.has(name)&&!file.statements.some(n=>ts.isClassDeclaration(n)&&n.name?.text===name))no();
      }
      if(ts.isBinaryExpression(node)&&big(node.left)&&big(node.right)&&!comparison.has(node.operatorToken.getText(file))&&node.operatorToken.kind!==ts.SyntaxKind.EqualsToken)no();
      ts.forEachChild(node,scan);
    };
    for(const node of file.statements)if(!ts.isImportDeclaration(node)&&!(ts.isFunctionDeclaration(node)&&['execute','meta'].includes(node.name?.text)))scan(node);
    const call=(name,args)=>f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('__alk_sdk'),name),undefined,args);
    const number=n=>f.createNumericLiteral(n);
    const byteArray=s=>f.createNewExpression(f.createIdentifier('Uint8Array'),undefined,[f.createArrayLiteralExpression([...Buffer.from(s)].map(number))]);
    const asBytes=s=>call('bytes',[byteArray(s)]);
    const transformed=ts.transform(file,[context=>{
      const visit=node=>{
        if(ts.isImportDeclaration(node))return undefined;
        if(ts.isFunctionDeclaration(node)&&node.name?.text==='meta')return f.updateFunctionDeclaration(node,node.modifiers,node.asteriskToken,node.name,node.typeParameters,node.parameters,f.createTypeReferenceNode('Uint8Array'),f.createBlock([f.createReturnStatement(byteArray(abi))],true));
        if(ts.isFunctionDeclaration(node)&&node.name?.text==='execute')return f.updateFunctionDeclaration(node,node.modifiers,node.asteriskToken,node.name,node.typeParameters,node.parameters,f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),f.createBlock([f.createReturnStatement(call('executeDispatch',[f.createIdentifier('__alk_dispatch'),f.createIdentifier('context')]))],true));
        if(node.kind===ts.SyntaxKind.BigIntKeyword)return f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
        if(node.kind===ts.SyntaxKind.StringKeyword)return f.createTypeReferenceNode('__alk_sdk.Bytes');
        if(ts.isBigIntLiteral(node)){
          const v=BigInt(node.text.replaceAll('_','').replace(/n$/,''));if(v<0n||v>=(1n<<128n))no();
          return call('literal',[0,1,2,3].map(i=>number(Number((v>>BigInt(i*32))&0xffff_ffffn))));
        }
        if(ts.isStringLiteral(node))return asBytes(node.text);
        if(ts.isThrowStatement(node)){
          if(!ts.isNewExpression(node.expression)||node.expression.expression.getText(file)!=='Error')no();
          return f.createExpressionStatement(call('raise',[ts.visitNode(node.expression.arguments[0],visit)]));
        }
        if(ts.isNewExpression(node)&&node.expression.getText(file)==='Uint8Array')return call('bytes',[node]);
        if(ts.isBinaryExpression(node)){
          const op=node.operatorToken.getText(file);
          if(big(node.left)&&big(node.right)&&comparison.has(op))return call('compare',[number(comparison.get(op)),ts.visitNode(node.left,visit),ts.visitNode(node.right,visit)]);
          if(op==='+'&&string(node.left)&&string(node.right))return call('concat',[ts.visitNode(node.left,visit),ts.visitNode(node.right,visit)]);
        }
        if(ts.isCallExpression(node)){
          const callee=node.expression;
          if(ts.isIdentifier(callee)&&callee.text==='Number'){if(node.arguments.length!==1||!big(node.arguments[0]))no();return call('toNumber',[ts.visitNode(node.arguments[0],visit)]);}
          if(ts.isIdentifier(callee)&&callee.text==='BigInt'){if(node.arguments.length!==1||!(checker.getTypeAtLocation(node.arguments[0]).flags&ts.TypeFlags.NumberLike))no();return call('fromNumber',[ts.visitNode(node.arguments[0],visit)]);}
          if(ts.isPropertyAccessExpression(callee)&&callee.name.text==='toString'&&big(callee.expression))return call('decimal',[ts.visitNode(callee.expression,visit)]);
        }
        return ts.visitEachChild(node,visit,context);
      };
      return root=>ts.visitNode(root,visit);
    }]);
    const imports=[`import * as __alk_sdk from ${JSON.stringify(resolve(sdkDirectory,'word-runtime.ts'))};`,...aliases.entries()].map(item=>Array.isArray(item)?`import {${item[1]} as ${item[0]}} from ${JSON.stringify(resolve(sdkDirectory,'word-runtime.ts'))};`:item);
    for(const namespace of namespaces)imports.push(`import * as ${namespace} from ${JSON.stringify(resolve(sdkDirectory,'word-runtime.ts'))};`);
    const output=imports.join('\n')+'\n'+printer.printFile(transformed.transformed[0]);transformed.dispose();return output;
  }catch(error){if(error===unsupported)return null;throw error;}
}

// Normalize static fluent registrations before applying the same SDK lowering.
export function lowerFluent({filename,source,sdkDirectory}){
  const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true),methods=[];
  let reserved=false;const check=n=>{if(ts.isIdentifier(n)&&n.text.startsWith('__alk'))reserved=true;ts.forEachChild(n,check);};check(file);if(reserved)return null;
  const entry=file.statements.find(ts.isExportAssignment);if(!entry||entry.isExportEquals)return null;
  for(const node of file.statements){
    if(node===entry||ts.isImportDeclaration(node)||ts.isFunctionDeclaration(node))continue;
    if(!ts.isVariableStatement(node))return null;
    for(const d of node.declarationList.declarations){
      const v=d.initializer;
      if(!ts.isIdentifier(d.name)||!v||!(ts.isStringLiteral(v)||ts.isNumericLiteral(v)||(ts.isNewExpression(v)&&v.expression.getText(file)==='StoragePointer'&&v.arguments?.length===1&&ts.isStringLiteral(v.arguments[0]))))return null;
    }
  }
  let cursor=entry.expression;
  while(ts.isCallExpression(cursor)&&ts.isPropertyAccessExpression(cursor.expression)&&cursor.expression.name.text==='method'){
    const [opcode,name,params,returns,handler]=cursor.arguments;
    if(cursor.arguments.length!==5||!ts.isNumericLiteral(opcode)||!Number.isSafeInteger(Number(opcode.text))||Number(opcode.text)<0||!ts.isStringLiteral(name)||!ts.isArrayLiteralExpression(params)||!ts.isStringLiteral(returns)||!ts.isArrowFunction(handler))return null;
    const inputs=[];
    for(const p of params.elements){if(!ts.isCallExpression(p)||p.expression.getText(file)!=='param'||p.arguments.length!==1||!ts.isStringLiteral(p.arguments[0]))return null;inputs.push({name:p.arguments[0].text,type:'u128'});}
    if(handler.parameters.length>2)return null;
    if(handler.parameters.some(p=>!ts.isIdentifier(p.name)||p.initializer||p.questionToken||p.dotDotDotToken))return null;
    const args=handler.parameters[1]?.name;
    if(args){
      let valid=true;
      const inspect=n=>{
        if(ts.isIdentifier(n)&&n.text===args.text&&n!==args){
          const property=n.parent,call=property.parent;
          if(!ts.isPropertyAccessExpression(property)||property.expression!==n||!['u128','id'].includes(property.name.text)||!ts.isCallExpression(call)||call.expression!==property||call.arguments.length!==1||!ts.isNumericLiteral(call.arguments[0]))valid=false;
          else{const index=Number(call.arguments[0].text);if(!Number.isSafeInteger(index)||index<0||index+(property.name.text==='id'?2:1)>inputs.length)valid=false;}
        }
        ts.forEachChild(n,inspect);
      };inspect(handler.body);if(!valid)return null;
    }
    methods.unshift({opcode:BigInt(Number(opcode.text)).toString(),name:name.text,params:inputs,returns:returns.text,handler:handler.getText(file),arity:handler.parameters.length});
    cursor=cursor.expression.expression;
  }
  if(!ts.isNewExpression(cursor)||cursor.expression.getText(file)!=='Contract'||cursor.arguments?.length!==1||!ts.isStringLiteral(cursor.arguments[0])||!methods.length)return null;
  if(new Set(methods.map(m=>m.opcode)).size!==methods.length)return null;
  const contract=cursor.arguments[0].text;
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(contract)||methods.some(m=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name)||m.params.some(p=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name))))return null;
  const abi='{ "contract": '+JSON.stringify(contract)+', "methods": ['+methods.map(m=>'{ "name": '+JSON.stringify(m.name)+', "opcode": '+m.opcode+', "params": ['+m.params.map(p=>JSON.stringify({type:p.type,name:p.name})).join(', ')+'], "returns": '+JSON.stringify(m.returns)+' }').join(', ')+'] }';
  const prefix=file.statements.filter(n=>n!==entry).map(n=>{
    if(ts.isImportDeclaration(n)){
      if(resolve(dirname(filename),n.moduleSpecifier.text)!==resolve(sdkDirectory,'index.ts'))return null;
      const bindings=n.importClause?.namedBindings;if(!bindings||!ts.isNamedImports(bindings)||bindings.elements.some(e=>e.propertyName))return null;
      return 'import {'+bindings.elements.filter(e=>!['Contract','param'].includes(e.name.text)).map(e=>e.name.text).join(',')+'} from '+JSON.stringify(resolve(sdkDirectory,'index.ts'))+';';
    }
    return n.getText(file);
  });if(prefix.includes(null))return null;
  const normalized=prefix.join('\n')+`\nimport {Inputs as __alk_Inputs} from ${JSON.stringify(resolve(sdkDirectory,'contract.ts'))};
import {Context as __alk_Context,CallResponse as __alk_Response} from ${JSON.stringify(resolve(sdkDirectory,'types.ts'))};
function __alk_dispatch(context:__alk_Context):__alk_Response{
 if(context.inputs.length===0)throw new Error("No opcode provided");
 const opcode=context.inputs[0],args=new __alk_Inputs(context.inputs.slice(1));
 ${methods.map(m=>`if(opcode===${m.opcode}n){if(context.inputs.length<${m.params.length+1})throw new Error(${JSON.stringify(m.name+' expects '+m.params.length+' inputs')});return (${m.handler})(${['context','args'].slice(0,m.arity).join(',')});}`).join('\n')}
 throw new Error("Unrecognized opcode "+opcode.toString());
}
export function execute(context:Uint8Array):Uint8Array{return new Uint8Array();}
export function meta():Uint8Array{return new Uint8Array();}
`;
  const lowered=lowerSDK({filename,source:normalized,abi,sdkDirectory});if(!lowered)return null;
  return {lowered,abi,word:'sdk',manifest:{format:2,contract,incomingAssets:'forward',initialized:false,trackedAssets:false,state:[],lowering:'word-sdk-v1',methods:methods.map(({handler,arity,...m})=>({...m,abiName:m.name,view:false,init:false,incomingAssets:'forward'}))}};
}
