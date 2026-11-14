# UI brief for the Splitback live page

You are building one static web page for a hackathon project called **Splitback**. Everything you need is in this file. Do not invent data, contract methods or numbers that are not described here.

## What Splitback is

Splitback is a smart contract on NEAR where AI agents split the cost of a computed result.

- One agent pays for an expensive result (for example a reproducible order-book replay) and publishes its input manifest and the SHA-256 of the result. The result itself stays private.
- Each later agent that wants the result pays an equal share of the original cost: `ceil(C / k)`, where `C` is the cost and `k` is the number of holders after it joins.
- The contract pays the earlier holders back, so every holder always ends up having paid the same amount, whenever they joined.
- The publisher locks a bond of `2 × C`. Anyone can challenge a result. A committee of three verifier agents votes and two votes decide. If they uphold the challenge, the entry is void, buyers are refunded in full, the challenger takes the bond, and the verifiers who voted with the outcome share a tenth of it.

The one-minute story the page must make obvious:

> One agent pays 12 for a replay. A second buys in for 6. A third buys in for 4, and the first two each get 2 back. One replay served three buyers, the provider earned 12, and every buyer ended up paying 4.

## Who will look at this page

Hackathon judges, for under two minutes, on a laptop. Some are AI agents checking that the page shows real chain state. The page has to prove three things fast: the mechanism (price falls as holders join), that it ran on chain (real account names, transaction links), and the measured result (how much the swarm saved).

## Hard constraints

- A static site in the `web/` folder: `index.html` plus plain CSS and JavaScript files. No build step, no framework install, no server. It must work when opened from GitHub Pages.
- Any library must load from a CDN with a pinned version. Prefer none.
- No wallet connection, no sign-in, no write transactions. The page is read-only.
- It must still render fully, with static content, if the RPC is unreachable (use the bundled JSON described below).
- Respect `prefers-reduced-motion`: all motion stops and the page is still complete and readable.
- Text must stay readable over the animated background at all times (WCAG AA contrast).
- Works at 1280 px and at 390 px wide with no horizontal scroll.

## Visual direction

The owner asked for two specific things. Both are required.

1. **Depth perception.** The page should feel like looking into a space, not at a flat sheet. Build it from at least three layers at different depths that move at different speeds on scroll and react slightly to pointer position: a far layer (the equation streams), a middle layer (soft structural shapes or grid lines in perspective), and a near layer (the content cards). Give the cards real depth cues: perspective tilt on hover, layered shadows, slight scale difference between foreground and background elements, and atmospheric fade on far layers. CSS 3D transforms are enough; WebGL is optional.
2. **Equations running up and down the page.** Vertical columns of mathematical expressions that drift continuously, some columns upward and some downward, at different speeds and sizes according to their depth. Use the real mathematics of the contract, not random symbols:
   - `share(k) = ⌈C / k⌉`
   - `price(k+1) = ⌈C / (k+1)⌉`
   - `rebate = paid − ⌈C / k⌉ − claimed`
   - `Σ ⌈C / j⌉ , j = 2..k`
   - `k · ⌈C / k⌉ ≥ C`
   - `bond = 2C`
   - `stake = ⌈C / 10⌉`
   - `12 → 6 → 4`
   - live values substituted in, for example `⌈2000000 / 5⌉ = 400000`, taken from the entries on screen.
   Far columns are small, dim and slow; near columns are larger and faster. They sit behind the content and never reduce text contrast.

Tone: precise and technical, like an instrument panel for a market. Dark theme by default with a light theme that also works. A monospace face for numbers and equations, a clean sans-serif for prose. No stock illustrations, no emoji, no marketing slogans.

## Page sections, in order

1. **Header.** The name Splitback, one line: "Agents split the cost of a result. The price falls every time another agent needs it." Then network name, contract account id (copyable) and a status dot showing whether live chain data loaded.
2. **The mechanism, interactive.** A slider or stepper for the number of holders `k` from 1 to 20 with a cost `C` (default 12). Show the price the next buyer pays, what each earlier holder gets back, and what everyone has paid net. At `k = 3`, `C = 12` it must show exactly 12 → 6 → 4 with 2 back to each of the first two. Use `ceil` exactly as the contract does.
3. **Headline numbers.** From the run data: cost if every agent had computed alone, cost actually paid, saving percent, number of joins, number of entries, amount slashed.
4. **Entries (live).** One card per entry: task spec, publisher, status (Open, Retired, Challenged, Voided, Closed), cost, holders, what each holder has paid net, the next buyer's price, bond. Make the falling price visible, for example a small step chart of `ceil(C / k)` for `k = 1..holders`. Voided entries must look clearly different.
5. **Rounds.** The event feed grouped by round (round 0 is sellers publishing). This is where a judge sees rounds, who bought what, the challenge and the slash.
6. **Receipts.** A table: round, buyer, what was bought, from whom, price, what it would have cost alone, whether the hash check passed, audit result, and a link to the transaction.
7. **The bad actor.** A short panel: which seller published a wrong result, who caught it, how the three verifiers voted (it is in the round events), the seller's balance before and after, the challenger's balance before and after, and what each verifier earned. While an entry is `Challenged`, show its live `votes_uphold` and `votes_reject` against the threshold from `get_config`.
8. **Footer.** Links to the repository, `RULES.md`, and the contract on the explorer. One sentence: "Test token on NEAR testnet. Not a real stablecoin."

