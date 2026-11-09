// Callback names and scalar/byte layouts shared by build profile and adapter.
export const wordCallbacks=Object.entries({
 begin:['bytes','u32'],forward:['u32','u32'],status:['u32'],count:['u32'],incoming:['u32'],input:['u32','u32'],
 literal:['u32','u32','u32','u32'],op:['u32','u32','u32','u32'],
 readonly:['u32','u32'],fail:['u32','bytes'],explain:['u32','bytes'],load:['u32','bytes','u32','u32'],
 store:['u32','bytes','u32','u32'],mint:['u32','u32'],auth:['u32','u32','u32'],
 id:['u32','u32','u32'],unknown:['u32','u32'],finish:['u32','u32','u32','bytes'],tonumber:['u32'],
 // Three-operand checked math (mulDiv/mulDivUp/mulSqrt/sqrt) and asset custody
 // (received/held/retain/send/myself); see shim/word.c.
 op3:['u32','u32','u32','u32','u32'],custody:['u32','u32','u32','u32','u32'],
 // Chain queries (height/available) and external calls; see shim/word.c.
 query:['u32','u32','u32','u32'],extcall:['u32','u32','u32','u32','u32','u32'],
}).map(([name,params])=>({name:'__w_'+name,params,returns:['forward','readonly','fail','explain','store','mint','auth','unknown'].includes(name)?'void':name==='tonumber'?'f64':'u32'}));
export const sdkCallbacks=[...wordCallbacks.filter(c=>['begin','status','count','incoming','input','literal','op','readonly','finish','tonumber'].includes(c.name.slice(4))),...Object.entries({
 copybytes:['bytes'],copyraw:['u32','u32'],size:['u32'],concat:['u32','u32'],equalbytes:['u32','u32'],decode:['u32','u32','u32'],
 rawload:['u32','u32'],rawstore:['u32','u32','u32'],context:['u32','u32'],parcel:['u32'],pay:['u32','u32','u32','u32'],
 mul:['u32','u32','u32'],fromnumber:['u32','f64'],decimal:['u32'],height:[],log:['u32'],failbytes:['u32','u32'],
 call:['u32','u32','u32','f64'],responsepart:['u32','u32'],finishresponse:['u32','u32','u32','bytes'],
}).map(([name,params])=>({name:'__w_'+name,params,returns:['rawstore','log','failbytes'].includes(name)?'void':'u32'}))];
// scriptc converts every u32 callback argument with an out-of-line ToUint32
// (scr_bit_ushr, about 25 instructions) before the call, even for constants
// and int32-typed values. An f64 parameter is passed as is, so the build
// profile declares u32 parameters as f64 and the adapter converts them: one
// truncation and a comparison for an exact u32, which every handle, kind,
// size and index is, and the same ToUint32 for anything else.
export const wordProfile=(sdk=false)=>(sdk?sdkCallbacks:wordCallbacks).map(c=>({...c,params:c.params.map(t=>t==='u32'?'f64':t)}));
// The conversion of parameter `i`, inline in each callback so the usual case
// costs no call. $r is the callback's scratch local.
const u32=i=>`(if(result i32)(f64.eq(f64.convert_i32_u(local.tee $r(i32.trunc_sat_f64_u(local.get ${i}))))(local.get ${i}))(then(local.get $r))(else(call $to_uint32(local.get ${i}))))`;
export const U32_CONVERSION=`
 (func $u32(export "__adapter_u32")(param f64)(result i32)(local $r i32)${u32(0)})
 ;; ECMAScript ToUint32: the integer part modulo 2^32; 0 for NaN and infinities.
 (func $to_uint32(param $x f64)(result i32)(local $bits i64)(local $e i32)(local $m i64)(local $r i32)
  (local.set $bits(i64.reinterpret_f64(local.get $x)))
  (local.set $e(i32.and(i32.wrap_i64(i64.shr_u(local.get $bits)(i64.const 52)))(i32.const 2047)))
  ;; Below 1 in magnitude, a multiple of 2^32 (exponent 84 and up), or not finite.
  (if(i32.or(i32.lt_u(local.get $e)(i32.const 1023))(i32.gt_u(local.get $e)(i32.const 1106)))(then(return(i32.const 0))))
  (local.set $m(i64.or(i64.and(local.get $bits)(i64.const 0xfffffffffffff))(i64.const 0x10000000000000)))
  (local.set $r(i32.wrap_i64(if(result i64)(i32.ge_u(local.get $e)(i32.const 1075))
   (then(i64.shl(local.get $m)(i64.extend_i32_u(i32.sub(local.get $e)(i32.const 1075)))))
   (else(i64.shr_u(local.get $m)(i64.extend_i32_u(i32.sub(i32.const 1075)(local.get $e))))))))
  (if(result i32)(i64.lt_s(local.get $bits)(i64.const 0))(then(i32.sub(i32.const 0)(local.get $r)))(else(local.get $r))))`;
