//! Test token for the Splitback demo. NOT a real stablecoin.
//!
//! It speaks the part of NEP-141 that Splitback uses (`ft_transfer`,
//! `ft_transfer_call`, `ft_balance_of`) and lets anyone mint, so the demo can
//! run on testnet and in a local sandbox without a faucet. It skips NEP-145
//! storage registration on purpose.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

const GAS_ON_TRANSFER: Gas = Gas::from_tgas(40);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[ext_contract(ext_receiver)]
pub trait FtReceiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
}

#[near]
impl MockUsdc {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            total_supply: 0,
        }
    }

    /// Anyone can mint. This is a test token.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let bal = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, bal + amount.0);
        self.total_supply += amount.0;
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        #[callback_result] unused: Result<U128, PromiseError>,
    ) -> U128 {
        let unused = match unused {
            Ok(u) => u.0.min(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let receiver_bal = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let refund = unused.min(receiver_bal);
            if refund > 0 {
                self.internal_transfer(&receiver_id, &sender_id, refund);
            }
            return U128(amount.0 - refund);
        }
        amount
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_metadata(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "spec": "ft-1.0.0",
            "name": "Mock USDC (test token)",
            "symbol": "mUSDC",
            "decimals": 6
        })
    }
}

impl MockUsdc {
    fn internal_transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        let from_bal = self.balances.get(from).copied().unwrap_or(0);
        require!(from_bal >= amount, "not enough balance");
        self.balances.insert(from.clone(), from_bal - amount);
        let to_bal = self.balances.get(to).copied().unwrap_or(0);
        self.balances.insert(to.clone(), to_bal + amount);
    }
}
