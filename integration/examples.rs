//! Counter and Token through the same unmodified indexer as CappedToken.
use super::*;
const COUNTER: &[u8]=include_bytes!("./counter.wasm");
#[cfg(feature="native-counter")]
const COUNTER_NATIVE: &[u8]=include_bytes!("./counter-native.wasm");
#[cfg(feature="native-counter")]
const COUNTER_042: &[u8]=include_bytes!("./counter-c-sdk-0.4.2.wasm");
#[cfg(feature="native-counter")]
const COUNTER_COERCION: &[u8]=include_bytes!("./counter-native-generic-coercion.wasm");
#[cfg(feature="native-counter")]
const NATIVE_WORD_PROBE: &[u8]=include_bytes!("./native-word-probe.wasm");
const TOKEN: &[u8]=include_bytes!("./token.wasm");
const COUNTER_RS: &[u8]=include_bytes!("./counter-rust.wasm");
const COUNTER_OPT: &[u8]=include_bytes!("./counter-rust-opt.wasm");
const TOKEN_RS: &[u8]=include_bytes!("./token-rust.wasm");
const TOKEN_OPT: &[u8]=include_bytes!("./token-rust-opt.wasm");
const RELAY: &[u8]=include_bytes!("./word-relay.wasm");
#[cfg(feature="examples-baseline")]
const COUNTER_BEFORE: &[u8]=include_bytes!("./counter-before.wasm");
#[cfg(feature="examples-baseline")]
const TOKEN_BEFORE: &[u8]=include_bytes!("./token-before.wasm");

fn id(tx:u128)->AlkaneId{AlkaneId{block:2,tx}}
fn deploy(binary:&[u8],inputs:Vec<u128>)->(Block,Execution){
    helpers::clear();
    let deployment=block(binary,cp(AlkaneId{block:1,tx:0},inputs),None,880000);
    let execution=index(&deployment,880000);
    assert!(execution.result.is_ok(),"deployment: {:?}",execution);
    helpers::assert_binary_deployed_to_id(id(1),binary.to_vec()).unwrap();
    (deployment,execution)
}
fn invoke(tx:u128,inputs:Vec<u128>,input:Option<OutPoint>,height:u32)->(Block,Execution){
    let b=block(&[],cp(id(tx),inputs),input,height);let e=index(&b,height);(b,e)
}
fn state(keys:&[&str])->BTreeMap<String,Vec<u8>>{
    keys.iter().map(|k|((*k).into(),storage(&id(1),k))).collect()
}
fn counter_state(n:u128)->BTreeMap<String,Vec<u8>>{
    let mut s=state(&["/initialized","/count"]);
    for i in 0..n{
        let mut key=b"/slots/".to_vec();key.extend(i.to_le_bytes());
        let value=IndexPointer::from_keyword("/alkanes/").select(&Vec::<u8>::from(id(1))).keyword("/storage/").select(&key).get().as_ref().clone();
        s.insert(format!("slot{i}"),value);
    }s
}

#[wasm_bindgen_test]
fn counter_checked_storage_loops_height_and_rollback(){
    let mut reference=None;
    let mut variants=vec![COUNTER,COUNTER_RS,COUNTER_OPT];
    #[cfg(feature="native-counter")]{variants.extend([COUNTER_NATIVE,COUNTER_042]);}
    for binary in variants{
        deploy(binary,vec![0]);let mut outputs=vec![];
        let (_,increment)=invoke(1,vec![1,(1u128<<96)+5],None,880001);
        assert_eq!(number(increment.result.as_ref().unwrap()),(1u128<<96)+5);
        outputs.push(increment.result.unwrap());let saved=counter_state(0);
        let (_,failed)=invoke(1,vec![3],None,880002);assert_revert(failed,"intentional failure");assert_eq!(counter_state(0),saved);
        for (i,n) in [0u128,100,10_000].into_iter().enumerate(){
            let (_,sum)=invoke(1,vec![5,n],None,880003+i as u32);
            assert_eq!(number(sum.result.as_ref().unwrap()),if n==0{0}else{n*(n-1)*(2*n-1)/6});outputs.push(sum.result.unwrap());
        }
        let (_,fill)=invoke(1,vec![6,10],None,880006);outputs.push(fill.result.unwrap());
        let (_,height)=invoke(1,vec![4],None,880007);assert_eq!(number(height.result.as_ref().unwrap()),880007);outputs.push(height.result.unwrap());
        let (_,read)=invoke(1,vec![2],None,880008);outputs.push(read.result.unwrap());
        let (_,again)=invoke(1,vec![0],None,880009);assert_revert(again,"already initialized");
        let (_,maximum)=invoke(1,vec![1,u128::MAX-((1u128<<96)+5)],None,880010);assert_eq!(number(maximum.result.as_ref().unwrap()),u128::MAX);
        let saved=counter_state(10);let (_,overflow)=invoke(1,vec![1,1],None,880011);assert_revert(overflow,"u128 overflow");assert_eq!(counter_state(10),saved);
        let assets=block(TOKEN,cp(AlkaneId{block:1,tx:0},vec![0,1]),None,880012);assert!(index(&assets,880012).result.is_ok());
        let (rejected,e)=invoke(1,vec![2],Some(outpoint(&assets,0)),880013);assert_revert(e,"rejects incoming assets");assert_eq!(balance(&rejected,id(2)),1);assert_eq!(counter_state(10),saved);
        let current=(outputs,counter_state(10));if let Some(ref expected)=reference{assert_eq!(&current,expected);}else{reference=Some(current);}
    }
}

