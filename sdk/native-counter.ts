// Experimental compiler-private SDK for the reject-assets contract subset.
// Address numbers point to immutable u128 words; amounts never use f64 math.
// The scriptc profile binds these declarations to LLVM intrinsics or env.*.
declare function __native_alloc(n:number):number;
declare function __native_load8(p:number):number;
declare function __native_load32(p:number):number;
declare function __native_store8(p:number,v:number):void;
declare function __native_store32(p:number,v:number):void;
declare function __native_fill(p:number,value:number,n:number):void;
declare function __native_equal(a:number,b:number,n:number):number;
declare function __native_copy(to:number,from:number,n:number):void;
declare function __native_bytes(value:Uint8Array):number;
declare function __native_add(out:number,a:number,b:number):number;
declare function __native_sub(out:number,a:number,b:number):number;
declare function __native_mul(out:number,a:number,b:number):number;
declare function __native_compare(a:number,b:number):number;
declare function __native_fromnumber(out:number,n:number):number;
declare function __native_tonumber(p:number):number;
declare function __native_request(key:number):number;
declare function __native_load(key:number,value:number):number;
declare function __native_height(p:number):void;
declare function __native_log(p:number):void;
declare function __native_abort(a:number,b:number,c:number,d:number):void;

function alloc(n:number):number{return __native_alloc(n);}
function size(p:number):number{return __native_load32(p-4);}
function copy(p:number,n:number):number{const out=alloc(n);__native_copy(out,p,n);return out;}
function zero(n:number):number{const p=alloc(n);__native_fill(p,0,n);return p;}
export function literal(a:number,b:number,c:number,d:number):number{const p=alloc(16);__native_store32(p,a);__native_store32(p+4,b);__native_store32(p+8,c);__native_store32(p+12,d);return p;}
export class Bytes {
  constructor(private p:number=0,private readonly value:Uint8Array=new Uint8Array()){}
  pointer():number{if(this.p===0)this.p=__native_bytes(this.value);return this.p;}
  get length():number{return this.p===0?this.value.length:size(this.p);}
}
export function bytes(value:Uint8Array):Bytes{return new Bytes(0,value);}
export function utf8(value:Bytes):Bytes{return value;}
export function concat(a:Bytes,b:Bytes):Bytes{const an=a.length,bn=b.length,p=alloc(an+bn);__native_copy(p,a.pointer(),an);__native_copy(p+an,b.pointer(),bn);return new Bytes(p);}
function equal(a:number,b:number):boolean{const n=size(a);return n===size(b)&&__native_equal(a,b,n)!==0;}
export function bytesEqual(a:Bytes,b:Bytes):boolean{return equal(a.pointer(),b.pointer());}

