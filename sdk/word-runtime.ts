// Compiler-private SDK for word-backed programs. Token values are immutable
// word addresses. Byte objects own immutable arena buffers or lazy TS literals.
import * as w from "./word.ts";
declare function __w_copybytes(value:Uint8Array):number;
declare function __w_copyraw(p:number,n:number):number;
declare function __w_size(p:number):number;
declare function __w_concat(a:number,b:number):number;
declare function __w_equalbytes(a:number,b:number):number;
declare function __w_decode(c:number,p:number,offset:number):number;
declare function __w_rawload(c:number,key:number):number;
declare function __w_rawstore(c:number,key:number,value:number):void;
declare function __w_context(c:number,which:number):number;
declare function __w_parcel(c:number):number;
declare function __w_pay(parcel:number,b:number,t:number,value:number):number;
declare function __w_mul(c:number,a:number,b:number):number;
declare function __w_fromnumber(c:number,n:number):number;
declare function __w_decimal(p:number):number;
declare function __w_height():number;
declare function __w_log(p:number):void;
declare function __w_failbytes(c:number,p:number):void;
declare function __w_call(c:number,cp:number,parcel:number,fuel:number):number;
declare function __w_responsepart(p:number,which:number):number;
declare function __w_finishresponse(c:number,parcel:number,data:number,message:Uint8Array):number;

let active=0;
// Constant buffers are built once during module initialization (captured by
// the build-time snapshot). Callers only read them; SDK leaves copy inputs.
const EMPTY=new Uint8Array();
export class Bytes {
  constructor(private p:number=0,private readonly literal:Uint8Array=EMPTY){}
  pointer():number { if(this.p===0)this.p=__w_copybytes(this.literal);return this.p; }
  get length():number { return this.p===0?this.literal.length:__w_size(this.p); }
}
export function bytes(value:Uint8Array):Bytes{return new Bytes(0,value);}
export function utf8(value:Bytes):Bytes{return value;}
export function literal(a:number,b:number,c:number,d:number):number{return w.literal(a,b,c,d);}
function guard():void {if(w.failed(active))throw 0;}
export function checked(value:number):number{guard();return value;}
export function add(a:number,b:number):number{const p=w.op(active,0,a,b);guard();return p;}
export function sub(a:number,b:number):number{const p=w.op(active,1,a,b);guard();return p;}
export function mul(a:number,b:number):number{const p=__w_mul(active,a,b);guard();return p;}
export function compare(kind:number,a:number,b:number):boolean{const v=w.op(active,kind,a,b);guard();return v!==0;}
export function fromNumber(n:number):number{const p=__w_fromnumber(active,n);guard();return p;}
export function toNumber(p:number):number{return w.toNumber(p);}
export function decimal(p:number):Bytes{return new Bytes(__w_decimal(p));}
export function concat(a:Bytes,b:Bytes):Bytes{return new Bytes(__w_concat(a.pointer(),b.pointer()));}
export function bytesEqual(a:Bytes,b:Bytes):boolean{return __w_equalbytes(a.pointer(),b.pointer())!==0;}
export function u128ToBytes(p:number):Bytes{return new Bytes(__w_copyraw(p,16));}
export function bytesToU128(value:Bytes,offset:number=0):number{const p=__w_decode(active,value.pointer(),offset);guard();return p;}
export function checkedAdd(a:number,b:number):number{return add(a,b);}
export class StoragePointer {
  constructor(private readonly key:Bytes){}
  select(part:Bytes):StoragePointer{return new StoragePointer(concat(this.key,part));}
  get():Bytes{const p=__w_rawload(active,this.key.pointer());guard();return new Bytes(p);}
  set(value:Bytes):void{__w_rawstore(active,this.key.pointer(),value.pointer());guard();}
  getU128():number{return bytesToU128(this.get());}
  setU128(value:number):void{this.set(u128ToBytes(value));}
  isEmpty():boolean{return this.get().length===0;}
}
export class AlkaneId {
  constructor(public readonly block:number,public readonly tx:number){}
  serialize():Bytes{return concat(u128ToBytes(this.block),u128ToBytes(this.tx));}
  equals(other:AlkaneId):boolean{return compare(2,this.block,other.block)&&compare(2,this.tx,other.tx);}
}
// A zero-count parcel. Parcel words are immutable; pay() copies.
const EMPTY_PARCEL=w.literal(0,0,0,0);
class TransferCount {constructor(public readonly length:number){}}
export class AlkaneTransferParcel {
  constructor(public p:number=0){}
  pointer():number{if(this.p===0)this.p=EMPTY_PARCEL;return this.p;}
  get transfers():TransferCount{return new TransferCount((__w_size(this.pointer())-16)/48);}
  pay(id:AlkaneId,value:number):AlkaneTransferParcel{this.p=__w_pay(this.pointer(),id.block,id.tx,value);return this;}
}
export class Context {
  public readonly inputs:number[]=[];
  constructor(private readonly c:number){for(let i=0;i<w.count(c);i++)this.inputs.push(w.input(c,i));}
  private id(which:number):AlkaneId{const p=__w_context(this.c,which);return new AlkaneId(p,p+16);}
  get myself():AlkaneId{return this.id(0);}
  get caller():AlkaneId{return this.id(1);}
  get incomingAlkanes():AlkaneTransferParcel{return new AlkaneTransferParcel(__w_parcel(this.c));}
  // Equals incomingAlkanes.transfers.length without copying the parcel.
  get incomingCount():number{return w.incoming(this.c);}
}
export class Inputs {
  constructor(private readonly values:number[]){}
  u128(i:number):number{const p=this.values[i];if(p===undefined)throw 0;return p;}
  id(i:number):AlkaneId{return new AlkaneId(this.u128(i),this.u128(i+1));}
}
export class Cellpack {
  constructor(public readonly target:AlkaneId,public readonly inputs:number[]){}
  serialize():Bytes{let p=this.target.serialize();for(const input of this.inputs)p=concat(p,u128ToBytes(input));return p;}
}
export class CallResponse {
  constructor(public alkanes:AlkaneTransferParcel=new AlkaneTransferParcel(),public data:Bytes=new Bytes()){}
  static forward(parcel:AlkaneTransferParcel):CallResponse{return new CallResponse(new AlkaneTransferParcel(parcel.pointer()));}
  withData(data:Bytes):CallResponse{this.data=data;return this;}
  withU128(value:number):CallResponse{return this.withData(u128ToBytes(value));}
  withString(value:Bytes):CallResponse{return this.withData(value);}
}
export function call(cp:Cellpack,parcel:AlkaneTransferParcel,budget:number):CallResponse{
  const p=__w_call(active,cp.serialize().pointer(),parcel.pointer(),budget);guard();
  return new CallResponse(new AlkaneTransferParcel(__w_responsepart(p,0)),new Bytes(__w_responsepart(p,1)));
}
export function height():number{return __w_height();}
export function log(value:Bytes):void{__w_log(value.pointer());}
export function setReadOnly(value:boolean):void{w.readOnly(active,value?1:0);}
const ERROR_PREFIX=bytes(new Uint8Array([69,114,114,111,114,58,32]));
export function raise(message:Bytes):never{__w_failbytes(active,concat(ERROR_PREFIX,message).pointer());throw 0;}