#[wasm_bindgen_test]
fn token_owner_wide_mint_real_balances_and_nested_rollback(){
    let mut reference=None;
    for binary in [TOKEN,TOKEN_RS,TOKEN_OPT]{
        let (deployment,initial)=deploy(binary,vec![0,100]);assert_eq!(balance(&deployment,id(1)),100);
        let mut outputs=vec![initial.result.unwrap()];
        let (mint,minted)=invoke(1,vec![77,(1u128<<96)+5],Some(outpoint(&deployment,0)),880001);
        assert_eq!(balance(&mint,id(1)),100+(1u128<<96)+5);outputs.push(minted.result.unwrap());
        for (i,opcode)in[99,100,101].into_iter().enumerate(){let (_,e)=invoke(1,vec![opcode],None,880002+i as u32);outputs.push(e.result.unwrap());}
        assert_eq!(outputs[2].data,b"TypeScript Token");assert_eq!(outputs[3].data,b"TST");assert_eq!(number(&outputs[4]),100+(1u128<<96)+5);
        let saved=state(&["/owner","/totalsupply"]);
        let (_,again)=invoke(1,vec![0,100],None,880005);assert_revert(again,"already initialized");assert_eq!(state(&["/owner","/totalsupply"]),saved);
        let relay=block(RELAY,cp(AlkaneId{block:1,tx:0},vec![9]),None,880006);assert!(index(&relay,880006).result.is_ok());
        let (_,denied)=invoke(2,vec![0,2,1,77,5],None,880007);assert_revert(denied,"caller is not the owner");assert_eq!(state(&["/owner","/totalsupply"]),saved);
        let (_,too_much)=invoke(1,vec![77,u128::MAX],None,880008);assert_revert(too_much,"u128 overflow");assert_eq!(state(&["/owner","/totalsupply"]),saved);
        let current=(outputs,saved);if let Some(ref expected)=reference{assert_eq!(&current,expected);}else{reference=Some(current);}
    }
}

#[wasm_bindgen_test]
fn token_cross_calls_preserve_data_cache_and_failure_atomicity(){
    for binary in [TOKEN,TOKEN_OPT]{
        deploy(binary,vec![0,100]);
        let counter=block(COUNTER,cp(AlkaneId{block:1,tx:0},vec![0]),None,880001);assert!(index(&counter,880001).result.is_ok());
        let (_,increment)=invoke(2,vec![1,41],None,880002);assert!(increment.result.is_ok());
        let (_,forward)=invoke(1,vec![200,2,2,2],None,880003);assert_eq!(number(forward.result.as_ref().unwrap()),41);
        let (_,failed)=invoke(1,vec![200,2,2,3],None,880004);assert_revert(failed,"intentional failure");assert_eq!(storage(&id(2),"/count"),41u128.to_le_bytes());
        let (_,read)=invoke(1,vec![200,2,2,2],None,880005);assert_eq!(number(read.result.as_ref().unwrap()),41);
    }
}

