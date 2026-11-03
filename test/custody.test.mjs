import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM,u128} from './vm.mjs';

const pool={block:2n,tx:10n},t0={block:2n,tx:1n},t1={block:2n,tx:2n},other={block:2n,tx:3n},router={block:2n,tx:20n};
const MAX=(1n<<128n)-1n;
// AmmPool pricing: 0.3% fee from the input, then the constant-product price.
const amountOut=(amountIn,rIn,rOut)=>{const x=amountIn*997n/1000n;return x*rOut/(rIn+x);};
const poolWasm=readFileSync('dist/amm-pool.wasm');

const work=resolve('build/test-custody-router');mkdirSync(work,{recursive:true});
writeFileSync(resolve(work,'entry.ts'),compileContract({filename:resolve('test/fixtures/custody-router.ts')}).lowered);
buildLibrary({entry:resolve(work,'entry.ts'),work,out:resolve(work,'router.wasm')});
const routerWasm=readFileSync(resolve(work,'router.wasm'));

function setup(vm=new AlkanesVM()){
  vm.deploy(pool,poolWasm);
  vm.call({target:pool,inputs:[0,t0.block,t0.tx,t1.block,t1.tx]});
  vm.deploy(router,routerWasm);
  vm.call({target:router,inputs:[0,pool.block,pool.tx,t0.block,t0.tx,t1.block,t1.tx]});
  return vm;
}
const view=(vm,target,opcode,...args)=>u128.decode(vm.call({target,inputs:[opcode,...args]}).data);
const state=vm=>({r0:view(vm,pool,20),r1:view(vm,pool,21),supply:view(vm,pool,22)});
const add=(vm,a0,a1,min=0n)=>vm.call({target:pool,inputs:[1,min],incoming:[{id:t0,value:a0},{id:t1,value:a1}]});
const paid=(response,id)=>response.alkanes.filter(t=>t.id.block===id.block&&t.id.tx===id.tx).reduce((s,t)=>s+t.value,0n);
const assertBacked=vm=>{const s=state(vm);assert.equal(vm.balanceOf(pool,t0),s.r0);assert.equal(vm.balanceOf(pool,t1),s.r1);};

// Custody API, AmmPool and host-model regressions. test/fixtures/custody-router.ts
// holds pool outputs and LP shares in custody and calls a precompile.

test('custody: held() is stable across a call whose callee pays back, and equals the host balance afterwards',()=>{
  const vm=setup();add(vm,1_000_000n,4_000_000n);
  const {r0,r1}=state(vm);const out=amountOut(10_000n,r0,r1);
  const r=vm.call({target:router,inputs:[1,1000n],incoming:[{id:t0,value:10_000n}]});
  assert.equal(u128.decode(r.data),1000n);
  assert.equal(paid(r,t1),out-1000n);assert.equal(paid(r,t0),0n);
  assert.equal(vm.balanceOf(router,t1),1000n);assert.equal(view(vm,router,10),1000n);
  assertBacked(vm);
  // Incoming token1 is never custody: withdrawing 1001 with 5000 incoming fails.
  assert.throws(()=>vm.call({target:router,inputs:[2,1001n],incoming:[{id:t1,value:5000n}]}),/INSUFFICIENT_CUSTODY/);
  const w=vm.call({target:router,inputs:[2,400n],incoming:[{id:t1,value:5000n}]});
  assert.equal(paid(w,t1),5400n);assert.equal(u128.decode(w.data),600n);assert.equal(vm.balanceOf(router,t1),600n);
  // Spend custody into another call.
  const s=vm.call({target:router,inputs:[3,600n]});
  assert.equal(u128.decode(s.data),0n);assert.equal(vm.balanceOf(router,t1),0n);assert.ok(paid(s,t0)>0n);
  assert.throws(()=>vm.call({target:router,inputs:[3,1n]}),/INSUFFICIENT_CUSTODY/);
  assertBacked(vm);
});

