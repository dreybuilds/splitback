//! Splitback: a cost-sharing market for computed results.
//!
//! The rules this contract implements are in RULES.md at the repo root.
//! Every holder of an entry ends up paying ceil(cost / holders), no matter
//! when they joined.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(10);
const MAX_SPEC_LEN: usize = 256;
const HASH_HEX_LEN: usize = 64;
/// Challenge stake is cost / CHALLENGE_STAKE_DIVISOR, rounded up.
const CHALLENGE_STAKE_DIVISOR: u128 = 10;
/// The bond is cost * BOND_MULTIPLIER, so a publisher caught with a wrong result
/// always loses more than the full cost, however many rebates it already claimed.
const BOND_MULTIPLIER: u128 = 2;
/// An entry that charges a delivery fee can collect at most `cost` in fees in
/// total, and bonds that much extra, so the fees are always refundable.
const FEE_BOND_MULTIPLIER: u128 = 1;
/// Share of the losing side's forfeit that goes to the verifiers who voted with
/// the outcome, split equally.
const VERIFIER_CUT_DIVISOR: u128 = 10;

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Balances,
    Entries,
    ByKey,
    Holdings,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Open,
    Retired,
    Challenged,
    Voided,
    Closed,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Entry {
    task_key: String,
    spec: String,
    result_hash: String,
    cost: u128,
    publisher: AccountId,
    provider: Option<AccountId>,
    holders: u32,
    status: Status,
    status_before_challenge: Status,
    challenger: Option<AccountId>,
    challenge_stake: u128,
    challenged_at: u64,
    votes_uphold: Vec<AccountId>,
    votes_reject: Vec<AccountId>,
    bond: u128,
    delivery_fee: u128,
    fees_collected: u128,
    paid_in: u128,
    rebated: u128,
    created_at: u64,
    last_activity: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Holding {
    paid: u128,
    fee_paid: u128,
    claimed: u128,
    joined_as: u32,
}

#[near(serializers = [json])]
pub struct EntryView {
    pub id: u32,
    pub task_key: String,
    pub spec: String,
    pub result_hash: String,
    pub cost: U128,
    pub publisher: AccountId,
    pub provider: Option<AccountId>,
    pub holders: u32,
    pub status: Status,
    pub challenger: Option<AccountId>,
    pub votes_uphold: Vec<AccountId>,
    pub votes_reject: Vec<AccountId>,
    pub bond: U128,
    pub delivery_fee: U128,
    pub fees_collected: U128,
    pub paid_in: U128,
    pub rebated: U128,
    pub current_share: U128,
    /// What the next buyer pays in total: its share plus the delivery fee.
    pub next_price: U128,
    pub next_share: U128,
    pub next_fee: U128,
    pub created_at: U64,
    pub last_activity: U64,
}

#[near(serializers = [json])]
pub struct HoldingView {
    pub paid: U128,
    pub fee_paid: U128,
    pub claimed: U128,
    pub joined_as: u32,
    pub claimable: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Stats {
    pub entries: u32,
    pub joins: u32,
    pub voided: u32,
    pub cost_published: U128,
    pub paid_in: U128,
    pub rebated: U128,
    pub slashed: U128,
    pub delivery_fees: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub token: AccountId,
    pub verifiers: Vec<AccountId>,
    pub threshold: u32,
    pub challenge_window_ns: U64,
    pub challenge_stake_divisor: u32,
    pub bond_multiplier: u32,
    pub fee_bond_multiplier: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Splitback {
    token: AccountId,
    verifiers: Vec<AccountId>,
    threshold: u32,
    challenge_window_ns: u64,
    balances: LookupMap<AccountId, u128>,
    entries: Vector<Entry>,
    by_key: LookupMap<String, Vec<u32>>,
    holdings: LookupMap<(u32, AccountId), Holding>,
    stats: Stats,
}

/// ceil(cost / k). What every holder has paid, net, when there are k holders.
pub fn share(cost: u128, k: u32) -> u128 {
    let k = k as u128;
    (cost + k - 1) / k
}

fn is_hash(s: &str) -> bool {
    s.len() == HASH_HEX_LEN && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "splitback",
            "version": "1.0.0",
            "event": event,
            "data": [data]
        })
    ));
}

