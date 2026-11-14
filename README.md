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
| 1 | `cargo test -p splitback` | `test result: ok. 25 passed`. The tests cover the rules in RULES.md, including the 12 → 6 → 4 story and the refund path. |
| 2 | `cd sim && npm install` | Dependencies install. The first run in step 3 also downloads a local NEAR node binary. |
| 3 | `npm run pitch` | A local NEAR sandbox starts, the contracts in `res/` are deployed, and three trading agents buy one replay. Last line: `PITCH CHECK PASSED: provider earned 12, every buyer paid 4.` |
| 4 | `npm run sim` | 20 buyers, 5 sellers and 3 verifiers trade for 3 rounds with scripted strategies and no LLM calls. One seller publishes a wrong result, the verifiers vote 2 to 1, and the seller is slashed. Last line: `ALL CHECKS PASSED: every holder paid exactly ceil(cost / holders), refunds were complete, the contract is solvent.` Takes about 80 seconds. |
| 5 | Open `sim/out/receipts.json` | One receipt per purchase: what was bought, from whom, the price, what it would have cost alone, and whether the result passed the buyer's check. |
| 6 | `node ../intents/quote.mjs` | Two dry NEAR Intents quotes from the live 1Click API: funding an agent from USDC on Base, and cashing out. Nothing is sent. |
| 7 | Optional, needs a NEAR AI Cloud key: `NEAR_AI_API_KEY=... npm run judge` | Two written briefs are sold, one written from tampered figures. Three verifier agents, each backed by a different model on NEAR AI Cloud, vote on chain. The tampered brief is voided. Each model answer's NEAR AI signature is saved to `sim/out/judgements.json`. |

Steps 3 and 4 exit with a non-zero code if any rule is broken, so they work as checks.

`./build.sh` rebuilds the contracts with cargo-near and refreshes `res/`. Steps 3, 4 and 7 use the prebuilt files in `res/`, so they run without Rust. Step 7 makes real model calls, so its outcome is not guaranteed the way steps 3 and 4 are.

## On testnet

Testnet deployment details are added here once the run completes.

To run it on testnet yourself: `cd sim && node faucet.mjs && npm run sim:testnet`. The faucet script creates a funded testnet account and saves its key to `sim/keys/testnet.json`, which is git-ignored.

## What a run of the simulation shows

Numbers from the local run in step 4 (the choices are seeded, so the totals repeat):

| | |
|---|---|
| Agents | 20 buyers, 5 sellers, 3 verifiers, each its own sub-account |
| Purchases | 58 joins across 10 entries, 60 receipts |
| Cost if every agent had computed alone | $67.33 |
| Cost paid through Splitback | $9.56 (85.8% less) |
| Wrong result | seller-5 published one, an auditing buyer recomputed it and challenged, two verifiers upheld it and one lazy verifier was outvoted and earned nothing from that ruling |
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

Work whose correctness is a matter of judgement (research summaries, recommendations) has nothing mechanical to check. For that, the verifiers can be models: see "Where NEAR AI fits" below.

## How it is built

| Part | What it is |
|---|---|
| `contracts/splitback` | The contract (Rust, near-sdk). Prepaid balances, publish, join, claim, challenge, vote, expire challenge, retire, release bond, withdraw. Emits a JSON event for every action. |
| `contracts/mock-usdc` | A test token with free minting, so the demo runs without a faucet. Not a real stablecoin. The contract takes any NEP-141 token id at init. |
| `sim/run.mjs` | The scripted market. |
| `sim/pitch.mjs` | The three-buyer story. |
| `sim/judge.mjs` | The NEAR AI verifier committee for work that cannot be recomputed. |
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

