// ShareVault test fixture: an auth token whose opcode 1 calls back into its caller (the
// vault) before approving. Mode selects the reentrant call.
import {Contract,CallResponse,StoragePointer,param,Cellpack,AlkaneId,AlkaneTransferParcel,call,staticcall,fuel} from '../../sdk/index.ts';
const mode=new StoragePointer('/mode');
const asset=new AlkaneId(2n,5n);
export default new Contract('ReenterAuth')
 .method(0,'initialize',[param('mode')],'void',(_ctx,args)=>{
  mode.setU128(args.u128(0));return new CallResponse();
 })
 .method(1,'authenticate',[],'bytes',(ctx)=>{
  const m=mode.getU128();
  const vault=ctx.caller;
  if(m===1n)call(new Cellpack(vault,[1n,0n]),new AlkaneTransferParcel().pay(asset,10n),Number(fuel()));
  if(m===2n)staticcall(new Cellpack(vault,[10n]),new AlkaneTransferParcel(),Number(fuel()));
  if(m===3n)call(new Cellpack(vault,[2n,0n]),new AlkaneTransferParcel().pay(vault,1000n),Number(fuel()));
  if(m===4n)call(new Cellpack(vault,[3n]),new AlkaneTransferParcel().pay(ctx.myself,1n),Number(fuel()));
  return CallResponse.forward(ctx.incomingAlkanes).withData(new Uint8Array([1]));
 });
