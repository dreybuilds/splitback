// Shared 1Click (NEAR Intents) helpers: which stablecoins can fund an agent, and quotes.
//
// Splitback settles in one token, USDC on NEAR. An owner can pay in any
// stablecoin 1Click lists; 1Click swaps it and delivers USDC on NEAR.
export const API = "https://1click.chaindefuser.com";
export const SETTLEMENT = { symbol: "USDC", chain: "near", decimals: 6, assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" };
export const STABLE_SYMBOLS = ["USDC", "USDT", "DAI", "USD1", "USDe", "FRAX"];

let tokenList;
/** Every stablecoin 1Click lists, as { symbol, chain, decimals, assetId }. */
export async function stablecoins() {
  if (!tokenList) {
    const res = await fetch(`${API}/v0/tokens`);
    if (!res.ok) throw new Error(`1Click token list failed (${res.status})`);
    tokenList = (await res.json())
      .filter((t) => STABLE_SYMBOLS.some((s) => s.toLowerCase() === t.symbol.toLowerCase()))
      .map((t) => ({ symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, assetId: t.assetId }));
  }
  return tokenList;
}

/** Resolves "usdt:eth" to a listed token. Throws with the valid choices if it is not listed. */
export async function resolve(spec) {
  const [symbol, chain] = String(spec).toLowerCase().split(":");
  const list = await stablecoins();
  const hits = list.filter((t) => t.symbol.toLowerCase() === symbol && t.chain === chain);
  if (!hits.length) {
    const sameSymbol = list.filter((t) => t.symbol.toLowerCase() === symbol).map((t) => `${symbol}:${t.chain}`);
    throw new Error(`"${spec}" is not a stablecoin 1Click lists.` + (sameSymbol.length ? ` Try: ${sameSymbol.join(", ")}` : " Run with --list to see them."));
  }
  // A few chains list two wrappers of the same coin; prefer the one with the usual 6 decimals.
  return hits.find((t) => t.decimals === 6) ?? hits[0];
}

/** "1.5" with 6 decimals -> 1500000n. */
export function toUnits(text, decimals) {
  const [whole, frac = ""] = String(text).split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

// Dry quotes need a well-formed refund address for the origin chain. Nothing is sent to it.
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
export function placeholderAddress(chain, nearAccount) {
  if (chain === "near") return nearAccount;
  if (chain === "sol") return "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg";
  if (chain === "tron") return "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
  return "0x" + randomHex(20);
}

export async function quote(body) {
  const res = await fetch(`${API}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ swapType: "EXACT_INPUT", slippageTolerance: 100, deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(), ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `quote failed (${res.status})`);
  return json.quote;
}

/** Quote for paying `amount` (base units) of `from` and receiving USDC on NEAR. */
export function topUpQuote({ from, amount, refundTo, recipient, creditTo, dry = true }) {
  return quote({
    dry,
    originAsset: from.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: SETTLEMENT.assetId,
    amount: amount.toString(),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    // Splitback's ft_on_transfer credits the account named in the message.
    ...(creditTo ? { customRecipientMsg: creditTo } : {}),
  });
}

/** Quote for paying `amount` of USDC on NEAR and receiving `to` on its own chain. */
export function cashOutQuote({ to, amount, refundTo, recipient }) {
  return quote({
    dry: true,
    originAsset: SETTLEMENT.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: to.assetId,
    amount: amount.toString(),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
  });
}
