import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM,u128} from './vm.mjs';

// dist/amm-router.wasm and dist/amm-pool.wasm are built by `npm run build`
// (npm test rebuilds first). The pool test doubles go through the same
// frontend and linker.
const fixture=name=>{
  const work=resolve(`build/test-${name}`);mkdirSync(work,{recursive:true});
  writeFileSync(resolve(work,'entry.ts'),compileContract({filename:resolve(`test/fixtures/${name}.ts`)}).lowered);
  buildLibrary({entry:resolve(work,'entry.ts'),work,out:resolve(work,`${name}.wasm`)});
  return readFileSync(resolve(work,`${name}.wasm`));
};
const liarWasm=fixture('lying-pool'),reentrantWasm=fixture('reentrant-pool'),selfIdWasm=fixture('self-id-pool');

const A={block:2n,tx:1n},B={block:2n,tx:2n},C={block:2n,tx:3n},D={block:2n,tx:4n};
// poolAB holds A/B; poolCB holds C/B, so A->B->C runs hop 1 as 0->1 and hop 2
// as 1->0. empty is initialized without liquidity; bare is never initialized.
const poolAB={block:2n,tx:10n},poolCB={block:2n,tx:11n},empty={block:2n,tx:12n},bare={block:2n,tx:13n};
const router={block:2n,tx:20n},liar={block:2n,tx:30n},reentrant={block:2n,tx:31n},selfIdPool={block:2n,tx:32n},missing={block:2n,tx:99n};
// [4, n] is the host's other block for deployed contracts.
const pool4={block:4n,tx:10n},precompile={block:800000000n,tx:0n};
const ids=(...xs)=>xs.flatMap(x=>[x.block,x.tx]);

function setup(){
  const vm=new AlkanesVM();
  const poolWasm=readFileSync('dist/amm-pool.wasm');
  for(const pool of [poolAB,poolCB,empty,bare])vm.deploy(pool,poolWasm);
  vm.deploy(router,readFileSync('dist/amm-router.wasm'));
  vm.deploy(liar,liarWasm);
  vm.deploy(reentrant,reentrantWasm);
  vm.call({target:poolAB,inputs:[0,...ids(A,B)]});
  vm.call({target:poolCB,inputs:[0,...ids(C,B)]});
  vm.call({target:empty,inputs:[0,...ids(B,C)]});
  vm.call({target:poolAB,inputs:[1,0],incoming:[{id:A,value:1_000_000n},{id:B,value:4_000_000n}]});
  vm.call({target:poolCB,inputs:[1,0],incoming:[{id:C,value:3_000_000n},{id:B,value:2_000_000n}]});
  vm.setBalance(liar,B,1_000_000n);
  return vm;
}
const view=(vm,pool,opcode,...args)=>vm.call({target:pool,inputs:[opcode,...args]}).data;
const reserves=(vm,pool)=>({r0:u128.decode(view(vm,pool,20)),r1:u128.decode(view(vm,pool,21))});
const sameId=(x,y)=>x.block===y.block&&x.tx===y.tx;
const tokenOf=(vm,pool,opcode)=>{const d=view(vm,pool,opcode);return {block:u128.decode(d,0),tx:u128.decode(d,16)};};
// Expected output of one AmmPool hop, from the pool's own quote view: opcode
// 10 (quote0For1) or 11 (quote1For0), chosen by matching tokenIn against the
// pool's token0/token1 views (23/24). The tests never restate the pool's
// pricing formula, so they follow any change to it.
const quote=(vm,pool,tokenIn,amountIn)=>{
  const opcode=sameId(tokenIn,tokenOf(vm,pool,23))?10:sameId(tokenIn,tokenOf(vm,pool,24))?11:0;
  assert.notEqual(opcode,0,'the pool does not trade tokenIn');
  return u128.decode(view(vm,pool,opcode,amountIn));
};
// Storage and every balance, for exact rollback checks.
const world=vm=>({storage:vm.snapshot(),balances:new Map(vm.balances)});
// Expected output of each hop of an AmmPool route [token, pool, token, ...].
// Each hop is quoted, then applied as a direct pool swap, which must pay
// exactly the quote, so a later hop through the same pool is quoted at the
// reserves it will see. Everything is rolled back afterwards.
const forecast=(vm,amountIn,path)=>{
  const saved=world(vm),outs=[];
  try{
    let amount=amountIn;
    for(let i=0;i+2<path.length;i+=2){
      const out=quote(vm,path[i+1],path[i],amount);
      const direct=vm.call({target:path[i+1],inputs:[3,0],incoming:[{id:path[i],value:amount}]});
      assert.equal(u128.decode(direct.data),out);
      outs.push(amount=out);
    }
  }finally{vm.storage=saved.storage;vm.balances=saved.balances;}
  return outs;
};
// Expected A->B->C output.
const route2=(vm,amountIn)=>{const [mid,out]=forecast(vm,amountIn,[A,poolAB,B,poolCB,C]);return {mid,out};};
// Routes default to deadline = current height, the inclusive bound, so every
// successful swap below also checks that a route may run at its deadline.
const swap2=(vm,amount,{path=[A,poolAB,B,poolCB,C],min=0n,deadline=vm.height,incoming=[{id:path[0],value:amount}]}={})=>
  vm.call({target:router,inputs:[1,...ids(...path),min,deadline],incoming});
