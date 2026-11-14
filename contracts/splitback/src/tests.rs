use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WINDOW: u64 = 60_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_caller(who: &str, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .block_timestamp(ts)
        .build());
}

fn setup() -> Splitback {
    as_caller("owner.test", 0);
    Splitback::new(acc("usdc.test"), acc("verifier.test"), U64(WINDOW))
}

fn fund(c: &mut Splitback, who: &str, amount: u128) {
    as_caller("usdc.test", 1);
    c.ft_on_transfer(acc("bank.test"), U128(amount), who.to_string());
}

fn bal(c: &Splitback, who: &str) -> u128 {
    c.balance_of(acc(who)).0
}

#[test]
fn share_is_ceiling() {
    assert_eq!(share(900, 1), 900);
    assert_eq!(share(900, 2), 450);
    assert_eq!(share(900, 3), 300);
    assert_eq!(share(1000, 3), 334);
    assert_eq!(share(1, 7), 1);
}

#[test]
fn the_worked_example_from_rules() {
    let mut c = setup();
    fund(&mut c, "p.test", 1800);
    fund(&mut c, "b1.test", 1000);
    fund(&mut c, "b2.test", 1000);

    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "demo".into(), HASH.into(), U128(900), None);
    assert_eq!(bal(&c, "p.test"), 0, "bond locked");
    assert_eq!(c.quote(id).0, 450);

    as_caller("b1.test", 3);
    assert_eq!(c.join(id, Some(U128(450))).0, 450);
    as_caller("p.test", 4);
    assert_eq!(c.claim(id).0, 450);

    as_caller("b2.test", 5);
    assert_eq!(c.join(id, None).0, 300);
    as_caller("p.test", 6);
    assert_eq!(c.claim(id).0, 150);
    as_caller("b1.test", 7);
    assert_eq!(c.claim(id).0, 150);

    // Everyone has paid 300 net.
    assert_eq!(bal(&c, "p.test"), 600); // paid 900 off chain, got 600 back
    assert_eq!(bal(&c, "b1.test"), 700);
    assert_eq!(bal(&c, "b2.test"), 700);
}

/// Rules 4 and 5: holders claim in a scattered order and all end at the same net cost.
fn run_case(cost: u128, n: u32) {
    let mut c = setup();
    fund(&mut c, "p.test", 2 * cost);
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(cost), None);
    let mut paid_in = 0u128;
    for i in 0..n {
        let who = format!("b{i}.test");
        fund(&mut c, &who, cost);
        as_caller(&who, 3);
        paid_in += c.join(id, None).0;
        // some holders claim along the way, some only at the end
        if i % 3 == 0 {
            as_caller("p.test", 4);
            c.claim(id);
        }
        if i % 4 == 1 {
            as_caller(&format!("b{}.test", i / 2), 4);
            c.claim(id);
        }
    }
    let k = n + 1;
    let target = share(cost, k);
    as_caller("p.test", 5);
    c.claim(id);
    assert_eq!(bal(&c, "p.test"), cost - target, "publisher net cost");
    for i in 0..n {
        let who = format!("b{i}.test");
        as_caller(&who, 5);
        c.claim(id);
        assert_eq!(bal(&c, &who), cost - target, "buyer {i} net cost, cost {cost}");
    }
    let e = c.get_entry(id).unwrap();
    assert_eq!(e.paid_in.0, paid_in);
    // Rebates paid out = publisher's (cost - target) + buyers' rebates. Buyers paid in
    // `paid_in` and keep n * target of it locked as their net cost.
    let buyers_rebates = paid_in - n as u128 * target;
    assert_eq!(e.rebated.0, (cost - target) + buyers_rebates);
    assert!(e.rebated.0 <= paid_in, "rebates never exceed what buyers paid in");
    assert!(paid_in - e.rebated.0 < k as u128, "only rounding dust is left");
}

#[test]
fn equal_net_cost_awkward_prime_49_buyers() {
    run_case(1_000_003, 49);
}

#[test]
fn equal_net_cost_tiny_cost_more_holders_than_units() {
    run_case(7, 20);
}

#[test]
fn equal_net_cost_three_buyers() {
    run_case(999_999, 3);
}

