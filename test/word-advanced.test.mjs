import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {MAX,inc,ids,buildPair,differential} from './differential.mjs';

// ShareVault, TimelockTreasury and AmmRouter lower to word-v1 through its
// chain-query and external-call leaves (height(), AlkaneId equals and
// constructor, assets.available and assets.call). Each must be observably
// identical to the general bigint backend: every response, revert message,
// committed storage map and host balance is compared after every call.
const fixture=name=>{
  const work=resolve(`build/word-advanced-${name}`),filename=resolve(`test/fixtures/${name}.ts`);mkdirSync(work,{recursive:true});
  writeFileSync(join(work,'entry.ts'),compileContract({filename})?.lowered??`import contract from ${JSON.stringify(filename)};
import {executeContract,contractMeta} from ${JSON.stringify(resolve('sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
  buildLibrary({entry:join(work,'entry.ts'),work,out:join(work,`${name}.wasm`)});
  return readFileSync(join(work,`${name}.wasm`));
};
const authWasm=fixture('test-auth');
const authority={block:4n,tx:9001n};
const le=v=>{const b=new Uint8Array(16);for(let i=0;i<16;i++)b[i]=Number((BigInt(v)>>BigInt(8*i))&255n);return b;};
const hex=s=>Buffer.from(s).toString('hex');
// test/fixtures/test-auth.ts modes: 0 approve, 1 reject, 2 revert, 3 probe reentrancy.
const withAuth=vm=>{vm.deploy(authority,authWasm);vm.call({target:authority,inputs:[0,0]});};
const authMode=mode=>vm=>vm.storageOf(authority).set(hex('/mode'),le(mode));
const elapse=blocks=>vm=>{vm.height+=BigInt(blocks);};
const atHeight=height=>vm=>{vm.height=BigInt(height);};
const corrupt=(id,key,length)=>vm=>vm.storageOf(id).set(hex(key),new Uint8Array(length).fill(1));
const auth=(...extra)=>[...inc([authority,1]),...extra];
const outcomes=results=>({ok:results.filter(r=>!r.error).length,failed:results.filter(r=>r.error).length});

test('ShareVault word-v1 matches the bigint backend call for call, through vesting and auth',()=>{
  const vault={block:2n,tx:1n},asset={block:2n,tx:5n},other={block:2n,tx:7n};
  const pair=buildPair('share-vault','contracts/share-vault/index.ts');
  const init=(a,b,d)=>({inputs:[0,...ids(a,b),d]});
  const deposit=(x,min=0n,extra=[])=>({inputs:[1,min],incoming:[...inc([asset,x]),...extra]});
  const redeem=(s,min=0n,extra=[])=>({inputs:[2,min],incoming:[...inc([vault,s]),...extra]});
  const harvest=(...extra)=>({inputs:[3],incoming:auth(...extra)});
  const donate=amount=>vm=>vm.setBalance(vault,asset,vm.balanceOf(vault,asset)+BigInt(amount));
  const look=()=>[[{inputs:[10]},'ok'],[{inputs:[11]},'ok'],[{inputs:[12,1000]},'ok'],[{inputs:[12,MAX]},'ok'],
    [{inputs:[13,1000]},'ok'],[{inputs:[13,MAX]},null],[{inputs:[14]},'ok'],[{inputs:[15]},'ok'],
    [{inputs:[16]},'ok'],[{inputs:[17]},'ok'],[{inputs:[18]},'ok']];
  const steps=[
    [deposit(100n),/NOT_INITIALIZED/],[{inputs:[10]},/NOT_INITIALIZED/],[harvest(),/NOT_INITIALIZED/],
    [init(vault,authority,100),/INVALID_ASSET/],[init(asset,vault,100),/INVALID_AUTHORITY/],[init(asset,asset,100),/INVALID_AUTHORITY/],
    [init(asset,authority,0),/INVALID_VESTING/],[init(asset,authority,1_051_201),/INVALID_VESTING/],
    [{...init(asset,authority,100),incoming:inc([asset,1])},/contract rejects incoming assets/],
    [{inputs:[0,...ids(asset,authority)]},/initialize expects 5 inputs/],
    [init(asset,authority,100),'ok'],[init(asset,authority,100),/ALREADY_INITIALIZED/],...look(),
    [{inputs:[1,0]},/ZERO_ASSETS/],[{inputs:[1,0],incoming:inc([other,5])},/ZERO_ASSETS/],
    [deposit(999n),'ok'],[harvest(),/INSUFFICIENT_SHARES/],[{inputs:[3]},/AUTH_ASSET_REQUIRED/],
    [deposit(1n,0n,inc([other,3])),'ok'],[deposit(5000n,MAX),/SLIPPAGE/],
    // Yield vests linearly over 100 blocks; conversions price the unlocked part.
    [{before:donate(500n),...harvest()},'ok'],...look(),
    [{before:elapse(10),...deposit(2000n)},'ok'],[{before:elapse(25),...redeem(300_000n)},'ok'],
    [redeem(1000n,MAX),/SLIPPAGE/],[{inputs:[2,0]},/ZERO_SHARES/],[redeem(1n),/ZERO_ASSETS/],...look(),
    // A second harvest during vesting, with yield sent along and an unrelated refund.
    [{before:donate(77n),...harvest(...inc([asset,23],[other,4]))},'ok'],...look(),
    // Around the end of vesting (harvest height + 100), including a lower height.
    [{before:atHeight(880_134n),inputs:[17]},'ok'],[{inputs:[13,1000]},'ok'],
    [{before:atHeight(880_135n),inputs:[17]},'ok'],[{inputs:[12,1000]},'ok'],
    [{before:atHeight(880_136n),inputs:[17]},'ok'],[{before:atHeight(880_000n),inputs:[17]},'ok'],
    [{before:atHeight(880_200n),...deposit(3n)},'ok'],
    // Auth failures through the external call, and a reentrant probe.
    [{before:authMode(1),...harvest()},/AUTH_REJECTED/],[{before:authMode(2),...harvest()},/AUTH_FAILURE/],
    [{before:authMode(3),...harvest()},null],[{before:authMode(0),...harvest()},'ok'],
    // Capacity and wide arithmetic.
    [deposit(MAX),null],[deposit((1n<<100n)+12345n),'ok'],[redeem(1n<<100n),'ok'],[{inputs:[12,1n<<126n]},/u128 overflow/],
    [{before:donate(1n<<110n),...harvest()},'ok'],[{inputs:[16]},'ok'],[{before:elapse(50),inputs:[13,1n<<90n]},'ok'],
    [{inputs:[16],incoming:inc([asset,1])},/contract rejects incoming assets/],
    [{inputs:[99]},/Unrecognized opcode 99/],[{inputs:[]},/No opcode provided/],[{inputs:[2]},/redeem expects 1 inputs/],
    // Malformed persisted state reports the field reached first.
    [{before:corrupt(vault,'/lockedProfit',3),inputs:[17]},/invalid u128 storage: \/lockedProfit/],
    [deposit(10n),/invalid u128 storage/],[{before:corrupt(vault,'/asset',5),inputs:[14]},/uninitialized or invalid AlkaneId state: \/asset/],
  ];
  const results=differential(pair,vault,steps,{},{setup:withAuth});
  const {ok,failed}=outcomes(results);
  assert.ok(ok>=50&&failed>=20,`${ok} successes, ${failed} failures`);
});

test('TimelockTreasury word-v1 matches the bigint backend call for call, across the timelock window',()=>{
  const treasury={block:2n,tx:1n},A={block:2n,tx:5n},B={block:2n,tx:6n};
  const pair=buildPair('timelock-treasury','contracts/timelock-treasury/index.ts');
  // The initializer authenticates the authority, so a deployment presents a unit.
  const init=(who,delay,grace,incoming=auth())=>({inputs:[0,...ids(who),delay,grace],incoming});
  const deposit=(id,incoming)=>({inputs:[1,...ids(id)],incoming});
  const schedule=(id,amount,...extra)=>({inputs:[2,...ids(id),amount],incoming:auth(...extra)});
  const execute=(...extra)=>({inputs:[3],incoming:auth(...extra)});
  const cancel=()=>({inputs:[4],incoming:auth()});
  const look=()=>[[{inputs:[10]},'ok'],[{inputs:[11]},'ok'],[{inputs:[12]},'ok'],[{inputs:[13,...ids(A)]},'ok'],
    [{inputs:[13,...ids(B)]},'ok'],[{inputs:[13,...ids(treasury)]},/SELF_CUSTODY_UNSUPPORTED/],
    [{inputs:[14]},'ok'],[{inputs:[15]},'ok'],[{inputs:[16]},'ok']];
  const steps=[
    [deposit(A,inc([A,5])),/NOT_INITIALIZED/],[{inputs:[10]},/NOT_INITIALIZED/],
    [init({block:3n,tx:1n},10,5),/INVALID_AUTHORITY/],[init(treasury,10,5),/SELF_AUTHORITY/],
    [init(authority,1_051_201,5),/DELAY_TOO_LONG/],[init(authority,10,0),/INVALID_GRACE/],[init(authority,10,1_051_201),/INVALID_GRACE/],
    [{inputs:[0,...ids(authority),10]},/initialize expects 4 inputs/],
    [init(authority,10,5,[]),/AUTH_ASSET_REQUIRED/],[init(authority,10,5,inc([B,4])),/AUTH_ASSET_REQUIRED/],
    [init({block:2n,tx:MAX},10,5,inc([{block:2n,tx:MAX},1])),null],[init({block:4n,tx:777n},10,5,inc([{block:4n,tx:777n},1])),null],
    [{before:authMode(1),...init(authority,10,5)},/AUTH_REJECTED/],[{before:authMode(2),...init(authority,10,5)},/AUTH_FAILURE/],
    [{before:authMode(0),...init(authority,10,5,auth(...inc([B,4])))},'ok'],[init(authority,10,5),/ALREADY_INITIALIZED/],...look(),
    [deposit(A,inc([A,1000])),'ok'],[deposit(B,inc([B,50],[A,7])),'ok'],
    [deposit(treasury,inc([A,1])),/SELF_ASSET/],[deposit(authority,inc([authority,1])),/AUTHORITY_ASSET/],
    [deposit(A,[]),/NOTHING_DEPOSITED/],[deposit(A,inc([B,9])),/NOTHING_DEPOSITED/],
    [{inputs:[2,...ids(A),10]},/AUTH_ASSET_REQUIRED/],[schedule(A,0),/INVALID_AMOUNT/],
    [schedule(treasury,1),/SELF_ASSET/],[schedule(authority,1),/AUTHORITY_ASSET/],
    [schedule(A,400),'ok'],[schedule(B,1),/WITHDRAWAL_PENDING/],...look(),
    // Ready at schedule height + 10, expired from ready + 5.
    [execute(),/TIMELOCK_ACTIVE/],[{before:elapse(9),...execute()},/TIMELOCK_ACTIVE/],
    [{before:elapse(1),...execute()},'ok'],[execute(),/NO_PENDING_WITHDRAWAL/],[cancel(),/NO_PENDING_WITHDRAWAL/],
    [schedule(A,5000),'ok'],[{before:elapse(10),...execute()},/INSUFFICIENT_CUSTODY/],
    [{before:elapse(4),...execute(...inc([A,2]))},/INSUFFICIENT_CUSTODY/],
    [{before:elapse(1),...execute()},/WITHDRAWAL_EXPIRED/],[schedule(B,50),'ok'],[cancel(),'ok'],...look(),
    [schedule(B,20),'ok'],[{before:authMode(1),...cancel()},/AUTH_REJECTED/],
    [{before:authMode(2),...execute()},/AUTH_FAILURE/],[{before:authMode(3),...cancel()},null],
    [{before:authMode(0),inputs:[10],incoming:inc([A,1])},/contract rejects incoming assets/],
    [{inputs:[3]},/AUTH_ASSET_REQUIRED/],[{before:elapse(10),...execute(...inc([B,3]))},null],...look(),
    [{inputs:[99]},/Unrecognized opcode 99/],[{inputs:[]},/No opcode provided/],
    [{inputs:[2,...ids(A)]},/schedule expects 3 inputs/],
    [schedule(A,1),null],[{before:corrupt(treasury,'/pending/asset',5),inputs:[10]},/uninitialized or invalid AlkaneId state: \/pending\/asset/],
    [{before:corrupt(treasury,'/grace',3),...schedule(A,1)},/invalid u128 storage: \/grace/],
  ];
  const results=differential(pair,treasury,steps,{},{setup:withAuth});
  const {ok,failed}=outcomes(results);
  assert.ok(ok>=40&&failed>=25,`${ok} successes, ${failed} failures`);
});

test('AmmRouter word-v1 matches the bigint backend call for call, through real and hostile pools',()=>{
  const A={block:2n,tx:1n},B={block:2n,tx:2n},C={block:2n,tx:3n};
  const poolAB={block:2n,tx:10n},poolCB={block:2n,tx:11n},empty={block:2n,tx:12n},bare={block:2n,tx:13n};
  const router={block:2n,tx:20n},liar={block:2n,tx:30n},reentrant={block:2n,tx:31n},selfId={block:2n,tx:32n},missing={block:2n,tx:99n};
  const pair=buildPair('amm-router','contracts/amm-router/index.ts');
  const poolWasm=readFileSync('dist/amm-pool.wasm'),liarWasm=fixture('lying-pool'),reentrantWasm=fixture('reentrant-pool'),selfIdWasm=fixture('self-id-pool');
  const setup=vm=>{
    for(const pool of [poolAB,poolCB,empty,bare])vm.deploy(pool,poolWasm);
    vm.deploy(liar,liarWasm);vm.deploy(reentrant,reentrantWasm);vm.deploy(selfId,selfIdWasm);
    vm.call({target:poolAB,inputs:[0,...ids(A,B)]});vm.call({target:poolCB,inputs:[0,...ids(C,B)]});vm.call({target:empty,inputs:[0,...ids(B,C)]});
    vm.call({target:poolAB,inputs:[1,0],incoming:inc([A,1_000_000n],[B,4_000_000n])});
    vm.call({target:poolCB,inputs:[1,0],incoming:inc([C,3_000_000n],[B,2_000_000n])});
    vm.setBalance(liar,B,1_000_000n);
  };
  const later=880_100n;
  const swap1=(tin,pool,tout,amount,min=0n,deadline=later,extra=[])=>({inputs:[2,...ids(tin,pool,tout),min,deadline],incoming:[...inc([tin,amount]),...extra]});
  const swap2=(tin,p1,tmid,p2,tout,amount,min=0n,deadline=later,extra=[])=>({inputs:[1,...ids(tin,p1,tmid,p2,tout),min,deadline],incoming:[...inc([tin,amount]),...extra]});
  const steps=[
    [{inputs:[0]},'ok'],[{inputs:[0],incoming:inc([A,1])},/contract rejects incoming assets/],
    [swap1(A,poolAB,B,10_000n),'ok'],[swap1(B,poolAB,A,5_000n,0n,later,inc([C,4])),'ok'],
    [swap1(A,poolAB,B,10_000n,0n,879_999n),/EXPIRED/],[swap1(A,poolAB,B,10_000n,0n,880_000n),'ok'],
    [{inputs:[2,...ids(A,poolAB,B),0,later]},/INSUFFICIENT_INPUT/],[{inputs:[2,...ids(A,poolAB,B),0,later],incoming:inc([C,10])},/INSUFFICIENT_INPUT/],
    [swap1(A,{block:800000000n,tx:0n},B,10n),/INVALID_POOL/],[swap1(A,{block:3n,tx:1n},B,10n),/INVALID_POOL/],
    [swap1(A,poolAB,A,10n),/IDENTICAL_TOKENS/],[swap1(A,poolAB,B,10_000n,MAX),/SLIPPAGE/],
    // Pool reverts surface through the external call with their messages.
    [swap1(A,bare,B,10_000n),/NOT_INITIALIZED/],[swap1(B,empty,C,10_000n),/INSUFFICIENT_LIQUIDITY/],
    [swap1(C,poolAB,B,10_000n),/SINGLE_INPUT_REQUIRED/],[swap1(A,missing,B,10n),null],
    [swap2(A,poolAB,B,poolCB,C,20_000n),'ok'],[swap2(A,poolAB,B,poolCB,C,20_000n,MAX),/SLIPPAGE/],
    [swap2(C,poolCB,B,poolAB,A,7_000n,0n,later,inc([B,11],[C,2])),'ok'],
    [swap2(A,poolAB,B,poolAB,A,1_000n),'ok'],[swap2(A,poolAB,B,poolCB,B,1_000n),/IDENTICAL_TOKENS/],
    [swap2(A,poolAB,B,poolCB,C,20_000n,0n,879_000n),/EXPIRED/],
    // Hostile pools: lying about outputs, reentering the router, paying with its own ID.
    [swap1(A,liar,B,1_000n),null],[swap1(A,reentrant,B,1_000n),null],[swap1(A,selfId,B,1_000n),null],
    [swap2(A,poolAB,B,liar,C,1_000n),null],[swap1(A,poolAB,B,1n<<100n),null],
    [{inputs:[1,...ids(A,poolAB,B,poolCB,C),0]},/swap2 expects 12 inputs/],
    [{inputs:[99]},/Unrecognized opcode 99/],[{inputs:[]},/No opcode provided/],
  ];
  const results=differential(pair,router,steps,{},{setup});
  const {ok,failed}=outcomes(results);
  assert.ok(ok>=8&&failed>=15,`${ok} successes, ${failed} failures`);
});
