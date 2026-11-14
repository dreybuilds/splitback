# Splitback

Built at NEAR HACKATHON (November 2026). Tracks: AI Swarms, Agent Economy, Open Innovation.

Splitback is a NEAR contract where AI agents split the cost of a computed result. One agent pays for the result. Each later agent that needs it pays an equal share, and the contract pays the earlier holders back.

> One agent pays 12 for an order-book replay. A second buys in for 6. A third buys in for 4, and the first two each get 2 back. One replay served three buyers, the provider earned 12, and every buyer ended up paying 4.

Every holder always ends up having paid `ceil(cost / holders)`, whenever they joined. The full rules, the case against the idea and the sequence of one round are in [RULES.md](RULES.md).

Take the payments out and nothing is left: the product is the split, the rebate and the bond.

## Try it

You need Node.js 20 or newer. Rust is only needed for step 1.

| # | Do | See |
|---|---|---|
| 1 | `cargo test -p splitback` | `test result: ok. 20 passed`. The tests cover the rules in RULES.md, including the 12 → 6 → 4 story and the refund path. |
| 2 | `cd sim && npm install` | Dependencies install. The first run in step 3 also downloads a local NEAR node binary. |
| 3 | `npm run pitch` | A local NEAR sandbox starts, the contracts in `res/` are deployed, and three trading agents buy one replay. Last line: `PITCH CHECK PASSED: provider earned 12, every buyer paid 4.` |
| 4 | `npm run sim` | 20 buyers, 5 sellers and 1 verifier trade for 3 rounds with scripted strategies and no LLM calls. One seller publishes a wrong result and is slashed. Last line: `ALL CHECKS PASSED: every holder paid exactly ceil(cost / holders), refunds were complete, the contract is solvent.` Takes about 80 seconds. |
| 5 | Open `sim/out/receipts.json` | One receipt per purchase: what was bought, from whom, the price, what it would have cost alone, and whether the result passed the buyer's check. |
| 6 | `node ../intents/quote.mjs` | Two dry NEAR Intents quotes from the live 1Click API: funding an agent from USDC on Base, and cashing out. Nothing is sent. |

Steps 3 and 4 exit with a non-zero code if any rule is broken, so they work as checks.

`./build.sh` rebuilds the contracts and refreshes `res/`. Step 3 and 4 use the prebuilt files in `res/`, so they run without Rust.

## On testnet

Testnet deployment details are added here once the run completes.

To run it on testnet yourself: `cd sim && node faucet.mjs && npm run sim:testnet`. The faucet script creates a funded testnet account and saves its key to `sim/keys/testnet.json`, which is git-ignored.

## What a run of the simulation shows

Numbers from the local run in step 4 (the choices are seeded, so the totals repeat):

| | |
|---|---|
| Agents | 20 buyers, 5 sellers, 1 verifier, each its own sub-account |
| Purchases | 58 joins across 10 entries, 60 receipts |
| Cost if every agent had computed alone | $67.33 |
| Cost paid through Splitback | $9.56 (85.8% less) |
| Wrong result | seller-5 published one, an auditing buyer recomputed it and challenged, the verifier upheld it |
| Outcome | every buyer of the bad entry refunded in full; seller-5 lost its bond |
| Undercutting | seller-4 republished seller-1's task at a lower cost and took all the buyers |
| Nobody sells it | one task had no seller, so the first buyer that needed it computed it and published it |

The amounts are a test token with 6 decimals. The task costs are the simulation's stand-in for a real compute bill.

## Why a buyer pays when copies are free

It would not, and it should not. If the same artifact is already free somewhere, Splitback adds nothing.

Splitback is for results the first buyer would otherwise keep to itself. Only the input manifest and the SHA-256 of the result go on chain. The bytes are delivered off chain, and only to accounts the contract lists as holders. In `npm run pitch` an account that has not paid asks for the replay and is refused.

Two things keep a holder from handing the bytes around:

- Every holder is paid a rebate each time a new buyer joins. A holder that leaks the result gives up its own future rebates.
- Much of this work loses value quickly. A replay of yesterday's order book is worth far less next week.

This is an incentive, not enforcement. RULES.md says so.

## Use cases

Each of these is expensive to produce, exactly reproducible from a public manifest, and useful to several agents that are not each other's customers.

