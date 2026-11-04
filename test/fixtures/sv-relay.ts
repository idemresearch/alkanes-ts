// ShareVault test fixture: forwards its incoming parcel to the vault at [2,1] with one
// argument and returns whatever the vault returned (a contract caller).
import {Contract,CallResponse,Cellpack,AlkaneId,call,fuel,param} from '../../sdk/index.ts';
export default new Contract('SvRelay')
 .method(1,'relay',[param('opcode'),param('arg')],'bytes',(ctx,args)=>{
  const r=call(new Cellpack(new AlkaneId(2n,1n),[args.u128(0),args.u128(1)]),ctx.incomingAlkanes,Number(fuel()));
  return new CallResponse(r.alkanes,r.data);
 });