test('custody: a third contract can hold LP (pool-minted) in custody and redeem it later',()=>{
  const vm=setup();add(vm,1_000_000n,4_000_000n);
  const r=vm.call({target:router,inputs:[4],incoming:[{id:t0,value:1000n},{id:t1,value:5000n}]});
  assert.equal(u128.decode(r.data),2000n);assert.equal(vm.balanceOf(router,pool),2000n);
  assert.equal(paid(r,t1),1000n);assert.equal(paid(r,pool),0n);
  assert.throws(()=>vm.call({target:router,inputs:[5,2001n]}),/INSUFFICIENT_CUSTODY/);
  const x=vm.call({target:router,inputs:[5,2000n]});
  assert.equal(u128.decode(x.data),0n);assert.equal(vm.balanceOf(router,pool),0n);
  assert.ok(paid(x,t0)>0n&&paid(x,t1)>0n);assertBacked(vm);
});

test('AmmPool refunds incoming LP on add/swap, splits duplicate parcels, and returns extra pool tokens on remove',()=>{
  const vm=setup();const first=add(vm,1_000_000n,4_000_000n);const lp=paid(first,pool);
  // LP sent along with an add is returned with the new shares.
  const a=vm.call({target:pool,inputs:[1,0],incoming:[{id:t0,value:500n},{id:pool,value:7n},{id:t1,value:1000n},{id:t1,value:1000n}]});
  assert.equal(u128.decode(a.data),1000n);assert.equal(paid(a,pool),1007n);
  // LP and an unrelated asset sent along with a swap are returned.
  const s=vm.call({target:pool,inputs:[3,0],incoming:[{id:t0,value:1000n},{id:pool,value:5n},{id:other,value:3n}]});
  assert.equal(paid(s,pool),5n);assert.equal(paid(s,other),3n);assert.equal(paid(s,t0),0n);
  // Pool tokens sent along with a remove are returned on top of the redemption.
  const st=state(vm);
  const x=vm.call({target:pool,inputs:[2,0,0],incoming:[{id:pool,value:100n},{id:pool,value:100n},{id:t0,value:9n}]});
  assert.equal(paid(x,t0),200n*st.r0/st.supply+9n);assert.equal(paid(x,pool),0n);
  assertBacked(vm);
  // LP alone to swap is not an input.
  assert.throws(()=>vm.call({target:pool,inputs:[3,0],incoming:[{id:pool,value:lp}]}),/SINGLE_INPUT_REQUIRED/);
});

test('AmmPool invariants hold over a random operation sequence (custody = reserves, k/supply^2 non-decreasing, LP conservation)',()=>{
  const vm=setup();
  let seed=12345n;const rand=(n)=>{seed=(seed*6364136223846793005n+1442695040888963407n)&((1n<<64n)-1n);return (seed>>33n)%n;};
  const first=add(vm,10n**12n,3n*10n**12n);let circulating=paid(first,pool);
  let prev=state(vm);
  for(let i=0;i<300;i++){
    const op=rand(3n);
    try{
      if(op===0n){const r=add(vm,rand(10n**11n)+1n,rand(10n**11n)+1n);circulating+=paid(r,pool);}
      else if(op===1n){const id=rand(2n)===0n?t0:t1;vm.call({target:pool,inputs:[3,0],incoming:[{id,value:rand(10n**11n)+1n}]});}
      else if(circulating>0n){const lp=rand(circulating)+1n;const r=vm.call({target:pool,inputs:[2,0,0],incoming:[{id:pool,value:lp}]});circulating-=lp;assert.equal(paid(r,pool),0n);}
    }catch(e){if(!/INSUFFICIENT|SLIPPAGE/.test(e.message))throw e;}
    const s=state(vm);
    assert.equal(s.supply,circulating+1000n);
    assert.equal(vm.balanceOf(pool,t0),s.r0);assert.equal(vm.balanceOf(pool,t1),s.r1);
    assert.ok(s.r0>0n&&s.r1>0n);
    // sqrt(k)/supply never decreases: compare k*prevSupply^2 >= prevK*supply^2.
    assert.ok(s.r0*s.r1*prev.supply*prev.supply>=prev.r0*prev.r1*s.supply*s.supply,`share value fell at step ${i}`);
    prev=s;
  }
  // Redeeming everything leaves exactly the locked 1000 shares and nonzero reserves.
  vm.call({target:pool,inputs:[2,0,0],incoming:[{id:pool,value:circulating}]});
  const end=state(vm);assert.equal(end.supply,1000n);assert.ok(end.r0>0n&&end.r1>0n);assertBacked(vm);
  // The pool still accepts deposits at the remaining ratio afterwards.
  const again=add(vm,end.r0,end.r1);assert.equal(paid(again,pool),1000n);
});

