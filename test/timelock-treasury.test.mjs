import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test,after} from 'node:test';
import ts from 'typescript';
import {AlkanesVM,u128} from './vm.mjs';
import {buildLibrary} from '../scripts/build.mjs';

// dist/timelock-treasury.wasm is built by `npm run build` (npm test rebuilds
// first). The auth-token fixture is the one CappedToken uses, built into its
// own directory so the two test files can run concurrently.
const fixtureWork=resolve('build/timelock-treasury-auth');mkdirSync(fixtureWork,{recursive:true});
writeFileSync(join(fixtureWork,'entry.ts'),`import contract from ${JSON.stringify(resolve('test/fixtures/test-auth.ts'))};
import {executeContract,contractMeta} from ${JSON.stringify(resolve('sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
buildLibrary({entry:join(fixtureWork,'entry.ts'),work:fixtureWork,out:join(fixtureWork,'auth.wasm')});
const authWasm=readFileSync(join(fixtureWork,'auth.wasm'));

const treasury={block:2n,tx:1n};
const authority={block:4n,tx:9001n},impostor={block:4n,tx:9002n};
const t0={block:2n,tx:10n},t1={block:2n,tx:11n},other={block:2n,tx:12n};
// LIMIT is the contract's bound on both delay and grace (about 20 years).
const DELAY=10n,GRACE=100n,LIMIT=1_051_200n,MAX=(1n<<128n)-1n,MAX_HEIGHT=(1n<<64n)-1n;
const auth=[{id:authority,value:1n}];

// mode: 0 approves, 1 answers [0], 2 reverts (test/fixtures/test-auth.ts).
// The treasury's initializer proves the authority with one auth call, so the
// authority approves that call and switches to `mode` afterwards.
const setMode=(vm,id,mode)=>vm.storageOf(id).set(Buffer.from('/mode').toString('hex'),u128.encode(BigInt(mode)));
function setup({mode=0,delay=DELAY,grace=GRACE,height=1000n}={}){
  const vm=new AlkanesVM({height});
  vm.deploy(treasury,readFileSync('dist/timelock-treasury.wasm'));
  vm.deploy(authority,authWasm);
  vm.deploy(impostor,authWasm);
  vm.call({target:authority,inputs:[0,0]});
  vm.call({target:impostor,inputs:[0,0]});
  vm.call({target:treasury,inputs:[0,authority.block,authority.tx,delay,grace],incoming:auth});
  if(mode!==0)setMode(vm,authority,mode);
  return vm;
}
const fresh=()=>{
  const vm=new AlkanesVM({height:1000n});
  vm.deploy(treasury,readFileSync('dist/timelock-treasury.wasm'));
  return vm;
};
const call=(vm,inputs,incoming=[])=>vm.call({target:treasury,inputs,incoming});
const value=response=>u128.decode(response.data);
const deposit=(vm,id,incoming)=>call(vm,[1,id.block,id.tx],incoming);
const schedule=(vm,id,amount,incoming=auth)=>call(vm,[2,id.block,id.tx,amount],incoming);
const execute=(vm,incoming=auth)=>call(vm,[3],incoming);
const cancel=(vm,incoming=auth)=>call(vm,[4],incoming);
const held=(vm,id)=>value(call(vm,[13,id.block,id.tx]));
const pending=vm=>({asset:call(vm,[10]).data,amount:value(call(vm,[11])),readyAt:value(call(vm,[12]))});
const NONE={asset:u128.list([0n,0n]),amount:0n,readyAt:0n};
const scheduled=(id,amount,readyAt)=>({asset:u128.list([id.block,id.tx]),amount,readyAt});
const authCalls=vm=>u128.decode(vm.call({target:authority,inputs:[2]}).data);
const paid=(response,id)=>response.alkanes.filter(t=>t.id.block===id.block&&t.id.tx===id.tx).reduce((s,t)=>s+t.value,0n);
// Custody is the host balance: held() must report it exactly, and it must
// equal what the test expects from the deposits and withdrawals it made.
const assertCustody=(vm,expected)=>{
  for(const [id,amount] of expected){
    assert.equal(vm.balanceOf(treasury,id),amount);
    assert.equal(held(vm,id),amount);
  }
};
// Everything observable that a reverted call must leave untouched.
const observe=vm=>({pending:pending(vm),calls:authCalls(vm),
  balances:[t0,t1,other,authority].map(id=>vm.balanceOf(treasury,id)),authBalance:vm.balanceOf(authority,authority)});

test('TimelockTreasury initializes once with an external authority and gates everything before that',()=>{
  const vm=new AlkanesVM();
  vm.deploy(treasury,readFileSync('dist/timelock-treasury.wasm'));
  vm.deploy(authority,authWasm);
  vm.call({target:authority,inputs:[0,0]});
  for(const inputs of [[1,t0.block,t0.tx],[2,t0.block,t0.tx,1],[3],[4],[10],[11],[12],[13,t0.block,t0.tx],[14],[15],[16]])
    assert.throws(()=>call(vm,inputs),/NOT_INITIALIZED/);
  assert.throws(()=>call(vm,[0,treasury.block,treasury.tx,5,7],auth),/SELF_AUTHORITY/);
  // The deployer proves the authority by presenting a unit, which comes back
  // along with anything else sent to the initializer.
  assert.throws(()=>call(vm,[0,authority.block,authority.tx,5,7]),/AUTH_ASSET_REQUIRED/);
  assert.throws(()=>call(vm,[0,authority.block,authority.tx,5,7],[{id:t0,value:3n}]),/AUTH_ASSET_REQUIRED/);
  const init=call(vm,[0,authority.block,authority.tx,5,7],[...auth,{id:t0,value:3n}]);
  assert.deepEqual(init.alkanes,[...auth,{id:t0,value:3n}]);
  assert.equal(authCalls(vm),1n);
  assert.throws(()=>call(vm,[0,authority.block,authority.tx,5,7],auth),/ALREADY_INITIALIZED/);
  assert.deepEqual(call(vm,[15]).data,u128.list([authority.block,authority.tx]));
  assert.equal(value(call(vm,[14])),5n);
  assert.equal(value(call(vm,[16])),7n);
  assert.deepEqual(pending(vm),NONE);
  assert.equal(held(vm,t0),0n);
  // The treasury never holds its own alkane, so custody of it is undefined.
  assert.throws(()=>held(vm,treasury),/SELF_CUSTODY_UNSUPPORTED/);
  assert.throws(()=>call(vm,[11],[{id:t0,value:1n}]),/rejects incoming assets/);
});

test('TimelockTreasury deposits retain only the named asset and refund the rest of the parcel',()=>{
  const vm=setup();
  // Duplicate transfers of the named asset all count; the others come back.
  const r=deposit(vm,t0,[{id:t0,value:100n},{id:t1,value:5n},{id:other,value:7n},{id:t0,value:50n},{id:authority,value:1n}]);
  assert.equal(value(r),150n);
  assert.deepEqual(r.alkanes,[{id:t1,value:5n},{id:other,value:7n},{id:authority,value:1n}]);
  assertCustody(vm,[[t0,150n],[t1,0n],[other,0n],[authority,0n]]);
  // A second asset, and a further deposit of the first: the result is the
  // amount kept, the held view the running total.
  const r1=deposit(vm,t1,[{id:t1,value:MAX}]);
  assert.equal(value(r1),MAX);assert.deepEqual(r1.alkanes,[]);
  assert.equal(value(deposit(vm,t0,[{id:t0,value:25n}])),25n);
  assertCustody(vm,[[t0,175n],[t1,MAX],[other,0n]]);
  // Deposits need no auth and never touch the authority: the one call so far
  // is the initializer's.
  assert.equal(authCalls(vm),1n);
  // Nothing named, nothing kept: the call reverts and nothing moves.
  const before=observe(vm);
  assert.throws(()=>deposit(vm,t0,[{id:other,value:5n}]),/NOTHING_DEPOSITED/);
  assert.throws(()=>deposit(vm,t0,[{id:t0,value:0n}]),/NOTHING_DEPOSITED/);
  assert.throws(()=>deposit(vm,t0,[]),/NOTHING_DEPOSITED/);
  assert.throws(()=>deposit(vm,treasury,[{id:treasury,value:5n}]),/SELF_ASSET/);
  // Custody beyond u128 is a balance overflow and reverts as a whole.
  assert.throws(()=>deposit(vm,t1,[{id:t1,value:1n}]),/overflow/);
  assert.deepEqual(observe(vm),before);
});

test('TimelockTreasury schedules, waits out the delay, executes once and pays the caller',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:150n}]);
  deposit(vm,t1,[{id:t1,value:40n}]);
  // Unrelated incoming assets on an authenticated call are refunded too.
  const s=schedule(vm,t0,60n,[...auth,{id:other,value:3n}]);
  assert.equal(value(s),1000n+DELAY);
  assert.deepEqual(s.alkanes,[{id:authority,value:1n},{id:other,value:3n}]);
  assert.deepEqual(pending(vm),scheduled(t0,60n,1010n));
  assert.equal(authCalls(vm),2n);
  // One pending withdrawal at a time.
  assert.throws(()=>schedule(vm,t1,1n),/WITHDRAWAL_PENDING/);
  // Early execution reverts at every height before readyAt.
  for(const height of [1000n,1005n,1009n]){
    vm.height=height;
    assert.throws(()=>execute(vm),/TIMELOCK_ACTIVE/);
  }
  assert.deepEqual(pending(vm),scheduled(t0,60n,1010n));
  assertCustody(vm,[[t0,150n],[t1,40n]]);
  vm.height=1010n;
  const r=execute(vm);
  assert.equal(value(r),60n);
  assert.equal(paid(r,t0),60n);assert.equal(paid(r,authority),1n);assert.equal(r.alkanes.length,2);
  assert.deepEqual(pending(vm),NONE);
  assertCustody(vm,[[t0,90n],[t1,40n],[authority,0n]]);
  // The slot is cleared: a second execute has nothing to pay.
  assert.throws(()=>execute(vm),/NO_PENDING_WITHDRAWAL/);
  assertCustody(vm,[[t0,90n],[t1,40n]]);
  // A later withdrawal starts its own delay from the height it is scheduled at.
  vm.height=2000n;
  assert.equal(value(schedule(vm,t1,40n)),2010n);
  vm.height=2050n;
  assert.equal(paid(execute(vm),t1),40n);
  assertCustody(vm,[[t0,90n],[t1,0n]]);
  // auth fixture balances are unchanged: the auth unit always comes back.
  assert.equal(vm.balanceOf(authority,authority),0n);
  assert.equal(authCalls(vm),5n);
});

test('TimelockTreasury cancel clears the slot without moving assets and restarts the delay',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:100n}]);
  assert.throws(()=>cancel(vm),/NO_PENDING_WITHDRAWAL/);
  schedule(vm,t0,100n);
  vm.height=1500n;
  const c=cancel(vm);
  assert.deepEqual(c.alkanes,auth);assert.equal(c.data.length,0);
  assert.deepEqual(pending(vm),NONE);
  assert.throws(()=>execute(vm),/NO_PENDING_WITHDRAWAL/);
  assertCustody(vm,[[t0,100n]]);
  // Rescheduling does not inherit the old readyAt.
  assert.equal(value(schedule(vm,t0,30n)),1510n);
  assert.throws(()=>execute(vm),/TIMELOCK_ACTIVE/);
  vm.height=1510n;
  assert.equal(paid(execute(vm),t0),30n);
  assertCustody(vm,[[t0,70n]]);
});

test('TimelockTreasury rejects missing, zero, foreign and refused auth tokens and rolls back every attempt',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:100n}]);
  schedule(vm,t0,10n);
  vm.height=2000n;
  const before=observe(vm);
  const impostorCalls=()=>u128.decode(vm.call({target:impostor,inputs:[2]}).data);
  for(const op of [incoming=>schedule(vm,t1,1n,incoming),incoming=>execute(vm,incoming),incoming=>cancel(vm,incoming)]){
    assert.throws(()=>op([]),/AUTH_ASSET_REQUIRED/);
    assert.throws(()=>op([{id:authority,value:0n}]),/AUTH_ASSET_REQUIRED/);
    // A working auth token of a different authority proves nothing here.
    assert.throws(()=>op([{id:impostor,value:1n}]),/AUTH_ASSET_REQUIRED/);
    // Other assets cannot stand in for the token either.
    assert.throws(()=>op([{id:t0,value:1n}]),/AUTH_ASSET_REQUIRED/);
  }
  assert.equal(impostorCalls(),0n);
  assert.deepEqual(observe(vm),before);
  // The authority contract itself must approve: [0] and reverts both fail.
  for(const [mode,error] of [[1,/AUTH_REJECTED/],[2,/AUTH_FAILURE/]]){
    const v=setup({mode});
    deposit(v,t0,[{id:t0,value:100n}]);
    const start=observe(v);
    assert.throws(()=>schedule(v,t0,10n),error);
    assert.throws(()=>execute(v),error);
    assert.throws(()=>cancel(v),error);
    assert.deepEqual(observe(v),start);
    assertCustody(v,[[t0,100n]]);
  }
});

test('TimelockTreasury reverts a withdrawal custody cannot cover and leaves it pending',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:50n}]);
  // Custody is checked at execution, so scheduling more than is held works.
  schedule(vm,t0,80n);
  vm.height=1010n;
  const before=observe(vm);
  assert.throws(()=>execute(vm),/INSUFFICIENT_CUSTODY/);
  // Incoming units of the asset on the execute call are not custody.
  assert.throws(()=>execute(vm,[...auth,{id:t0,value:30n}]),/INSUFFICIENT_CUSTODY/);
  assert.deepEqual(observe(vm),before);
  assert.deepEqual(pending(vm),scheduled(t0,80n,1010n));
  // A deposit during the pending period completes the funding.
  deposit(vm,t0,[{id:t0,value:30n}]);
  const r=execute(vm);
  assert.equal(paid(r,t0),80n);
  assertCustody(vm,[[t0,0n]]);
  // An asset the treasury never held, and its own alkane, cannot be withdrawn.
  schedule(vm,other,1n);
  vm.height=1020n;
  assert.throws(()=>execute(vm),/INSUFFICIENT_CUSTODY/);
  cancel(vm);
  assert.throws(()=>schedule(vm,treasury,1n),/SELF_ASSET/);
  assert.throws(()=>schedule(vm,t0,0n),/INVALID_AMOUNT/);
  assert.deepEqual(pending(vm),NONE);
});

test('TimelockTreasury refuses its authority token as a deposit or withdrawal asset',()=>{
  // Auth tokens are often a single unit: once deposited, nothing could present
  // it again to execute, and every asset in the treasury would be stuck.
  const vm=setup({delay:0n});
  deposit(vm,t0,[{id:t0,value:100n}]);
  const before=observe(vm);
  assert.throws(()=>deposit(vm,authority,[{id:authority,value:1n}]),/AUTHORITY_ASSET/);
  assert.throws(()=>deposit(vm,authority,[{id:authority,value:3n},{id:t0,value:5n}]),/AUTHORITY_ASSET/);
  // The token is never custody, so a withdrawal of it could never be paid.
  assert.throws(()=>schedule(vm,authority,1n,[{id:authority,value:2n}]),/AUTHORITY_ASSET/);
  assert.deepEqual(observe(vm),before);
  // Units presented for auth alongside another deposit are refunded, and the
  // treasury still works with the token outside custody.
  assert.deepEqual(deposit(vm,t0,[{id:t0,value:5n},{id:authority,value:1n}]).alkanes,auth);
  schedule(vm,t0,30n);
  // Delay 0: executable in the same block. All presented units come back
  // with the withdrawal; none of them was ever custody.
  const r=execute(vm,[{id:authority,value:2n},{id:t0,value:4n}]);
  assert.equal(paid(r,authority),2n);assert.equal(paid(r,t0),34n);
  assertCustody(vm,[[t0,75n],[authority,0n]]);
});

test('TimelockTreasury refuses assets on views and rejects unknown opcodes',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:1n}]);
  for(const inputs of [[10],[11],[12],[13,t0.block,t0.tx],[14],[15],[16]])
    assert.throws(()=>call(vm,inputs,[{id:t0,value:1n}]),/rejects incoming assets/);
  assert.throws(()=>call(vm,[99]),/Unrecognized opcode/);
});

test('TimelockTreasury initialize accepts only an authority the deployer proves by authenticating',()=>{
  // Any ID outside blocks 2 and 4 can never answer the auth call, so it is
  // refused before any call. 0:0 is the top-level caller ID.
  for(const id of [{block:0n,tx:0n},{block:1n,tx:0n},{block:3n,tx:9001n},{block:5n,tx:1n},{block:6n,tx:1n},{block:32n,tx:0n},{block:800000000n,tx:1n},{block:MAX,tx:MAX}]){
    const vm=fresh();
    assert.throws(()=>call(vm,[0,id.block,id.tx,DELAY,GRACE],[{id,value:1n}]),/INVALID_AUTHORITY/,`authority ${id.block}:${id.tx}`);
    // The failed initializer leaves the treasury unusable for deposits.
    assert.throws(()=>deposit(vm,t0,[{id:t0,value:7n}]),/NOT_INITIALIZED/);
  }
  // A block-2/4 ID only counts once it authenticates. [2, MAX] is never
  // reached by CREATE, and an ID nobody has deployed yet would belong to
  // whoever deploys it first; neither can answer the initializer's auth call.
  for(const id of [{block:2n,tx:0n},{block:2n,tx:MAX},{block:4n,tx:0n},{block:4n,tx:777n}]){
    const vm=fresh();
    assert.throws(()=>call(vm,[0,id.block,id.tx,DELAY,GRACE]),/AUTH_ASSET_REQUIRED/,`authority ${id.block}:${id.tx}`);
    assert.throws(()=>call(vm,[0,id.block,id.tx,DELAY,GRACE],[{id,value:1n}]),`authority ${id.block}:${id.tx} with a unit`);
    assert.throws(()=>deposit(vm,t0,[{id:t0,value:7n}]),/NOT_INITIALIZED/);
  }
  // An authority that refuses the initializer's call is refused too.
  for(const [mode,error] of [[1,/AUTH_REJECTED/],[2,/AUTH_FAILURE/]]){
    const vm=fresh();
    vm.deploy(authority,authWasm);vm.call({target:authority,inputs:[0,mode]});
    assert.throws(()=>call(vm,[0,authority.block,authority.tx,DELAY,GRACE],auth),error);
  }
});

test('TimelockTreasury: an authority ID nobody has deployed yet is refused, so it cannot be claimed later',()=>{
  // Before initialization required authentication, a treasury could be bound
  // to an authority nobody had deployed yet. Whoever deployed that ID first
  // could then schedule and execute withdrawals of the users' deposits. The
  // initializer's auth call now fails for such an ID; on chain, the failed
  // initializer rolls the treasury's creation back.
  const reserved={block:4n,tx:777n},vm=fresh();
  assert.throws(()=>call(vm,[0,reserved.block,reserved.tx,DELAY,GRACE],[{id:reserved,value:1n}]));
  vm.deploy(reserved,authWasm);vm.call({target:reserved,inputs:[0,0]});
  const squatter=[{id:reserved,value:1n}];
  assert.throws(()=>deposit(vm,t0,[{id:t0,value:500n}]),/NOT_INITIALIZED/);
  assert.throws(()=>schedule(vm,t0,500n,squatter),/NOT_INITIALIZED/);
  assert.throws(()=>execute(vm,squatter),/NOT_INITIALIZED/);
});

test('TimelockTreasury initialize bounds delay and grace to 1_051_200 blocks so every window is reachable',()=>{
  // The host reports height as a u64. A delay past 2^64 (or any unbounded
  // one) would make readyAt unreachable and lock deposits forever.
  for(const delay of [LIMIT+1n,1n<<64n,MAX])
    assert.throws(()=>call(fresh(),[0,authority.block,authority.tx,delay,GRACE]),/DELAY_TOO_LONG/,`delay ${delay}`);
  // A grace of 0 is an empty window; nothing could ever execute.
  for(const grace of [0n,LIMIT+1n,MAX])
    assert.throws(()=>call(fresh(),[0,authority.block,authority.tx,DELAY,grace]),/INVALID_GRACE/,`grace ${grace}`);
  // The largest delay and grace: the window opens 1_051_200 blocks after the
  // schedule and stays open for 1_051_200 blocks.
  const vm=setup({delay:LIMIT,grace:LIMIT});
  assert.equal(value(call(vm,[14])),LIMIT);assert.equal(value(call(vm,[16])),LIMIT);
  deposit(vm,t0,[{id:t0,value:9n}]);
  const readyAt=value(schedule(vm,t0,4n));
  assert.equal(readyAt,1000n+LIMIT);
  vm.height=readyAt-1n;
  assert.throws(()=>execute(vm),/TIMELOCK_ACTIVE/);
  vm.height=readyAt+LIMIT-1n;
  assert.equal(paid(execute(vm),t0),4n);
  schedule(vm,t0,5n);
  vm.height+=2n*LIMIT;
  assert.throws(()=>execute(vm),/WITHDRAWAL_EXPIRED/);
  // Even scheduled at the largest u64 height, readyAt + grace stays far below
  // 2^128: the checked additions in schedule and execute never overflow.
  const top=setup({delay:LIMIT,grace:LIMIT,height:MAX_HEIGHT});
  deposit(top,t0,[{id:t0,value:5n}]);
  assert.equal(value(schedule(top,t0,5n)),MAX_HEIGHT+LIMIT);
  assert.throws(()=>execute(top),/TIMELOCK_ACTIVE/);
  assert.throws(()=>schedule(top,t0,1n),/WITHDRAWAL_PENDING/);
  cancel(top);
  assertCustody(top,[[t0,5n]]);
});

test('TimelockTreasury executes only while readyAt <= height < readyAt + grace',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:100n}]);
  assert.equal(value(schedule(vm,t0,10n)),1010n);
  vm.height=1009n;
  assert.throws(()=>execute(vm),/TIMELOCK_ACTIVE/);
  // The window closes at readyAt + grace = 1110: an expired withdrawal
  // reverts as a whole and stays in the slot.
  for(const height of [1110n,1111n,5000n,MAX_HEIGHT]){
    vm.height=height;
    const before=observe(vm);
    assert.throws(()=>execute(vm),/WITHDRAWAL_EXPIRED/);
    assert.deepEqual(observe(vm),before);
  }
  assert.deepEqual(pending(vm),scheduled(t0,10n,1010n));
  // The last block of the window still executes.
  vm.height=1109n;
  assert.equal(paid(execute(vm),t0),10n);
  assert.deepEqual(pending(vm),NONE);
  assertCustody(vm,[[t0,90n]]);
  // Grace 1 with delay 0: executable only in the block it was scheduled in.
  const once=setup({delay:0n,grace:1n});
  deposit(once,t0,[{id:t0,value:10n}]);
  assert.equal(value(schedule(once,t0,3n)),1000n);
  assert.equal(paid(execute(once),t0),3n);
  schedule(once,t0,3n);
  once.height=1001n;
  assert.throws(()=>execute(once),/WITHDRAWAL_EXPIRED/);
  assertCustody(once,[[t0,7n]]);
});

test('TimelockTreasury schedule replaces a pending withdrawal only once it has expired, and cancel still clears it',()=>{
  const vm=setup();
  deposit(vm,t0,[{id:t0,value:100n}]);
  deposit(vm,t1,[{id:t1,value:50n}]);
  schedule(vm,t0,10n);
  // Still executable through height 1109: no schedule may overwrite it.
  for(const height of [1000n,1010n,1109n]){
    vm.height=height;
    assert.throws(()=>schedule(vm,t1,5n),/WITHDRAWAL_PENDING/);
  }
  assert.deepEqual(pending(vm),scheduled(t0,10n,1010n));
  // Expired at 1110: a new schedule replaces it and starts a full delay.
  vm.height=1110n;
  assert.equal(value(schedule(vm,t1,5n)),1120n);
  assert.deepEqual(pending(vm),scheduled(t1,5n,1120n));
  assert.throws(()=>execute(vm),/TIMELOCK_ACTIVE/);
  // An expired withdrawal can also be cancelled.
  vm.height=1220n;
  assert.throws(()=>execute(vm),/WITHDRAWAL_EXPIRED/);
  cancel(vm);
  assert.deepEqual(pending(vm),NONE);
  assert.throws(()=>cancel(vm),/NO_PENDING_WITHDRAWAL/);
  assertCustody(vm,[[t0,100n],[t1,50n]]);
});

test('TimelockTreasury lets an unfunded withdrawal expire instead of draining a deposit made long after it',()=>{
  const vm=setup();
  // The authority schedules 100 t0 while the treasury holds none.
  assert.equal(held(vm,t0),0n);
  schedule(vm,t0,100n);
  // Long after readyAt + grace, a depositor funds the treasury at 50000.
  vm.height=50000n;
  deposit(vm,t0,[{id:t0,value:100n}]);
  // The old withdrawal expired at 1110, so the deposit cannot leave in the
  // block it arrives.
  const before=observe(vm);
  assert.throws(()=>execute(vm),/WITHDRAWAL_EXPIRED/);
  assert.deepEqual(observe(vm),before);
  assertCustody(vm,[[t0,100n]]);
  // Taking it requires a new schedule, which gives watchers the full delay.
  assert.equal(value(schedule(vm,t0,100n)),50010n);
  assert.throws(()=>execute(vm),/TIMELOCK_ACTIVE/);
  vm.height=50010n;
  assert.equal(paid(execute(vm),t0),100n);
  assertCustody(vm,[[t0,0n]]);
});

const directory=mkdtempSync(join(tmpdir(),'alkanes-treasury-client-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
const transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
writeFileSync(join(directory,'runtime.mjs'),transpile(readFileSync('client/runtime.ts','utf8')));
writeFileSync(join(directory,'client.mjs'),transpile(readFileSync('dist/TimelockTreasuryClient.ts','utf8')).replace(JSON.stringify(resolve('client/runtime.ts')),'"./runtime.mjs"'));
const {TimelockTreasuryClient}=await import(pathToFileURL(join(directory,'client.mjs')));

test('generated TimelockTreasury client attaches auth/deposit assets and simulates without committing',async()=>{
  const vm=setup();
  const transport={simulate:async request=>vm.simulate(request)};
  const client=new TimelockTreasuryClient(transport,treasury);
  assert.deepEqual(await client.read.getAuthority(),authority);
  assert.equal(await client.read.getDelay(),DELAY);
  assert.equal(await client.read.getGrace(),GRACE);
  const preview=await client.call.deposit({asset:t0}).withAssets([{id:t0,value:9n},{id:t1,value:2n}]).simulate();
  assert.equal(preview.value,9n);assert.deepEqual(preview.alkanes,[{id:t1,value:2n}]);
  assert.equal(await client.read.held({asset:t0}),0n);
  deposit(vm,t0,[{id:t0,value:9n}]);
  const plan=client.call.schedule({asset:t0,amount:4n}).withAssets(auth);
  assert.deepEqual(plan.prepare().cellpack,u128.list([treasury.block,treasury.tx,2n,t0.block,t0.tx,4n]));
  assert.equal((await plan.simulate()).value,1000n+DELAY);
  assert.equal(await client.read.getPendingAmount(),0n);
  assert.deepEqual(await client.read.getPendingAsset(),{block:0n,tx:0n});
  const deployment=TimelockTreasuryClient.deploy(transport,new Uint8Array([0]),{authority,delay:DELAY,grace:GRACE});
  // The initializer authenticates, so the deployment carries an auth unit.
  assert.deepEqual(deployment.withAssets(auth).prepare().incoming,auth);
  assert.deepEqual(deployment.prepare().target,{block:1n,tx:0n});
  assert.deepEqual(deployment.prepare().inputs,[0n,authority.block,authority.tx,DELAY,GRACE]);
});

// ---------------------------------------------------------------------------
// Adversarial authorities: one that re-enters the treasury from inside its auth
// call, and one that keeps or inflates the auth unit.
const reenterWork=resolve('build/timelock-treasury-reenter');mkdirSync(reenterWork,{recursive:true});
writeFileSync(join(reenterWork,'entry.ts'),`import contract from ${JSON.stringify(resolve('test/fixtures/reenter-auth.ts'))};
import {executeContract,contractMeta} from ${JSON.stringify(resolve('sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
buildLibrary({entry:join(reenterWork,'entry.ts'),work:reenterWork,out:join(reenterWork,'auth.wasm')});
const reenterWasm=readFileSync(join(reenterWork,'auth.wasm'));
// The fixture's initializer takes the re-entry cellpack [op, a, b, c] (a/b and
// c omitted when zero) and whether to forward the auth unit with it.
// The initializer authenticates while the treasury is still initializing, when
// any re-entry fails and this fixture would refuse. So the authority approves
// the initializer's call with the plain fixture and is then replaced by the
// re-entering one.
function setupReenter([op,a,b,fwd,c=0]){
  const vm=new AlkanesVM({height:1000n});
  vm.deploy(treasury,readFileSync('dist/timelock-treasury.wasm'));
  vm.deploy(authority,authWasm);
  vm.call({target:authority,inputs:[0,0]});
  vm.call({target:treasury,inputs:[0,authority.block,authority.tx,0,GRACE],incoming:auth});
  vm.deploy(authority,reenterWasm);
  vm.call({target:authority,inputs:[0,op,a,b,fwd,c]});
  return vm;
}

test('TimelockTreasury blocks an authority that re-enters it during authentication',()=>{
  // execute and cancel (forwarding the auth unit), schedule, deposit and two
  // views, each re-entered from inside schedule/execute/cancel's auth call.
  for(const cfg of [[3,0,0,1],[4,0,0,1],[2,t0.block,t0.tx,1,5],[1,t0.block,t0.tx,0],[11,0,0,0],[13,t0.block,t0.tx,0]]){
    const vm=setupReenter(cfg);
    deposit(vm,t0,[{id:t0,value:100n}]);
    const before={bal:vm.balanceOf(treasury,t0),amt:held(vm,t0)};
    for(const op of [()=>schedule(vm,t0,10n),()=>execute(vm),()=>cancel(vm)])
      assert.throws(op,/REENTRANT_CALL/,`reentry ${cfg} not blocked`);
    assert.deepEqual({bal:vm.balanceOf(treasury,t0),amt:held(vm,t0)},before);
    assert.deepEqual(pending(vm),NONE);
  }
});

const oddWork=resolve('build/timelock-treasury-odd');mkdirSync(oddWork,{recursive:true});
writeFileSync(join(oddWork,'entry.ts'),`import contract from ${JSON.stringify(resolve('test/fixtures/odd-auth.ts'))};
import {executeContract,contractMeta} from ${JSON.stringify(resolve('sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
buildLibrary({entry:join(oddWork,'entry.ts'),work:oddWork,out:join(oddWork,'auth.wasm')});
const oddWasm=readFileSync(join(oddWork,'auth.wasm'));

test('TimelockTreasury custody does not drift when the authority keeps or inflates the auth unit',()=>{
  // mode 0 approves but keeps the unit sent to it; mode 1 keeps it and pays
  // back 3 newly issued units instead. Whatever the authority returns is a
  // call return in the ledger and goes back to the caller, never custody.
  for(const [mode,back] of [[0n,1n],[1n,4n]]){
    const vm=new AlkanesVM({height:1000n});
    vm.deploy(treasury,readFileSync('dist/timelock-treasury.wasm'));
    vm.deploy(authority,oddWasm);
    vm.call({target:authority,inputs:[0,mode]});
    vm.call({target:treasury,inputs:[0,authority.block,authority.tx,0,GRACE],incoming:auth});
    deposit(vm,t0,[{id:t0,value:100n}]);
    // Two units presented each time, one of them sent to the authority:
    // the caller gets 2-1 back (mode 0) or 2-1+3 (mode 1).
    assert.equal(paid(schedule(vm,t0,40n,[{id:authority,value:2n}]),authority),back);
    const r=execute(vm,[{id:authority,value:2n}]);
    assert.equal(paid(r,authority),back);assert.equal(paid(r,t0),40n);
    assertCustody(vm,[[t0,60n],[authority,0n]]);
    // Inflated units cannot be parked in the treasury either.
    assert.throws(()=>deposit(vm,authority,[{id:authority,value:back}]),/AUTHORITY_ASSET/);
  }
});
