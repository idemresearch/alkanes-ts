import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {AlkanesVM,u128} from './vm.mjs';

// dist/amm-pool.wasm is built by `npm run build` (npm test rebuilds first).
// ALKANES_SOURCE=1 runs the contract from its TypeScript source instead.
const poolCode=process.env.ALKANES_SOURCE?'contracts/amm-pool/index.ts':readFileSync('dist/amm-pool.wasm');
const pool={block:2n,tx:10n},t0={block:2n,tx:1n},t1={block:2n,tx:2n},other={block:2n,tx:3n};
const MAX=(1n<<128n)-1n;

function isqrt(n){if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
// Fee from the input first, then the constant-product price.
const amountOut=(amountIn,rIn,rOut)=>{const x=amountIn*997n/1000n;return x*rOut/(rIn+x);};

function setup(){
  const vm=new AlkanesVM();
  vm.deploy(pool,poolCode);
  vm.call({target:pool,inputs:[0,t0.block,t0.tx,t1.block,t1.tx]});
  return vm;
}
const view=(vm,opcode,...args)=>u128.decode(vm.call({target:pool,inputs:[opcode,...args]}).data);
const state=vm=>({r0:view(vm,20),r1:view(vm,21),supply:view(vm,22)});
const add=(vm,a0,a1,min=0n)=>vm.call({target:pool,inputs:[1,min],incoming:[{id:t0,value:a0},{id:t1,value:a1}]});
const swap=(vm,id,amount,min=0n)=>vm.call({target:pool,inputs:[3,min],incoming:[{id,value:amount}]});
const remove=(vm,lp,min0=0n,min1=0n)=>vm.call({target:pool,inputs:[2,min0,min1],incoming:[{id:pool,value:lp}]});
const paid=(response,id)=>response.alkanes.filter(t=>t.id.block===id.block&&t.id.tx===id.tx).reduce((s,t)=>s+t.value,0n);
// Custody must always back the stored reserves exactly.
const assertBacked=vm=>{const s=state(vm);assert.equal(vm.balanceOf(pool,t0),s.r0);assert.equal(vm.balanceOf(pool,t1),s.r1);};

test('AmmPool initializes once, rejects identical tokens and gates methods until initialized',()=>{
  const vm=new AlkanesVM();vm.deploy(pool,poolCode);
  assert.throws(()=>add(vm,10n,10n),/NOT_INITIALIZED/);
  assert.throws(()=>vm.call({target:pool,inputs:[0,t0.block,t0.tx,t0.block,t0.tx]}),/IDENTICAL_TOKENS/);
  assert.throws(()=>vm.call({target:pool,inputs:[0,pool.block,pool.tx,t1.block,t1.tx]}),/LP_TOKEN_AS_RESERVE/);
  assert.throws(()=>vm.call({target:pool,inputs:[0,t0.block,t0.tx,pool.block,pool.tx]}),/LP_TOKEN_AS_RESERVE/);
  vm.call({target:pool,inputs:[0,t0.block,t0.tx,t1.block,t1.tx]});
  assert.throws(()=>vm.call({target:pool,inputs:[0,t0.block,t0.tx,t1.block,t1.tx]}),/ALREADY_INITIALIZED/);
  assert.deepEqual(vm.call({target:pool,inputs:[23]}).data,u128.list([t0.block,t0.tx]));
  assert.deepEqual(vm.call({target:pool,inputs:[24]}).data,u128.list([t1.block,t1.tx]));
});

test('AmmPool first deposit mints sqrt(a*b) - 1000 LP, keeps both tokens and locks minimum liquidity',()=>{
  const vm=setup();
  const response=add(vm,1_000_000n,4_000_000n);
  assert.equal(u128.decode(response.data),1_999_000n);
  assert.deepEqual(response.alkanes,[{id:pool,value:1_999_000n}]);
  assert.deepEqual(state(vm),{r0:1_000_000n,r1:4_000_000n,supply:2_000_000n});
  assertBacked(vm);
  assert.throws(()=>add(setup(),1000n,1000n),/INSUFFICIENT_LIQUIDITY_MINTED/);
  assert.throws(()=>add(setup(),0n,1000n),/INSUFFICIENT_INPUT/);
  assert.throws(()=>add(setup(),1_000_000n,4_000_000n,1_999_001n),/SLIPPAGE/);
});

test('AmmPool later deposits use the pool ratio, refund the excess side and unrelated assets',()=>{
  const vm=setup();add(vm,1_000_000n,4_000_000n);
  // 500 token0 needs 2000 token1; 3000 offered, 1000 refunded.
  const r=vm.call({target:pool,inputs:[1,0],incoming:[{id:t0,value:500n},{id:t1,value:3000n},{id:other,value:7n}]});
  assert.equal(u128.decode(r.data),1000n);
  assert.equal(paid(r,pool),1000n);assert.equal(paid(r,t1),1000n);assert.equal(paid(r,other),7n);assert.equal(paid(r,t0),0n);
  assert.deepEqual(state(vm),{r0:1_000_500n,r1:4_002_000n,supply:2_001_000n});
  assertBacked(vm);assert.equal(vm.balanceOf(pool,other),0n);
  // Token0 is the excess side here.
  const r2=add(vm,1000n,2000n);
  assert.equal(paid(r2,t0),500n);assert.equal(paid(r2,t1),0n);assertBacked(vm);
});

test('AmmPool swaps exact input in both directions with a 0.3% fee and min-out protection',()=>{
  const vm=setup();add(vm,1_000_000n,4_000_000n);
  let {r0,r1}=state(vm);
  const out1=amountOut(10_000n,r0,r1);
  assert.equal(view(vm,10,10_000n),out1);
  const r=swap(vm,t0,10_000n);
  assert.equal(u128.decode(r.data),out1);assert.deepEqual(r.alkanes,[{id:t1,value:out1}]);
  assert.deepEqual(state(vm),{r0:r0+10_000n,r1:r1-out1,supply:2_000_000n});
  assertBacked(vm);
  ({r0,r1}=state(vm));
  const out0=amountOut(50_000n,r1,r0);
  assert.equal(view(vm,11,50_000n),out0);
  assert.equal(u128.decode(swap(vm,t1,50_000n).data),out0);
  assertBacked(vm);
  // k never decreases.
  const after=state(vm);assert.ok(after.r0*after.r1>=1_000_000n*4_000_000n);
  const before=state(vm);
  assert.throws(()=>swap(vm,t0,1000n,amountOut(1000n,before.r0,before.r1)+1n),/SLIPPAGE/);
  assert.throws(()=>vm.call({target:pool,inputs:[3,0],incoming:[{id:t0,value:5n},{id:t1,value:5n}]}),/SINGLE_INPUT_REQUIRED/);
  assert.throws(()=>vm.call({target:pool,inputs:[3,0],incoming:[{id:other,value:5n}]}),/SINGLE_INPUT_REQUIRED/);
  // token1 is the cheaper side: one unit rounds down to zero token0.
  assert.equal(view(vm,11,1n),0n);
  assert.throws(()=>swap(vm,t1,1n),/INSUFFICIENT_OUTPUT_AMOUNT/);
  assert.deepEqual(state(vm),before);assertBacked(vm);
  assert.throws(()=>swap(setup(),t0,1000n),/INSUFFICIENT_LIQUIDITY/);
});

test('AmmPool redeems LP proportionally, takes the shares out of circulation and checks slippage',()=>{
  const vm=setup();add(vm,1_000_000n,4_000_000n);swap(vm,t0,25_000n);
  const s=state(vm);
  const lp=999_000n;
  const e0=lp*s.r0/s.supply,e1=lp*s.r1/s.supply;
  assert.throws(()=>remove(vm,lp,e0+1n,0n),/SLIPPAGE/);
  const r=remove(vm,lp,e0,e1);
  assert.equal(u128.decode(r.data),lp);
  assert.equal(paid(r,t0),e0);assert.equal(paid(r,t1),e1);assert.equal(paid(r,pool),0n);
  assert.deepEqual(state(vm),{r0:s.r0-e0,r1:s.r1-e1,supply:s.supply-lp});
  assertBacked(vm);
  // Returned shares stay in pool custody; reissuing recycles them.
  assert.equal(vm.balanceOf(pool,pool),lp);
  assert.throws(()=>vm.call({target:pool,inputs:[2,0,0]}),/INSUFFICIENT_INPUT/);
  // Remaining circulating LP (1,999,000 - 999,000) redeems all but the locked share.
  const rest=remove(vm,1_000_000n);
  const end=state(vm);assert.equal(end.supply,1000n);assert.ok(end.r0>0n&&end.r1>0n);
  assertBacked(vm);assert.equal(paid(rest,pool),0n);
});

test('AmmPool views reject assets, methods roll back atomically, and checked math rejects overflow',()=>{
  const vm=setup();add(vm,1_000_000n,4_000_000n);
  const before=state(vm);
  assert.throws(()=>vm.call({target:pool,inputs:[20],incoming:[{id:t0,value:1n}]}),/rejects incoming assets/);
  // An input the pool's balance cannot absorb is rejected by the host and nothing moves.
  assert.throws(()=>swap(vm,t0,MAX-before.r0+1n),/balance overflow/);
  assert.deepEqual(state(vm),before);assertBacked(vm);
  // Even the largest quotable input never prices the whole reserve.
  assert.ok(view(vm,10,MAX)<before.r1);
  assert.throws(()=>vm.call({target:pool,inputs:[99]}),/Unrecognized opcode|unknown opcode|opcode/i);
});

test('AmmPool trades both ways when a reserve is far above MAX/1000 and the input is above MAX/997',()=>{
  const vm=setup();
  add(vm,MAX/1000n+1n,10n**30n);
  for(const [id,amount] of [[t1,10n**27n],[t0,MAX/997n+1n],[t1,10n**28n]]){
    const s=state(vm),zeroForOne=id===t0;
    const expected=zeroForOne?amountOut(amount,s.r0,s.r1):amountOut(amount,s.r1,s.r0);
    assert.ok(expected>0n);
    assert.equal(view(vm,zeroForOne?10:11,amount),expected);
    assert.equal(u128.decode(swap(vm,id,amount).data),expected);
    assertBacked(vm);
  }
  const s=state(vm);assert.ok(s.r0*s.r1>=(MAX/1000n+1n)*10n**30n);
});