## Data

All amounts are integer strings in micro-units of a 6-decimal test token. Divide by 1,000,000 and show as dollars with up to four decimals (`"400000"` is `$0.4000`). Account ids look like `buyer-7.s1abc.splitback-swarm.testnet`; show the first label (`buyer-7`) and keep the full id in a tooltip.

### 1. Deployment config: `web/deployment.json`

```json
{ "rpcUrl": "https://test.rpc.fastnear.com", "contract": "splitback.<run>.splitback-swarm.testnet", "token": "usdc.<run>.splitback-swarm.testnet", "network": "testnet" }
```

The query parameters `?rpc=` and `?contract=` override it. If the file is missing, fall back to the bundled run data only.

### 2. Live chain state: read-only contract calls

POST to `rpcUrl`:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "query",
  "params": { "request_type": "call_function", "finality": "final",
              "account_id": "<contract>", "method_name": "<method>",
              "args_base64": "<base64 of the JSON args>" } }
```

`result.result` is an array of bytes; decode it as UTF-8 JSON. Poll every 10 seconds at most.

| Method | Args | Returns |
|---|---|---|
| `get_stats` | `{}` | `{ entries, joins, voided, cost_published, paid_in, rebated, slashed, delivery_fees }` (counts are numbers, amounts are strings) |
| `get_entries` | `{ "from_index": 0, "limit": 100 }` | array of entries (below) |
| `get_entry` | `{ "entry_id": 3 }` | one entry or null |
| `get_config` | `{}` | `{ token, verifiers: [account ids], threshold, challenge_window_ns, challenge_stake_divisor, bond_multiplier }` |
| `balance_of` | `{ "account_id": "..." }` | amount string |
| `get_holding` | `{ "entry_id": 3, "account_id": "..." }` | `{ paid, fee_paid, claimed, joined_as, claimable }` or null |
| `quote` | `{ "entry_id": 3 }` | amount string: the next buyer's total price (share plus delivery fee) |

An entry. `next_price` is what the next buyer pays in total: `next_share` (its equal share) plus `next_fee` (a flat delivery fee the publisher set, which goes to the publisher and is outside the split). Show the share and the fee separately on each card.

```json
{ "id": 6, "task_key": "<64 hex>", "spec": "orderbook-replay:market=NEAR-USDC;seed=2026-11-13;events=1500000",
  "result_hash": "<64 hex>", "cost": "2000000", "publisher": "seller-2....testnet", "provider": null,
  "holders": 5, "status": "Open", "challenger": null, "votes_uphold": [], "votes_reject": [], "bond": "4000000",
  "delivery_fee": "20000", "fees_collected": "80000",
  "paid_in": "1716667", "rebated": "1716665", "current_share": "400000",
  "next_price": "353334", "next_share": "333334", "next_fee": "20000",
  "created_at": "<ns timestamp>", "last_activity": "<ns timestamp>" }
```

### 3. Run history: `web/data/run.json`

Written by the simulation after it runs on testnet. `web/data/run.sample.json` has the same shape from a local run; use it while developing and as the fallback when `run.json` is missing. Open the sample file to see real values. Top-level keys:

- `network`, `contract`, `token`, `rpc_url`, `explorer_tx_url` (prefix for transaction links; null in the sample)
- `agents`: `{ buyers, sellers, verifiers, votes_needed }`
- `entries`: `[{ id, spec, publisher, status, cost, holders, each_paid_net }]`
- `stats`: same shape as `get_stats`
- `cost_if_every_agent_computed_alone_micro_usdc`, `cost_actually_paid_micro_usdc`, `saving_percent`
- `rounding_dust_left_in_contract_micro_usdc`
- `poisoner_seller_5_balance`: `{ start, end }`
- `challenger` (agent name) and `challenger_balance`: `{ start, end }`
- `verifier_earnings`: `{ "verifier-1": amount, "verifier-2": amount, "verifier-3": amount }`
- `events`: `[{ round, text }]` in order
- `receipts`: `[{ round, buyer, bought, entry, from, price_micro_usdc, alone_would_cost_micro_usdc, hash_check_passed, audit, tx }]`
- `problems`: should be an empty array; if it is not, show its contents in a visible warning

Live data from section 2 wins over `run.json` for entries and stats when both load.

## What done looks like

- Opening `web/index.html` through any static file server shows every section filled from `run.sample.json` with no console errors.
- With a valid `deployment.json`, the entries and headline stats come from the chain and the status dot says so.
- The mechanism control shows 12 → 6 → 4 at `C = 12`, `k = 3`.
- Equation columns move in both directions at depth-dependent speeds, and stop under reduced motion.
- Scrolling shows clear parallax between at least three layers.
- No text is unreadable at any scroll position in either theme.

Tell me which files you created and anything in this brief you could not do.
