//! Custody contracts through the unmodified indexer: AmmPool deposits, swaps
//! and redemptions with real UTXO balances, AmmRouter routing through two
//! pools, and ShareVault and TimelockTreasury authenticated with the upstream
//! auth token. Contract custody is read from the indexer's own balance table
//! and must always back the contracts' stored totals.
use super::*;

const CUSTODY_TOKEN: &[u8] = include_bytes!("./token.wasm");
const POOL: &[u8] = include_bytes!("./amm-pool.wasm");
const ROUTER: &[u8] = include_bytes!("./amm-router.wasm");
const VAULT: &[u8] = include_bytes!("./share-vault.wasm");
const TREASURY: &[u8] = include_bytes!("./timelock-treasury.wasm");

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
/// The upstream auth token at [4, 9001], its one unit in the block's first output.
fn real_auth(height: u32) -> Block {
    let b = block(AUTH, cp(AlkaneId { block: 3, tx: 9001 }, auth_init(None)), None, height);
    assert!(index(&b, height).result.is_ok(), "auth token");
    assert_eq!(balance(&b, authority()), 1);
    b
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

#[wasm_bindgen_test]
fn share_vault_vests_harvested_yield_with_real_auth() {
    helpers::clear();
    let (asset, vault) = (alkane(1), alkane(2));
    let auth = real_auth(880300);
    // Token forwards incoming assets, so this output holds the asset and the auth unit.
    let (funded, e) = create(CUSTODY_TOKEN, vec![0, 10_000_000], Some(outpoint(&auth, 0)), 880301);
    assert!(e.result.is_ok(), "asset: {e:?}");
    // Harvested yield vests over 10 blocks.
    let (_, e) = create(VAULT, vec![0, 2, 1, 4, 9001, 10], None, 880302);
    assert!(e.result.is_ok(), "vault: {e:?}");
    report("share-vault deploy+initialize", &e);
    helpers::assert_binary_deployed_to_id(vault.clone(), VAULT.to_vec()).unwrap();
    let view = |inputs: Vec<u128>, height: u32| ok(&call(&vault, inputs, None, height).1);

    // 1000 virtual shares per virtual asset: the first deposit issues 1e10
    // shares. The auth unit is unrelated to a deposit and comes back.
    let shares = 10_000_000_000u128;
    let (deposited, e) = call(&vault, vec![1, 0], Some(outpoint(&funded, 0)), 880303);
    assert_eq!(ok(&e), shares);
    report("share-vault first deposit", &e);
    assert_eq!(balance(&deposited, vault.clone()), shares);
    assert_eq!(balance(&deposited, asset.clone()), 0);
    assert_eq!(balance(&deposited, authority()), 1);
    assert_eq!(custody(&vault, &asset), 10_000_000);

    // Yield sent with an authenticated harvest is locked at height 880305,
    // then vests linearly: locked(h) = ceil(500000 * (880315 - h) / 10).
    let (minted, e) = call(&asset, vec![77, 500_000], Some(outpoint(&deposited, 0)), 880304);
    assert!(e.result.is_ok(), "mint: {e:?}");
    let (harvested, e) = call(&vault, vec![3], Some(outpoint(&minted, 0)), 880305);
    assert_eq!(ok(&e), 500_000);
    report("share-vault harvest (real auth + yield)", &e);
    assert_eq!(balance(&harvested, asset.clone()), 0);
    assert_eq!(balance(&harvested, vault.clone()), shares);
    assert!(balance(&harvested, authority()) >= 1, "the auth unit comes back");
    assert_eq!(custody(&vault, &asset), 10_500_000);
    assert_eq!(view(vec![10], 880306), 10_500_000);
    assert_eq!(view(vec![17], 880307), 400_000);
    assert_eq!(view(vec![17], 880310), 250_000);
    assert_eq!(view(vec![17], 880314), 50_000);
    assert_eq!(view(vec![17], 880315), 0);

    // Fully vested: every share redeems at (assets + 1) / (shares + 1000).
    let payout = shares * (10_500_000 + 1) / (shares + 1000);
    assert_eq!(view(vec![13, shares], 880316), payout);
    let (redeemed, e) = call(&vault, vec![2, 0], Some(outpoint(&harvested, 0)), 880317);
    assert_eq!(ok(&e), payout);
    report("share-vault redeem", &e);
    assert_eq!(balance(&redeemed, asset.clone()), payout);
    assert_eq!(balance(&redeemed, vault.clone()), 0);
    // Redeemed shares stay in the vault's custody, out of circulation; the
    // virtual shares' slice of the yield stays behind.
    assert_eq!(custody(&vault, &vault), shares);
    assert_eq!(custody(&vault, &asset), 10_500_000 - payout);
    assert_eq!(view(vec![10], 880318), 10_500_000 - payout);
    assert_eq!(view(vec![11], 880319), 0);

    // A deposit with a slippage bound it cannot meet reverts and refunds.
    let (_, e) = call(&vault, vec![1, u128::MAX], Some(outpoint(&redeemed, 0)), 880320);
    assert_revert(e, "SLIPPAGE");
    assert_eq!(custody(&vault, &asset), 10_500_000 - payout);
}

#[wasm_bindgen_test]
fn timelock_treasury_pays_out_inside_its_window_with_real_auth() {
    helpers::clear();
    let (treasury, asset) = (alkane(1), alkane(2));
    let auth = real_auth(880200);
    // The initializer proves the authority: the deployment presents the auth
    // unit, which comes back with the response. Withdrawals are ready 2
    // blocks after scheduling and expire 3 blocks later.
    let (deployed, e) = create(TREASURY, vec![0, 4, 9001, 2, 3], Some(outpoint(&auth, 0)), 880201);
    assert!(e.result.is_ok(), "treasury: {e:?}");
    report("timelock-treasury deploy+initialize (real auth)", &e);
    helpers::assert_binary_deployed_to_id(treasury.clone(), TREASURY.to_vec()).unwrap();
    let units = balance(&deployed, authority());
    assert!(units >= 1, "the auth unit comes back");
    // Token forwards incoming assets, so this output holds the asset and the auth units.
    let (funded, e) = create(CUSTODY_TOKEN, vec![0, 1_000_000], Some(outpoint(&deployed, 0)), 880202);
    assert!(e.result.is_ok(), "asset: {e:?}");
    let view = |inputs: Vec<u128>, height: u32| ok(&call(&treasury, inputs, None, height).1);

    // A deposit keeps the asset and returns the auth units.
    let (deposited, e) = call(&treasury, vec![1, 2, 2], Some(outpoint(&funded, 0)), 880203);
    assert_eq!(ok(&e), 1_000_000);
    report("timelock-treasury deposit", &e);
    assert_eq!(balance(&deposited, asset.clone()), 0);
    assert_eq!(balance(&deposited, authority()), units);
    assert_eq!(custody(&treasury, &asset), 1_000_000);

    // Scheduled at 880204: ready from 880206, expired from 880209.
    let (scheduled, e) = call(&treasury, vec![2, 2, 2, 400_000], Some(outpoint(&deposited, 0)), 880204);
    assert_eq!(ok(&e), 880206);
    report("timelock-treasury schedule (real auth)", &e);
    let units = balance(&scheduled, authority());
    assert!(units >= 1, "the auth unit comes back");
    let (early, e) = call(&treasury, vec![3], Some(outpoint(&scheduled, 0)), 880205);
    assert_revert(e, "TIMELOCK_ACTIVE");
    assert_eq!(balance(&early, authority()), units, "a revert refunds the auth units");
    let (paid, e) = call(&treasury, vec![3], Some(outpoint(&early, 0)), 880206);
    assert_eq!(ok(&e), 400_000);
    report("timelock-treasury execute (real auth + payout)", &e);
    assert_eq!(balance(&paid, asset.clone()), 400_000);
    assert_eq!(custody(&treasury, &asset), 600_000);
    assert_eq!(view(vec![11], 880207), 0);

    // A withdrawal left past its window can no longer execute; its slot can
    // be replaced, and the replacement cancelled.
    let (again, e) = call(&treasury, vec![2, 2, 2, 100_000], Some(outpoint(&paid, 0)), 880208);
    assert_eq!(ok(&e), 880210);
    let (late, e) = call(&treasury, vec![3], Some(outpoint(&again, 0)), 880213);
    assert_revert(e, "WITHDRAWAL_EXPIRED");
    assert_eq!(custody(&treasury, &asset), 600_000);
    let (replaced, e) = call(&treasury, vec![2, 2, 2, 50_000], Some(outpoint(&late, 0)), 880214);
    assert_eq!(ok(&e), 880216);
    assert_eq!(view(vec![12], 880215), 880216);
    let (_, e) = call(&treasury, vec![4], Some(outpoint(&replaced, 0)), 880216);
    assert!(e.result.is_ok(), "cancel: {e:?}");
    report("timelock-treasury cancel (real auth)", &e);
    assert_eq!(view(vec![11], 880217), 0);
    assert_eq!(view(vec![13, 2, 2], 880218), 600_000);
    assert_eq!(custody(&treasury, &asset), 600_000);

    // An authority that nobody can present a unit of is refused, and the
    // failed initializer rolls the creation back.
    let (_, e) = create(TREASURY, vec![0, 4, 7777, 2, 3], None, 880219);
    assert_revert(e, "AUTH_ASSET_REQUIRED");
}