#[test]
fn equal_net_cost_one_unit() {
    run_case(1, 5);
}

#[test]
fn equal_net_cost_demo_size() {
    run_case(250_000, 20);
}

#[test]
fn upheld_challenge_refunds_buyers_and_pays_challenger_from_bond() {
    let mut c = setup();
    fund(&mut c, "p.test", 1800);
    for b in ["b1.test", "b2.test"] {
        fund(&mut c, b, 1000);
    }
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "poison".into(), HASH.into(), U128(900), None);
    as_caller("b1.test", 3);
    c.join(id, None);
    as_caller("b2.test", 4);
    c.join(id, None);
    // Publisher takes rebates before being caught; b1 claims too.
    as_caller("p.test", 5);
    assert_eq!(c.claim(id).0, 600);
    as_caller("b1.test", 5);
    assert_eq!(c.claim(id).0, 150);

    as_caller("b2.test", 6);
    c.challenge(id, "hash does not match recompute".into());
    assert_eq!(bal(&c, "b2.test"), 1000 - 300 - 90);

    // Joins are blocked while challenged.
    as_caller("verifier.test", 7);
    c.resolve(id, true);
    let e = c.get_entry(id).unwrap();
    assert_eq!(e.status, Status::Voided);

    // Challenger: stake back + bond minus what the publisher already took.
    assert_eq!(bal(&c, "b2.test"), 1000 - 300 + (1800 - 600));
    as_caller("b2.test", 8);
    assert_eq!(c.claim(id).0, 300);
    as_caller("b1.test", 8);
    assert_eq!(c.claim(id).0, 300);
    assert_eq!(bal(&c, "b1.test"), 1000, "b1 made whole");
    assert_eq!(bal(&c, "b2.test"), 1000 + 1200, "b2 made whole plus reward");

    as_caller("p.test", 9);
    assert_eq!(c.claim(id).0, 0, "publisher gets nothing more");
    // Money is conserved: 1800 + 1000 + 1000 went in.
    assert_eq!(bal(&c, "p.test") + bal(&c, "b1.test") + bal(&c, "b2.test"), 3800);
    // The publisher claimed 600 in rebates and lost a bond of 1800: worse off than the full cost.
    assert_eq!(bal(&c, "p.test"), 600);
}

#[test]
fn rejected_challenge_pays_stake_to_publisher_and_reopens() {
    let mut c = setup();
    fund(&mut c, "p.test", 2000);
    fund(&mut c, "x.test", 1000);
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "ok".into(), HASH.into(), U128(1000), None);
    as_caller("x.test", 3);
    c.challenge(id, "i think it is wrong".into());
    as_caller("verifier.test", 4);
    c.resolve(id, false);
    assert_eq!(bal(&c, "p.test"), 100);
    assert_eq!(bal(&c, "x.test"), 900);
    assert_eq!(c.get_entry(id).unwrap().status, Status::Open);
    as_caller("x.test", 5);
    assert_eq!(c.join(id, None).0, 500);
}

#[test]
fn bond_is_released_only_after_retire_and_window() {
    let mut c = setup();
    fund(&mut c, "p.test", 1000);
    as_caller("p.test", 10);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
    c.retire(id);
    as_caller("p.test", 10 + WINDOW);
    assert_eq!(c.release_bond(id).0, 1000);
    assert_eq!(bal(&c, "p.test"), 1000);
    assert_eq!(c.get_entry(id).unwrap().status, Status::Closed);
}

#[test]
#[should_panic(expected = "challenge window has not passed")]
fn bond_cannot_be_released_early() {
    let mut c = setup();
    fund(&mut c, "p.test", 1000);
    as_caller("p.test", 10);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
    c.retire(id);
    as_caller("p.test", 10 + WINDOW - 1);
    c.release_bond(id);
}

#[test]
#[should_panic(expected = "prepaid balance too low")]
fn cannot_publish_without_the_bond() {
    let mut c = setup();
    fund(&mut c, "p.test", 999);
    as_caller("p.test", 2);
    c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
}

