// Failure/callback fixture. Canonical integration uses the upstream auth Wasm
// for the happy path, and the equivalent Rust fixture for these failure modes.
import {Contract,CallResponse,StoragePointer,param,Cellpack,call,fuel} from '../../sdk/index.ts';
const mode=new StoragePointer('/mode');
const calls=new StoragePointer('/calls');
export default new Contract('TestAuth')
 .method(0,'initialize',[param('mode')],'void',(_ctx,args)=>{
  if(!mode.isEmpty())throw new Error('already initialized');
  mode.setU128(args.u128(0));return new CallResponse();
 })
 .method(1,'authenticate',[],'bytes',(ctx)=>{
  if(ctx.incomingAlkanes.transfers.length!==1||!ctx.incomingAlkanes.transfers[0].id.equals(ctx.myself)||ctx.incomingAlkanes.transfers[0].value!==1n)throw new Error('BAD_AUTH_CALL');
  calls.setU128(calls.getU128()+1n);
  const behavior=mode.getU128();
  if(behavior===2n)throw new Error('AUTH_FAILURE');
  if(behavior===3n){
   let blocked=false;
   try{call(new Cellpack(ctx.caller,[77n,1n]),ctx.incomingAlkanes,Number(fuel()));}
   catch(error){blocked=error instanceof Error&&error.message.includes('REENTRANT_CALL');}
   if(!blocked)throw new Error('REENTRANCY_NOT_BLOCKED');
  }
  return CallResponse.forward(ctx.incomingAlkanes).withData(new Uint8Array([behavior===1n?0:1]));
 })
 .method(2,'calls',[],'u128',()=>new CallResponse().withU128(calls.getU128()));