// Linked cache records: next/key/value/dirty, each a u32 address or flag.
let entries=0;
let code=0,message=0,readOnly=false;
function fail(value:number):void{if(code===0)code=value;}
function guard():void{if(code!==0)throw 0;}
export function checked(p:number):number{guard();return p;}
export function add(a:number,b:number):number{const p=alloc(16);if(__native_add(p,a,b)!==0)fail(2);guard();return p;}
export function sub(a:number,b:number):number{const p=alloc(16);if(__native_sub(p,a,b)!==0)fail(3);guard();return p;}
export function mul(a:number,b:number):number{const p=alloc(16);if(__native_mul(p,a,b)!==0)fail(2);guard();return p;}
export function compare(kind:number,a:number,b:number):boolean{const c=__native_compare(a,b);return kind===2?c===0:kind===3?c!==0:kind===4?c<0:kind===5?c<=0:kind===6?c>0:c>=0;}
export function fromNumber(n:number):number{const p=alloc(16),error=__native_fromnumber(p,n);if(error!==0)fail(error);guard();return p;}
export function toNumber(p:number):number{return __native_tonumber(p);}
export function decimal(p:number):Bytes{
  const limbs:number[]=[];for(let i=0;i<4;i++)limbs.push(__native_load32(p+i*4));
  const digits:number[]=[];let more=true;
  while(more){let rem=0;more=false;for(let i=3;i>=0;i--){const n=rem*4294967296+limbs[i],q=Math.floor(n/10);rem=n-q*10;limbs[i]=q;if(q!==0)more=true;}digits.push(48+rem);}
  const out=alloc(digits.length);for(let i=0;i<digits.length;i++)__native_store8(out+i,digits[digits.length-i-1]);return new Bytes(out);
}
export function u128ToBytes(p:number):Bytes{return new Bytes(copy(p,16));}
export function bytesToU128(value:Bytes,offset:number=0):number{const out=zero(16),n=value.length-offset;if(n>0)__native_copy(out,value.pointer()+offset,Math.min(n,16));return out;}
export function checkedAdd(a:number,b:number):number{return add(a,b);}
function entry(key:number):number{let e=entries,previous=0;while(e!==0){if(equal(__native_load32(e+4),key))return e;previous=e;e=__native_load32(e);}e=zero(16);__native_store32(e+4,key);if(previous===0)entries=e;else __native_store32(previous,e);return e;}
export class StoragePointer {
  constructor(private readonly key:Bytes){}
  select(part:Bytes):StoragePointer{return new StoragePointer(concat(this.key,part));}
  get():Bytes{
    const e=entry(this.key.pointer());
    const key=__native_load32(e+4);let value=__native_load32(e+8);
    if(value===0){const n=__native_request(key);if(n<0){fail(4);guard();}value=alloc(n);__native_store32(e+8,value);if(n!==0)__native_load(key,value);}
    return new Bytes(copy(value,size(value)));
  }
  set(value:Bytes):void{if(readOnly)fail(6);guard();const e=entry(this.key.pointer());__native_store32(e+8,copy(value.pointer(),value.length));__native_store32(e+12,1);}
  getU128():number{return bytesToU128(this.get());}
  setU128(value:number):void{this.set(u128ToBytes(value));}
  isEmpty():boolean{return this.get().length===0;}
}
export class AlkaneId {constructor(public readonly block:number,public readonly tx:number){}}
class Transfers {constructor(public readonly length:number){}}
class Parcel {constructor(public readonly transfers:Transfers){}}
export class Context {
  public readonly inputs:number[]=[];
  public readonly incomingAlkanes:Parcel;
  constructor(p:number,n:number){
    this.incomingAlkanes=new Parcel(new Transfers(0));
    if(n<96){fail(1);guard();}
    const incoming=p+80,maximum=literal(Math.floor((n-96)/48),0,0,0);
    if(__native_compare(incoming,maximum)>0){fail(1);guard();}
    const count=__native_load32(incoming),start=96+count*48;
    if((n-start)%16!==0){fail(1);guard();}
    this.incomingAlkanes=new Parcel(new Transfers(count));
    for(let i=start;i<n;i+=16)this.inputs.push(p+i);
  }
}
export class CallResponse {
  constructor(public data:Bytes=new Bytes()){}
  withU128(value:number):CallResponse{this.data=u128ToBytes(value);return this;}
}
export function height():number{const p=zero(16);__native_height(p);return p;}
export function log(value:Bytes):void{__native_log(value.pointer());}
export function setReadOnly(value:boolean):void{readOnly=value;}
export function raise(value:Bytes):never{if(code===0){code=100;message=concat(bytes(new Uint8Array([69,114,114,111,114,58,32])),value).pointer();}throw 0;}
function finish(data:Bytes):number{
  let n=20+data.length,count=0;for(let e=entries;e!==0;e=__native_load32(e))if(__native_load32(e+12)!==0){n+=8+size(__native_load32(e+4))+size(__native_load32(e+8));count++;}
  const p=alloc(n);__native_fill(p,0,16);__native_store32(p+16,count);let at=p+20;
  for(let e=entries;e!==0;e=__native_load32(e))if(__native_load32(e+12)!==0){const key=__native_load32(e+4),value=__native_load32(e+8),kn=size(key),vn=size(value);__native_store32(at,kn);at+=4;__native_copy(at,key,kn);at+=kn;__native_store32(at,vn);at+=4;__native_copy(at,value,vn);at+=vn;}
  __native_copy(at,data.pointer(),data.length);return p;
}
function finishError():number{
  __native_abort(0,0,0,0);
  if(message===0){
    if(code===1)message=__native_bytes(new Uint8Array([69,114,114,111,114,58,32,117,110,101,120,112,101,99,116,101,100,32,101,110,100,32,111,102,32,105,110,112,117,116,32,114,101,97,100,105,110,103,32,117,49,50,56]));
    else if(code===2)message=__native_bytes(new Uint8Array([69,114,114,111,114,58,32,117,49,50,56,32,111,118,101,114,102,108,111,119]));
    else if(code===3)message=__native_bytes(new Uint8Array([69,114,114,111,114,58,32,117,49,50,56,32,117,110,100,101,114,102,108,111,119]));
    else if(code===6)message=__native_bytes(new Uint8Array([69,114,114,111,114,58,32,118,105,101,119,32,99,97,110,110,111,116,32,109,117,116,97,116,101,32,115,116,111,114,97,103,101,32,111,114,32,99,97,108,108,32,97,32,109,117,116,97,116,105,110,103,32,99,111,110,116,114,97,99,116]));
    else message=alloc(0);
  }
  const n=size(message),p=zero(24+n);__native_store32(p+20,2692334344);__native_copy(p+24,message,n);return p;
}
export function executeDispatch(dispatch:(context:Context)=>CallResponse,context:Uint8Array):number{
  entries=0;code=0;message=0;readOnly=false;
  try {const response=dispatch(new Context(__native_bytes(context),context.length));guard();return finish(response.data);}
  catch(error){if(code===0)throw error;return finishError();}
}
