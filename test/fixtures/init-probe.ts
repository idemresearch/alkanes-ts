import {Contract,state,init,view,type AlkaneId} from '../../sdk/authoring.ts';
export default class InitProbe extends Contract {
 @state({key:'/authority'}) private authority!:AlkaneId;
 @init({opcode:0,incomingAssets:'forward'})
 initialize(authority:AlkaneId):void{
  this.authority=authority;
  this.auth.require(authority);
 }
 @view({opcode:1}) getAuthority():AlkaneId{return this.authority;}
}
