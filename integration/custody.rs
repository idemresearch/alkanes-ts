//! Custody contracts through the unmodified indexer: AmmPool deposits, swaps
//! and redemptions with real UTXO balances, and AmmRouter routing through two
//! pools. Contract custody is read from the indexer's own balance table and
//! must always equal the pools' stored reserves.
use super::*;

const CUSTODY_TOKEN: &[u8] = include_bytes!("./token.wasm");
const POOL: &[u8] = include_bytes!("./amm-pool.wasm");
const ROUTER: &[u8] = include_bytes!("./amm-router.wasm");

fn alkane(tx: u128) -> AlkaneId {
    AlkaneId { block: 2, tx }
}
/// `who`'s balance of `what` in the indexer's balance table (utils.rs
/// balance_pointer): the custody a contract can spend.
fn custody(who: &AlkaneId, what: &AlkaneId) -> u128 {
    IndexPointer::from_keyword("/alkanes/")
        .select(&what.clone().into())
        .keyword("/balances/")
        .select(&who.clone().into())
        .get_value::<u128>()
}
fn create(binary: &[u8], inputs: Vec<u128>, input: Option<OutPoint>, height: u32) -> (Block, Execution) {
    let b = block(binary, cp(AlkaneId { block: 1, tx: 0 }, inputs), input, height);
    let e = index(&b, height);
    (b, e)
}
fn call(target: &AlkaneId, inputs: Vec<u128>, input: Option<OutPoint>, height: u32) -> (Block, Execution) {
    let b = block(&[], cp(target.clone(), inputs), input, height);
    let e = index(&b, height);
    (b, e)
}
fn ok(e: &Execution) -> u128 {
    match &e.result {
        Ok(response) => number(response),
        Err(error) => panic!("unexpected revert: {error}"),
    }
}
/// AmmPool pricing: 0.3% fee from the input, then the constant-product price.
fn quote(amount: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    let x = amount * 997 / 1000;
    x * reserve_out / (reserve_in + x)
}
fn report(scenario: &str, e: &Execution) {
    report!(
        "ALKANES_TS_CUSTODY {}",
        serde_json::json!({"scenario": scenario, "fuel": e.fuel, "us": e.micros})
    );
}

#[wasm_bindgen_test]
fn amm_pool_custody_matches_reserves_with_real_balances() {
    helpers::clear();
    let (t0, t1, pool) = (alkane(1), alkane(2), alkane(3));
    let (a, e) = create(CUSTODY_TOKEN, vec![0, 10_000_000], None, 880000);
    assert!(e.result.is_ok(), "token0: {e:?}");
    // Token forwards incoming assets, so this output holds both tokens.
    let (b, e) = create(CUSTODY_TOKEN, vec![0, 40_000_000], Some(outpoint(&a, 0)), 880001);
    assert!(e.result.is_ok(), "token1: {e:?}");
    assert_eq!(balance(&b, t0.clone()), 10_000_000);
    assert_eq!(balance(&b, t1.clone()), 40_000_000);
    // Initializers reject incoming assets, so the pool is created on its own.
    let (_, e) = create(POOL, vec![0, 2, 1, 2, 2], None, 880002);
    assert!(e.result.is_ok(), "pool: {e:?}");
    report("amm-pool deploy+initialize", &e);
    helpers::assert_binary_deployed_to_id(pool.clone(), POOL.to_vec()).unwrap();
    let backed = |r0: u128, r1: u128, height: u32| {
        assert_eq!(ok(&call(&pool, vec![20], None, height).1), r0);
        assert_eq!(ok(&call(&pool, vec![21], None, height + 1).1), r1);
        assert_eq!(custody(&pool, &t0), r0, "custody of token0");
        assert_eq!(custody(&pool, &t1), r1, "custody of token1");
    };

    // First deposit: sqrt(1e7 * 4e7) = 2e7 shares, 1000 of them locked.
    let (add, e) = call(&pool, vec![1, 0], Some(outpoint(&b, 0)), 880003);
    assert_eq!(ok(&e), 19_999_000);
    report("amm-pool first addLiquidity", &e);
    assert_eq!(balance(&add, pool.clone()), 19_999_000);
    assert_eq!(balance(&add, t0.clone()), 0);
    assert_eq!(balance(&add, t1.clone()), 0);
    backed(10_000_000, 40_000_000, 880004);
    assert_eq!(ok(&call(&pool, vec![22], None, 880006).1), 20_000_000);

    // Swap token0 -> token1. The LP shares travel along and are refunded.
    let (mint, e) = call(&t0, vec![77, 100_000], Some(outpoint(&add, 0)), 880007);
    assert!(e.result.is_ok(), "mint: {e:?}");
    assert_eq!(balance(&mint, t0.clone()), 100_000);
    assert_eq!(balance(&mint, pool.clone()), 19_999_000);
    let expected = quote(100_000, 10_000_000, 40_000_000);
    let (_, e) = call(&pool, vec![10, 100_000], None, 880008);
    assert_eq!(ok(&e), expected);
    report("amm-pool quote view", &e);
    let (swap, e) = call(&pool, vec![3, 0], Some(outpoint(&mint, 0)), 880009);
    assert_eq!(ok(&e), expected);
    report("amm-pool swap", &e);
    assert_eq!(balance(&swap, t1.clone()), expected);
    assert_eq!(balance(&swap, t0.clone()), 0);
    assert_eq!(balance(&swap, pool.clone()), 19_999_000);
    let (r0, r1) = (10_100_000, 40_000_000 - expected);
    backed(r0, r1, 880010);

    // Redeem every circulating share; the 1000 locked shares stay.
    let (lp, supply) = (19_999_000u128, 20_000_000u128);
    let (a0, a1) = (lp * r0 / supply, lp * r1 / supply);
    let (remove, e) = call(&pool, vec![2, 0, 0], Some(outpoint(&swap, 0)), 880012);
    assert_eq!(ok(&e), lp);
    report("amm-pool removeLiquidity", &e);
    assert_eq!(balance(&remove, t0.clone()), a0);
    assert_eq!(balance(&remove, t1.clone()), expected + a1);
    assert_eq!(balance(&remove, pool.clone()), 0);
    backed(r0 - a0, r1 - a1, 880013);
    assert_eq!(custody(&pool, &pool), lp, "redeemed shares stay in pool custody");
    assert_eq!(ok(&call(&pool, vec![22], None, 880015).1), 1000);

    // Both tokens in one swap revert atomically: reserves and custody hold.
    let (_, e) = call(&pool, vec![3, 0], Some(outpoint(&remove, 0)), 880016);
    assert_revert(e, "SINGLE_INPUT_REQUIRED");
    backed(r0 - a0, r1 - a1, 880017);
}

