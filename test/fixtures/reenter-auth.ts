// Audit fixture: an authority that approves, but first re-enters its caller
// with a configurable cellpack, optionally forwarding the auth unit.
import {Contract,CallResponse,StoragePointer,param,Cellpack,call,fuel,AlkaneTransferParcel} from '../../sdk/index.ts';
const op=new StoragePointer('/op'),a=new StoragePointer('/a'),b=new StoragePointer('/b'),fwd=new StoragePointer('/fwd'),c=new StoragePointer('/c');
export default new Contract('ReenterAuth')
 .method(0,'initialize',[param('op'),param('a'),param('b'),param('fwd'),param('c')],'void',(_ctx,args)=>{
  op.setU128(args.u128(0));a.setU128(args.u128(1));b.setU128(args.u128(2));fwd.setU128(args.u128(3));c.setU128(args.u128(4));return new CallResponse();
 })
 .method(1,'authenticate',[],'bytes',(ctx)=>{
  const inputs=[op.getU128()];
  if(a.getU128()!==0n||b.getU128()!==0n){inputs.push(a.getU128());inputs.push(b.getU128());}
  if(c.getU128()!==0n)inputs.push(c.getU128());
  const parcel=fwd.getU128()===1n?ctx.incomingAlkanes:new AlkaneTransferParcel();
  const r=call(new Cellpack(ctx.caller,inputs),parcel,Number(fuel()));
  return CallResponse.forward(fwd.getU128()===1n?r.alkanes:ctx.incomingAlkanes).withData(new Uint8Array([1]));
 });
