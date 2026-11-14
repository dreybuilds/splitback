# Splitback demo script

About three minutes. The left column is what is on screen, the right is what you say. Lines in quotes are meant to be said as written; change the wording to sound like you, but keep the numbers.

## Before you record

```sh
cd sim
npm run pitch      # run once so the sandbox binary is downloaded and it starts fast
```

Have three things open:

1. A terminal in `sim/`, font large enough to read on a small video.
2. The live page (`web/index.html` through GitHub Pages or `cd web && python3 -m http.server`).
3. The testnet contract on the explorer: https://testnet.nearblocks.io/address/splitback.smwgbt9yi.splitback-swarm5.testnet

`npm run sim` takes about 80 seconds. Do not run it live. Show the page, which is the recorded testnet run of the same thing.

## The script

| Time | On screen | Say |
|---|---|---|
| 0:00 | The live page, top. | "AI agents pay for the same expensive results over and over. A market replay, a proof, a heavy query. Each agent pays the full price, alone, for something another agent already bought. Splitback is a NEAR contract that lets them split that cost." |
| 0:20 | The Cost simulator beside the headline. Original cost 12. Move holders 1, then 2, then 3. | "One agent pays 12 for a replay. A second agent needs it, and buys in for 6. A third buys in for 4, and the contract pays the first two back 2 each. Every buyer has now paid 4. It does not matter who came first." |
| 0:40 | Keep dragging the slider up to about 10. | "Every new buyer lowers the price for everyone, including the ones who already paid. The first buyer took the risk, and gets money back each time someone else needs the same thing. The provider was paid in full, once, at the start." |
| 0:55 | Terminal: `npm run pitch`. Let it scroll, stop on the last lines. | "Here it is on a real chain. Three trading agents, one replay. Only the input manifest and the hash of the result go on chain. The result itself is delivered off chain, and only to accounts the contract lists as holders. This fourth account never paid, asks for it, and is refused." |
| 1:25 | The page: Run results. | "This is a bigger run on NEAR testnet. Twenty buyers, five sellers, three verifiers, each agent its own account with a key that can only call this contract. Computed alone, the work would have cost 69 dollars 57. Through Splitback they paid 10 dollars 16, delivery fees included. That is 85 percent less." |
| 1:45 | Scroll to Compute entries. Point at one step chart, then the voided card. | "Each card is one result. The chart is the price falling as holders joined. This one is different: seller-5 published a wrong result." |
| 1:55 | Round activity: click Round 2 to expand it. Then scroll to Challenge outcome. | "A buyer recomputed it, found the hash did not match, and challenged it. Three verifier agents voted, two to one. The entry was voided, every buyer was refunded in full, and the seller lost its bond. Publishing a bad result costs more than the result was worth." |
| 2:15 | Purchase receipts table. Click one transaction link so the explorer opens. | "Every purchase is a receipt with a transaction you can open. None of this is mocked." |
| 2:25 | Terminal: `npm run fund`, or show its last ten lines if already run. | "Owners do not need to hold the contract's token. Through NEAR Intents one owner pays in USDC, one in USDT, one in DAI. Each agent is credited in one step, they buy the same result, and each ends up paying exactly the same. The provider cashes out in USDT." |
| 2:45 | Terminal: last lines of `npm run judge`, or `sim/samples/judgements.sample.json`. | "Some work cannot be recomputed, like a written brief. For that the verifiers are three different models on NEAR AI Cloud. They read the brief against the real figures and vote on chain, and each answer carries NEAR AI's signature." |
| 3:00 | Back to the page top. | "Splitback: the first buyer gets paid back, the next buyer pays less, and a wrong result costs the seller. Take the payments out and nothing is left." |

## If you only have one minute

Use rows 0:00, 0:20, 1:25 and 1:55, then the closing line.

## Things to say only if asked

Be direct about these. They are in the README and judges respect it.

- **What stops a holder leaking the result?** Nothing prevents it. A holder that leaks gives up its own future rebates, and much of this work loses value in days. It is an incentive, not enforcement.
- **Does the provider earn more when more agents buy?** No. The provider is paid the full cost once. Later buyers pay back the earlier buyers, not the provider.
- **Does the first buyer have to share?** No. Publishing is a choice. An agent that wants exclusivity keeps the result and pays full price. An agent that publishes locks a bond of twice the cost and gets rebates as others join.
- **What if the verifiers collude?** A colluding majority can rule wrongly. The committee is fixed at deployment and posts no bond. That is a limit of this version.
- **Is the stablecoin funding live?** The quotes are real, from the live 1Click API. NEAR Intents has no testnet, so on testnet the swap leg is a stand-in and everything after it is the real contract. A real mainnet top-up has not been run.
- **Is it audited?** No. It holds only test tokens.

## Commands, in the order used

```sh
cd sim
npm run pitch          # 12 -> 6 -> 4 on a local chain
npm run fund           # USDC, USDT and DAI in, USDT out
npm run judge          # needs NEAR_AI_API_KEY in sim/.env; makes real model calls
node ../intents/quote.mjs   # live stablecoin quotes, nothing sent
```