// Pricing must not overflow for any reserves the host can hold: computing
// reserveIn*1000 in u128 would make every swap into a reserve above MAX/1000
// revert even though reserves, balances and the result all fit.
test('swaps into a reserve above MAX/1000 do not overflow',()=>{
  const vm=setup();
  const big=MAX/1000n+1n,small=10n**30n;
  add(vm,big,small);
  assertBacked(vm);
  const {r0,r1}=state(vm);
  // token1 -> token0 still works (reserveIn = token1 is small).
  assert.equal(u128.decode(vm.call({target:pool,inputs:[3,0],incoming:[{id:t1,value:10n**27n}]}).data),amountOut(10n**27n,r1,r0));
  const s=state(vm);
  const expected=amountOut(10n**33n,s.r0,s.r1);
  assert.ok(expected>0n&&expected<s.r1);
  assert.equal(view(vm,pool,10,10n**33n),expected);
  assert.equal(u128.decode(vm.call({target:pool,inputs:[3,0],incoming:[{id:t0,value:10n**33n}]}).data),expected);
});

// The SDK drops its storage cache after a successful call because the host
// commits the piped checkpoint. The 8e8 precompiles take no checkpoint, so
// the cache must survive them or earlier writes would be lost.
test('state written before a tracked call to an 8e8 precompile persists',()=>{
  const vm=setup(new AlkanesVM());
  assert.equal(u128.decode(vm.call({target:router,inputs:[6]}).data),7n);
  assert.equal(view(vm,router,11),7n);
});

// The host never moves assets for a precompile call. If the ledger debited
// them anyway they would silently become custody, so the SDK refuses.
test('assets cannot be sent with a precompile call',()=>{
  const vm=setup(new AlkanesVM());
  let r;
  try{r=vm.call({target:router,inputs:[7],incoming:[{id:t0,value:50n}]});}
  catch(e){assert.match(e.message,/PRECOMPILE/);assert.equal(vm.balanceOf(router,t0),0n);return;}
  assert.equal(paid(r,t0),50n,'caller was not refunded');
  assert.equal(vm.balanceOf(router,t0),0n,'router kept the assets');
});

// Canonical transfer_from (alkanes-rs src/utils.rs) debits then credits per
// transfer, which matters when from === to (a self-call).
test('host self-transfers follow canonical per-transfer debit/credit order',()=>{
  const a={block:2n,tx:50n},x={block:2n,tx:51n};
  const vm=new AlkanesVM();
  vm.setBalance(a,x,5n);
  // Canonical: [x:5,x:5] from a to a succeeds (5 -> 0 -> 5 -> 0 -> 5).
  assert.doesNotThrow(()=>vm.transfer([{id:x,value:5n},{id:x,value:5n}],a,a));
  assert.equal(vm.balanceOf(a,x),5n);
  // Canonical own-ID self-transfer from 0: max(0,5)-5+5 = 5, twice -> 5 (vm.mjs gives 10).
  const vm2=new AlkanesVM();
  vm2.transfer([{id:a,value:5n},{id:a,value:5n}],a,a);
  assert.equal(vm2.balanceOf(a,a),5n);
});