const swap1=(vm,amount,{path=[A,poolAB,B],min=0n,deadline=vm.height,incoming=[{id:path[0],value:amount}]}={})=>
  vm.call({target:router,inputs:[2,...ids(...path),min,deadline],incoming});
const paid=(response,id)=>response.alkanes.filter(t=>sameId(t.id,id)).reduce((s,t)=>s+t.value,0n);
const assertNoCustody=(vm,who=router)=>{for(const token of [A,B,C,D])assert.equal(vm.balanceOf(who,token),0n);};
const assertBacked=(vm,pool,t0,t1)=>{const r=reserves(vm,pool);assert.equal(vm.balanceOf(pool,t0),r.r0);assert.equal(vm.balanceOf(pool,t1),r.r1);};

test('AmmRouter swap2 equals two composed AmmPool swaps and keeps no custody',()=>{
  const vm=setup();
  const ab=reserves(vm,poolAB),cb=reserves(vm,poolCB);
  const {mid,out}=route2(vm,10_000n);
  const r=swap2(vm,10_000n);
  assert.equal(u128.decode(r.data),out);
  assert.deepEqual(r.alkanes,[{id:C,value:out}]);
  assert.deepEqual(reserves(vm,poolAB),{r0:ab.r0+10_000n,r1:ab.r1-mid});
  assert.deepEqual(reserves(vm,poolCB),{r0:cb.r0-out,r1:cb.r1+mid});
  assertNoCustody(vm);assertBacked(vm,poolAB,A,B);assertBacked(vm,poolCB,C,B);
  // The reverse route C->B->A runs hop 1 as 0->1 on poolCB and hop 2 as 1->0 on poolAB.
  const [,out2]=forecast(vm,25_000n,[C,poolCB,B,poolAB,A]);
  const r2=swap2(vm,25_000n,{path:[C,poolCB,B,poolAB,A]});
  assert.equal(u128.decode(r2.data),out2);assert.deepEqual(r2.alkanes,[{id:A,value:out2}]);
  assertNoCustody(vm);assertBacked(vm,poolAB,A,B);assertBacked(vm,poolCB,C,B);
});

test('AmmRouter swap2 slippage rolls back both pools and every balance',()=>{
  const vm=setup();
  const {out}=route2(vm,10_000n);
  const before=world(vm);
  assert.throws(()=>swap2(vm,10_000n,{min:out+1n}),/SLIPPAGE/);
  assert.deepEqual(world(vm),before);
  // Exactly minOut succeeds.
  assert.equal(u128.decode(swap2(vm,10_000n,{min:out}).data),out);
  assertNoCustody(vm);
});

test('AmmRouter refunds unrelated incoming and never strands the intermediate token',()=>{
  const vm=setup();
  const {out}=route2(vm,10_000n);
  // The input arrives split across two transfers; the caller's own B and an
  // unrelated D ride along and must come back untouched.
  const r=swap2(vm,0n,{incoming:[{id:A,value:4_000n},{id:D,value:7n},{id:B,value:5n},{id:A,value:6_000n}]});
  assert.equal(u128.decode(r.data),out);
  assert.equal(paid(r,C),out);assert.equal(paid(r,B),5n);assert.equal(paid(r,D),7n);assert.equal(paid(r,A),0n);
  assert.equal(r.alkanes.length,3);
  assertNoCustody(vm);assertBacked(vm,poolAB,A,B);assertBacked(vm,poolCB,C,B);
  // Output token already in the incoming parcel is not counted as output.
  const {out:out2}=route2(vm,1_000n);
  const r2=swap2(vm,0n,{min:out2,incoming:[{id:A,value:1_000n},{id:C,value:1_000_000n}]});
  assert.equal(u128.decode(r2.data),out2);assert.equal(paid(r2,C),1_000_000n+out2);
  assert.throws(()=>swap2(vm,0n,{min:out2+1n,incoming:[{id:A,value:1_000n},{id:C,value:1_000_000n}]}),/SLIPPAGE/);
  assertNoCustody(vm);
});

