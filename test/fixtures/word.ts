import {Contract,state,init,method,view,type u128,type AlkaneId} from '../../sdk/authoring.ts';
export default class WordProbe extends Contract {
 @state({key:'/value'}) private value:u128=17n;
 @state({key:'/identity'}) private identity!:AlkaneId;
 @init({opcode:0}) initialize(id:AlkaneId):void{this.identity=id;}
 @method({opcode:1}) add(by:u128):u128{this.value+=by;return this.value;}
 @method({opcode:2}) subtract(by:u128):u128{this.value-=by;return this.value;}
 @view({opcode:3}) read():u128{return this.value;}
 @view({opcode:4}) getId():AlkaneId{return this.identity;}
 @method({opcode:5}) fail():void{this.value=99n;throw new Error('word rollback');}
 @view({opcode:6}) intermediate():u128{return (340282366920938463463374607431768211455n+1n)-1n;}
 @view({opcode:7}) compare(a:u128,b:u128):u128{
  const less=a<b; if(less&&a!==b)return 1n;
  if(a>=b&&a===b)return 2n;
  return 3n;
 }
 @method({opcode:8,incomingAssets:'forward'}) authenticate(id:AlkaneId):void{this.auth.require(id);}
 @method({opcode:9}) issue(amount:u128):void{this.assets.mintSelf(amount);}
 @view({opcode:10}) echo(w:u128):u128{const id=w+1n;return id;}
 @method({opcode:11}) forgedSelfAuth(id:AlkaneId):void{this.assets.mintSelf(1n);this.auth.require(id);}
 @method({opcode:12}) conditional(flag:u128):u128{if(flag===0n)this.value=1n;else this.value=2n;return this.value;}
 @method({opcode:13}) previous(by:u128):u128{const before=this.value;this.value+=by;return before;}
 @view({opcode:170141183460469231731687303715884105728n}) high():u128{return 42n;}
}
