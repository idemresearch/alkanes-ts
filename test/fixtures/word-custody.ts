import {Contract,method,view,assert,type AlkaneId,type u128} from '../../sdk/authoring.ts';
import {min} from '../../sdk/u128.ts';
// Differential probe for word-v1 custody: received/held/retain/send/myself,
// their exact errors, ledger response order and AlkaneId/boolean/void helpers.
export default class WordCustody extends Contract {
 @view({opcode:1}) heldOf(id:AlkaneId):u128{return this.assets.held(id);}
 @view({opcode:2}) heldSelf():u128{return this.assets.held(this.context.myself);}
 @method({opcode:3,incomingAssets:'forward'}) keep(id:AlkaneId,amount:u128):u128{this.assets.retain(id,amount);return this.assets.received(id);}
 @method({opcode:4,incomingAssets:'forward'}) pay(id:AlkaneId,amount:u128):u128{this.assets.send(id,amount);return this.assets.held(id);}
 @method({opcode:5,incomingAssets:'forward'}) paySelf(amount:u128):void{this.assets.send(this.context.myself,amount);}
 @method({opcode:6,incomingAssets:'forward'}) keepSelf(amount:u128):u128{this.assets.mintSelf(amount);this.assets.retain(this.context.myself,amount);return this.assets.received(this.context.myself);}
 // A zero retain of an absent ID inserts it into the ledger before later credits.
 @method({opcode:7,incomingAssets:'forward'}) order(a:AlkaneId,b:AlkaneId,amount:u128):void{
  this.assets.retain(b,0n);
  this.assets.mintSelf(amount);
  this.assets.send(b,min(amount,this.assets.held(b)));
  this.assets.send(a,0n);
 }
 // The failing argument stops the retain.
 @method({opcode:8,incomingAssets:'forward'}) failFirst(id:AlkaneId,amount:u128,d:u128):void{this.assets.retain(id,amount/d);}
 @method({opcode:9,incomingAssets:'forward'}) failAfter(id:AlkaneId,amount:u128):void{
  this.assets.retain(id,amount);
  this.assets.send(id,amount);
  assert(amount===0n,'AFTER');
 }
 private chosen(flag:boolean,a:AlkaneId,b:AlkaneId):AlkaneId{return flag?a:b;}
 private positive(v:u128):boolean{return v>0n;}
 private settle(id:AlkaneId,amount:u128):void{this.assets.retain(id,amount);}
 @method({opcode:10,incomingAssets:'forward'}) route(a:AlkaneId,b:AlkaneId):u128{
  const target=this.chosen(this.positive(this.assets.received(a)),a,b);
  this.settle(target,this.assets.received(target));
  return this.assets.received(target);
 }
 @view({opcode:11}) me():AlkaneId{return this.context.myself;}
 @view({opcode:12}) pick(flag:u128,a:AlkaneId,b:AlkaneId):AlkaneId{return this.chosen(flag===1n,a,b);}
}
