# Splitback

Built at NEAR HACKATHON (November 2026). Tracks: AI Swarms, Agent Economy, Open Innovation.

**Live page:** https://dreybuilds.github.io/splitback/ (read-only; shows the testnet deployment below, with a transaction link for every purchase).

Splitback is a NEAR contract where AI agents split the cost of a computed result. One agent pays for the result. Each later agent that needs it pays an equal share, and the contract pays the earlier holders back.

> One agent pays 12 for an order-book replay. A second buys in for 6. A third buys in for 4, and the first two each get 2 back. One replay served three buyers, the provider earned 12, and every buyer ended up paying 4.

Every holder always ends up having paid `ceil(cost / holders)`, whenever they joined. The full rules, the case against the idea and the sequence of one round are in [RULES.md](RULES.md).

Take the payments out and nothing is left: the product is the split, the rebate and the bond.

## Try it

You need Node.js 20 or newer. Rust is only needed for step 1.

| # | Do | See |
|---|---|---|
| 1 | `cargo test -p splitback` | `test result: ok. 29 passed`. The tests cover the rules in RULES.md, including the 12 → 6 → 4 story and the refund path. |
| 2 | `cd sim && npm install` | Dependencies install. The first run in step 3 also downloads a local NEAR node binary. |
| 3 | `npm run pitch` | A local NEAR sandbox starts, the contracts in `res/` are deployed, and three trading agents buy one replay. One of them has a budget of 4, sees a price of 6 and does not buy; after another agent joins the price is 4 and it buys. Every payment prints its transaction hash. Last line: `PITCH CHECK PASSED: provider earned 12, every buyer paid 4.` |
| 4 | `npm run sim` | 20 buyers, 5 sellers and 3 verifiers trade for 3 rounds with scripted strategies and no LLM calls. One seller publishes a wrong result, the verifiers vote 2 to 1, and the seller is slashed. Last line: `ALL CHECKS PASSED: every holder paid exactly ceil(cost / holders), refunds were complete, the contract is solvent.` Takes about 80 seconds. |
| 5 | Open `sim/out/receipts.json` | One receipt per purchase: what was bought, from whom, the price, what it would have cost alone, and whether the result passed the buyer's check. |
| 6 | `node ../intents/quote.mjs` | Dry NEAR Intents quotes from the live 1Click API: funding an agent from USDC, USDT or DAI on several chains, and cashing out. Nothing is sent. `--list` shows every stablecoin and chain that can be used. |
| 6b | `npm run fund` | Three agents are funded from USDC, USDT and DAI, buy the same result and each end up paying the same. The provider cashes out in USDT. Last line: `FUNDING CHECK PASSED`. |
| 7 | Optional, needs a NEAR AI Cloud key: `NEAR_AI_API_KEY=... npm run judge` | Two written briefs are sold, one written from tampered figures. Three verifier agents, each backed by a different model on NEAR AI Cloud, vote on chain. The tampered brief is voided. Each model answer's NEAR AI signature is saved to `sim/out/judgements.json`. |

Steps 3 and 4 exit with a non-zero code if any rule is broken, so they work as checks.

[GUIDE.md](GUIDE.md) goes further: which example shows what, every contract call for one entry (`npm run walkthrough`), a call reference, how to add your own task, and how each use case below maps onto a spec and a verifier.

`./build.sh` rebuilds the contracts with cargo-near and refreshes `res/`. Steps 3, 4 and 7 use the prebuilt files in `res/`, so they run without Rust. Step 7 makes real model calls, so its outcome is not guaranteed the way steps 3 and 4 are.

## On testnet

The full simulation ran on NEAR testnet and passed every check.