test('AmmRouter failure of the second pool reverts the first hop and every balance',()=>{
  const vm=setup();
  const before=world(vm);
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,empty,C]}),/Extcall failed.*INSUFFICIENT_LIQUIDITY/);
  assert.deepEqual(world(vm),before);
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,bare,C]}),/Extcall failed.*NOT_INITIALIZED/);
  assert.deepEqual(world(vm),before);
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,missing,C]}),/Extcall failed.*no contract/);
  assert.deepEqual(world(vm),before);
  // A second pool that does not trade the intermediate token rejects it.
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,poolAB,C]}),/INSUFFICIENT_HOP_OUTPUT/);
  assert.deepEqual(world(vm),before);
});

test('AmmRouter swap1 matches a direct pool swap in both directions',()=>{
  const routed=setup(),direct=setup();
  for(const [token,other,amount] of [[A,B,10_000n],[B,A,50_000n],[A,B,1n<<40n]]){
    const viaRouter=swap1(routed,amount,{path:[token,poolAB,other]});
    const viaPool=direct.call({target:poolAB,inputs:[3,0],incoming:[{id:token,value:amount}]});
    assert.deepEqual(viaRouter,viaPool);
    assert.deepEqual(reserves(routed,poolAB),reserves(direct,poolAB));
    assertNoCustody(routed);assertBacked(routed,poolAB,A,B);
  }
  // The large A input left B scarce, so quote the B->A direction.
  const expected=quote(routed,poolAB,B,1_000n);
  const before=world(routed);
  assert.throws(()=>swap1(routed,1_000n,{path:[B,poolAB,A],min:expected+1n}),/SLIPPAGE/);
  assert.deepEqual(world(routed),before);
  assert.equal(u128.decode(swap1(routed,1_000n,{path:[B,poolAB,A],min:expected}).data),expected);
});

test('AmmRouter cycles A->B->A through one pool with both fees',()=>{
  const vm=setup();
  const ab=reserves(vm,poolAB);
  // The second hop is quoted at the reserves the first hop leaves behind.
  const [,back]=forecast(vm,100_000n,[A,poolAB,B,poolAB,A]);
  const r=swap2(vm,100_000n,{path:[A,poolAB,B,poolAB,A]});
  assert.equal(u128.decode(r.data),back);assert.deepEqual(r.alkanes,[{id:A,value:back}]);
  assert.ok(back<100_000n);
  assert.deepEqual(reserves(vm,poolAB),{r0:ab.r0+100_000n-back,r1:ab.r1});
  assertNoCustody(vm);assertBacked(vm,poolAB,A,B);
});

test('AmmRouter measures hop output from transfers, not pool response data',()=>{
  const vm=setup();
  // The liar refunds the input, pays 1000 B and claims 10^21 in its data.
  const r=swap1(vm,10_000n,{path:[A,liar,B]});
  assert.equal(u128.decode(r.data),1000n);
  assert.deepEqual(r.alkanes,[{id:A,value:10_000n},{id:B,value:1000n}]);
  const out=quote(vm,poolCB,B,1000n);
  const r2=swap2(vm,10_000n,{path:[A,liar,B,poolCB,C]});
  assert.equal(u128.decode(r2.data),out);
  assert.deepEqual(r2.alkanes,[{id:A,value:10_000n},{id:C,value:out}]);
  assert.equal(vm.balanceOf(liar,B),1_000_000n-2000n);
  assertNoCustody(vm);assertBacked(vm,poolCB,C,B);
});