| Result | Who buys in | How the verifier checks it |
|---|---|---|
| **Order-book replay** for a market and time window (the demo) | Trading agents running different strategies on the same tape | Replay the manifest, compare the hash |
| **Backtest feature sets**: cleaned and joined market data at a pinned version | Quant agents that differ in model but not in inputs | Rebuild from the pinned sources |
| **Zero-knowledge proofs** and other heavy verifiable computation | Any agent that needs the same statement proven | Verify the proof, which is cheap; no recompute needed |
| **Archive-node queries**: every transfer of a token across a block range | Analytics, accounting and risk agents | Re-run the query against an archive node |
| **Reproducible builds** of a pinned commit | Agents that deploy or audit the same dependency | Rebuild and compare the artifact hash |
| **Benchmark runs** of a pinned model, seed and test set | Agents choosing which model to route work to | Re-run a sample at the pinned settings |

The first four fit the current contract as it is. The last two need care about what "the same result" means, and benchmark runs are only reproducible if the model provider guarantees it.

Work whose correctness is a matter of judgement (research summaries, recommendations) does not fit, because the verifier has nothing mechanical to check.

## How it is built

| Part | What it is |
|---|---|
| `contracts/splitback` | The contract (Rust, near-sdk). Prepaid balances, publish, join, claim, challenge, resolve, retire, release bond, withdraw. Emits a JSON event for every action. |
| `contracts/mock-usdc` | A test token with free minting, so the demo runs without a faucet. Not a real stablecoin. The contract takes any NEP-141 token id at init. |
| `sim/run.mjs` | The scripted market. |
| `sim/pitch.mjs` | The three-buyer story. |
| `intents/quote.mjs` | NEAR Intents quotes and a guided live top-up. |
| `web/` | The live page. |
| `res/` | Prebuilt contract binaries. |

### How an agent holds its key

Each agent is a sub-account under one parent (`buyer-7.<parent>`, `seller-2.<parent>`), so every action on chain traces to one agent.

- The agent process holds a function-call access key limited to the Splitback contract. It can publish, join, claim, challenge and withdraw.
- It cannot transfer NEAR, call the token contract or add keys.
- The human funds the agent's prepaid balance with `ft_transfer_call`. That balance is the agent's whole budget.
- `withdraw` sends tokens to the agent's own account, where only the human's full-access key can move them.

### Where NEAR Intents fits

Intents is used at the two edges, not for each purchase.

- **Funding.** An agent's owner holding USDC on Base (or any chain Intents supports) gets a 1Click deposit address, sends once, and USDC arrives on NEAR to fund the prepaid balance.
- **Cash-out.** A seller's earnings go the other way to whatever chain it wants.
- **Not per purchase.** A 1Click quote estimates 20 to 35 seconds. A purchase inside Splitback is one NEAR transaction with no token transfer, because prices are debited from prepaid balances.

What is and is not done here: `intents/quote.mjs` gets real quotes from the live API in dry mode. NEAR Intents has no testnet, so the testnet contract uses the test token and is not connected to a live Intents transfer. `node intents/quote.mjs --live` walks through one real top-up on mainnet.

## Failure cases

| Case | What happens |
|---|---|
| Wrong or poisoned result | Anyone stakes `ceil(cost / 10)` and challenges. If the verifier upholds it, buyers are refunded in full and the challenger takes the bond. The publisher loses more than the full cost. |
| Frivolous challenge | The stake goes to the publisher. |
| Publisher never serves the bytes | Treated as a challenge: no bytes matching the hash means it is upheld. |
| A holder leaks the result | Not prevented. The holder loses its future rebates. |
| Publisher overstates the cost | A competitor publishes the same task for less and takes the buyers. If the publisher names a provider, the cost is a payment the chain saw. |
| Publisher did not do the work itself | Not detected. |
| Verifier is dishonest or offline | Not handled. The verifier is one account in this version. With it offline, a challenged entry stays frozen. |
| Agent key is stolen | The thief can spend the prepaid balance on entries and can withdraw only to the agent's own account. It cannot take NEAR or reach other contracts. |

## Limits of this version

- The verifier is a single trusted account.
- Only deterministic tasks are supported.
- The contract pays its own storage, so there is no charge for the storage a join uses.
- A bond stays locked until the publisher retires the entry and the challenge window passes.
- The contracts are unaudited.

## Credits

- Libraries: [near-sdk](https://github.com/near/near-sdk-rs) (contracts), [near-api-js](https://github.com/near/near-api-js) and [near-sandbox](https://github.com/near/near-sandbox-js) (simulation).
- Code was written with Claude Code (AI-generated, human-directed) during the hackathon window. No earlier code was reused.

MIT licence.
