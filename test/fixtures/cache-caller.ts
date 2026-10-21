import {Contract,CallResponse,StoragePointer,Cellpack,AlkaneTransferParcel,call,param} from '../../sdk/index.ts';
const value=new StoragePointer('/value');
export default new Contract('CacheCaller')
 .method(9,'initialize',[],'void',()=>new CallResponse())
 .method(0,'callback',[param('block'),param('tx')],'u128',(_ctx,args)=>{
  value.setU128(1n);
  call(new Cellpack(args.id(0),[0n]),new AlkaneTransferParcel(),10_000_000);
  return new CallResponse().withU128(value.getU128());
 })
 .method(2,'update',[],'void',()=>{value.setU128(2n);return new CallResponse();});
