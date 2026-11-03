// Callback names and scalar/byte layouts shared by build profile and adapter.
export const wordCallbacks=Object.entries({
 begin:['bytes','u32'],forward:['u32','u32'],status:['u32'],count:['u32'],incoming:['u32'],input:['u32','u32'],
 literal:['u32','u32','u32','u32'],op:['u32','u32','u32','u32'],
 readonly:['u32','u32'],fail:['u32','bytes'],explain:['u32','bytes'],load:['u32','bytes','u32','u32'],
 store:['u32','bytes','u32','u32'],mint:['u32','u32'],auth:['u32','u32','u32'],
 id:['u32','u32','u32'],unknown:['u32','u32'],finish:['u32','u32','u32','bytes'],
 // Three-operand checked math (mulDiv/mulDivUp/mulSqrt/sqrt) and asset custody
 // (received/held/retain/send/myself); see shim/word.c.
 op3:['u32','u32','u32','u32','u32'],custody:['u32','u32','u32','u32','u32'],
}).map(([name,params])=>({name:'__w_'+name,params,returns:['forward','readonly','fail','explain','store','mint','auth','unknown'].includes(name)?'void':'u32'}));
export const sdkCallbacks=[...wordCallbacks.filter(c=>['begin','status','count','input','literal','op','readonly','finish'].includes(c.name.slice(4))),...Object.entries({
 copybytes:['bytes'],copyraw:['u32','u32'],size:['u32'],concat:['u32','u32'],equalbytes:['u32','u32'],decode:['u32','u32','u32'],
 rawload:['u32','u32'],rawstore:['u32','u32','u32'],context:['u32','u32'],parcel:['u32'],pay:['u32','u32','u32','u32'],
 mul:['u32','u32','u32'],fromnumber:['u32','f64'],tonumber:['u32'],decimal:['u32'],height:[],log:['u32'],failbytes:['u32','u32'],
 call:['u32','u32','u32','f64'],responsepart:['u32','u32'],finishresponse:['u32','u32','u32','bytes'],
}).map(([name,params])=>({name:'__w_'+name,params,returns:['rawstore','log','failbytes'].includes(name)?'void':name==='tonumber'?'f64':'u32'}))];
export function wordAdapter(sdk=false){
 const callbacks=(sdk?sdkCallbacks:wordCallbacks).map(c=>{
  const n=c.name.slice(2),params=c.params.flatMap(t=>t==='bytes'?['i32','i32']:[t==='f64'?'f64':'i32']);
  const declaration=params.map(t=>'(param '+t+')').join(' '),result=c.returns==='void'?'':`(result ${c.returns==='f64'?'f64':'i32'})`;
  const locals=params.map((_,i)=>'(local.get '+i+')').join(' ');
  return {import:`(import "word" "${n}" (func $${n} ${declaration} ${result}))`,body:`(func (export "${c.name}") ${declaration} ${result} ${n==='w_begin'?'(global.set $word_stack (i32.and (i32.add (call $reserve (i32.const 4096)) (i32.const 4096)) (i32.const -16)))':''} (call $${n} ${locals}))`};
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
 (func $initialize_once(if(i32.eqz(global.get $ready))(then(global.set $ready(i32.const 1))(call $initialize)(call $init))))
 (func(export "__bench_init")(call $initialize_once))
 (func(export "__execute")(result i32)(local $len i32)(local $p i32)
  (call $initialize_once)(local.set $len(call $request))(local.set $p(call $reserve(local.get $len)))
  (drop(call $context(local.get $p)))(i32.trunc_sat_f64_u(call $execute(local.get $p)(local.get $len))))
 (func(export "__meta")(result i32)(local $slots i32)(local $p i32)(local $len i32)
  (call $initialize_once)(local.set $slots(call $alloc(i32.const 8)))
  (call $meta(local.get $slots)(i32.add(local.get $slots)(i32.const 4)))
  (local.set $len(i32.load offset=4(local.get $slots)))(local.set $p(call $reserve(local.get $len)))
  (memory.copy(local.get $p)(i32.load(local.get $slots))(local.get $len))(local.get $p))
 (func(export "panic")(param $p i32)(param $n i32)(local $out i32)
  (local.set $out(call $reserve(local.get $n)))(memory.copy(local.get $out)(local.get $p)(local.get $n))
  (call $log(local.get $out))(call $abort(i32.const 0)(i32.const 0)(i32.const 0)(i32.const 0)))
 ${callbacks.map(c=>c.body).join('\n')}
 )`;
}
