// NEAR Intents (1Click API) for the two edges of Splitback: funding an agent
// from another chain, and cashing out.
//
//   node intents/quote.mjs                         dry quotes only, moves no money
//   node intents/quote.mjs --live --near-account you.near --refund 0xYourBaseAddress [--amount 1.00]
//       asks for a real deposit address for "USDC on Base -> USDC on NEAR", then
//       polls until the swap settles. You send the USDC from your own wallet.
//   add --into-contract splitback.you.near --agent buyer-1.you.near
//       to have 1Click deliver with ft_transfer_call straight into a Splitback
//       contract, credited to that agent's prepaid balance in one step. This uses
//       the 1Click field `customRecipientMsg`, which the docs mark as highly
//       experimental: the contract must be a mainnet deployment whose token is
//       real USDC, and it must be storage-registered on the USDC contract first,
//       or the funds can be lost.
//
// No API key is needed for quotes and status. See docs.near-intents.org.
const API = "https://1click.chaindefuser.com";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const LIVE = process.argv.includes("--live");
const nearAccount = arg("--near-account", "dreybuilds.near");
// Dry quotes need a well-formed Base address; a random one is fine because nothing is sent.
const randomAddress = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const refund = arg("--refund", randomAddress);
const amount = BigInt(Math.round(Number(arg("--amount", "1.00")) * 1e6));
const intoContract = arg("--into-contract", null);
const agent = arg("--agent", nearAccount);

async function quote(body) {
  const res = await fetch(`${API}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`quote failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const topUp = (dry) => ({
  dry,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: USDC_BASE,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC_NEAR,
  amount: amount.toString(),
  refundTo: refund,
  refundType: "ORIGIN_CHAIN",
  recipient: intoContract ?? nearAccount,
  recipientType: "DESTINATION_CHAIN",
  // Splitback's ft_on_transfer credits the account named in the message.
  ...(intoContract ? { customRecipientMsg: agent } : {}),
  deadline,
});
const cashOut = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC_BASE,
  amount: amount.toString(),
  refundTo: nearAccount,
  refundType: "ORIGIN_CHAIN",
  recipient: refund,
  recipientType: "DESTINATION_CHAIN",
  deadline,
};

const show = (label, q) => {
  const x = q.quote;
  console.log(`${label}`);
  console.log(`  in  ${x.amountInFormatted} USDC   out ${x.amountOutFormatted} USDC   estimated ${x.timeEstimate}s`);
};

if (!LIVE) {
  const target = intoContract ? `${intoContract}, credited to ${agent}` : nearAccount;
  show(`top-up: ${Number(amount) / 1e6} USDC on Base -> USDC on NEAR for ${target} (dry)`, await quote(topUp(true)));
  show(`cash-out: ${Number(amount) / 1e6} USDC on NEAR -> USDC on Base (dry)`, await quote(cashOut));
  console.log("\nDry quotes only. Nothing was sent.");
  process.exit(0);
}

if (refund === randomAddress) {
  console.error("--live needs --refund set to your own Base address, so a failed swap is returned to you");
  process.exit(1);
}
const q = await quote(topUp(false));
show("live top-up quote", q);
const { depositAddress, depositMemo } = q.quote;
console.log(`\nSend exactly ${q.quote.amountInFormatted} USDC on Base to:\n  ${depositAddress}${depositMemo ? `\n  memo ${depositMemo}` : ""}`);
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