test('AmmRouter stays consistent when a pool reenters it',()=>{
  // The reentrant pool routes A back through router.swap1 via poolAB; the
  // inner invocation has its own ledger and returns its B to that pool.
  const vm=setup();
  const ab=reserves(vm,poolAB),out=quote(vm,poolAB,A,10_000n);
  const r=swap1(vm,10_000n,{path:[A,reentrant,B]});
  assert.equal(u128.decode(r.data),out);assert.deepEqual(r.alkanes,[{id:B,value:out}]);
  assert.deepEqual(reserves(vm,poolAB),{r0:ab.r0+10_000n,r1:ab.r1-out});
  // Through the reentrant pool, hop 1 trades on poolAB.
  const [,out2]=forecast(vm,5_000n,[A,poolAB,B,poolCB,C]);
  const r2=swap2(vm,5_000n,{path:[A,reentrant,B,poolCB,C]});
  assert.equal(u128.decode(r2.data),out2);assert.deepEqual(r2.alkanes,[{id:C,value:out2}]);
  assertNoCustody(vm);assertNoCustody(vm,reentrant);
  assertBacked(vm,poolAB,A,B);assertBacked(vm,poolCB,C,B);
});

test('AmmRouter validates routes and rolls back rejected ones',()=>{
  const vm=setup();
  const before=world(vm);
  assert.throws(()=>swap2(vm,0n,{incoming:[{id:D,value:5n}]}),/INSUFFICIENT_INPUT/);
  assert.throws(()=>swap1(vm,0n,{incoming:[]}),/INSUFFICIENT_INPUT/);
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,A,poolAB,B]}),/IDENTICAL_TOKENS/);
  assert.throws(()=>swap1(vm,10_000n,{path:[A,poolAB,A]}),/IDENTICAL_TOKENS/);
  // poolAB pays B, not the claimed intermediate/output token.
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,D,poolCB,C]}),/INSUFFICIENT_HOP_OUTPUT/);
  assert.throws(()=>swap1(vm,10_000n,{path:[A,poolAB,C]}),/INSUFFICIENT_HOP_OUTPUT/);
  // An input the first pool does not trade.
  assert.throws(()=>swap2(vm,10_000n,{path:[C,poolAB,B,poolCB,C]}),/Extcall failed.*SINGLE_INPUT_REQUIRED/);
  // A caller still using the ABI without a deadline is rejected, not run
  // without one.
  assert.throws(()=>vm.call({target:router,inputs:[1,...ids(A,poolAB,B,poolCB,C),0],incoming:[{id:A,value:1n}]}),/swap2 expects 12 inputs/);
  assert.throws(()=>vm.call({target:router,inputs:[2,...ids(A,poolAB,B),0],incoming:[{id:A,value:1n}]}),/swap1 expects 8 inputs/);
  assert.throws(()=>vm.call({target:router,inputs:[3]}),/Unrecognized opcode/);
  assert.deepEqual(world(vm),before);
  assertNoCustody(vm);
});

test('AmmRouter rejects hop-2 identical tokens and itself as a pool, rolling back hop 1',()=>{
  const vm=setup();
  const before=world(vm);
  // tokenMid == tokenOut fails on hop 2, after hop 1 ran; hop 1 must roll back.
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,poolCB,B]}),/IDENTICAL_TOKENS/);
  assert.deepEqual(world(vm),before);
  // The router as its own pool: opcode 3 is unknown, so the self-call aborts.
  assert.throws(()=>swap1(vm,10_000n,{path:[A,router,B]}),/Extcall failed.*Unrecognized opcode 3/);
  assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,router,C]}),/Extcall failed.*Unrecognized opcode 3/);
  assert.deepEqual(world(vm),before);
  assertNoCustody(vm);
});