export function wordAdapter(sdk=false){
 const callbacks=(sdk?sdkCallbacks:wordCallbacks).map(c=>{
  // `native` is the word module's signature, `outer` the scriptc callback's.
  const n=c.name.slice(2),native=c.params.flatMap(t=>t==='bytes'?['i32','i32']:[t==='f64'?'f64':'i32']);
  const outer=c.params.flatMap(t=>t==='bytes'?['i32','i32']:[t==='u32'||t==='f64'?'f64':'i32']);
  const convert=c.params.flatMap(t=>t==='bytes'?[false,false]:[t==='u32']);
  const declare=types=>types.map(t=>'(param '+t+')').join(' '),result=c.returns==='void'?'':`(result ${c.returns==='f64'?'f64':'i32'})`;
  const locals=outer.map((_,i)=>convert[i]?u32(i):'(local.get '+i+')').join(' ');
  return {import:`(import "word" "${n}" (func $${n} ${declare(native)} ${result}))`,body:`(func $${c.name} (export "${c.name}") ${declare(outer)} ${result} (local $r i32) ${n==='w_begin'?'(global.set $word_stack (i32.and (i32.add (call $reserve (i32.const 4096)) (i32.const 4096)) (i32.const -16)))':''} (call $${n} ${locals}))`};
 });
 return `(module
 (import "contract" "memory" (memory 0))
 (import "contract" "_initialize" (func $initialize))
 (import "contract" "contract_init" (func $init))
 (import "contract" "scriptc_alloc" (func $alloc (param i32)(result i32)))
 (import "contract" "contract_execute" (func $execute (param i32 i32)(result f64)))
 (import "contract" "contract_meta" (func $meta (param i32 i32)))
 (import "word" "__stack_pointer" (global $word_stack (mut i32)))
 (import "env" "__request_context" (func $request(result i32)))
 (import "env" "__load_context" (func $context(param i32)(result i32)))
 (import "env" "__log" (func $log(param i32)))
 (import "env" "abort" (func $abort(param i32 i32 i32 i32)))
 ${callbacks.map(c=>c.import).join('\n')}
 (global $ready(mut i32)(i32.const 0))
 (global $next(mut i32)(i32.const 0)) (global $end(mut i32)(i32.const 0))
 (func $reserve(export "__adapter_reserve")(param $n i32)(result i32)
  (local $size i32)(local $p i32)(local $pages i32)
  (local.set $size(i32.and(i32.add(local.get $n)(i32.const 23))(i32.const -16)))
  (if(i32.gt_u(local.get $size)(i32.sub(global.get $end)(global.get $next)))(then
   (local.set $pages(i32.shr_u(i32.add(local.get $size)(i32.const 65535))(i32.const 16)))
   (local.set $p(memory.grow(local.get $pages)))
   (if(i32.eq(local.get $p)(i32.const -1))(then(unreachable)))
   (global.set $next(i32.shl(local.get $p)(i32.const 16)))
   (global.set $end(i32.add(global.get $next)(i32.shl(local.get $pages)(i32.const 16))))))
  (local.set $p(global.get $next))(global.set $next(i32.add(local.get $p)(local.get $size)))
  (i32.store(local.get $p)(local.get $n))(i32.add(local.get $p)(i32.const 4)))
 ;; Module initialization may build constant words (hoisted literals) before
 ;; __w_begin, so it gets its own word stack instead of the linker default.
 (func $initialize_once(if(i32.eqz(global.get $ready))(then(global.set $ready(i32.const 1))
  (global.set $word_stack(i32.and(i32.add(call $reserve(i32.const 4096))(i32.const 4096))(i32.const -16)))
  (call $initialize)(call $init))))
 (func $__bench_init(export "__bench_init")(call $initialize_once))
 (func $__execute(export "__execute")(result i32)(local $len i32)(local $p i32)
  (call $initialize_once)(local.set $len(call $request))(local.set $p(call $reserve(local.get $len)))
  (drop(call $context(local.get $p)))(i32.trunc_sat_f64_u(call $execute(local.get $p)(local.get $len))))
 (func $__meta(export "__meta")(result i32)(local $slots i32)(local $p i32)(local $len i32)
  (call $initialize_once)(local.set $slots(call $alloc(i32.const 8)))
  (call $meta(local.get $slots)(i32.add(local.get $slots)(i32.const 4)))
  (local.set $len(i32.load offset=4(local.get $slots)))(local.set $p(call $reserve(local.get $len)))
  (memory.copy(local.get $p)(i32.load(local.get $slots))(local.get $len))(local.get $p))
 (func $panic(export "panic")(param $p i32)(param $n i32)(local $out i32)
  (local.set $out(call $reserve(local.get $n)))(memory.copy(local.get $out)(local.get $p)(local.get $n))
  (call $log(local.get $out))(call $abort(i32.const 0)(i32.const 0)(i32.const 0)(i32.const 0)))
 ${U32_CONVERSION}
 ${callbacks.map(c=>c.body).join('\n')}
 )`;
}
