// NEAR Intents (1Click API) for the two edges of Splitback: funding an agent
// from another chain, and cashing out. The contract settles in USDC on NEAR;
// the owner can pay in any stablecoin 1Click lists, and 1Click swaps it.
//
//   node intents/quote.mjs                 dry quotes for several stablecoins, moves no money
//   node intents/quote.mjs --list          every stablecoin and chain that can be used
//   node intents/quote.mjs --from usdt:eth --to usdc:arb [--amount 25]
//       dry quotes for one way in and one way out
//   node intents/quote.mjs --live --from usdt:eth --near-account you.near --refund 0xYourAddress [--amount 1.00]
//       asks for a real deposit address for "USDT on Ethereum -> USDC on NEAR",
//       then polls until the swap settles. You send the coins from your own wallet.
//   add --into-contract splitback.you.near --agent buyer-1.you.near
//       to have 1Click deliver with ft_transfer_call straight into a Splitback
//       contract, credited to that agent's prepaid balance in one step. This uses
//       the 1Click field `customRecipientMsg`, which the docs mark as highly
//       experimental: the contract must be a mainnet deployment whose token is
//       real USDC, and it must be storage-registered on the USDC contract first,
//       or the funds can be lost.
//
// No API key is needed for quotes and status. See docs.near-intents.org.
import { API, cashOutQuote, placeholderAddress, resolve, stablecoins, toUnits, topUpQuote } from "./lib.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const LIVE = has("--live");
const nearAccount = arg("--near-account", "dreybuilds.near");
const amountText = arg("--amount", "1.00");
const intoContract = arg("--into-contract", null);
const agent = arg("--agent", nearAccount);
const name = (t) => `${t.symbol} on ${t.chain}`;

if (has("--list")) {
  const byCoin = new Map();
  for (const t of await stablecoins()) byCoin.set(t.symbol, [...(byCoin.get(t.symbol) ?? []), t.chain]);
  console.log("Stablecoins 1Click lists. Use them as --from symbol:chain or --to symbol:chain.\n");
  for (const [symbol, chains] of byCoin) console.log(`  ${symbol.padEnd(5)} ${[...new Set(chains)].sort().join(", ")}`);
  console.log("\nA listed coin can still be refused for a given amount: the API reports minimums and missing liquidity per quote.");
  process.exit(0);
}

const topUp = async (spec, dry, refundTo) => {
  const from = await resolve(spec);
  const q = await topUpQuote({
    from, dry,
    amount: toUnits(amountText, from.decimals),
    refundTo: refundTo ?? placeholderAddress(from.chain, nearAccount),
    recipient: intoContract ?? nearAccount,
    creditTo: intoContract ? agent : null,
  });
  return { from, q };
};
const row = (label, q) => console.log(`  ${label.padEnd(18)} in ${q.amountInFormatted.padStart(8)}   out ${q.amountOutFormatted.padStart(9)}   about ${q.timeEstimate}s`);
const refused = (label, e) => console.log(`  ${label.padEnd(18)} refused: ${e.message}`);

if (!LIVE) {
  const target = intoContract ? `${intoContract}, credited to ${agent}` : nearAccount;
  const froms = has("--from") ? [arg("--from")] : ["usdc:base", "usdt:eth", "usdc:sol", "usdc:arb", "usdt:near", "dai:eth"];
  const tos = has("--to") ? [arg("--to")] : has("--from") ? [arg("--from")] : ["usdc:base", "usdt:eth"];
  console.log(`top-up: pay ${amountText} of a stablecoin, receive USDC on NEAR for ${target} (dry)`);
  for (const spec of froms) {
    try { const { from, q } = await topUp(spec, true); row(name(from), q); }
    catch (e) { refused(spec, e); }
  }
  console.log(`\ncash-out: pay ${amountText} USDC on NEAR, receive a stablecoin on its own chain (dry)`);
  for (const spec of tos) {
    try {
      const to = await resolve(spec);
      row(name(to), await cashOutQuote({ to, amount: toUnits(amountText, 6), refundTo: nearAccount, recipient: placeholderAddress(to.chain, nearAccount) }));
    } catch (e) { refused(spec, e); }
  }
  console.log("\nDry quotes only. Nothing was sent.");
  process.exit(0);
}

const refund = arg("--refund", null);
if (!refund) {
  console.error("--live needs --refund set to your own address on the chain you pay from, so a failed swap is returned to you");
  process.exit(1);
}
const { from, q } = await topUp(arg("--from", "usdc:base"), false, refund);
console.log("live top-up quote");
row(name(from), q);
const { depositAddress, depositMemo } = q;
console.log(`\nSend exactly ${q.amountInFormatted} ${name(from)} to:\n  ${depositAddress}${depositMemo ? `\n  memo ${depositMemo}` : ""}`);
console.log("Waiting for the deposit ...");
for (;;) {
  await new Promise((r) => setTimeout(r, 8000));
  const url = `${API}/v0/status?depositAddress=${depositAddress}${depositMemo ? `&depositMemo=${depositMemo}` : ""}`;
  const s = await (await fetch(url)).json();
  console.log(`  ${new Date().toISOString()}  ${s.status}`);
  if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) {
    console.log(JSON.stringify(s.swapDetails ?? s, null, 2));
    break;
  }
}
