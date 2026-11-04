import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {AlkanesVM,u128} from './vm.mjs';
import {buildLibrary} from '../scripts/build.mjs';

// dist/share-vault.wasm is built by `npm run build` (npm test rebuilds first).
// Each fixture contract is built into its own directory so concurrently
// running test files never share a work tree: the auth token CappedToken uses,
// an auth token that reenters its caller, and a relay that calls the vault.
function buildFixture(name,source){
  const work=resolve(`build/share-vault-${name}`);mkdirSync(work,{recursive:true});
  writeFileSync(join(work,'entry.ts'),`import contract from ${JSON.stringify(resolve(source))};
import {executeContract,contractMeta} from ${JSON.stringify(resolve('sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
  buildLibrary({entry:join(work,'entry.ts'),work,out:join(work,`${name}.wasm`)});
  return readFileSync(join(work,`${name}.wasm`));
}
const vaultWasm=readFileSync('dist/share-vault.wasm');
const authWasm=buildFixture('auth','test/fixtures/test-auth.ts');
const reenterWasm=buildFixture('reenter','test/fixtures/sv-reenter-auth.ts');
const relayWasm=buildFixture('relay','test/fixtures/sv-relay.ts');

const vault={block:2n,tx:1n},asset={block:2n,tx:5n},other={block:2n,tx:7n},authority={block:4n,tx:9001n};
const authToken={id:authority,value:1n};
const MAX=(1n<<128n)-1n,V=1000n;
// Vesting period of setup()'s vault, in blocks, and harvest's share minimum.
const D=100n,MIN_SHARES=1_000_000n;

// Reference model: one virtual asset, 1000 virtual shares, both directions
// floor, priced against unlocked assets (pricing() below).
const toShares=(x,t)=>x*(t.shares+V)/(t.assets+1n);
const toAssets=(s,t)=>s*(t.assets+1n)/(t.shares+V);
// Reference lock: ceil(L * r / d) with r = max(0, H + d - h), never above L.
// Redemptions (and lockedProfit) use it; deposits use the floor, so the
// rounding favors the vault both ways.
const lockedAt=(L,H,d,h)=>{const r=H+d>h?H+d-h:0n;const c=r<d?r:d;return (L*c+d-1n)/d;};
const lockedFloorAt=(L,H,d,h)=>{const r=H+d>h?H+d-h:0n;const c=r<d?r:d;return L*c/d;};

function setup({mode=0,init=true,vesting=D}={}){
  const vm=new AlkanesVM();
  vm.deploy(vault,vaultWasm);
  vm.deploy(authority,authWasm);
  vm.call({target:authority,inputs:[0,mode]});
  if(init)vm.call({target:vault,inputs:[0,asset.block,asset.tx,authority.block,authority.tx,vesting]});
  return vm;
}
const view=(vm,opcode,...args)=>u128.decode(vm.call({target:vault,inputs:[opcode,...args]}).data);
// Stored totals: totalAssets includes yield that is still vesting.
const totals=vm=>({assets:view(vm,10),shares:view(vm,11)});
// What redemptions price against: totalAssets minus lockedProfit.
const pricing=vm=>({assets:view(vm,10)-view(vm,17),shares:view(vm,11)});
// What deposits price against: totalAssets minus the lock rounded down, for a
// lock of L harvested at height H.
const depositPricing=(vm,L,H,d=D)=>({assets:view(vm,10)-lockedFloorAt(L,H,d,vm.height),shares:view(vm,11)});
const elapse=(vm,blocks)=>{vm.height+=blocks;};
const deposit=(vm,x,min=0n,extra=[])=>vm.call({target:vault,inputs:[1,min],incoming:[{id:asset,value:x},...extra]});
const redeem=(vm,s,min=0n,extra=[])=>vm.call({target:vault,inputs:[2,min],incoming:[{id:vault,value:s},...extra]});
const harvest=(vm,extra=[])=>vm.call({target:vault,inputs:[3],incoming:[authToken,...extra]});
const out=r=>u128.decode(r.data);
const paid=(response,id)=>response.alkanes.filter(t=>t.id.block===id.block&&t.id.tx===id.tx).reduce((s,t)=>s+t.value,0n);
const custody=vm=>vm.balanceOf(vault,asset);
// Models an out-of-band transfer into the vault's balance. Tracked entrypoints
// refund everything they do not retain, so a test has to credit it directly.
const donate=(vm,amount)=>vm.setBalance(vault,asset,custody(vm)+amount);
const authCalls=vm=>u128.decode(vm.call({target:authority,inputs:[2]}).data);
// Everything observable, for rollback checks.
const snapshot=vm=>({...totals(vm),locked:view(vm,17),custody:custody(vm),own:vm.balanceOf(vault,vault),other:vm.balanceOf(vault,other),auth:vm.balanceOf(vault,authority)});
// I1, I2 and I5 from the contract, plus the harvest preview.
function assertBacked(vm){
  const t=totals(vm),held=custody(vm),locked=view(vm,17);
  assert.ok(held>=t.assets,`custody ${held} < totalAssets ${t.assets}`);
  assert.ok(locked<=t.assets,`locked ${locked} > totalAssets ${t.assets}`);
  assert.ok(t.shares<=V*(t.assets-locked),`price fell below 1/1000: ${t.assets-locked} unlocked assets for ${t.shares} shares`);
  assert.equal(view(vm,16),held-t.assets);
  // No unrelated asset or authority token is ever kept.
  assert.equal(vm.balanceOf(vault,other),0n);assert.equal(vm.balanceOf(vault,authority),0n);
  return t;
}

test('ShareVault initializes once with distinct asset/authority IDs and a bounded vesting period, and gates every entrypoint',()=>{
  const vm=setup({init:false});
  assert.deepEqual(vm.meta(vault),JSON.parse(readFileSync('dist/share-vault.abi.json','utf8')));
  for(const inputs of [[1,0],[2,0],[3],[10],[11],[12,1],[13,1],[14],[15],[16],[17],[18]])assert.throws(()=>vm.call({target:vault,inputs}),/NOT_INITIALIZED/);
  const init=(a,b,d=D)=>vm.call({target:vault,inputs:[0,a.block,a.tx,b.block,b.tx,d]});
  assert.throws(()=>init(vault,authority),/INVALID_ASSET/);
  assert.throws(()=>init(asset,vault),/INVALID_AUTHORITY/);
  assert.throws(()=>init(asset,asset),/INVALID_AUTHORITY/);
  assert.throws(()=>init(asset,authority,0n),/INVALID_VESTING/);
  assert.throws(()=>init(asset,authority,1_051_201n),/INVALID_VESTING/);
  assert.throws(()=>init(asset,authority,MAX),/INVALID_VESTING/);
  assert.throws(()=>vm.call({target:vault,inputs:[0,asset.block,asset.tx,authority.block,authority.tx]}),/initialize expects 5 inputs/);
  assert.throws(()=>vm.call({target:vault,inputs:[0,asset.block,asset.tx,authority.block,authority.tx,D],incoming:[{id:asset,value:1n}]}),/rejects incoming assets/);
  assert.equal(custody(vm),0n);
  init(asset,authority);
  assert.throws(()=>init(asset,authority),/ALREADY_INITIALIZED/);
  assert.deepEqual(vm.call({target:vault,inputs:[14]}).data,u128.list([asset.block,asset.tx]));
  assert.deepEqual(vm.call({target:vault,inputs:[15]}).data,u128.list([authority.block,authority.tx]));
  assert.deepEqual(totals(vm),{assets:0n,shares:0n});
  assert.equal(view(vm,17),0n);assert.equal(view(vm,18),D);
  assert.equal(view(vm,12,1n),1000n);assert.equal(view(vm,13,1000n),1n);
  // Both ends of the vesting range are accepted.
  for(const vesting of [1n,1_051_200n])assert.equal(view(setup({vesting}),18),vesting);
});

test('ShareVault first deposit issues 1000 shares per asset, retains the underlying and refunds the rest',()=>{
  const vm=setup();
  assert.equal(view(vm,12,1_000_000n),1_000_000_000n);
  const r=deposit(vm,1_000_000n);
  assert.equal(out(r),1_000_000_000n);
  assert.deepEqual(r.alkanes,[{id:vault,value:1_000_000_000n}]);
  assert.deepEqual(assertBacked(vm),{assets:1_000_000n,shares:1_000_000_000n});
  assert.equal(custody(vm),1_000_000n);
  // Split underlying transfers are summed; unrelated assets and incoming
  // shares are refunded exactly.
  const r2=deposit(vm,300n,0n,[{id:other,value:7n},{id:asset,value:200n},{id:vault,value:5n}]);
  assert.equal(out(r2),500_000n);
  assert.equal(paid(r2,asset),0n);assert.equal(paid(r2,other),7n);assert.equal(paid(r2,vault),500_005n);
  assert.deepEqual(assertBacked(vm),{assets:1_000_500n,shares:1_000_500_000n});
  assert.throws(()=>vm.call({target:vault,inputs:[1,0]}),/ZERO_ASSETS/);
  assert.throws(()=>vm.call({target:vault,inputs:[1,0],incoming:[{id:other,value:1n}]}),/ZERO_ASSETS/);
  assert.throws(()=>vm.call({target:vault,inputs:[1]}),/expects 1 inputs/);
});

test('ShareVault deposits and redeems stay proportional through yield',()=>{
  const vm=setup();
  deposit(vm,1_000_000n);                       // alice: 1e9 shares
  const bob=out(deposit(vm,3_000_000n));        // same price for the second depositor
  assert.equal(bob,3_000_000_000n);
  // 10% yield, delivered with the harvest call itself, fully vested.
  assert.equal(out(harvest(vm,[{id:asset,value:400_000n}])),400_000n);
  elapse(vm,D);
  let t=assertBacked(vm);
  assert.deepEqual(t,{assets:4_400_000n,shares:4_000_000_000n});
  assert.deepEqual(pricing(vm),t);
  // A later deposit pays the higher price; nobody is diluted.
  const carol=out(deposit(vm,1_100_000n));
  assert.equal(carol,toShares(1_100_000n,t));
  t=assertBacked(vm);
  // Each holder redeems their proportional share (minus virtual-share dust).
  const expectBob=toAssets(bob,t);
  const r=redeem(vm,bob);
  assert.equal(out(r),expectBob);assert.deepEqual(r.alkanes,[{id:asset,value:expectBob}]);
  assert.ok(expectBob>3_300_000n-5n&&expectBob<=3_300_000n,`${expectBob}`);
  t=assertBacked(vm);
  const expectCarol=toAssets(carol,t);
  assert.equal(out(redeem(vm,carol)),expectCarol);
  assert.ok(expectCarol>1_100_000n-5n&&expectCarol<=1_100_000n,`${expectCarol}`);
  t=assertBacked(vm);
  const expectAlice=toAssets(1_000_000_000n,t);
  assert.equal(out(redeem(vm,1_000_000_000n)),expectAlice);
  assert.ok(expectAlice>1_100_000n-5n&&expectAlice<=1_100_000n,`${expectAlice}`);
  t=assertBacked(vm);
  // All shares redeemed: only rounding dust owned by the virtual shares remains.
  assert.equal(t.shares,0n);assert.ok(t.assets<5n);
  assert.equal(custody(vm),t.assets);
  // Redeemed shares stay in vault custody, out of circulation, and are
  // reissued before any new shares are minted.
  const redeemed=bob+carol+1_000_000_000n;
  assert.equal(vm.balanceOf(vault,vault),redeemed);
  const again=out(deposit(vm,1n));
  assert.equal(again,toShares(1n,t));
  assert.equal(vm.balanceOf(vault,vault),redeemed-again);
  assertBacked(vm);
});

test('ShareVault rounds both directions down at tiny amounts, exactly as previewed',()=>{
  const vm=setup();
  assert.equal(out(deposit(vm,1n)),1000n);
  // 1000 shares are worth exactly one asset; fewer round down to nothing.
  for(const s of [1n,500n,999n])assert.equal(view(vm,13,s),0n);
  assert.throws(()=>redeem(vm,999n),/ZERO_ASSETS/);
  assert.equal(view(vm,13,1000n),1n);
  // Harvest needs a million circulating shares. Vested yield then moves the
  // conversion rate to (1020+1)/(1e6+1000) assets per share: 1 asset buys
  // 980 shares (980.4 rounded down), and after that deposit 980 shares
  // redeem for 980*1022/1001980 = 0.9996 -> 0 assets.
  assert.equal(out(deposit(vm,999n)),999_000n);
  assert.equal(out(harvest(vm,[{id:asset,value:20n}])),20n);
  elapse(vm,D);
  let t=assertBacked(vm);
  assert.deepEqual(t,{assets:1020n,shares:1_000_000n});
  for(let x=1n;x<=40n;x++)assert.equal(view(vm,12,x),toShares(x,t),`deposit ${x}`);
  for(let s=1n;s<=3000n;s+=71n)assert.equal(view(vm,13,s),toAssets(s,t),`redeem ${s}`);
  assert.equal(out(deposit(vm,1n)),980n);
  t=assertBacked(vm);
  assert.deepEqual(t,{assets:1021n,shares:1_000_980n});
  assert.equal(view(vm,13,980n),0n);
  assert.throws(()=>redeem(vm,980n),/ZERO_ASSETS/);
  assert.equal(out(redeem(vm,981n)),1n);
  // 999,999 circulating shares are one short of what harvest requires.
  assert.deepEqual(assertBacked(vm),{assets:1020n,shares:999_999n});
  assert.throws(()=>harvest(vm,[{id:asset,value:1_000_000_000n}]),/INSUFFICIENT_SHARES/);
  assert.equal(out(deposit(vm,1n)),980n);
  // A high price makes one asset worth less than one share: deposit reverts
  // instead of taking the asset for nothing.
  harvest(vm,[{id:asset,value:1_000_000_000n}]);
  elapse(vm,D);
  t=assertBacked(vm);
  assert.equal(view(vm,12,1n),0n);
  assert.throws(()=>deposit(vm,1n),/ZERO_SHARES/);
  const x=(t.assets+1n)/(t.shares+V)+1n;
  assert.equal(out(deposit(vm,x)),toShares(x,t));
  assertBacked(vm);
});

test('ShareVault ignores donations before and after the first deposit until harvested',()=>{
  // Donation into an empty vault: the price does not move.
  let vm=setup();
  donate(vm,10n**18n);
  assert.equal(view(vm,12,100n),100_000n);
  assert.equal(view(vm,16),10n**18n);
  assert.equal(out(deposit(vm,100n)),100_000n);
  assert.equal(out(redeem(vm,100_000n)),100n);
  assert.deepEqual(assertBacked(vm),{assets:0n,shares:0n});
  // The donation is still unclaimed, and harvest refuses to fold it while
  // fewer than a million shares circulate, so it is not stranded with the
  // virtual shares of an empty vault.
  assert.throws(()=>harvest(vm),/INSUFFICIENT_SHARES/);
  assert.equal(custody(vm),10n**18n);

  // Classic attack: be first, shrink circulation to one share, then donate.
  vm=setup();
  deposit(vm,1n);deposit(vm,1n);
  assert.equal(out(redeem(vm,1999n)),1n);        // 1 share left, worth 2/1001 assets
  assert.deepEqual(assertBacked(vm),{assets:1n,shares:1n});
  donate(vm,10n**18n);
  // The victim still buys at the stored price and loses nothing.
  const t=totals(vm);
  const victim=out(deposit(vm,5_000n));
  assert.equal(victim,toShares(5_000n,t));
  assert.equal(victim,2_502_500n);
  assert.equal(view(vm,13,victim),5_000n);
  // The attacker's last share is worth nothing; the donation stays pending.
  assert.equal(view(vm,13,1n),0n);
  assert.equal(out(redeem(vm,victim)),5_000n);
  assertBacked(vm);
  assert.equal(view(vm,16),10n**18n);
});

test('ShareVault makes rounding-driven price inflation cost the attacker far more than any victim loses',()=>{
  const vm=setup();
  let spent=0n,received=0n,held=0n;
  const dep=x=>{const s=out(deposit(vm,x));spent+=x;held+=s;return s;};
  const red=s=>{const a=out(redeem(vm,s));received+=a;held-=s;return a;};
  dep(1n);dep(1n);red(1999n);
  // Each round deposits and then redeems all but one share, choosing the
  // redemption with the largest rounding remainder so as much value as
  // possible is left behind to raise the price per share.
  for(let round=0;round<20;round++){
    dep(1000n);
    const t=totals(vm);
    let best=0n,bestRemainder=-1n;
    for(let s=held-1n;s>0n&&s>held-2000n;s--){
      const a=toAssets(s,t);
      const remainder=s*(t.assets+1n)-a*(t.shares+V);
      if(a>0n&&remainder>bestRemainder){best=s;bestRemainder=remainder;}
    }
    red(best);
    assertBacked(vm);
  }
  const t=totals(vm);
  const attackerLoss=spent-received-toAssets(held,t);
  // Fewer than one asset per round was left behind, and the virtual shares
  // own almost all of it, so the price per share barely moved.
  assert.ok(attackerLoss>=10n,`attacker lost ${attackerLoss}`);
  assert.ok(view(vm,12,1n)>=50n);
  // A victim round trip loses at most one unit, whatever the size.
  for(const amount of [1n,10n,12_345n,10n**15n]){
    const before=totals(vm);
    const shares=out(deposit(vm,amount));
    assert.equal(shares,toShares(amount,before));
    // One asset buys fewer shares than redeem one asset, so that round trip
    // cannot redeem at all; it is the one-unit loss.
    const back=view(vm,13,shares);
    if(back>0n)assert.equal(out(redeem(vm,shares)),back);
    else assert.throws(()=>redeem(vm,shares),/ZERO_ASSETS/);
    assert.ok(amount-back<=1n,`victim lost ${amount-back} of ${amount}`);
    assert.ok((amount-back)*10n<=attackerLoss);
    assertBacked(vm);
  }
});

test('ShareVault redemption refunds incoming underlying and unrelated assets and checks slippage',()=>{
  const vm=setup();
  deposit(vm,1_000_000n);harvest(vm,[{id:asset,value:123_457n}]);elapse(vm,D);
  const before=snapshot(vm);
  const t=totals(vm),expected=toAssets(400_000_000n,t);
  assert.equal(view(vm,13,400_000_000n),expected);
  assert.throws(()=>redeem(vm,400_000_000n,expected+1n),/SLIPPAGE/);
  assert.deepEqual(snapshot(vm),before);
  const r=redeem(vm,400_000_000n,expected,[{id:asset,value:9n},{id:other,value:3n}]);
  assert.equal(out(r),expected);
  assert.equal(paid(r,asset),expected+9n);assert.equal(paid(r,other),3n);assert.equal(paid(r,vault),0n);
  assert.deepEqual(assertBacked(vm),{assets:t.assets-expected,shares:t.shares-400_000_000n});
  assert.equal(vm.balanceOf(vault,vault),400_000_000n);
  assert.throws(()=>vm.call({target:vault,inputs:[2,0],incoming:[{id:asset,value:5n}]}),/ZERO_SHARES/);
  // Deposit slippage, at the exact boundary.
  const quote=view(vm,12,777n);
  assert.throws(()=>deposit(vm,777n,quote+1n),/SLIPPAGE/);
  assert.equal(out(deposit(vm,777n,quote)),quote);
  assertBacked(vm);
});

test('ShareVault harvest requires the authority token and folds excess custody into a vesting lock',()=>{
  const vm=setup();
  assert.throws(()=>harvest(vm),/INSUFFICIENT_SHARES/); // authenticated, but nothing to fold into
  assert.equal(authCalls(vm),0n);                       // and the auth call rolled back
  deposit(vm,1_000_000n);
  donate(vm,50_000n);
  const before=snapshot(vm);
  assert.throws(()=>vm.call({target:vault,inputs:[3]}),/AUTH_ASSET_REQUIRED/);
  assert.throws(()=>vm.call({target:vault,inputs:[3],incoming:[{id:other,value:1n}]}),/AUTH_ASSET_REQUIRED/);
  assert.throws(()=>vm.call({target:vault,inputs:[3],incoming:[{id:authority,value:0n}]}),/AUTH_ASSET_REQUIRED/);
  // A vault share is not the authority, however many are sent.
  assert.throws(()=>vm.call({target:vault,inputs:[3],incoming:[{id:vault,value:1_000_000n}]}),/AUTH_ASSET_REQUIRED/);
  assert.deepEqual(snapshot(vm),before);
  // Success: the donation and the yield sent with the call are folded in; the
  // auth token and unrelated assets go back.
  const r=harvest(vm,[{id:asset,value:25_000n},{id:other,value:4n}]);
  assert.equal(out(r),75_000n);
  assert.equal(paid(r,authority),1n);assert.equal(paid(r,other),4n);assert.equal(paid(r,asset),0n);
  assert.equal(authCalls(vm),1n);
  assert.deepEqual(assertBacked(vm),{assets:1_075_000n,shares:1_000_000_000n});
  assert.equal(view(vm,16),0n);
  // totalAssets includes the gain at once; the price only once it vests.
  assert.equal(view(vm,17),75_000n);
  assert.deepEqual(pricing(vm),{assets:1_000_000n,shares:1_000_000_000n});
  // A second harvest with nothing pending folds nothing and keeps the lock.
  assert.equal(out(harvest(vm)),0n);
  assert.equal(authCalls(vm),2n);
  assert.equal(view(vm,17),75_000n);
  // Extra authority tokens are all returned.
  assert.equal(paid(harvest(vm,[{id:authority,value:2n}]),authority),3n);
  elapse(vm,D);
  assert.equal(view(vm,17),0n);
  assert.deepEqual(pricing(vm),{assets:1_075_000n,shares:1_000_000_000n});
  assertBacked(vm);
});

test('ShareVault harvest rolls back completely when the authority rejects or fails',()=>{
  for(const [mode,error] of [[1,/AUTH_REJECTED/],[2,/AUTH_FAILURE/]]){
    const vm=setup({mode});
    deposit(vm,1_000_000n);donate(vm,50_000n);
    const before=snapshot(vm);
    assert.throws(()=>harvest(vm,[{id:asset,value:10n}]),error);
    assert.deepEqual(snapshot(vm),before);
    assert.equal(authCalls(vm),0n);
    assert.equal(view(vm,16),50_000n);
    // Deposits and redemptions never consult the authority.
    assert.equal(out(redeem(vm,1_000_000_000n)),1_000_000n);
    assertBacked(vm);
  }
});

test('ShareVault views reject assets and failed methods roll back every effect',()=>{
  const vm=setup();
  deposit(vm,1_000_000n);
  harvest(vm,[{id:asset,value:10_000n}]);elapse(vm,D/2n);
  const before=snapshot(vm);
  assert.equal(before.locked,5_000n);
  for(const inputs of [[10],[11],[12,1],[13,1],[14],[15],[16],[17],[18]]){
    assert.throws(()=>vm.call({target:vault,inputs,incoming:[{id:asset,value:1n}]}),/rejects incoming assets/);
  }
  // Shares beyond circulation cannot exist on chain; if they did, redeem would
  // still fail closed on the checked subtraction instead of overpaying.
  assert.throws(()=>redeem(vm,2_000_000_000n),/u128 underflow/);
  // Over-sized deposits fail after the host credited them.
  assert.throws(()=>deposit(vm,MAX/500n),/u128 overflow|VAULT_FULL/);
  assert.throws(()=>deposit(vm,1n,1001n),/SLIPPAGE/);
  assert.deepEqual(snapshot(vm),before);
  assert.throws(()=>vm.call({target:vault,inputs:[99]}),/Unrecognized opcode/);
  assertBacked(vm);
});

test('ShareVault keeps u128 boundaries: largest deposit, VAULT_FULL, overflow and full redemption',()=>{
  // shares = 1000x must leave room for the 1000 virtual shares.
  const largest=(MAX-V)/V;
  let vm=setup();
  // A share count beyond u128 overflows in deposit and in its preview alike.
  assert.throws(()=>view(vm,12,largest+2n),/u128 overflow/);
  assert.throws(()=>deposit(vm,largest+2n),/u128 overflow/);
  assert.equal(view(vm,12,largest+1n),0n);
  assert.throws(()=>deposit(vm,largest+1n),/VAULT_FULL/);
  assert.equal(view(vm,12,largest),largest*V);
  assert.equal(out(deposit(vm,largest)),largest*V);
  let t=assertBacked(vm);
  assert.equal(t.shares+V<=MAX,true);
  assert.equal(view(vm,12,1n),0n);
  assert.throws(()=>deposit(vm,1n),/VAULT_FULL/);
  // Previews stay computable at the edge (the exact product is 256 bits).
  assert.equal(view(vm,13,t.shares),largest);
  assert.equal(view(vm,12,MAX),0n);
  assert.equal(out(redeem(vm,t.shares)),largest);
  assert.deepEqual(assertBacked(vm),{assets:0n,shares:0n});
  assert.equal(custody(vm),0n);

  // managed + 1 must fit: harvesting a full-width custody is refused.
  vm=setup();
  deposit(vm,1000n);                            // the million shares harvest needs
  vm.setBalance(vault,asset,MAX);
  assert.throws(()=>harvest(vm),/VAULT_FULL/);
  vm.setBalance(vault,asset,MAX-1n);
  assert.equal(out(harvest(vm)),MAX-1001n);
  t=assertBacked(vm);
  assert.deepEqual(t,{assets:MAX-1n,shares:1_000_000n});
  // Even a full-width gain leaves the price alone until it vests.
  assert.equal(view(vm,17),MAX-1001n);
  assert.equal(view(vm,13,1_000_000n),1000n);
  elapse(vm,D-1n);
  assert.equal(view(vm,17),(MAX-1001n+D-1n)/D);
  elapse(vm,1n);
  t=assertBacked(vm);
  assert.equal(view(vm,17),0n);
  // No room is left for assets: previews are 0, and the host refuses to
  // credit the vault past u128.
  assert.equal(view(vm,12,1n),0n);assert.equal(view(vm,12,MAX),0n);
  assert.throws(()=>deposit(vm,2n),/balance overflow/);
  assert.throws(()=>deposit(vm,1n),/VAULT_FULL/);
  // A million real shares beside the 1000 virtual ones own 1000/1001 of it.
  const all=toAssets(1_000_000n,t);
  assert.equal(all,MAX*1000n/1001n);
  assert.equal(out(redeem(vm,1_000_000n)),all);
  assertBacked(vm);
});

test('ShareVault never lets redeemable value exceed custody across a random operation sequence',()=>{
  const vm=setup();
  let seed=0x5eed1234n;
  const next=bound=>{seed=(seed*6364136223846793005n+1442695040888963407n)&((1n<<64n)-1n);return (seed>>16n)%bound;};
  const holders=[0n,0n,0n];
  let deposited=0n,withdrawn=0n,yieldIn=0n,harvests=0,lockL=0n,lockH=0n;
  for(let step=0;step<120;step++){
    const t=pricing(vm),action=next(12n),who=Number(next(3n));
    if(action<4n){
      const x=1n+next([10n,1000n,10n**9n,10n**24n][Number(next(4n))]);
      const s=toShares(x,depositPricing(vm,lockL,lockH));
      if(s===0n){assert.throws(()=>deposit(vm,x),/ZERO_SHARES/);continue;}
      assert.equal(view(vm,12,x),s);
      assert.equal(out(deposit(vm,x,s)),s);
      holders[who]+=s;deposited+=x;
    }else if(action<7n){
      if(holders[who]===0n)continue;
      const s=1n+next(holders[who]);
      const a=toAssets(s,t);
      if(a===0n){assert.throws(()=>redeem(vm,s),/ZERO_ASSETS/);continue;}
      assert.throws(()=>redeem(vm,s,a+1n),/SLIPPAGE/);
      assert.equal(out(redeem(vm,s,a)),a);
      holders[who]-=s;withdrawn+=a;
    }else if(action<8n){
      donate(vm,next(10n**6n));
    }else if(action<10n){
      elapse(vm,next(D));
    }else{
      const y=next(10n**6n);
      if(t.shares<MIN_SHARES){assert.throws(()=>harvest(vm,[{id:asset,value:y}]),/INSUFFICIENT_SHARES/);continue;}
      const pending=custody(vm)-totals(vm).assets;
      assert.equal(out(harvest(vm,y?[{id:asset,value:y}]:[])),pending+y);
      // The harvest itself never moves the price.
      assert.deepEqual(pricing(vm),t);
      lockL=lockedAt(lockL,lockH,D,vm.height)+pending+y;lockH=vm.height;
      yieldIn+=pending+y;harvests++;
    }
    const now=assertBacked(vm);
    assert.equal(view(vm,17),lockedAt(lockL,lockH,D,vm.height));
    assert.equal(now.shares,holders.reduce((a,b)=>a+b,0n));
    assert.equal(now.assets,deposited+yieldIn-withdrawn);
  }
  assert.ok(harvests>=3,`only ${harvests} harvests ran`);
  // Everyone exits once the yield has vested, one after another: the stored
  // totals pay every holder and never more than custody.
  elapse(vm,D);
  for(let i=0;i<holders.length;i++){
    if(holders[i]===0n)continue;
    const t=pricing(vm),a=toAssets(holders[i],t);
    if(a>0n){assert.equal(out(redeem(vm,holders[i])),a);withdrawn+=a;holders[i]=0n;}
    assertBacked(vm);
  }
  const end=totals(vm);
  assert.ok(withdrawn<=deposited+yieldIn);
  assert.equal(end.assets,deposited+yieldIn-withdrawn);
  assert.ok(custody(vm)>=end.assets);
});

test('ShareVault reentrancy lock blocks every callback from the auth contract during harvest',()=>{
  for(const [mode,what] of [[1n,'deposit'],[2n,'totalAssets view (staticcall)'],[3n,'redeem'],[4n,'nested harvest']]){
    const vm=new AlkanesVM();
    vm.deploy(vault,vaultWasm);vm.deploy(authority,reenterWasm);
    vm.call({target:authority,inputs:[0,mode]});
    vm.call({target:vault,inputs:[0,asset.block,asset.tx,authority.block,authority.tx,D]});
    deposit(vm,1_000_000n);
    // Give the auth contract what its callback needs so only the lock can stop it.
    vm.setBalance(authority,asset,100n);vm.setBalance(authority,vault,1000n);vm.setBalance(authority,authority,5n);
    const before=snapshot(vm);
    assert.throws(()=>harvest(vm,[{id:asset,value:10n}]),/REENTRANT_CALL/,`${what} reentered`);
    assert.deepEqual(snapshot(vm),before);
    assert.equal(vm.balanceOf(authority,asset),100n);
  }
});

test('ShareVault harvest refuses dust circulation, returns the yield, and leaves the virtual shares under 0.1% of it',()=>{
  const vm=setup();
  const Y=1_000_000n;
  const refused=()=>{
    const before=snapshot(vm);
    assert.throws(()=>harvest(vm,[{id:asset,value:Y}]),/INSUFFICIENT_SHARES/);
    // The revert undoes the whole call: the yield never enters custody, so
    // it goes back to the sender, and the auth call is rolled back too.
    assert.deepEqual(snapshot(vm),before);
    assert.equal(authCalls(vm),0n);
  };
  refused();                                    // empty vault
  // A griefer front-runs the harvest: deposits 2 units and redeems all but
  // one share (net cost: 1 unit) so that issued = 1 > 0. That no longer
  // lets the harvest through to strand the yield with the virtual shares.
  deposit(vm,1n);deposit(vm,1n);
  assert.equal(out(redeem(vm,1999n)),1n);
  assert.deepEqual(totals(vm),{assets:1n,shares:1n});
  refused();
  // A real holder brings circulation to exactly a million shares, and the
  // same harvest succeeds.
  const holder=out(deposit(vm,1998n));
  assert.equal(holder,999_999n);
  assert.equal(totals(vm).shares,MIN_SHARES);
  assert.equal(out(harvest(vm,[{id:asset,value:Y}])),Y);
  elapse(vm,D);
  const t=assertBacked(vm);
  // Once vested, all circulating shares together can claim all but the
  // virtual shares' slice, which is under 0.1% of the vault.
  const claimable=toAssets(t.shares,t);
  assert.ok((t.assets-claimable)*1000n<t.assets,`virtual shares keep ${t.assets-claimable} of ${t.assets}`);
  const got=out(redeem(vm,holder));
  assert.ok(got-1998n>=Y*999n/1000n,`holder earned ${got-1998n} of ${Y}`);
  // The griefer's dust share is worth its one unit and none of the yield.
  assert.equal(out(redeem(vm,1n)),1n);
  assertBacked(vm);
});

test('ShareVault harvest into a nearly empty vault reverts instead of paying a one-unit depositor half the yield',()=>{
  const vm=setup();
  const Y=10_000_000n;
  // Attacker sees harvest(+Y) in the mempool and deposits a single unit first.
  const s=out(deposit(vm,1n));
  assert.throws(()=>harvest(vm,[{id:asset,value:Y}]),/INSUFFICIENT_SHARES/);
  assert.equal(custody(vm),1n);
  const got=out(redeem(vm,s));
  assert.equal(got,1n,`1 unit deposited for one block returned ${got} of ${Y} yield`);
  assert.deepEqual(assertBacked(vm),{assets:0n,shares:0n});
});

test('ShareVault vests harvested yield so a just-in-time deposit earns nothing and the long-term holder keeps it',()=>{
  const Y=100_000n,spent=99_000_000n;
  const run=heldBlocks=>{
    const vm=setup();
    const alice=out(deposit(vm,1_000_000n));
    elapse(vm,1000n);
    // The authority's harvest(+Y) is visible in the mempool; the attacker
    // deposits in the same block just before it confirms.
    const att=out(deposit(vm,spent));
    const quote=view(vm,13,att);
    assert.ok(quote<=spent);
    harvest(vm,[{id:asset,value:Y}]);
    // totalAssets includes the whole gain at once, but all of it is locked,
    // so the attacker's shares are worth what it paid.
    assert.equal(view(vm,17),Y);
    assert.equal(view(vm,13,att),quote);
    elapse(vm,heldBlocks);
    const got=out(redeem(vm,att));
    // Alice held all period; after the rest vests she has the yield.
    elapse(vm,D);
    const aliceGain=view(vm,13,alice)-1_000_000n;
    assertBacked(vm);
    return {earned:got-spent,aliceGain};
  };
  // Redeemed right after the harvest: the attacker earns nothing and Alice
  // gets all of the yield except rounding.
  const now=run(0n);
  assert.ok(now.earned<=0n,`attacker earned ${now.earned} in one block`);
  assert.ok(now.aliceGain>=Y-2n,`alice (held all period) earned ${now.aliceGain}; attacker (one block) earned ${now.earned} of ${Y}`);
  // Each block held earns the attacker only its 99% of the 1/D that vested,
  // and the rest still reaches Alice.
  const later=run(1n);
  assert.ok(later.earned>0n&&later.earned<=Y*99n/100n/D,`attacker earned ${later.earned} in one block`);
  assert.ok(later.aliceGain+later.earned>=Y-2n&&later.aliceGain+later.earned<=Y);
  const half=run(D/2n);
  assert.ok(half.earned<=Y*99n/100n/2n&&half.earned>=Y*99n/100n/2n-2n,`attacker earned ${half.earned} in D/2 blocks`);
});

test('ShareVault unlocks harvested yield linearly, pricing redemptions against the lock rounded up and deposits against it rounded down',()=>{
  const d=7n,Y=1000n;                           // 1000/7 is not whole, so rounding shows
  const vm=setup({vesting:d});
  deposit(vm,1_000_000n);
  const H=vm.height;
  harvest(vm,[{id:asset,value:Y}]);
  // ceil(1000*(7-k)/7) for k blocks after the harvest.
  const expected=[1000n,858n,715n,572n,429n,286n,143n,0n,0n,0n];
  for(let k=0n;k<BigInt(expected.length);k++){
    vm.height=H+k;
    const locked=view(vm,17);
    assert.equal(locked,expected[k]);
    assert.equal(locked,lockedAt(Y,H,d,vm.height));
    const t=pricing(vm);
    assert.deepEqual(t,{assets:1_001_000n-locked,shares:1_000_000_000n});
    const forDeposits={assets:1_001_000n-lockedFloorAt(Y,H,d,vm.height),shares:1_000_000_000n};
    for(const x of [1n,999n,123_456n])assert.equal(view(vm,12,x),toShares(x,forDeposits),`deposit ${x} at +${k}`);
    for(const s of [999n,1_000_000n,1_000_000_000n])assert.equal(view(vm,13,s),toAssets(s,t),`redeem ${s} at +${k}`);
    assertBacked(vm);
  }
  // A height before the harvest cannot occur on chain; it would still report
  // no more than the harvest locked.
  vm.height=H-5n;
  assert.equal(view(vm,17),Y);

  // Mid-vesting deposits and redemptions price at the same unlocked totals
  // and leave the lock alone.
  const mid=setup({vesting:d});
  deposit(mid,1_000_000n);
  const midH=mid.height;
  harvest(mid,[{id:asset,value:Y}]);
  elapse(mid,3n);
  // floor(1000 * 4 / 7) = 571 for the deposit, 572 for everything else.
  const s=out(deposit(mid,5_000n));
  assert.equal(lockedFloorAt(Y,midH,d,mid.height),571n);
  assert.equal(s,toShares(5_000n,{assets:1_001_000n-571n,shares:1_000_000_000n}));
  assert.equal(view(mid,17),572n);
  let t=pricing(mid);
  assert.equal(out(redeem(mid,s)),toAssets(s,t));
  assert.equal(view(mid,17),572n);
  assertBacked(mid);

  // A one-block period still keeps a same-block deposit out of the harvest.
  const fast=setup({vesting:1n});
  deposit(fast,1_000_000n);
  harvest(fast,[{id:asset,value:Y}]);
  assert.equal(view(fast,17),Y);
  assert.equal(view(fast,13,1_000_000_000n),1_000_000n);
  elapse(fast,1n);
  assert.equal(view(fast,17),0n);
  assert.equal(view(fast,13,1_000_000_000n),toAssets(1_000_000_000n,totals(fast)));
});

test('ShareVault relocks the unvested remainder with a second harvest during vesting',()=>{
  const vm=setup();
  deposit(vm,1_000_000n);
  harvest(vm,[{id:asset,value:30_000n}]);
  elapse(vm,40n);
  assert.equal(view(vm,17),18_000n);            // 60% of the first gain still locked
  const t=pricing(vm),quote=view(vm,13,1_000_000_000n);
  assert.deepEqual(t,{assets:1_012_000n,shares:1_000_000_000n});
  // A donation and the yield sent with the call make the second gain.
  donate(vm,5_000n);
  assert.equal(out(harvest(vm,[{id:asset,value:7_000n}])),12_000n);
  // The new lock is the unvested 18,000 plus the new 12,000, from this
  // height: the harvest itself never moves the price.
  assert.equal(view(vm,17),30_000n);
  assert.deepEqual(pricing(vm),t);
  assert.equal(view(vm,13,1_000_000_000n),quote);
  assert.deepEqual(assertBacked(vm),{assets:1_042_000n,shares:1_000_000_000n});
  // All of it vests over a full new period.
  elapse(vm,50n);
  assert.equal(view(vm,17),15_000n);
  elapse(vm,49n);
  assert.equal(view(vm,17),300n);
  elapse(vm,1n);
  assert.equal(view(vm,17),0n);
  const vested=pricing(vm);
  assert.deepEqual(vested,{assets:1_042_000n,shares:1_000_000_000n});
  assert.equal(out(redeem(vm,1_000_000_000n)),toAssets(1_000_000_000n,vested));
  assertBacked(vm);
});

test('ShareVault previewDeposit returns 0 wherever deposit reverts with VAULT_FULL or ZERO_SHARES',()=>{
  // Out of share room: one more asset would issue 1000 shares.
  let vm=setup();
  deposit(vm,(MAX-V)/V);
  const quote=view(vm,12,1n);
  assert.throws(()=>deposit(vm,1n),/VAULT_FULL/);
  assert.equal(quote,0n,`previewDeposit(1) = ${quote} but deposit(1) reverts VAULT_FULL`);

  // Out of asset room while shares still fit: S = 2^127-ish shares, and a
  // harvest takes managed to within `room` of the u128 limit.
  vm=setup();
  deposit(vm,MAX/2000n);
  const room=10n**30n;
  vm.setBalance(vault,asset,MAX-1n-room);
  harvest(vm);elapse(vm,D);
  const t=assertBacked(vm);
  // About two assets per share here, so a single asset buys none.
  assert.equal(view(vm,12,1n),0n);
  assert.throws(()=>deposit(vm,1n),/ZERO_SHARES/);
  assert.ok(view(vm,12,room)>0n);
  assert.equal(view(vm,12,room+1n),0n);
  assert.throws(()=>deposit(vm,room+1n),/VAULT_FULL/);
  assert.equal(out(deposit(vm,room)),toShares(room,t));
  assertBacked(vm);

  // What the preview cannot see: the host credits a deposit to the vault's
  // balance first, so an unharvested donation can make a deposit the totals
  // have room for overflow that balance.
  vm=setup();
  deposit(vm,1_000_000n);
  vm.setBalance(vault,asset,MAX-10n);
  assert.equal(view(vm,12,11n),11_000n);
  assert.throws(()=>deposit(vm,11n),/balance overflow/);
});

test('ShareVault deposits and redemptions through a contract caller keep shares, custody and totals in step',()=>{
  const vm=setup();
  const relay={block:2n,tx:9n};vm.deploy(relay,relayWasm);
  const via=(opcode,arg,incoming)=>vm.call({target:relay,inputs:[1,opcode,arg],incoming});
  // Nested deposit: shares are minted to the relay and passed on to the top level.
  const r1=via(1n,0n,[{id:asset,value:1_000_000n},{id:other,value:3n}]);
  assert.equal(out(r1),1_000_000_000n);
  assert.equal(paid(r1,vault),1_000_000_000n);assert.equal(paid(r1,other),3n);
  assert.equal(vm.balanceOf(relay,vault),0n);assert.equal(vm.balanceOf(relay,asset),0n);
  const H=vm.height;
  harvest(vm,[{id:asset,value:12_345n}]);elapse(vm,D/3n);
  // Nested redemption retains the shares as reissuable vault balance.
  let t=pricing(vm);
  const r2=via(2n,0n,[{id:vault,value:600_000_000n}]);
  assert.equal(out(r2),toAssets(600_000_000n,t));
  assert.equal(vm.balanceOf(vault,vault),600_000_000n);
  // A nested deposit larger than the retained balance reissues all of it and
  // mints only the difference.
  t=depositPricing(vm,12_345n,H);
  const s=out(via(1n,0n,[{id:asset,value:900_000n}]));
  assert.equal(s,toShares(900_000n,t));
  assert.ok(s>600_000_000n);
  assert.equal(vm.balanceOf(vault,vault),0n);
  t=assertBacked(vm);
  assert.equal(t.shares,400_000_000n+s);
  assert.equal(custody(vm),t.assets);
  assert.equal(vm.balanceOf(relay,vault),0n);assert.equal(vm.balanceOf(relay,asset),0n);
});

test('ShareVault deposits never issue more shares than the exact lock prices',()=>{
  // D = 7, one block after a harvest of 1000: the exact lock is 6000/7 =
  // 857.14. Rounding it up for deposits (E rounded down) would issue 857
  // shares too many for a 1,000,000 deposit; deposits round the lock down.
  const D=7n,vm=setup({vesting:D});
  deposit(vm,1_000_000n);
  const H=vm.height;
  harvest(vm,[{id:asset,value:1000n}]);
  vm.height=H+1n;
  assert.equal(view(vm,17),858n);
  const A=view(vm,10),S=view(vm,11),L=1000n,r=D-1n,x=1_000_000n;
  const exact=x*(S+V)*D/(A*D-L*r+D);                // floor(x(S+V)/(A - L*r/D + 1))
  const issued=view(vm,12,x);
  assert.ok(issued<=exact,`deposit issues ${issued} shares, ${issued-exact} more than the exact lock prices (${exact})`);
  assert.equal(out(deposit(vm,x)),issued);
  assertBacked(vm);
});
