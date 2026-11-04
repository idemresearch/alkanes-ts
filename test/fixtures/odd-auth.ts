// Audit fixture: approves but keeps the auth unit (mode 0) or pays back extra
// units of itself plus the unit (mode 1).
import {Contract,CallResponse,StoragePointer,param,AlkaneTransferParcel} from '../../sdk/index.ts';
const mode=new StoragePointer('/mode');
export default new Contract('OddAuth')
 .method(0,'initialize',[param('mode')],'void',(_ctx,args)=>{mode.setU128(args.u128(0));return new CallResponse();})
 .method(1,'authenticate',[],'bytes',(ctx)=>{
  if(mode.getU128()===0n)return new CallResponse().withData(new Uint8Array([1]));
  return CallResponse.forward(new AlkaneTransferParcel().pay(ctx.myself,3n)).withData(new Uint8Array([1]));
 });
