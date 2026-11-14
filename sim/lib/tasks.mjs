// Deterministic tasks. Each one is a spec string; anyone can recompute it and
// get the same bytes, which is what lets the verifier rule on challenges.
import { createHash } from "node:crypto";

export const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

/** The on-chain key for a task is the SHA-256 of its spec. */
export const taskKey = (spec) => sha256hex(spec);

function parse(spec) {
  const [kind, rest] = spec.split(":");
  const params = Object.fromEntries(rest.split(";").map((kv) => kv.split("=")));
  return { kind, params };
}

/** Runs a task and returns its result bytes as a string. */
export function compute(spec) {
  const { kind, params } = parse(spec);
  if (kind === "sha256-chain") {
    let h = Buffer.from(params.seed);
    const rounds = Number(params.rounds);
    for (let i = 0; i < rounds; i++) h = createHash("sha256").update(h).digest();
    return JSON.stringify({ spec, digest: h.toString("hex") });
  }
  if (kind === "prime-count") {
    const n = Number(params.below);
    const sieve = new Uint8Array(n);
    let count = 0;
    for (let i = 2; i < n; i++) {
      if (!sieve[i]) {
        count++;
        for (let j = i * 2; j < n; j += i) sieve[j] = 1;
      }
    }
    return JSON.stringify({ spec, primes: count });
  }
  if (kind === "collatz-max") {
    const n = Number(params.below);
    let best = 1;
    let bestLen = 1;
    for (let s = 1; s < n; s++) {
      let x = s;
      let len = 1;
      while (x !== 1) {
        x = x % 2 === 0 ? x / 2 : 3 * x + 1;
        len++;
      }
      if (len > bestLen) {
        bestLen = len;
        best = s;
      }
    }
    return JSON.stringify({ spec, start: best, steps: bestLen });
  }
  if (kind === "orderbook-replay") {
    // Replays a seeded stream of limit orders through a price-time matching
    // engine. The spec is the input manifest: market, seed and event count.
    let state = 0;
    for (const ch of `${params.market}|${params.seed}`) state = (Math.imul(state, 31) + ch.charCodeAt(0)) >>> 0;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const LEVELS = 4096;
    const bids = new Float64Array(LEVELS);
    const asks = new Float64Array(LEVELS);
    let bestBid = 0;
    let bestAsk = LEVELS;
    let mid = 2048;
    let fills = 0;
    let volume = 0;
    let notional = 0;
    const tape = createHash("sha256");
    const events = Number(params.events);
    for (let i = 0; i < events; i++) {
      const r = next();
      const buy = (r & 1) === 1;
      const offset = ((r >>> 1) % 41) - 20;
      let price = Math.min(LEVELS - 2, Math.max(1, mid + offset));
      let qty = 1 + ((r >>> 8) % 50);
      if (buy) {
        while (qty > 0 && bestAsk <= price) {
          const take = Math.min(qty, asks[bestAsk]);
          if (take > 0) {
            asks[bestAsk] -= take; qty -= take; fills++; volume += take; notional += take * bestAsk; mid = bestAsk;
            tape.update(`${i}:${bestAsk}:${take};`);
          }
          if (asks[bestAsk] === 0) { bestAsk++; while (bestAsk < LEVELS && asks[bestAsk] === 0) bestAsk++; }
        }
        if (qty > 0) { bids[price] += qty; if (price > bestBid) bestBid = price; }
      } else {
        while (qty > 0 && bestBid >= price && bestBid > 0) {
          const take = Math.min(qty, bids[bestBid]);
          if (take > 0) {
            bids[bestBid] -= take; qty -= take; fills++; volume += take; notional += take * bestBid; mid = bestBid;
            tape.update(`${i}:${bestBid}:${take};`);
          }
          if (bids[bestBid] === 0) { bestBid--; while (bestBid > 0 && bids[bestBid] === 0) bestBid--; }
        }
        if (qty > 0) { asks[price] += qty; if (price < bestAsk) bestAsk = price; }
      }
    }
    return JSON.stringify({
      spec, fills, volume, vwap_ticks: Math.floor(notional / Math.max(1, volume)),
      best_bid: bestBid, best_ask: bestAsk, tape_sha256: tape.digest("hex"),
    });
  }
  throw new Error(`unknown task kind: ${kind}`);
}

// What each task costs to run, in micro-USDC (6 decimals). These are the
// simulation's stand-in for a real compute or API bill.
export const CATALOGUE = [
  { spec: "sha256-chain:seed=near;rounds=400000", cost: 900_000n },
  { spec: "sha256-chain:seed=intents;rounds=600000", cost: 1_350_000n },
  { spec: "prime-count:below=3000000", cost: 1_200_000n },
  { spec: "orderbook-replay:market=NEAR-USDC;seed=2026-11-13;events=1500000", cost: 2_000_000n },
  { spec: "collatz-max:below=300000", cost: 750_000n },
  { spec: "collatz-max:below=600000", cost: 1_500_000n },
  { spec: "sha256-chain:seed=swarm;rounds=250000", cost: 560_000n },
  { spec: "prime-count:below=1500000", cost: 600_000n },
];

export const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(4)}`;
