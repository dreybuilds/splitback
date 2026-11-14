// Work that cannot be recomputed: a committee of NEAR AI models as the verifiers.
//
// Two sellers each sell a written market brief about an order-book replay. The
// briefs are written by a model, so no two runs produce the same bytes and a
// recompute-and-compare verifier has nothing to compare. One brief is honest.
// The other was written from tampered figures.
//
// Both are challenged. Three verifier agents, each backed by a different model
// on NEAR AI Cloud, read the brief against the replay's real figures and vote
// on chain. Two votes decide. Each model response is signed by NEAR AI; the
// script fetches the signature, checks it covers this exact request and
// response, and records the signing address next to the vote.
//
//   NEAR_AI_API_KEY=... node judge.mjs      (or put the key in sim/.env)
//
// Runs on a local sandbox. Uses real model calls, so it is not part of `npm run sim`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { actions } from "near-api-js";
import { TGAS, account, call, createAccount, deploy, newKey, publicKeyOf, send, view } from "./lib/chain.mjs";
import { compute, sha256hex, taskKey, usd } from "./lib/tasks.mjs";
import { network } from "./lib/network.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "res");
const API = "https://cloud-api.near.ai/v1";
const log = (...a) => console.log(...a);

if (!process.env.NEAR_AI_API_KEY && existsSync(join(HERE, ".env"))) process.loadEnvFile(join(HERE, ".env"));
const KEY = process.env.NEAR_AI_API_KEY;
if (!KEY) {
  console.error("Set NEAR_AI_API_KEY (get one at https://cloud.near.ai). Example: NEAR_AI_API_KEY=... node judge.mjs");
  process.exit(2);
}
const WANTED = (process.env.JUDGE_MODELS ?? "Qwen/Qwen3.8-27B,z-ai/glm-5.3-flash,Qwen/Qwen3.6-35B-A3B-FP8").split(",");
const WRITER = process.env.WRITER_MODEL ?? WANTED[1];

// ------------------------------------------------------------- NEAR AI Cloud

const sha = (s) => createHash("sha256").update(s).digest("hex");

async function chat(model, messages, maxTokens = 900) {
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2, stream: false });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "x-no-aliasing": "true",
        "accept-encoding": "identity",
      },
      body,
    });
    const raw = await res.text();
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`NEAR AI ${model} -> ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    return { id: json.id, text: json.choices[0].message.content ?? "", body, raw, usage: json.usage };
  }
}

/** Fetches NEAR AI's signature for one completion and checks what it covers. */
async function signatureFor(model, completion) {
  const out = { model, completion_id: completion.id, request_sha256: sha(completion.body), response_sha256: sha(completion.raw) };
  try {
    let sig;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${API}/signature/${completion.id}?signing_algo=ecdsa`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      sig = await res.json();
      break;
    }
    if (!sig || sig.error_code || !sig.signature) return { ...out, signed: false, note: sig ? JSON.stringify(sig).slice(0, 200) : "not recorded" };
    const expected =
      sig.signature_kind === "gateway"
        ? `${out.request_sha256}:${out.response_sha256}`
        : `${model}:${out.request_sha256}:${out.response_sha256}`;
    let recovered = null;
    try {
      const { verifyMessage } = await import("ethers");
      recovered = verifyMessage(sig.text, sig.signature);
    } catch {
      recovered = null;
    }
    return {
      ...out,
      signed: true,
      signature_kind: sig.signature_kind,
      signing_address: sig.signing_address,
      signature: sig.signature,
      covers_this_request_and_response: sig.text === expected,
      signer_recovered_matches: recovered ? recovered.toLowerCase() === String(sig.signing_address).toLowerCase() : null,
    };
  } catch (e) {
    return { ...out, signed: false, note: String(e).slice(0, 200) };
  }
}

const models = (await (await fetch(`${API}/models`)).json()).data.map((m) => m.id);
const JUDGES = WANTED.filter((m) => models.includes(m));
if (JUDGES.length < 3) {
  console.error(`Need 3 judge models that NEAR AI lists. Found ${JSON.stringify(JUDGES)} of ${JSON.stringify(WANTED)}.`);
  console.error("Set JUDGE_MODELS to three ids from https://cloud-api.near.ai/v1/models");
  process.exit(2);
}

