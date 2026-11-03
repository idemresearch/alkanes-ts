// Compiler-private fixed-width ABI. Values are immutable arena word handles,
// never JS numbers used as u128 arithmetic. Only eligible source is lowered here.
declare function __w_begin(context:Uint8Array,tracked:number):number;
declare function __w_forward(c:number,value:number):void;
declare function __w_status(c:number):number;
declare function __w_count(c:number):number;
declare function __w_incoming(c:number):number;
declare function __w_input(c:number,index:number):number;
declare function __w_literal(a:number,b:number,c:number,d:number):number;
declare function __w_op(c:number,kind:number,a:number,b:number):number;
declare function __w_readonly(c:number,value:number):void;
declare function __w_fail(c:number,message:Uint8Array):void;
declare function __w_explain(c:number,message:Uint8Array):void;
declare function __w_load(c:number,key:Uint8Array,fallback:number,size:number):number;
declare function __w_store(c:number,key:Uint8Array,value:number,size:number):void;
declare function __w_mint(c:number,amount:number):void;
declare function __w_auth(c:number,block:number,tx:number):void;
declare function __w_id(c:number,block:number,tx:number):number;
declare function __w_unknown(c:number,value:number):void;
declare function __w_finish(c:number,value:number,len:number,message:Uint8Array):number;
export function begin(c:Uint8Array,tracked:number):number{return __w_begin(c,tracked);}
export function forward(c:number,value:number):void{__w_forward(c,value);}
export function count(c:number):number{return __w_count(c);}
export function incoming(c:number):number{return __w_incoming(c);}
export function input(c:number,index:number):number{return __w_input(c,index);}
export function literal(a:number,b:number,c:number,d:number):number{return __w_literal(a,b,c,d);}
export function op(c:number,kind:number,a:number,b:number):number{return __w_op(c,kind,a,b);}
export function readOnly(c:number,value:number):void{__w_readonly(c,value);}
export function fail(c:number,message:Uint8Array):void{__w_fail(c,message);}
export function explain(c:number,message:Uint8Array):void{__w_explain(c,message);}
export function load(c:number,key:Uint8Array,fallback:number,size:number):number{return __w_load(c,key,fallback,size);}
export function store(c:number,key:Uint8Array,value:number,size:number):void{__w_store(c,key,value,size);}
export function mint(c:number,amount:number):void{__w_mint(c,amount);}
export function auth(c:number,block:number,tx:number):void{__w_auth(c,block,tx);}
export function id(c:number,block:number,tx:number):number{return __w_id(c,block,tx);}
export function unknown(c:number,value:number):void{__w_unknown(c,value);}
export function failed(c:number):boolean{return __w_status(c)!==0;}
export function status(c:number):number{return __w_status(c);}
export class Id { constructor(public readonly block:number,public readonly tx:number){} }
// Filled with compile-time UTF-8 byte literals by the frontend. No dynamic
// Error/encoding runtime is needed on this restricted, uncaught-error path.
export function finish(c:number,value:number,len:number,message:Uint8Array):number{return __w_finish(c,value,len,message);}
// Three-operand checked math and asset custody for the word-v1 subset.
// Kinds: op3 0 mulDiv, 1 mulDivUp, 2 mulSqrt, 3 sqrt, 4 *, 5 /, 6 %, 7 min,
// 8 max (binary kinds ignore d); custody 0 received,
// 1 held, 2 retain, 3 send, 4 myself. Ids are passed once, as evaluated.
declare function __w_op3(c:number,kind:number,a:number,b:number,d:number):number;
declare function __w_custody(c:number,kind:number,block:number,tx:number,amount:number):number;
export function op3(c:number,kind:number,a:number,b:number,d:number):number{return __w_op3(c,kind,a,b,d);}
export function received(c:number,id:Id):number{return __w_custody(c,0,id.block,id.tx,0);}
export function held(c:number,id:Id):number{return __w_custody(c,1,id.block,id.tx,0);}
export function retain(c:number,id:Id,amount:number):void{__w_custody(c,2,id.block,id.tx,amount);}
export function send(c:number,id:Id,amount:number):void{__w_custody(c,3,id.block,id.tx,amount);}
export function myself(c:number):Id{const p=__w_custody(c,4,0,0,0);return new Id(p,p+16);}
// An AlkaneId returned by a lowered helper: a 32-byte block/tx word pair.
export function at(p:number):Id{return new Id(p,p+16);}
