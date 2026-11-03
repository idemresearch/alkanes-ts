import {Contract,state,method,view,assert,type AlkaneId,type u128} from '../../sdk/authoring.ts';
import {mulDiv,mulDivUp,sqrt,min,max} from '../../sdk/u128.ts';
// Adversarial verification probe for word-v1 custody, error order and helpers.
// Every observable (response data, ledger order, storage, host balances,
// revert message) is compared against the bigint backend.
export default class VerifyCustody extends Contract {
 @state({key:'/s1'}) s1:u128=0n;
 @state({key:'/s2'}) s2:u128=0n;
 @state({key:'/s3'}) s3:u128=0n;
 // received with duplicate entries and for the contract's own ID; held for two IDs.
 @method({opcode:1,incomingAssets:'forward'}) observe(a:AlkaneId,b:AlkaneId):u128{
  this.s1=this.assets.received(a);
  this.s2=this.assets.received(this.context.myself);
  this.s3=this.assets.held(a);
  return this.assets.held(b);
 }
 // held before/after retain, mintSelf, send; ledger order of the response.
 @method({opcode:2,incomingAssets:'forward'}) effects(a:AlkaneId,b:AlkaneId,x:u128):u128{
  const h0=this.assets.held(a);
  this.assets.retain(a,min(x,this.assets.received(a)));
  const h1=this.assets.held(a);
  this.assets.mintSelf(x);
  this.assets.send(b,min(x,this.assets.held(b)));
  const h2=this.assets.held(b);
  this.s1=h0;this.s2=h1;this.s3=h2;
  return this.assets.received(this.context.myself);
 }
 // Retaining the contract's own incoming ID takes it out of circulation.
 @method({opcode:3,incomingAssets:'forward'}) burnOwn(x:u128):u128{
  this.assets.retain(this.context.myself,x);
  return this.assets.received(this.context.myself);
 }
 // First failure wins; later store/mint/send must not happen.
 @method({opcode:4,incomingAssets:'forward'}) failMid(a:AlkaneId,x:u128,y:u128,d:u128):void{
  this.s1=x;
  this.assets.mintSelf(x);
  this.assets.send(a,mulDiv(x,y,d));
  this.s2=y;
  this.assets.retain(a,x*y);
  this.s3=d;
 }
 // Nested argument evaluation: leftmost failing operation wins.
 @view({opcode:5}) order(x:u128,y:u128,d:u128):u128{
  return mulDiv(this.boom(x,d),x/d,sqrt(x*y))+mulDivUp(y,y,d);
 }
 private boom(x:u128,d:u128):u128{
  if(d===7n)throw new Error('BOOM');
  assert(x!==13n,'THIRTEEN');
  return x-d;
 }
 // Ternary AlkaneId into send (self send must fail with SELF_SEND_USE_MINT_SELF).
 @method({opcode:6,incomingAssets:'forward'}) sendPick(flag:u128,a:AlkaneId,x:u128):u128{
  const target=flag===1n?this.context.myself:a;
  this.assets.send(target,x);
  return this.assets.held(flag===2n?this.context.myself:a);
 }
 @view({opcode:7}) heldView(a:AlkaneId,b:AlkaneId):u128{return this.assets.held(a)*2n+this.assets.received(b)+this.assets.received(this.context.myself);}
 // Short-circuit boolean helpers with custody side effects.
 private trySend(id:AlkaneId,x:u128):boolean{
  if(this.assets.held(id)<x)return false;
  this.assets.send(id,x);
  return true;
 }
 @method({opcode:8,incomingAssets:'forward'}) either(a:AlkaneId,b:AlkaneId,x:u128):u128{
  if(this.trySend(a,x)||this.trySend(b,x))return 1n;
  return 0n;
 }
 @method({opcode:9,incomingAssets:'forward'}) both(a:AlkaneId,b:AlkaneId,x:u128):u128{
  const ok=this.trySend(a,x)&&this.trySend(b,x);
  return ok?this.assets.held(a)+this.assets.held(b):0n;
 }
 // Many allocations through a non-recursive helper tree (1024 leaves): arena growth.
 private l0(a:AlkaneId,x:u128):u128{return this.assets.held(a)+mulDiv(x,x,x+1n)+this.assets.received(a);}
 private l1(a:AlkaneId,x:u128):u128{return this.l0(a,x)+this.l0(a,x+1n);}
 private l2(a:AlkaneId,x:u128):u128{return this.l1(a,x)+this.l1(a,x+2n);}
 private l3(a:AlkaneId,x:u128):u128{return this.l2(a,x)+this.l2(a,x+3n);}
 private l4(a:AlkaneId,x:u128):u128{return this.l3(a,x)+this.l3(a,x+4n);}
 private l5(a:AlkaneId,x:u128):u128{return this.l4(a,x)+this.l4(a,x+5n);}
 private l6(a:AlkaneId,x:u128):u128{return this.l5(a,x)+this.l5(a,x+6n);}
 private l7(a:AlkaneId,x:u128):u128{return this.l6(a,x)+this.l6(a,x+7n);}
 private l8(a:AlkaneId,x:u128):u128{return this.l7(a,x)+this.l7(a,x+8n);}
 private l9(a:AlkaneId,x:u128):u128{return this.l8(a,x)+this.l8(a,x+9n);}
 private l10(a:AlkaneId,x:u128):u128{return this.l9(a,x)+this.l9(a,x+10n);}
 @method({opcode:10,incomingAssets:'forward'}) arena(a:AlkaneId,x:u128):u128{
  this.assets.retain(a,this.assets.received(a)/2n);
  const v=this.l10(a,x);
  this.s1=v;
  this.assets.send(a,min(this.assets.held(a),x));
  return v;
 }
 // Zero-value entries: mintSelf(0), retain(id,0), send(id,0) and their ledger positions.
 @method({opcode:11,incomingAssets:'forward'}) zeros(a:AlkaneId,b:AlkaneId,x:u128):void{
  this.assets.mintSelf(0n);
  this.assets.send(b,0n);
  this.assets.retain(a,0n);
  this.assets.mintSelf(x);
  this.assets.send(a,min(x,this.assets.held(a)));
  this.assets.retain(b,min(x,this.assets.received(b)));
 }
 // held() of the contract's own ID through an AlkaneId helper.
 private me():AlkaneId{return this.context.myself;}
 private pick(flag:boolean,a:AlkaneId):AlkaneId{return flag?this.me():a;}
 @view({opcode:12}) heldPick(flag:u128,a:AlkaneId):u128{return this.assets.held(this.pick(flag>0n,a));}
 // Division by zero via %=, /=, and retain amount computed after the failure.
 @method({opcode:13,incomingAssets:'forward'}) compound(a:AlkaneId,x:u128,d:u128):u128{
  let v=x;
  v%=d;
  this.assets.retain(a,v);
  v/=d;
  v*=x;
  return v;
 }
 // Failure inside a helper argument after an earlier custody effect.
 @method({opcode:14,incomingAssets:'forward'}) helperFail(a:AlkaneId,b:AlkaneId,x:u128,d:u128):u128{
  this.assets.send(a,min(x,this.assets.held(a)));
  this.settle(b,x/d,this.boom(x,d));
  return this.assets.held(a);
 }
 private settle(id:AlkaneId,amount:u128,extra:u128):void{
  this.assets.retain(id,amount);
  this.s2=extra;
 }
 // Comparison results flowing through boolean equality and ternaries of AlkaneIds.
 @view({opcode:15}) idMath(a:AlkaneId,b:AlkaneId):u128{
  const same=(a.block===b.block)===(a.tx===b.tx);
  const id=same?a:b;
  const other=same!==true?a:this.context.myself;
  return max(id.block,other.tx)*3n+min(id.tx,other.block)+(same?1n:0n);
 }
}