// ------------------------------------------------------------------ the work

const manifestA = "orderbook-replay:market=NEAR-USDC;seed=2026-11-12;events=400000";
const manifestB = "orderbook-replay:market=NEAR-USDC;seed=2026-11-13;events=400000";
const factsA = JSON.parse(compute(manifestA));
const factsB = JSON.parse(compute(manifestB));
const tampered = { ...factsB, fills: Math.round(factsB.fills * 1.6), volume: Math.round(factsB.volume * 2.1), vwap_ticks: factsB.vwap_ticks + 37 };

const briefPrompt = (facts) => [
  { role: "system", content: "You write short market briefs for trading desks. Plain prose, 90 to 130 words, no headings, no lists. State every figure you are given exactly as given. Do not invent figures." },
  { role: "user", content: `Write a brief on this order-book replay.\nFigures: ${JSON.stringify(facts)}\nNote: prices are in ticks.` },
];

log(`writing two briefs with ${WRITER} ...`);
const honest = await chat(WRITER, briefPrompt(factsA));
const poisoned = await chat(WRITER, briefPrompt(tampered));

// --------------------------------------------------------------------- chain

const net = await network(false);
const { rpcUrl } = net;
const humanPk = publicKeyOf(net.humanKey);
const human = (id) => account(rpcUrl, id, net.humanKey);
const root = `judge.${net.parentId}`;
const SB = `splitback.${root}`;
const USDC = `usdc.${root}`;
const v = (m, a) => view(rpcUrl, SB, m, a);
const names = ["seller-honest", "seller-tampered", "buyer", "griefer", "verifier-1", "verifier-2", "verifier-3"];
const id = (n) => `${n}.${root}`;

await createAccount(human(net.parentId), root, net.nearRoot, [humanPk]);
await createAccount(human(root), SB, net.nearContract.splitback, [humanPk]);
await createAccount(human(root), USDC, net.nearContract.usdc, [humanPk]);
await deploy(human(USDC), readFileSync(join(WASM, "mock_usdc.wasm")), "new", {});
await deploy(human(SB), readFileSync(join(WASM, "splitback.wasm")), "new", {
  token: USDC, verifiers: [1, 2, 3].map((i) => id(`verifier-${i}`)), threshold: 2, challenge_window_ns: "60000000000",
});
const agents = {};
for (const n of names) {
  const key = newKey();
  await send(human(root), id(n), [
    actions.createAccount(), actions.transfer(net.nearAgent), actions.addFullAccessKey(humanPk),
    actions.addFunctionCallAccessKey(key.publicKey, SB, ["publish", "join", "claim", "challenge", "vote", "withdraw"]),
  ]);
  agents[n] = account(rpcUrl, id(n), key.secret);
  if (!n.startsWith("verifier")) {
    await send(human(id(n)), USDC, [
      actions.functionCall("mint", { account_id: id(n), amount: "5000000" }, 10n * TGAS, 0n),
      actions.functionCall("ft_transfer_call", { receiver_id: SB, amount: "5000000", msg: id(n) }, 100n * TGAS, 1n),
    ]);
  }
}

const COST = 1_500_000n;
async function publish(seller, manifest, text) {
  const spec = `brief:${manifest}`.slice(0, 256);
  const { value } = await call(agents[seller], SB, "publish", {
    task_key: taskKey(spec), spec, result_hash: sha256hex(text), cost: COST.toString(), provider: null,
  });
  return value;
}
const entryHonest = await publish("seller-honest", manifestA, honest.text);
const entryTampered = await publish("seller-tampered", manifestB, poisoned.text);
const cases = [
  { entry: entryHonest, seller: "seller-honest", manifest: manifestA, facts: factsA, brief: honest.text, challenger: "griefer", truth: "honest" },
  { entry: entryTampered, seller: "seller-tampered", manifest: manifestB, facts: factsB, brief: poisoned.text, challenger: "buyer", truth: "tampered" },
];
log(`\nentry ${entryHonest}: honest brief by seller-honest, ${usd(COST)}`);
log(`entry ${entryTampered}: brief written from tampered figures by seller-tampered, ${usd(COST)}`);

