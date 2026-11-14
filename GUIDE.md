# Splitback guide

How to run each example, call the contract yourself, and fit your own kind of work to it. [README.md](README.md) says what Splitback is and [RULES.md](RULES.md) gives the rules; this file is the how-to.

Amounts are in the smallest unit of a 6-decimal token, passed as strings: `"12000000"` is 12 test USDC.

## 1. Set up

You need Node.js 20 or newer. Rust is only needed for the contract tests.

```sh
cd sim
npm install
```

The first script you run downloads a local NEAR node binary. The walkthrough, pitch, sim, fund and judge scripts each start their own local chain and deploy the prebuilt contracts from `res/`. The first four exit non-zero if a rule is broken. `fund` and `quote.mjs` also call the live NEAR Intents API for rates.

## 2. Which example shows what

Run these from `sim/`.

| You want to see | Run |
|---|---|
| Every contract call for one entry, with its arguments | `npm run walkthrough` (about 30 seconds) |
| A wrong result caught: challenge, vote, refund, slashed bond | `npm run walkthrough -- --wrong` |
| A delivery fee on top of the split | `npm run walkthrough -- --fee 0.5` |
| The three-buyer story, with a buyer that waits for the price to fall | `npm run pitch` |
| A whole market: 20 buyers, 5 sellers, 3 verifiers, undercutting, a lazy verifier, a task nobody sells | `npm run sim` (about 80 seconds) |
| Agents funded in USDC, USDT and DAI; cash-out in USDT | `npm run fund` |
| Live stablecoin quotes from NEAR Intents, nothing sent | `node ../intents/quote.mjs` |
| Written briefs judged by three models (needs a NEAR AI Cloud key) | `NEAR_AI_API_KEY=... npm run judge` |
| Each rule on its own, as a unit test | `cargo test -p splitback`, from the repo root |

To read results without running anything:

| File | What it is |
|---|---|
| `sim/samples/pitch.testnet.txt` | Transcript of the three-buyer story on testnet |
| `web/data/run.json` | Every receipt from the testnet market run, with transaction hashes |
| `sim/samples/funding.testnet.json` | The stablecoin funding run |
| `sim/samples/judgements.sample.json` | The briefs, each model's answer, its vote and its signature |

## 3. One entry, call by call

`npm run walkthrough` prints each call as `who -> method(arguments) => return value`. This section follows its output. The numbers are from the default run: a cost of 12 and two buyers.

### Setup: deploy and fund

The contract is initialised once with its token, its verifiers and the challenge window:

```
new({"token":"usdc.walk.sandbox","verifiers":["verifier-1...","verifier-2...","verifier-3..."],"threshold":2,"challenge_window_ns":"5000000000"})
```

Each agent is a sub-account. Its owner gives it a key that can only call Splitback, then funds it by sending tokens to the contract with the agent's account id as the message:

```
owner -> usdc.ft_transfer_call({"receiver_id":"splitback.walk.sandbox","amount":"24000000","msg":"publisher.walk.sandbox"})
```

That credits the agent's prepaid balance, which is its whole budget. The publisher needs the bond: twice the cost, or three times if it charges a delivery fee.

### Publish

```
publisher -> publish({"task_key":"a790...","spec":"orderbook-replay:market=NEAR-USDC;seed=2026-11-13;events=1500000","result_hash":"8ff8...","cost":"12000000","provider":null,"delivery_fee":null})  =>  0
```

- `spec` is the public description of the work, at most 256 characters.
- `task_key` is the SHA-256 of the spec. Buyers look entries up by it.
- `result_hash` is the SHA-256 of the result bytes. The bytes never go on chain.
- `provider`, if set, is paid `cost` from the publisher's balance inside this call. The publisher then needs the bond plus the cost. `npm run pitch` does this.
- The return value is the entry id.

### Join

A buyer finds the entry, reads the price and buys:

```
view entries_for_key({"task_key":"a790..."})  =>  1 entry, id 0, status Open, 1 holder(s)
view quote({"entry_id":0})                    =>  "6000000"
buyer-1 -> join({"entry_id":0,"max_price":"6000000"})  =>  "6000000"
```

`max_price` protects the buyer: if the total is higher when the call lands, the call fails and nothing is spent.

The publisher then serves the bytes off chain. Before serving, it checks `is_holder({"entry_id":0,"account_id":"buyer-1..."})`. The buyer checks that the SHA-256 of what it received equals the `result_hash` on chain.

The second buyer's quote is 4.

### Claim

Each join lowers everyone's share. Earlier holders call `claim` to collect the difference:

```
publisher -> claim({"entry_id":0})  =>  "8000000"
buyer-1   -> claim({"entry_id":0})  =>  "2000000"
```

