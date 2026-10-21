import {Contract,CallResponse,Cellpack,AlkaneTransferParcel,call} from '../../sdk/index.ts';
export default new Contract('CacheCallee')
 .method(9,'initialize',[],'void',()=>new CallResponse())
 .method(0,'callback',[],'void',(ctx)=>{call(new Cellpack(ctx.caller,[2n]),new AlkaneTransferParcel(),10_000_000);return new CallResponse();});