- **Funding in one step.** The contract credits a prepaid balance when it receives tokens by `ft_transfer_call` with the agent's account id as the message. The 1Click quote field `customRecipientMsg` makes 1Click deliver exactly that way. So an owner holding USDC on Base sends once to a 1Click deposit address, and the money lands inside Splitback already credited to the agent.
- **Cash-out.** A seller's earnings go the other way to whatever chain it wants.
- **Not per purchase.** At the time of writing a 1Click quote for Base to NEAR estimates about 35 seconds, and the docs say to allow up to 15 minutes. A purchase inside Splitback is one NEAR transaction with no token transfer, because prices are debited from prepaid balances.

What is and is not done here:

- `intents/quote.mjs` gets real quotes from the live API in dry mode, including one with `customRecipientMsg` set. The API accepts the field. Actual delivery into the contract has not been exercised, and the 1Click docs mark the field as highly experimental.
- NEAR Intents has no testnet, so the testnet deployment uses the test token and is not connected to a live Intents transfer.
- `node intents/quote.mjs --live` walks through one real top-up on mainnet.
- Quotes and status need no API key. Without a partner key 1Click adds 0.25%; with one, a stablecoin pair such as USDC to USDC costs 0.01%.

### Where NEAR AI fits

The scripted market only sells work a verifier can recompute. `sim/judge.mjs` handles work it cannot: written briefs produced by a model.

- Each of the three verifier agents is backed by a different model on NEAR AI Cloud. It reads the brief against the replay's real figures and votes on chain. Two votes decide.
- NEAR AI signs each model response. The script fetches the signature, checks that the signed text is the hash of this exact request and response, recovers the signer, and stores all of it beside the vote.
- This is a surface check. It does not verify the hardware attestation quote behind the signing key.

## Failure cases

| Case | What happens |
|---|---|
| Wrong or poisoned result | Anyone stakes `ceil(cost / 10)` and challenges. If a majority of verifiers uphold it, buyers are refunded in full and the challenger takes the forfeited bond less the verifiers' tenth. The publisher loses more than the full cost. |
| Frivolous challenge | The stake goes to the publisher, less the verifiers' tenth. |
| Publisher never serves the bytes | Treated as a challenge: no bytes matching the hash means it is upheld. |
| A holder leaks the result | Not prevented. The holder loses its future rebates. |
| Publisher overstates the cost | A competitor publishes the same task for less and takes the buyers. If the publisher names a provider, the cost is a payment the chain saw. |
| Publisher did not do the work itself | Not detected. |
| One verifier is dishonest or lazy | It is outvoted and earns nothing. The simulation includes one. |
| Verifiers are offline | After the challenge window anyone can lapse the challenge. The stake is returned and the entry reopens. |
| A majority of verifiers collude | Not handled. They can rule wrongly. |
| Agent key is stolen | The thief can spend the prepaid balance on entries and can withdraw only to the agent's own account. It cannot take NEAR or reach other contracts. |

## Limits of this version

| Limit | State |
|---|---|
| Who rules on challenges | A committee with a majority threshold, paid only for voting with the outcome. The committee is fixed at deployment and its members post no bond, so a colluding majority is not punished. |
| Work that cannot be recomputed | The contract does not care how verifiers decide. `sim/judge.mjs` runs a committee of NEAR AI models on written briefs. Models can be wrong, and three models can be wrong together. |
| Storage | The contract pays for its own storage. A join costs tokens, which limits spam, but there is no separate storage charge. |
| Locked bond | A bond of twice the cost stays locked until the publisher retires the entry and the challenge window passes. That is the price of making buyers whole. |
| Leaks | A holder can still pass the bytes on. The rebate makes that cost the holder money; nothing prevents it. |
| Audit | The contracts are unaudited and hold only test tokens. |

## Credits

- Libraries: [near-sdk](https://github.com/near/near-sdk-rs) (contracts), [near-api-js](https://github.com/near/near-api-js) and [near-sandbox](https://github.com/near/near-sandbox-js) (simulation), [ethers](https://github.com/ethers-io/ethers.js) (checking NEAR AI signatures).
- Services: NEAR Intents 1Click API, NEAR AI Cloud.
- Code was written with Claude Code (AI-generated, human-directed) during the hackathon window. No earlier code was reused.

MIT licence.