Every holder has now paid 4. `get_holding` shows `paid`, `claimed` and `claimable` for one account.

### Honest path: retire, release the bond, withdraw

```
publisher -> retire({"entry_id":0})
publisher -> release_bond({"entry_id":0})  =>  "24000000"
publisher -> withdraw({"amount":"32000000"})  =>  true
```

`retire` stops new joins. `release_bond` fails until the challenge window has passed since the last join. `withdraw` sends tokens to the agent's own account, where only the owner's full-access key can move them.

### Wrong-result path: challenge, vote, refund

With `--wrong` the publisher tampers with the result. The delivered bytes still match the hash on chain, so the hash check passes. A buyer finds the problem only by recomputing the task.

```
buyer-2    -> challenge({"entry_id":0,"reason":"recomputed, hash differs"})
verifier-1 -> vote({"entry_id":0,"upheld":true})  =>  null
verifier-2 -> vote({"entry_id":0,"upheld":true})  =>  true
buyer-1    -> claim({"entry_id":0})  =>  "4000000"
buyer-2    -> claim({"entry_id":0})  =>  "4000000"
```

- `challenge` stakes a tenth of the cost from the challenger's balance.
- `vote` returns `null` until a vote decides the challenge, then `true` (upheld) or `false` (rejected).
- On a voided entry, `claim` is the refund.

At the end buyer-1 is back to 12, buyer-2 has gained 14.4, the two verifiers that voted hold 0.8 each, and the publisher has lost 16 against a cost of 12.

If the verifiers never reach the threshold, anyone can call `expire_challenge({"entry_id":0})` after the window. The stake is returned and the entry reopens.

## 4. Call reference

### Calls that change state

| Method | Arguments | Who calls it | Returns |
|---|---|---|---|
| `ft_transfer_call` on the token | `receiver_id` (the contract), `amount`, `msg` (account to credit; empty credits the sender). Attach 1 yoctoNEAR. | Anyone holding the token | |
| `publish` | `task_key`, `spec`, `result_hash`, `cost`, `provider` or null, `delivery_fee` or null | Publisher | Entry id |
| `join` | `entry_id`, `max_price` or null | Buyer | Total paid |
| `claim` | `entry_id` | Any holder | Amount credited |
| `challenge` | `entry_id`, `reason` (at most 256 characters) | Anyone but the publisher | |
| `vote` | `entry_id`, `upheld` (true or false) | A verifier | Outcome, or null if undecided |
| `expire_challenge` | `entry_id` | Anyone, after the window | |
| `retire` | `entry_id` | Publisher | |
| `release_bond` | `entry_id` | Publisher, after retiring and the window | Bond returned |
| `withdraw` | `amount` | Any account, for its own balance | true if the tokens were sent |

### Views

| Method | Arguments | Returns |
|---|---|---|
| `get_config` | none | Token, verifiers, threshold, challenge window |
| `get_stats` | none | Totals: entries, joins, voided, paid in, rebated, slashed |
| `balance_of` | `account_id` | Prepaid balance |
| `get_entry` | `entry_id` | One entry, including `status`, `holders`, `current_share` and `next_price` |
| `get_entries` | `from_index`, `limit` (at most 100) | A page of entries |
| `entries_for_key` | `task_key` | Every entry published for a task |
| `quote` | `entry_id` | What the next buyer pays in total |
| `get_holding` | `entry_id`, `account_id` | `paid`, `fee_paid`, `claimed`, `claimable`, or null if not a holder |
| `is_holder` | `entry_id`, `account_id` | true or false |

An entry's `status` is `Open`, `Retired`, `Challenged`, `Voided` or `Closed`.

### Errors you will meet

| Message | Cause |
|---|---|
| `prepaid balance too low` | The balance does not cover the bond, price or stake |
| `price is above max_price` | The price rose between the quote and the join |
| `entry is not open` | Joining an entry that is retired, challenged, voided or closed |
| `already a holder` | Joining an entry twice |
| `challenge window has not passed` | Calling `release_bond` too early |
| `only the configured token is accepted` | Funding with a token other than the one the contract settles in |

### From the command line