test('AmmRouter only pays pools at deployed-contract IDs (blocks 2 and 4)',()=>{
  const vm=setup();
  const before=world(vm);
  // CREATE, reserved CREATE, factory clones of [2,10] (poolAB) and [4,10],
  // a precompile and a system alkane: none is an AmmPool, and a deployment
  // cellpack would hand the input to a contract the call itself creates.
  for(const pool of [{block:1n,tx:0n},{block:3n,tx:10n},{block:5n,tx:10n},{block:6n,tx:10n},precompile,{block:32n,tx:0n}]){
    assert.throws(()=>swap1(vm,10_000n,{path:[A,pool,B]}),/INVALID_POOL/);
    // As hop 2 it fails after hop 1 ran; hop 1 rolls back.
    assert.throws(()=>swap2(vm,10_000n,{path:[A,poolAB,B,pool,C]}),/INVALID_POOL/);
    assert.deepEqual(world(vm),before);
  }
  assertNoCustody(vm);
  // An AmmPool deployed at [4, n] routes like one at [2, n].
  vm.deploy(pool4,readFileSync('dist/amm-pool.wasm'));
  vm.call({target:pool4,inputs:[0,...ids(A,B)]});
  vm.call({target:pool4,inputs:[1,0],incoming:[{id:A,value:1_000_000n},{id:B,value:4_000_000n}]});
  const out=quote(vm,pool4,A,10_000n);
  const r=swap1(vm,10_000n,{path:[A,pool4,B]});
  assert.equal(u128.decode(r.data),out);assert.deepEqual(r.alkanes,[{id:B,value:out}]);
  const [,out2]=forecast(vm,10_000n,[A,pool4,B,poolCB,C]);
  const r2=swap2(vm,10_000n,{path:[A,pool4,B,poolCB,C]});
  assert.equal(u128.decode(r2.data),out2);assert.deepEqual(r2.alkanes,[{id:C,value:out2}]);
  assertNoCustody(vm);assertBacked(vm,pool4,A,B);assertBacked(vm,poolCB,C,B);
});

test('AmmRouter returns a pool-1 refund in a cycle to the caller but never counts it toward minOut',()=>{
  const vm=setup();
  // liar refunds 10,000 A and pays 1000 B; poolAB turns the B back into A.
  const out=quote(vm,poolAB,B,1000n);
  const before=world(vm);
  assert.throws(()=>swap2(vm,10_000n,{path:[A,liar,B,poolAB,A],min:out+1n}),/SLIPPAGE/);
  assert.deepEqual(world(vm),before);
  const r=swap2(vm,10_000n,{path:[A,liar,B,poolAB,A],min:out});
  // The result is the hop-2 output only; the parcel also carries the refund,
  // which is why integrators measure their own ledger delta instead.
  assert.equal(u128.decode(r.data),out);
  assert.equal(paid(r,A),10_000n+out);
  assertNoCustody(vm);assertBacked(vm,poolAB,A,B);
});

test('AmmRouter never mints or keeps custody of its own alkane',()=>{
  const vm=setup();
  vm.deploy(selfIdPool,selfIdWasm);
  vm.setBalance(selfIdPool,router,500n);
  const r=swap1(vm,10_000n,{path:[A,selfIdPool,router]});
  assert.equal(u128.decode(r.data),500n);
  assert.deepEqual(r.alkanes,[{id:A,value:10_000n},{id:router,value:500n}]);
  assert.equal(vm.balanceOf(router,router),0n);
  assert.equal(vm.balanceOf(selfIdPool,router),0n);
  // A second call has no router tokens to draw on: the pool's send fails and
  // nothing is minted.
  const before=world(vm);
  assert.throws(()=>swap1(vm,10_000n,{path:[A,selfIdPool,router]}),/INSUFFICIENT_CUSTODY/);
  assert.deepEqual(world(vm),before);
  assertNoCustody(vm);
});

test('AmmRouter rejects a route after its deadline height before calling any pool',()=>{
  const vm=setup();
  const {out}=route2(vm,10_000n);
  // A route signed to expire in 10 blocks confirms 1,000,000 blocks later.
  const deadline=vm.height+10n;
  vm.height+=1_000_000n;
  const before=world(vm);
  assert.throws(()=>swap2(vm,10_000n,{min:out,deadline}),/EXPIRED/);
  assert.throws(()=>swap1(vm,10_000n,{deadline}),/EXPIRED/);
  // The check runs first: a missing pool or a missing input would otherwise
  // fail differently.
  assert.throws(()=>swap2(vm,10_000n,{path:[A,missing,B,poolCB,C],deadline}),/EXPIRED/);
  assert.throws(()=>swap1(vm,0n,{incoming:[],deadline}),/EXPIRED/);
  // The deadline is inclusive: one block after it fails, at it the route runs.
  vm.height=deadline+1n;
  assert.throws(()=>swap2(vm,10_000n,{min:out,deadline}),/EXPIRED/);
  assert.deepEqual(world(vm),before);
  vm.height=deadline;
  assert.equal(u128.decode(swap2(vm,10_000n,{min:out,deadline}).data),out);
  assertNoCustody(vm);
});