#[near]
impl Splitback {
    #[init]
    pub fn new(
        token: AccountId,
        verifiers: Vec<AccountId>,
        threshold: u32,
        challenge_window_ns: U64,
    ) -> Self {
        let n = verifiers.len() as u32;
        require!(n >= 1, "at least one verifier");
        // A strict majority, so the two outcomes can never both reach the threshold.
        require!(threshold <= n && threshold * 2 > n, "threshold must be a strict majority");
        for (i, v) in verifiers.iter().enumerate() {
            require!(!verifiers[..i].contains(v), "duplicate verifier");
        }
        Self {
            token,
            verifiers,
            threshold,
            challenge_window_ns: challenge_window_ns.0,
            balances: LookupMap::new(StorageKey::Balances),
            entries: Vector::new(StorageKey::Entries),
            by_key: LookupMap::new(StorageKey::ByKey),
            holdings: LookupMap::new(StorageKey::Holdings),
            stats: Stats::default(),
        }
    }

    // ---------------------------------------------------------------- money in

    /// NEP-141 receiver. `msg` may name the account to credit; empty credits the sender.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "only the configured token is accepted"
        );
        let beneficiary: AccountId = if msg.is_empty() {
            sender_id.clone()
        } else {
            msg.parse().unwrap_or_else(|_| env::panic_str("msg must be empty or an account id"))
        };
        self.credit(&beneficiary, amount.0);
        emit(
            "deposit",
            near_sdk::serde_json::json!({
                "account": beneficiary, "from": sender_id, "amount": amount
            }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ----------------------------------------------------------------- publish

    /// Rule 2. Locks a bond of twice `cost` from the caller's balance.
    /// If `provider` is given, the caller also pays `cost` to that account here,
    /// so the price of the work is a payment the chain saw, not a claim.
    /// `delivery_fee` is a flat amount each buyer pays the publisher on top of
    /// its share, for storing and serving the bytes. It sits outside the split.
    pub fn publish(
        &mut self,
        task_key: String,
        spec: String,
        result_hash: String,
        cost: U128,
        provider: Option<AccountId>,
        delivery_fee: Option<U128>,
    ) -> u32 {
        require!(is_hash(&task_key), "task_key must be 64 lowercase hex chars");
        require!(is_hash(&result_hash), "result_hash must be 64 lowercase hex chars");
        require!(spec.len() <= MAX_SPEC_LEN, "spec too long");
        require!(cost.0 > 0, "cost must be positive");
        let publisher = env::predecessor_account_id();
        let delivery_fee = delivery_fee.map(|f| f.0).unwrap_or(0);
        require!(delivery_fee <= cost.0, "delivery fee cannot exceed the cost");
        let fee_bond = if delivery_fee > 0 { cost.0 * FEE_BOND_MULTIPLIER } else { 0 };
        let bond = cost.0 * BOND_MULTIPLIER + fee_bond;
        self.debit(&publisher, bond);
        if let Some(p) = &provider {
            require!(*p != publisher, "provider must be a different account");
            self.debit(&publisher, cost.0);
            self.credit(p, cost.0);
        }

        let id = self.entries.len();
        let now = env::block_timestamp();
        self.entries.push(Entry {
            task_key: task_key.clone(),
            spec,
            result_hash: result_hash.clone(),
            cost: cost.0,
            publisher: publisher.clone(),
            provider: provider.clone(),
            holders: 1,
            status: Status::Open,
            status_before_challenge: Status::Open,
            challenger: None,
            challenge_stake: 0,
            challenged_at: 0,
            votes_uphold: Vec::new(),
            votes_reject: Vec::new(),
            bond,
            delivery_fee,
            fees_collected: 0,
            paid_in: 0,
            rebated: 0,
            created_at: now,
            last_activity: now,
        });
        self.holdings.insert(
            (id, publisher.clone()),
            Holding { paid: cost.0, fee_paid: 0, claimed: 0, joined_as: 1 },
        );
        let mut ids = self.by_key.get(&task_key).cloned().unwrap_or_default();
        ids.push(id);
        self.by_key.insert(task_key.clone(), ids);

        self.stats.entries += 1;
        self.stats.cost_published.0 += cost.0;
        emit(
            "publish",
            near_sdk::serde_json::json!({
                "entry": id, "task_key": task_key, "result_hash": result_hash,
                "publisher": publisher, "provider": provider, "cost": cost, "bond": U128(bond), "delivery_fee": U128(delivery_fee)
            }),
        );
        id
    }

    // -------------------------------------------------------------------- join

    /// Rule 3. Pays ceil(cost / (k + 1)), plus the entry's delivery fee, and
    /// becomes holder k + 1. `max_price` bounds the total.
    pub fn join(&mut self, entry_id: u32, max_price: Option<U128>) -> U128 {
        let buyer = env::predecessor_account_id();
        let mut entry = self.entry(entry_id);
        require!(entry.status == Status::Open, "entry is not open");
        require!(
            self.holdings.get(&(entry_id, buyer.clone())).is_none(),
            "already a holder"
        );
        let k = entry.holders + 1;
        let price = share(entry.cost, k);
        let fee = Self::next_fee(&entry);
        if let Some(max) = max_price {
            require!(price + fee <= max.0, "price is above max_price");
        }
        self.debit(&buyer, price + fee);
        if fee > 0 {
            // The delivery fee goes straight to the publisher. It is outside the split.
            let publisher = entry.publisher.clone();
            self.credit(&publisher, fee);
            entry.fees_collected += fee;
            self.stats.delivery_fees.0 += fee;
        }
        self.holdings.insert(
            (entry_id, buyer.clone()),
            Holding { paid: price, fee_paid: fee, claimed: 0, joined_as: k },
        );
        entry.holders = k;
        entry.paid_in += price;
        entry.last_activity = env::block_timestamp();
        self.stats.joins += 1;
        self.stats.paid_in.0 += price;
        emit(
            "join",
            near_sdk::serde_json::json!({
                "entry": entry_id, "task_key": entry.task_key, "result_hash": entry.result_hash,
                "buyer": buyer, "seller": entry.publisher, "price": U128(price), "delivery_fee": U128(fee),
                "holders": k, "cost": U128(entry.cost)
            }),
        );
        self.entries.replace(entry_id, entry);
        U128(price + fee)
    }

    // ------------------------------------------------------------------- claim

    /// Rule 4, and the refund half of rule 8. Credits the caller's balance.
    pub fn claim(&mut self, entry_id: u32) -> U128 {
        let who = env::predecessor_account_id();
        let mut entry = self.entry(entry_id);
        let mut holding = self
            .holdings
            .get(&(entry_id, who.clone()))
            .cloned()
            .unwrap_or_else(|| env::panic_str("not a holder"));
        let amount = Self::claimable_of(&entry, &holding, &who);
        if amount > 0 {
            holding.claimed += amount;
            self.holdings.insert((entry_id, who.clone()), holding);
            entry.rebated += amount;
            self.stats.rebated.0 += amount;
            self.entries.replace(entry_id, entry.clone());
            self.credit(&who, amount);
            emit(
                "claim",
                near_sdk::serde_json::json!({
                    "entry": entry_id, "account": who, "amount": U128(amount),
                    "refund": entry.status == Status::Voided
                }),
            );
        }
        U128(amount)
    }

    // --------------------------------------------------------------- challenge

    /// Rule 7. Stakes ceil(cost / 10) from the caller's balance.
    pub fn challenge(&mut self, entry_id: u32, reason: String) {
        require!(reason.len() <= MAX_SPEC_LEN, "reason too long");
        let challenger = env::predecessor_account_id();
        let mut entry = self.entry(entry_id);
        require!(
            entry.status == Status::Open || entry.status == Status::Retired,
            "entry cannot be challenged"
        );
        require!(challenger != entry.publisher, "publisher cannot challenge own entry");
        let stake = share(entry.cost, CHALLENGE_STAKE_DIVISOR as u32);
        self.debit(&challenger, stake);
        entry.status_before_challenge = entry.status;
        entry.status = Status::Challenged;
        entry.challenger = Some(challenger.clone());
        entry.challenge_stake = stake;
        entry.challenged_at = env::block_timestamp();
        entry.votes_uphold.clear();
        entry.votes_reject.clear();
        self.entries.replace(entry_id, entry);
        emit(
            "challenge",
            near_sdk::serde_json::json!({
                "entry": entry_id, "challenger": challenger, "stake": U128(stake), "reason": reason
            }),
        );
    }

    /// Rule 8. One vote per verifier per challenge. The challenge is decided as
    /// soon as either side reaches the threshold. Returns the outcome if this
    /// vote decided it.
    pub fn vote(&mut self, entry_id: u32, upheld: bool) -> Option<bool> {
        let voter = env::predecessor_account_id();
        require!(self.verifiers.contains(&voter), "only a verifier votes");
        let mut entry = self.entry(entry_id);
        require!(entry.status == Status::Challenged, "no pending challenge");
        require!(
            !entry.votes_uphold.contains(&voter) && !entry.votes_reject.contains(&voter),
            "already voted"
        );
        if upheld {
            entry.votes_uphold.push(voter.clone());
        } else {
            entry.votes_reject.push(voter.clone());
        }
        emit(
            "vote",
            near_sdk::serde_json::json!({ "entry": entry_id, "verifier": voter, "upheld": upheld }),
        );
        let outcome = if entry.votes_uphold.len() as u32 >= self.threshold {
            Some(true)
        } else if entry.votes_reject.len() as u32 >= self.threshold {
            Some(false)
        } else {
            None
        };
        match outcome {
            Some(o) => self.finalize(entry_id, entry, o),
            None => {
                self.entries.replace(entry_id, entry);
            }
        }
        outcome
    }

    /// Rule 8b. If the verifiers have not decided within the challenge window,
    /// anyone may lapse the challenge: the stake returns to the challenger and
    /// the entry goes back to its previous state. Nobody is punished.
    pub fn expire_challenge(&mut self, entry_id: u32) {
        let mut entry = self.entry(entry_id);
        require!(entry.status == Status::Challenged, "no pending challenge");
        require!(
            env::block_timestamp() >= entry.challenged_at + self.challenge_window_ns,
            "verifiers still have time to vote"
        );
        let challenger = entry.challenger.take().unwrap();
        let stake = entry.challenge_stake;
        entry.challenge_stake = 0;
        entry.votes_uphold.clear();
        entry.votes_reject.clear();
        entry.status = entry.status_before_challenge;
        entry.last_activity = env::block_timestamp();
        self.entries.replace(entry_id, entry);
        self.credit(&challenger, stake);
        emit(
            "challenge_expired",
            near_sdk::serde_json::json!({ "entry": entry_id, "challenger": challenger, "stake": U128(stake) }),
        );
    }

    // ------------------------------------------------------- retire and release

    /// Rule 10. Stops new joins.
    pub fn retire(&mut self, entry_id: u32) {
        let mut entry = self.entry(entry_id);
        require!(
            env::predecessor_account_id() == entry.publisher,
            "only the publisher retires"
        );
        require!(entry.status == Status::Open, "entry is not open");
        entry.status = Status::Retired;
        self.entries.replace(entry_id, entry);
        emit("retire", near_sdk::serde_json::json!({ "entry": entry_id }));
    }

    /// Rule 10. Returns the bond once the challenge window has passed.
    pub fn release_bond(&mut self, entry_id: u32) -> U128 {
        let mut entry = self.entry(entry_id);
        require!(
            env::predecessor_account_id() == entry.publisher,
            "only the publisher releases the bond"
        );
        require!(entry.status == Status::Retired, "retire the entry first");
        require!(
            env::block_timestamp() >= entry.last_activity + self.challenge_window_ns,
            "challenge window has not passed"
        );
        let bond = entry.bond;
        entry.bond = 0;
        entry.status = Status::Closed;
        let publisher = entry.publisher.clone();
        self.entries.replace(entry_id, entry);
        self.credit(&publisher, bond);
        emit(
            "release_bond",
            near_sdk::serde_json::json!({ "entry": entry_id, "amount": U128(bond) }),
        );
        U128(bond)
    }

    // --------------------------------------------------------------- money out

    /// Rule 11. Sends tokens to the caller's own account.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        self.debit(&who, amount.0);
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(who.clone(), amount, Some("splitback withdraw".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_WITHDRAW_CALLBACK)
                    .on_withdraw(who, amount),
            )
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            self.credit(&account, amount.0);
            return false;
        }
        emit(
            "withdraw",
            near_sdk::serde_json::json!({ "account": account, "amount": amount }),
        );
        true
    }

    // ------------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config {
            token: self.token.clone(),
            verifiers: self.verifiers.clone(),
            threshold: self.threshold,
            challenge_window_ns: U64(self.challenge_window_ns),
            challenge_stake_divisor: CHALLENGE_STAKE_DIVISOR as u32,
            bond_multiplier: BOND_MULTIPLIER as u32,
            fee_bond_multiplier: FEE_BOND_MULTIPLIER as u32,
        }
    }

    pub fn get_stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_entry(&self, entry_id: u32) -> Option<EntryView> {
        self.entries.get(entry_id).map(|e| Self::view(entry_id, e))
    }

    pub fn get_entries(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<EntryView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.entries.len().min(from.saturating_add(limit)))
            .map(|i| Self::view(i, self.entries.get(i).unwrap()))
            .collect()
    }

    /// All entries published for a task key, in publish order.
    pub fn entries_for_key(&self, task_key: String) -> Vec<EntryView> {
        self.by_key
            .get(&task_key)
            .map(|ids| {
                ids.iter()
                    .map(|i| Self::view(*i, self.entries.get(*i).unwrap()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The total the next buyer would pay: its share plus the delivery fee.
    pub fn quote(&self, entry_id: u32) -> U128 {
        let e = self.entry(entry_id);
        U128(share(e.cost, e.holders + 1) + Self::next_fee(&e))
    }

    pub fn get_holding(&self, entry_id: u32, account_id: AccountId) -> Option<HoldingView> {
        let entry = self.entries.get(entry_id)?;
        let h = self.holdings.get(&(entry_id, account_id.clone()))?;
        Some(HoldingView {
            paid: U128(h.paid),
            fee_paid: U128(h.fee_paid),
            claimed: U128(h.claimed),
            joined_as: h.joined_as,
            claimable: U128(Self::claimable_of(entry, h, &account_id)),
        })
    }

    pub fn is_holder(&self, entry_id: u32, account_id: AccountId) -> bool {
        self.holdings.get(&(entry_id, account_id)).is_some()
    }
}

impl Splitback {
    fn finalize(&mut self, entry_id: u32, mut entry: Entry, upheld: bool) {
        let challenger = entry.challenger.take().unwrap();
        let stake = entry.challenge_stake;
        entry.challenge_stake = 0;
        let winners = if upheld { entry.votes_uphold.clone() } else { entry.votes_reject.clone() };
        entry.votes_uphold.clear();
        entry.votes_reject.clear();
        let mut reward = 0u128;
        let forfeit;
        if upheld {
            // The publisher keeps what it already claimed; the bond covers exactly
            // that hole in the buyers' pool, and the rest is forfeit.
            let key = (entry_id, entry.publisher.clone());
            let mut pub_holding = self.holdings.get(&key).cloned().unwrap();
            let pub_claimed = pub_holding.claimed;
            pub_holding.claimed = pub_holding.paid;
            self.holdings.insert(key, pub_holding);
            // Delivery fees were paid out to the publisher as they came in; the bond
            // also covers refunding them.
            forfeit = entry.bond - pub_claimed - entry.fees_collected;
            entry.bond = 0;
            entry.status = Status::Voided;
            self.stats.voided += 1;
            self.stats.slashed.0 += forfeit;
        } else {
            forfeit = stake;
            entry.status = entry.status_before_challenge;
            entry.last_activity = env::block_timestamp();
        }
        // Verifiers who voted with the outcome split a tenth of the forfeit.
        let per_verifier = forfeit / VERIFIER_CUT_DIVISOR / winners.len() as u128;
        for w in &winners {
            self.credit(w, per_verifier);
        }
        let rest = forfeit - per_verifier * winners.len() as u128;
        if upheld {
            reward = rest;
            self.credit(&challenger, stake + rest);
        } else {
            let publisher = entry.publisher.clone();
            self.credit(&publisher, rest);
        }
        self.entries.replace(entry_id, entry);
        emit(
            "resolve",
            near_sdk::serde_json::json!({
                "entry": entry_id, "upheld": upheld, "challenger": challenger,
                "stake": U128(stake), "reward": U128(reward),
                "verifiers_paid": winners, "per_verifier": U128(per_verifier)
            }),
        );
    }

    fn entry(&self, id: u32) -> Entry {
        self.entries
            .get(id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such entry"))
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let bal = self.balances.get(account).copied().unwrap_or(0);
        self.balances.insert(account.clone(), bal + amount);
    }

    fn debit(&mut self, account: &AccountId, amount: u128) {
        let bal = self.balances.get(account).copied().unwrap_or(0);
        require!(bal >= amount, "prepaid balance too low");
        self.balances.insert(account.clone(), bal - amount);
    }

    /// The fee the next join pays: the entry's fee, until fees total the cost.
    fn next_fee(entry: &Entry) -> u128 {
        entry.delivery_fee.min(entry.cost - entry.fees_collected)
    }

    fn claimable_of(entry: &Entry, holding: &Holding, who: &AccountId) -> u128 {
        if entry.status == Status::Voided {
            // Buyers get back everything they paid net of rebates. The publisher's
            // holding was zeroed out in `resolve`.
            if *who == entry.publisher {
                return 0;
            }
            return holding.paid + holding.fee_paid - holding.claimed;
        }
        let net_target = share(entry.cost, entry.holders);
        holding.paid.saturating_sub(net_target).saturating_sub(holding.claimed)
    }

    fn view(id: u32, e: &Entry) -> EntryView {
        EntryView {
            id,
            task_key: e.task_key.clone(),
            spec: e.spec.clone(),
            result_hash: e.result_hash.clone(),
            cost: U128(e.cost),
            publisher: e.publisher.clone(),
            provider: e.provider.clone(),
            holders: e.holders,
            status: e.status,
            challenger: e.challenger.clone(),
            votes_uphold: e.votes_uphold.clone(),
            votes_reject: e.votes_reject.clone(),
            bond: U128(e.bond),
            delivery_fee: U128(e.delivery_fee),
            fees_collected: U128(e.fees_collected),
            paid_in: U128(e.paid_in),
            rebated: U128(e.rebated),
            current_share: U128(share(e.cost, e.holders)),
            next_price: U128(share(e.cost, e.holders + 1) + Self::next_fee(e)),
            next_share: U128(share(e.cost, e.holders + 1)),
            next_fee: U128(Self::next_fee(e)),
            created_at: U64(e.created_at),
            last_activity: U64(e.last_activity),
        }
    }
}

#[cfg(test)]
mod tests;