| | |
|---|---|
| Contract | [`splitback.smwgbt9yi.splitback-swarm5.testnet`](https://testnet.nearblocks.io/address/splitback.smwgbt9yi.splitback-swarm5.testnet) |
| Test token | `usdc.smwgbt9yi.splitback-swarm5.testnet` |
| Agents | 28 sub-accounts under `smwgbt9yi.splitback-swarm5.testnet`: `buyer-1` to `buyer-20`, `seller-1` to `seller-5`, `verifier-1` to `verifier-3` |
| Activity | 10 entries, 58 joins, 1 entry voided by a 2 to 1 verifier vote |
| Example purchase | [`CnX4rY7skLwvRW811ZsesXw1cieUfnHPzW6BStrCdnkr`](https://testnet.nearblocks.io/txns/CnX4rY7skLwvRW811ZsesXw1cieUfnHPzW6BStrCdnkr) |
| Full record | [`web/data/run.json`](web/data/run.json): every receipt with its transaction hash |

Read the live state yourself, with no key:

```sh
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"splitback.smwgbt9yi.splitback-swarm5.testnet","method_name":"get_stats","args_base64":"e30="}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

It prints `{"entries":10,"joins":58,"voided":1,...}`.

### The three-buyer story, on testnet

`npm run pitch:testnet` ran against `splitback.pmwg2rpww.splitback-swarm5.testnet`. Each step is a transaction you can open:

| Step | Transaction |
|---|---|
| desk-a pays the provider 12 and publishes | [EgiDHFeBDzLS…](https://testnet.nearblocks.io/txns/EgiDHFeBDzLSRWNggX8g7tkiwYMhshchC3YLZ3c4Jq9k) |
| desk-b buys in for 6 | [3bcsVhosrWgP…](https://testnet.nearblocks.io/txns/3bcsVhosrWgPdHBgeRo86MJC7K6Pctw41Kwr4cYp8bmh) |
| desk-a claims 6 back | [CBS5ojGEYzdw…](https://testnet.nearblocks.io/txns/CBS5ojGEYzdwbBZxosPqoBue2b3sAYkmQ2imF66re7v3) |
| desk-c buys in for 4 | [DQiQeMeyc8Si…](https://testnet.nearblocks.io/txns/DQiQeMeyc8SiMcHQzp6q1wjcdMo8iQXxpBqadz5hMae8) |
| desk-a claims 2 back | [HtG8wQXetK9Q…](https://testnet.nearblocks.io/txns/HtG8wQXetK9Qzn97JXNFsSM8ngwhRf74NuJZiL5r8jRn) |
| desk-b claims 2 back | [n2ANyXAS2wBT…](https://testnet.nearblocks.io/txns/n2ANyXAS2wBTuGqHwaXXEcFRZp1Z9S1F1U5evXMWw3k) |

Between the first two rows, desk-c (budget 4) looked at a price of 6 and did not buy, so there is no transaction for it. Net paid at the end: desk-a 4, desk-b 4, desk-c 4. The provider holds 12. Full transcript: [`sim/samples/pitch.testnet.txt`](sim/samples/pitch.testnet.txt).

The same run timed the work: replaying the 1,500,000-event book from scratch took 345 ms on a laptop, and hash-checking a delivered copy took under a millisecond. This replay is deliberately small so the demo is quick. The saving that matters is the price of the work, not these milliseconds.

To run it on testnet yourself: `cd sim && node faucet.mjs && npm run sim:testnet`. The faucet script creates a funded testnet account and saves its key to `sim/keys/testnet.json`, which is git-ignored.

## What a run of the simulation shows

Numbers from the testnet run above. Buyers' needs are seeded, so the amount paid repeats from run to run; the order agents act in is not fixed, so which entries they pick, and the "computed alone" figure, vary by a few percent:

| | |
|---|---|
| Agents | 20 buyers, 5 sellers, 3 verifiers, each its own sub-account |
| Purchases | 58 joins across 10 entries, 60 receipts |
| Cost if every agent had computed alone | $69.57 |
| Cost paid through Splitback | $10.16 (85.39% less), of which $0.60 was delivery fees to publishers |
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

Only the order-book replay has a runnable example. [GUIDE.md](GUIDE.md#6-fitting-the-readmes-use-cases) sketches the spec, result and verifier for each of the others.

The first four fit the current contract as it is. The last two need care about what "the same result" means, and benchmark runs are only reproducible if the model provider guarantees it.

Work whose correctness is a matter of judgement (research summaries, recommendations) has nothing mechanical to check. For that, the verifiers can be models: see "Where NEAR AI fits" below.

## How it is built

| Part | What it is |
|---|---|
| `contracts/splitback` | The contract (Rust, near-sdk). Prepaid balances, publish, join, claim, challenge, vote, expire challenge, retire, release bond, withdraw. Emits a JSON event for every action. |
| `contracts/mock-usdc` | A test token with free minting, so the demo runs without a faucet. Not a real stablecoin. The contract takes any NEP-141 token id at init. |
| `sim/run.mjs` | The scripted market. |
| `sim/pitch.mjs` | The three-buyer story. |
| `sim/walkthrough.mjs` | One entry from publish to withdraw, printing every contract call. [GUIDE.md](GUIDE.md) follows its output. |
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

- **Pay in any stablecoin.** The contract settles in one token, USDC on NEAR, so every price, rebate and bond is in one unit. The owner does not have to hold that token. 1Click lists USDC, USDT, DAI and others across more than 20 chains, swaps what the owner sends, and delivers USDC. `node intents/quote.mjs --from usdt:eth` quotes any of them. A stablecoin sent straight to the contract without a swap is refused and returned.
- **Funding in one step.** The contract credits a prepaid balance when it receives tokens by `ft_transfer_call` with the agent's account id as the message. The 1Click quote field `customRecipientMsg` makes 1Click deliver exactly that way. So an owner holding USDC on Base sends once to a 1Click deposit address, and the money lands inside Splitback already credited to the agent.
- **Cash-out.** A seller's earnings go the other way to whatever chain it wants.
- **Not per purchase.** At the time of writing a 1Click quote for Base to NEAR estimates about 35 seconds, and the docs say to allow up to 15 minutes. A purchase inside Splitback is one NEAR transaction with no token transfer, because prices are debited from prepaid balances.

What is and is not done here:

- `intents/quote.mjs` gets real quotes from the live API in dry mode, including one with `customRecipientMsg` set. The API accepts the field. Actual delivery into the contract has not been exercised, and the 1Click docs mark the field as highly experimental.
- NEAR Intents has no testnet, so the testnet deployment uses the test token and is not connected to a live Intents transfer.
- `sim/fund.mjs` tests everything around the swap on testnet. Test tokens stand in for USDT and DAI on Ethereum, a `solver` account stands in for 1Click, and the rate comes from a real dry quote on the live API for that exact pair. The delivery by `ft_transfer_call`, the credit to the named agent and the agent spending that balance are the real contract. In the recorded run ([`sim/samples/funding.testnet.json`](sim/samples/funding.testnet.json)) 20 USDT was credited as $19.9783, 200 DAI as $199.5837, both agents then bought the same result as an agent funded in USDC, and the provider cashed $30 out as 29.7166 USDT. Example delivery: [`BPLwNGqc…`](https://testnet.nearblocks.io/txns/BPLwNGqcuyKTksK4jrvSAp6xoPhpkZRt7cENmiZKu2g8).
- Small amounts can be refused. At the time of writing DAI had no route for 1 DAI but quoted at 200, USDT on Tron had a $100 minimum, and cashing 1 USDC out to Ethereum returned about 0.70 because of gas.
- `node intents/quote.mjs --live` walks through one real top-up on mainnet.
- Quotes and status need no API key. Without a partner key 1Click adds 0.25%; with one, a stablecoin pair such as USDC to USDC costs 0.01%.

### Where NEAR AI fits

The scripted market only sells work a verifier can recompute. `sim/judge.mjs` handles work it cannot: written briefs produced by a model.

- Each of the three verifier agents is backed by a different model on NEAR AI Cloud. It reads the brief against the replay's real figures and votes on chain. Two votes decide.
- NEAR AI signs each model response. The script fetches the signature, checks that the signed text is the hash of this exact request and response, recovers the signer, and stores all of it beside the vote.
- This is a surface check. It does not verify the hardware attestation quote behind the signing key.

A recorded run is in [`sim/samples/judgements.sample.json`](sim/samples/judgements.sample.json), with the briefs, each model's answer, its vote and its NEAR AI signature. In that run the tampered brief was voided 2 to 0. On the honest brief one model voted to uphold the challenge, because the brief mentioned a spread the reference did not list, and the other two outvoted it. That is the majority rule doing its job, and also a fair picture of how far model judgement can be trusted.

## Failure cases

| Case | What happens |
|---|---|
| Wrong or poisoned result | Anyone stakes `ceil(cost / 10)` and challenges. If a majority of verifiers uphold it, buyers are refunded in full and the challenger takes the forfeited bond less the verifiers' tenth. The publisher loses more than the full cost. |
| Frivolous challenge | The stake goes to the publisher, less the verifiers' tenth. |
| Publisher never serves the bytes | Treated as a challenge: no bytes matching the hash means it is upheld. |
| A holder leaks the result | Not prevented. The holder loses its future rebates. |
| The price moves before an agent's purchase lands | The agent passes `max_price`, the lower of the quote it saw and its remaining budget. The contract rejects the join if the total is higher, and nothing is spent. |
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
| What the split covers | The declared cost of the work, split equally, plus an optional flat delivery fee per buyer that pays the publisher for storing and serving the bytes. Not covered: each agent's own NEAR gas, and the contract's storage, which the contract pays. |
| The cost is declared | The contract cannot measure compute. Naming a provider makes the cost a payment the chain saw; a cheaper competing entry is the other check. |
| No profit for the first buyer | The provider is paid once. The first buyer only ever gets closer to an equal share, plus delivery fees if it set one. |
| Locked bond | A bond of twice the cost stays locked until the publisher retires the entry and the challenge window passes. That is the price of making buyers whole. |
| Leaks | A holder can still pass the bytes on. The rebate makes that cost the holder money; nothing prevents it. |
| Audit | The contracts are unaudited and hold only test tokens. |

## Credits

- Libraries: [near-sdk](https://github.com/near/near-sdk-rs) (contracts), [near-api-js](https://github.com/near/near-api-js) and [near-sandbox](https://github.com/near/near-sandbox-js) (simulation), [ethers](https://github.com/ethers-io/ethers.js) (checking NEAR AI signatures).
- Services: NEAR Intents 1Click API, NEAR AI Cloud.

MIT licence.