Views need no account. With [near-cli-rs](https://github.com/near/near-cli-rs), against the testnet deployment:

```sh
near contract call-function as-read-only splitback.smwg0fyby.splitback-swarm5.testnet \
  quote json-args '{"entry_id":0}' network-config testnet now
```

It prints `"450000"`. Swap in any view from the table above.

A call that changes state has the form below. It has not been run for this guide; the scripts in `sim/` send the same calls through near-api-js.

```sh
near contract call-function as-transaction <contract> join \
  json-args '{"entry_id":0,"max_price":"450000"}' \
  prepaid-gas '60 Tgas' attached-deposit '0 NEAR' \
  sign-as <your-agent>.testnet network-config testnet sign-with-keychain send
```

Use your own deployment for calls that change state. `cd sim && node faucet.mjs && npm run pitch:testnet` creates a testnet account, deploys a fresh contract and test token, and prints the contract's name. The test token's `mint` is open to anyone. The testnet contract named in the README is the recorded run and predates the delivery fee, so leave it as it is.

### From JavaScript

`sim/lib/chain.mjs` has the two helpers every script uses:

```js
import { account, call, view } from "./lib/chain.mjs";

const price = await view(rpcUrl, contractId, "quote", { entry_id: 0 });
const agent = account(rpcUrl, "buyer-1.you.testnet", agentSecretKey);
const { value, txHash } = await call(agent, contractId, "join", { entry_id: 0, max_price: price });
```

## 5. Add your own task

A task fits the scripted market if anyone can recompute it from its spec and get the same bytes.

1. Pick a spec format: `kind:name=value;name=value`. The kind and the values must not contain `:`, `;` or `=`.
2. Add a branch to `compute()` in `sim/lib/tasks.mjs`, above the final `throw`. It must return a string, and the same string every time for the same spec:

   ```js
   if (kind === "fib-mod") {
     const n = Number(params.n);
     const mod = Number(params.mod);
     let a = 0;
     let b = 1;
     for (let i = 0; i < n; i++) [a, b] = [b, (a + b) % mod];
     return JSON.stringify({ spec, value: a });
   }
   ```

3. Run it through a full entry, on both paths:

   ```sh
   npm run walkthrough -- --spec "fib-mod:n=20000000;mod=1000000007" --cost 3
   npm run walkthrough -- --spec "fib-mod:n=20000000;mod=1000000007" --cost 3 --wrong
   ```

   Both end with `WALKTHROUGH CHECK PASSED`.

4. Optional: add `{ spec, cost }` to `CATALOGUE` in the same file so `npm run sim` trades it. The buyers' needs are drawn from the catalogue, so the run's totals will change.

Things that break determinism: the current time, random numbers without a seed in the spec, object key order that depends on insertion from unordered input, floating-point results that differ between machines, and data fetched from a source that can change. Pin every input in the spec.

## 6. Fitting the README's use cases

Only the order-book replay has a runnable example. The others are listed in the README as work that fits the rules. This table is a starting point for each one; none of it has been built or tested here.

| Use case | What the spec pins | Result bytes | How a verifier rules |
|---|---|---|---|
| Order-book replay (runnable) | Market, seed or date, event count | Summary plus a hash of the fill tape | Replay and compare |
| Backtest feature set | Source dataset ids and versions, the transform's commit, the time window | The feature file | Rebuild from the pinned sources and compare |
| Zero-knowledge proof | Circuit or program hash, public inputs | The proof | Verify the proof; no recompute needed |
| Archive-node query | Chain, contract, event, block range | The rows in a fixed order and encoding | Re-run against an archive node and compare |
| Reproducible build | Repository, commit, toolchain version, build flags | The build artifact | Rebuild and compare |
| Benchmark run | Model and version, seed, test set hash, settings | Scores per item | Re-run a sample; only works if the model provider guarantees repeatable output |

Three things apply to all of them:

- **The spec is capped at 256 characters.** If the manifest is longer, publish the manifest somewhere stable and put its SHA-256 and location in the spec.
- **The result must be one exact byte string.** Fix the encoding, the row order and the number formatting, or two honest runs will hash differently and an honest publisher will be challenged.
- **The verifiers are yours to write.** The contract only counts votes. `sim/run.mjs` has verifiers that recompute; `sim/judge.mjs` has verifiers that ask a model. For a proof, a verifier would run the proof check instead.

For work with no mechanical check, such as a written brief, start from `sim/judge.mjs`. It publishes two briefs, challenges both, and has three models vote. Read [`sim/samples/judgements.sample.json`](sim/samples/judgements.sample.json) first to see what the models said and where one of them got it wrong.

## 7. On testnet

```sh
cd sim
node faucet.mjs          # creates a funded account, saves its key to sim/keys/testnet.json
npm run pitch:testnet    # about 9 NEAR
npm run sim:testnet      # about 27 NEAR; node topup.mjs adds more from the faucet
npm run fund:testnet     # about 9 NEAR
```

Each run deploys fresh contracts under a new sub-account and prints explorer links. `npm run sim:testnet` also points `web/deployment.json` at the new contract, so the live page shows that run. `npm run walkthrough` runs on the local chain only.