#[wasm_bindgen_test]
fn amm_router_routes_two_hops_through_real_pools() {
    helpers::clear();
    let (ta, tb, tc, p1, p2, router) = (alkane(1), alkane(2), alkane(3), alkane(4), alkane(5), alkane(6));
    let (a, e) = create(CUSTODY_TOKEN, vec![0, 10_000_000], None, 880100);
    assert!(e.result.is_ok(), "A: {e:?}");
    let (b, e) = create(CUSTODY_TOKEN, vec![0, 40_000_000], Some(outpoint(&a, 0)), 880101);
    assert!(e.result.is_ok(), "B: {e:?}");
    let (c, e) = create(CUSTODY_TOKEN, vec![0, 90_000_000], Some(outpoint(&b, 0)), 880102);
    assert!(e.result.is_ok(), "C: {e:?}");
    assert!(create(POOL, vec![0, 2, 1, 2, 2], None, 880103).1.result.is_ok(), "pool A/B");
    assert!(create(POOL, vec![0, 2, 2, 2, 3], None, 880104).1.result.is_ok(), "pool B/C");
    // The router has no state; its read-only opcode 0 is the deployment call.
    let (_, e) = create(ROUTER, vec![0], None, 880105);
    assert_eq!(ok(&e), 1, "router deployment");
    helpers::assert_binary_deployed_to_id(router.clone(), ROUTER.to_vec()).unwrap();

    // Pool A/B takes A and B; C is unrelated and comes back.
    let (add1, e) = call(&p1, vec![1, 0], Some(outpoint(&c, 0)), 880106);
    assert_eq!(ok(&e), 19_999_000);
    assert_eq!(balance(&add1, tc.clone()), 90_000_000);
    let (mint_b, e) = call(&tb, vec![77, 30_000_000], Some(outpoint(&add1, 0)), 880107);
    assert!(e.result.is_ok(), "mint B: {e:?}");
    // Pool B/C takes B and C; the A/B shares come back.
    let (add2, e) = call(&p2, vec![1, 0], Some(outpoint(&mint_b, 0)), 880108);
    assert!(e.result.is_ok(), "pool B/C deposit: {e:?}");
    assert_eq!(balance(&add2, p1.clone()), 19_999_000);
    // An outpoint's balance reads as empty once a later transaction spends
    // it, so the new shares are counted before the next step.
    let lp2 = balance(&add2, p2.clone());
    assert_eq!(lp2, 51_960_524, "sqrt(3e7 * 9e7) - 1000");
    let (mint_a, e) = call(&ta, vec![77, 100_000], Some(outpoint(&add2, 0)), 880109);
    assert!(e.result.is_ok(), "mint A: {e:?}");

    // A -> B -> C through both pools, LP shares riding along untouched.
    let mid = quote(100_000, 10_000_000, 40_000_000);
    let out = quote(mid, 30_000_000, 90_000_000);
    let route = vec![1, 2, 1, 2, 4, 2, 2, 2, 5, 2, 3, out, 880120];
    let (swap, e) = call(&router, route, Some(outpoint(&mint_a, 0)), 880110);
    assert_eq!(ok(&e), out);
    report("amm-router swap2 (two pools)", &e);
    assert_eq!(balance(&swap, tc.clone()), out);
    assert_eq!(balance(&swap, ta.clone()), 0);
    assert_eq!(balance(&swap, tb.clone()), 0);
    assert_eq!(balance(&swap, p1.clone()), 19_999_000);
    assert_eq!(balance(&swap, p2.clone()), lp2);
    for token in [&ta, &tb, &tc] {
        assert_eq!(custody(&router, token), 0, "the router keeps no custody");
    }
    assert_eq!(custody(&p1, &ta), 10_100_000);
    assert_eq!(custody(&p1, &tb), 40_000_000 - mid);
    assert_eq!(custody(&p2, &tb), 30_000_000 + mid);
    assert_eq!(custody(&p2, &tc), 90_000_000 - out);

    // A single hop C -> B with an unreachable minimum reverts both sides.
    let before = (custody(&p2, &tb), custody(&p2, &tc));
    let (_, e) = call(&router, vec![2, 2, 3, 2, 5, 2, 2, u128::MAX, 880120], Some(outpoint(&swap, 0)), 880111);
    assert_revert(e, "SLIPPAGE");
    assert_eq!((custody(&p2, &tb), custody(&p2, &tc)), before);
    for token in [&ta, &tb, &tc] {
        assert_eq!(custody(&router, token), 0);
    }
}
