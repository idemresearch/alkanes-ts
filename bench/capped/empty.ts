import {executeDispatch} from '../../sdk/contract.ts';
import {CallResponse} from '../../sdk/types.ts';
export function execute(context:Uint8Array):Uint8Array{return executeDispatch(()=>new CallResponse(),context);}
export function meta():Uint8Array{return new Uint8Array();}