await call(agents.buyer, SB, "join", { entry_id: entryHonest, max_price: COST.toString() });
await call(agents.buyer, SB, "join", { entry_id: entryTampered, max_price: COST.toString() });
await call(agents.griefer, SB, "challenge", { entry_id: entryHonest, reason: "frivolous" });
await call(agents.buyer, SB, "challenge", { entry_id: entryTampered, reason: "figures do not match my own replay" });
log("buyer bought both; griefer challenged the honest one, buyer challenged the tampered one\n");

// --------------------------------------------------------------- the judging

const judgePrompt = (c) => [
  { role: "system", content: 'You are a verifier. You are given reference figures that are known to be correct and a brief that was sold as describing them. Decide whether the brief is faithful: every figure it states must match the reference, and it must not state figures the reference does not contain. Ignore wording and style. Answer with one JSON object and nothing else: {"faithful": true or false, "reason": "one sentence"}' },
  { role: "user", content: `Input manifest: ${c.manifest}\nReference figures: ${JSON.stringify(c.facts)}\n\nBrief:\n${c.brief}` },
];
function parseVerdict(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return typeof j.faithful === "boolean" ? j : null;
  } catch {
    return null;
  }
}

const judgements = [];
for (const c of cases) {
  log(`entry ${c.entry} (${c.truth})`);
  for (let i = 0; i < 3; i++) {
    const model = JUDGES[i];
    const completion = await chat(model, judgePrompt(c), 1200);
    const verdict = parseVerdict(completion.text);
    const record = { entry: c.entry, verifier: id(`verifier-${i + 1}`), model, verdict, raw_answer: verdict ? undefined : completion.text.slice(0, 300) };
    if (!verdict) {
      log(`  verifier-${i + 1} (${model}): no parseable verdict, abstains`);
      judgements.push({ ...record, vote: "abstained" });
      continue;
    }
    const upheld = !verdict.faithful;
    const attest = await signatureFor(model, completion);
    const { value, txHash } = await call(agents[`verifier-${i + 1}`], SB, "vote", { entry_id: c.entry, upheld });
    judgements.push({ ...record, vote: upheld ? "uphold" : "reject", vote_tx: txHash, near_ai: attest });
    log(`  verifier-${i + 1} (${model}): ${upheld ? "UPHOLD" : "reject"}  "${verdict.reason}"`);
    log(`      NEAR AI signature: ${attest.signed ? `${attest.signature_kind} by ${attest.signing_address}, covers this exact request and response: ${attest.covers_this_request_and_response}` : `none (${attest.note})`}`);
    if (value !== null && value !== undefined) {
      log(`  decided: challenge ${value ? "UPHELD" : "rejected"}`);
      c.outcome = value;
      break;
    }
  }
}

await call(agents.buyer, SB, "claim", { entry_id: entryTampered }).catch(() => {});
const entries = await v("get_entries", { from_index: 0, limit: 10 });
const balances = {};
for (const n of names) balances[n] = await v("balance_of", { account_id: id(n) });
mkdirSync(join(HERE, "out"), { recursive: true });
writeFileSync(
  join(HERE, "out", "judgements.json"),
  JSON.stringify({ writer_model: WRITER, briefs: { honest: honest.text, tampered: poisoned.text }, reference: { [manifestA]: factsA, [manifestB]: factsB }, judgements, entries, balances }, null, 2),
);

log("\nresult");
for (const c of cases) {
  const e = entries[c.entry];
  log(`  entry ${c.entry} (${c.truth}): ${e.status}`);
}
for (const n of names) log(`  ${n.padEnd(16)} ${usd(balances[n])}`);
log("\nvotes, model answers and NEAR AI signatures: sim/out/judgements.json");
await net.stop();

const asExpected = entries[entryHonest].status === "Open" && entries[entryTampered].status === "Voided";
log(asExpected
  ? "\nJUDGE CHECK PASSED: the honest brief stands and the tampered brief is void."
  : "\nThe committee did not reach the expected outcome. Model judgement is not guaranteed; see judgements.json.");
process.exit(asExpected ? 0 : 1);