const ERROR_INPUT=new Uint8Array([69,114,114,111,114,58,32,117,110,101,120,112,101,99,116,101,100,32,101,110,100,32,111,102,32,105,110,112,117,116,32,114,101,97,100,105,110,103,32,117,49,50,56]);
const ERROR_OVERFLOW=new Uint8Array([69,114,114,111,114,58,32,117,49,50,56,32,111,118,101,114,102,108,111,119]);
const ERROR_UNDERFLOW=new Uint8Array([69,114,114,111,114,58,32,117,49,50,56,32,117,110,100,101,114,102,108,111,119]);
const ERROR_VIEW=new Uint8Array([69,114,114,111,114,58,32,118,105,101,119,32,99,97,110,110,111,116,32,109,117,116,97,116,101,32,115,116,111,114,97,103,101,32,111,114,32,99,97,108,108,32,97,32,109,117,116,97,116,105,110,103,32,99,111,110,116,114,97,99,116]);
const ERROR_EXTCALL=new Uint8Array([69,114,114,111,114,58,32,69,120,116,99,97,108,108,32,102,97,105,108,101,100,32,40,110,111,32,100,101,116,97,105,108,115,32,97,118,97,105,108,97,98,108,101,41]);
const ERROR_EXTCALL_REVERT=new Uint8Array([69,114,114,111,114,58,32,69,120,116,99,97,108,108,32,102,97,105,108,101,100,58,32]);
function finishError():number{
  const code=w.status(active);
  if(code===1)return w.finish(active,0,0,ERROR_INPUT);
  if(code===2)return w.finish(active,0,0,ERROR_OVERFLOW);
  if(code===3)return w.finish(active,0,0,ERROR_UNDERFLOW);
  if(code===6)return w.finish(active,0,0,ERROR_VIEW);
  if(code===10)return w.finish(active,0,0,ERROR_EXTCALL);
  if(code===11)return w.finish(active,0,0,ERROR_EXTCALL_REVERT);
  return w.finish(active,0,0,EMPTY);
}
export function executeDispatch(dispatch:(context:Context)=>CallResponse,context:Uint8Array):number{
  active=w.begin(context,0);
  try {
    guard();const response=dispatch(new Context(active));guard();
    return __w_finishresponse(active,response.alkanes.pointer(),response.data.pointer(),EMPTY);
  }catch(error){if(!w.failed(active))throw error;return finishError();}
}