#[test]
#[should_panic(expected = "already a holder")]
fn cannot_join_twice() {
    let mut c = setup();
    fund(&mut c, "p.test", 1000);
    fund(&mut c, "b.test", 500);
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
    as_caller("b.test", 3);
    c.join(id, None);
    c.join(id, None);
}

#[test]
#[should_panic(expected = "price is above max_price")]
fn max_price_protects_the_buyer() {
    let mut c = setup();
    fund(&mut c, "p.test", 1000);
    fund(&mut c, "b.test", 500);
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
    as_caller("b.test", 3);
    c.join(id, Some(U128(249)));
}

#[test]
#[should_panic(expected = "entry is not open")]
fn cannot_join_a_challenged_entry() {
    let mut c = setup();
    fund(&mut c, "p.test", 1000);
    fund(&mut c, "x.test", 500);
    fund(&mut c, "b.test", 500);
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
    as_caller("x.test", 3);
    c.challenge(id, "".into());
    as_caller("b.test", 4);
    c.join(id, None);
}

#[test]
#[should_panic(expected = "only the verifier resolves")]
fn only_verifier_resolves() {
    let mut c = setup();
    fund(&mut c, "p.test", 1000);
    fund(&mut c, "x.test", 500);
    as_caller("p.test", 2);
    let id = c.publish(KEY.into(), "t".into(), HASH.into(), U128(500), None);
    as_caller("x.test", 3);
    c.challenge(id, "".into());
    c.resolve(id, true);
}

#[test]
#[should_panic(expected = "only the configured token is accepted")]
fn deposits_from_other_tokens_are_rejected() {
    let mut c = setup();
    as_caller("fake.test", 1);
    c.ft_on_transfer(acc("a.test"), U128(5), "".into());
}

#[test]
fn competing_entries_for_one_task_key() {
    let mut c = setup();
    fund(&mut c, "p1.test", 1800);
    fund(&mut c, "p2.test", 1200);
    as_caller("p1.test", 2);
    c.publish(KEY.into(), "t".into(), HASH.into(), U128(900), None);
    as_caller("p2.test", 3);
    c.publish(KEY.into(), "t".into(), HASH.into(), U128(600), None);
    let found = c.entries_for_key(KEY.into());
    assert_eq!(found.len(), 2);
    assert_eq!(found[1].next_price.0, 300);
}

/// The pitch: one agent pays 12 for a replay, a second buys in for 6, a third for 4.
#[test]
fn commissioned_work_pays_the_provider_and_everyone_ends_at_four() {
    let mut c = setup();
    fund(&mut c, "a.test", 36); // 12 to the provider + 24 bond
    fund(&mut c, "b.test", 6);
    fund(&mut c, "c.test", 4);
    as_caller("a.test", 2);
    let id = c.publish(KEY.into(), "replay".into(), HASH.into(), U128(12), Some(acc("provider.test")));
    assert_eq!(bal(&c, "provider.test"), 12, "provider earned 12");
    assert_eq!(bal(&c, "a.test"), 0);

    as_caller("b.test", 3);
    assert_eq!(c.join(id, None).0, 6);
    as_caller("c.test", 4);
    assert_eq!(c.join(id, None).0, 4);

    as_caller("a.test", 5);
    assert_eq!(c.claim(id).0, 8, "first buyer gets 6 then 2 back");
    as_caller("b.test", 5);
    assert_eq!(c.claim(id).0, 2, "second buyer gets 2 back");
    as_caller("c.test", 5);
    assert_eq!(c.claim(id).0, 0);

    // Every buyer paid 4 net. A still has its bond of 24 locked.
    assert_eq!(bal(&c, "a.test"), 8);
    assert_eq!(bal(&c, "b.test"), 2);
    assert_eq!(bal(&c, "c.test"), 0);
    assert_eq!(c.get_entry(id).unwrap().current_share.0, 4);
}

#[test]
#[should_panic(expected = "provider must be a different account")]
fn cannot_name_yourself_as_provider() {
    let mut c = setup();
    fund(&mut c, "a.test", 36);
    as_caller("a.test", 2);
    c.publish(KEY.into(), "t".into(), HASH.into(), U128(12), Some(acc("a.test")));
}