#[cfg(feature="benchmark")]
#[wasm_bindgen_test]
fn benchmark_examples(){
    let iterations:usize=include_str!("./iterations.txt").trim().parse().unwrap();
    let mut counter_variants=vec![("typescript",COUNTER),("rust-o3-lto",COUNTER_RS),("rust-o3-lto-wasm-opt",COUNTER_OPT)];
    let mut token_variants=vec![("typescript",TOKEN),("rust-o3-lto",TOKEN_RS),("rust-o3-lto-wasm-opt",TOKEN_OPT)];
    #[cfg(feature="examples-baseline")]{counter_variants.push(("typescript-before",COUNTER_BEFORE));token_variants.push(("typescript-before",TOKEN_BEFORE));}
    #[cfg(feature="native-counter")]{counter_variants.extend([("native-0.4.2",COUNTER_NATIVE),("c-sdk-0.4.2",COUNTER_042),("native-generic-coercion",COUNTER_COERCION)]);}
    let mut samples=BTreeMap::<(&str,&str),Vec<(u64,f64)>>::new();let mut references=BTreeMap::new();
    for iteration in 0..iterations+3{
        let mut contracts=vec![("counter",&counter_variants)];
        if !cfg!(feature="native-counter"){contracts.push(("token",&token_variants));}
        for (contract,variants)in contracts{
            for offset in 0..variants.len(){
                let (name,binary)=variants[(iteration+offset)%variants.len()];
                let (deployment,initial)=deploy(binary,if contract=="counter"{vec![0]}else{vec![0,100]});
                let mut outputs=vec![];
                let mut record=|method:&'static str,e:Execution,s:BTreeMap<String,Vec<u8>>|{
                    assert!(e.result.is_ok(),"{contract}/{method}: {:?}",e);
                    if iteration>=3{samples.entry((name,method)).or_default().push((e.fuel,e.micros));}
                    outputs.push((e.result.unwrap(),s));
                };
                if contract=="counter"{
                    record("counter/deploy+init",initial,counter_state(0));
                    for (i,(label,inputs))in[("counter/increment",vec![1,5]),("counter/increment-wide",vec![1,(1u128<<96)+5]),("counter/read",vec![2]),("counter/height+log",vec![4]),("counter/sum-100",vec![5,100]),("counter/sum-10000",vec![5,10_000]),("counter/fill-10",vec![6,10])].into_iter().enumerate(){
                        let (_,e)=invoke(1,inputs,None,880001+i as u32);record(label,e,counter_state(if i==6{10}else{0}));
                    }
                }else{
                    record("token/deploy+init",initial,state(&["/owner","/totalsupply"]));
                    let (mint,e)=invoke(1,vec![77,5],Some(outpoint(&deployment,0)),880001);assert_eq!(balance(&mint,id(1)),105);record("token/mint",e,state(&["/owner","/totalsupply"]));
                    let (wide,e)=invoke(1,vec![77,(1u128<<96)+5],Some(outpoint(&mint,0)),880002);assert_eq!(balance(&wide,id(1)),110+(1u128<<96));record("token/mint-wide",e,state(&["/owner","/totalsupply"]));
                    for (i,(label,opcode))in[("token/supply",101),("token/name",99),("token/symbol",100)].into_iter().enumerate(){let (_,e)=invoke(1,vec![opcode],None,880003+i as u32);record(label,e,state(&["/owner","/totalsupply"]));}
                    let counter=block(COUNTER,cp(AlkaneId{block:1,tx:0},vec![0]),None,880006);assert!(index(&counter,880006).result.is_ok());
                    let (_,e)=invoke(1,vec![200,2,2,2],None,880007);record("token/forward-call",e,state(&["/owner","/totalsupply"]));
                }
                if let Some(expected)=references.get(contract){assert_eq!(&outputs,expected);}else{references.insert(contract,outputs);}
            }
        }
    }
    for((name,method),mut values)in samples{
        assert_eq!(values.len(),iterations);assert!(values.iter().all(|v|v.0==values[0].0));values.sort_by(|a,b|a.1.partial_cmp(&b.1).unwrap());
        let median=if iterations%2==0{(values[iterations/2-1].1+values[iterations/2].1)/2.0}else{values[iterations/2].1};
        metashrew_core::println!("ALKANES_TS_BENCH {}",serde_json::json!({"variant":name,"method":method,"iterations":iterations,"fuel":values[0].0,"median_us":median}));
    }
}

#[cfg(feature="native-counter")]
#[wasm_bindgen_test]
fn native_checked_u128_uses_actual_runtime(){
    deploy(NATIVE_WORD_PROBE,vec![0,0,0]);
    let mut height=880001;
    for (a,b) in [(0,u128::MAX),(1,u128::MAX),(u64::MAX as u128,u64::MAX as u128),((1u128<<96)+5,3),(1u128<<127,2),(u128::MAX,u128::MAX)]{
        let (_,e)=invoke(1,vec![0,a,b],None,height);height+=1;
        if let Some(expected)=a.checked_mul(b){assert_eq!(number(e.result.as_ref().unwrap()),expected);}else{assert_revert(e,"u128 overflow");}
        let (_,e)=invoke(1,vec![5,a,b],None,height);height+=1;
        if let Some(expected)=a.checked_sub(b){assert_eq!(number(e.result.as_ref().unwrap()),expected);}else{assert_revert(e,"u128 underflow");}
    }
    for a in [0,1,(1u128<<53)+1,(1u128<<53)+3,(1u128<<96)+5,u128::MAX]{
        let (_,e)=invoke(1,vec![1,a],None,height);height+=1;
        if a==u128::MAX{assert_revert(e,"u128 overflow");}else{assert_eq!(number(e.result.as_ref().unwrap()),(a as f64) as u128);}
    }
}
