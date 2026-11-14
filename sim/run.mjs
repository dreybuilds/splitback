// Scripted market: 5 sellers, 20 buyers, 3 verifiers. No LLM calls.
//
//   node run.mjs            local sandbox (downloads a NEAR node binary on first run)
//   node run.mjs --testnet  NEAR testnet, needs keys/testnet.json (see README)
//
// Exits non-zero if any rule from RULES.md is violated at the end.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import {
  NEAR, TGAS, account, call, createAccount, deploy, newKey, publicKeyOf, send, view,
} from "./lib/chain.mjs";
import { CATALOGUE, compute, sha256hex, taskKey, usd } from "./lib/tasks.mjs";
import { network } from "./lib/network.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "res");
const OUT = join(HERE, "out");
const TESTNET = process.argv.includes("--testnet");
const N_BUYERS = 20;
const N_SELLERS = 5;
const ROUNDS = 3;
const AGENT_METHODS = ["publish", "join", "claim", "challenge", "retire", "release_bond", "withdraw"];
const WINDOW_NS = 5_000_000_000n;

// Seeded PRNG so every run makes the same choices.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261114);
const log = (...a) => console.log(...a);
// Run fn over items with limited concurrency: public testnet RPCs rate-limit bursts.
const LIMIT = TESTNET ? 3 : 25;
async function each(items, fn) {
  const queue = [...items.entries()];
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(LIMIT, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) out[next[0]] = await fn(next[1]);
    }),
  );
  return out;
}

// -------------------------------------------------------------------- main

async function main() {
  const net = await network(TESTNET);
  const { rpcUrl } = net;
  const humanPk = publicKeyOf(net.humanKey);
  const human = (id) => account(rpcUrl, id, net.humanKey);
  const tag = TESTNET ? `s${Date.now().toString(36)}` : "swarm";
  const root = `${tag}.${net.parentId}`;
  const SH = `splitback.${root}`;
  const USDC = `usdc.${root}`;
  const VERIFIERS = [1, 2, 3].map((i) => `verifier-${i}.${root}`);
  const v = (method, args) => view(rpcUrl, SH, method, args);

  log(`network ${net.name}, swarm parent ${root}`);
  await createAccount(human(net.parentId), root, net.nearRoot, [humanPk]);
  await createAccount(human(root), SH, net.nearContract.splitback, [humanPk]);
  await createAccount(human(root), USDC, net.nearContract.usdc, [humanPk]);
  await deploy(human(USDC), readFileSync(join(WASM, "mock_usdc.wasm")), "new", {});
  await deploy(human(SH), readFileSync(join(WASM, "splitback.wasm")), "new", {
    token: USDC, verifiers: VERIFIERS, threshold: 2, challenge_window_ns: WINDOW_NS.toString(),
  });
  log(`contracts deployed: ${SH}, ${USDC}`);

  // One sub-account per agent. The human holds the full-access key; the agent
  // process only ever gets a function-call key limited to the Splitback contract.
  const agents = {};
  const names = [
    "verifier-1", "verifier-2", "verifier-3",
    ...Array.from({ length: N_SELLERS }, (_, i) => `seller-${i + 1}`),
    ...Array.from({ length: N_BUYERS }, (_, i) => `buyer-${i + 1}`),
  ];
  for (const name of names) {
    const id = `${name}.${root}`;
    const key = newKey();
    await send(human(root), id, [
      actions.createAccount(),
      actions.transfer(net.nearAgent),
      actions.addFullAccessKey(humanPk),
      actions.addFunctionCallAccessKey(key.publicKey, SH, name.startsWith("verifier") ? ["vote", "withdraw"] : AGENT_METHODS),
    ]);
    agents[name] = { name, id, acct: account(rpcUrl, id, key.secret) };
  }
  log(`${names.length} agent sub-accounts created, each with a function-call key for ${SH} only`);

  // The human funds each agent's prepaid balance: mint test tokens, then ft_transfer_call.
  const budget = (name) => (name.startsWith("seller") ? 10_000_000n : 4_000_000n);
  const funded = {};
  await each(names.filter((n) => !n.startsWith("verifier")), async (name) => {
    const a = agents[name];
    funded[name] = budget(name);
    await send(human(a.id), USDC, [
      actions.functionCall("mint", { account_id: a.id, amount: budget(name).toString() }, 10n * TGAS, 0n),
      actions.functionCall(
        "ft_transfer_call",
        { receiver_id: SH, amount: budget(name).toString(), msg: a.id },
        100n * TGAS, 1n,
      ),
    ]);
  });
  log("prepaid balances funded");

  // ---------------------------------------------------------------- market
  // The content store stands in for each seller's HTTP endpoint. It only serves
  // an account the contract says is a holder.
  const store = new Map();
  const serve = async (entryId, resultHash, who) =>
    (await v("is_holder", { entry_id: entryId, account_id: who })) ? store.get(resultHash) : undefined;

  const receipts = [];
  const grief = [];
  let caughtBy = null;
  const holdings = []; // { name, entry }
  const events = [];
  const note = (round, text) => {
    events.push({ round, text });
    log(`  ${text}`);
  };

  async function publish(agent, task, { cost = task.cost, poison = false, round = 0 } = {}) {
    let bytes = compute(task.spec);
    if (poison) bytes = bytes.replace(/[0-9]/, (d) => String((Number(d) + 1) % 10));
    const hash = sha256hex(bytes);
    store.set(hash, bytes);
    const { value, txHash } = await call(agent.acct, SH, "publish", {
      task_key: taskKey(task.spec), spec: task.spec, result_hash: hash, cost: cost.toString(), provider: null,
    });
    holdings.push({ name: agent.name, entry: value });
    note(round, `${agent.name} published entry ${value} "${task.spec}" at ${usd(cost)}${poison ? "  (wrong result)" : ""}`);
    return { entry: value, txHash };
  }

  log("\nsellers publish");
  const T = CATALOGUE;
  await publish(agents["seller-1"], T[0]);
  await each(
    [
      ["seller-1", T[1], {}],
      ["seller-2", T[2], {}],
      ["seller-3", T[4], {}],
      ["seller-4", T[5], {}],
      ["seller-5", T[6], { poison: true }],
    ],
    ([s, t, o]) => publish(agents[s], t, o),
  );
  await publish(agents["seller-2"], T[3]);
  // Rule 6: seller-4 undercuts seller-1 on the same task.
  await publish(agents["seller-4"], T[0], { cost: 700_000n });
  // T[7] is left unpublished on purpose: the first buyer that needs it has to compute it.

  // Each buyer needs three different tasks. Buyer 5 audits and is steered to the poisoned one.
  const buyers = Array.from({ length: N_BUYERS }, (_, i) => {
    const pool = [...T.keys()];
    const needs = [];
    while (needs.length < ROUNDS) needs.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    const n = i + 1;
    return {
      agent: agents[`buyer-${n}`],
      needs,
      strategy: n % 5 === 0 ? "auditor" : n === 7 ? "griefer" : "trusting",
    };
  });
  const b5 = buyers[4];
  b5.needs = [...b5.needs.filter((t) => t !== 6).slice(0, 1), 6, ...b5.needs.filter((t) => t !== 6).slice(1, 2)];

  async function buy(buyer, task, round) {
    const key = taskKey(task.spec);
    const open = (await v("entries_for_key", { task_key: key })).filter((e) => e.status === "Open");
    if (open.length === 0) return false;
    // Cheapest next price wins. Never pay more than computing alone would cost.
    open.sort((a, b) => Number(BigInt(a.next_price) - BigInt(b.next_price)));
    const e = open[0];
    let joined;
    try {
      joined = await call(buyer.agent.acct, SH, "join", { entry_id: e.id, max_price: task.cost.toString() });
    } catch (err) {
      // The entry was challenged or retired between the quote and the join.
      if (!err.contractFailure) throw err;
      return false;
    }
    const { value: price, txHash } = joined;
    holdings.push({ name: buyer.agent.name, entry: e.id });
    const bytes = await serve(e.id, e.result_hash, buyer.agent.id);
    const hashOk = bytes !== undefined && sha256hex(bytes) === e.result_hash;
    let audit = "not audited";
    if (buyer.strategy === "auditor") audit = bytes === compute(task.spec) ? "recomputed, matches" : "recomputed, MISMATCH";
    receipts.push({
      round, buyer: buyer.agent.id, bought: task.spec, entry: e.id, from: e.publisher,
      price_micro_usdc: price, alone_would_cost_micro_usdc: task.cost.toString(),
      hash_check_passed: hashOk, audit, tx: txHash,
    });
    if (audit.endsWith("MISMATCH")) {
      try {
        await call(buyer.agent.acct, SH, "challenge", { entry_id: e.id, reason: "recompute does not match result hash" });
        caughtBy = buyer.agent.name;
        note(round, `${buyer.agent.name} recomputed entry ${e.id}, found it wrong, and challenged it`);
      } catch (err) {
        // Rule 7: one challenge at a time. Another auditor got there first.
        if (!err.contractFailure) throw err;
        note(round, `${buyer.agent.name} also found entry ${e.id} wrong, but it was already under challenge`);
      }
    } else if (buyer.strategy === "griefer" && !buyer.griefed) {
      buyer.griefed = true;
      grief.push({ buyer, entry: e.id }); // filed after the round's purchases
    }
    return true;
  }

  // Three verifiers, two votes decide. verifier-1 and verifier-2 recompute the
  // task. verifier-3 is lazy: it never recomputes and always sides with the
  // publisher, so it is outvoted and unpaid whenever a result really is wrong.
  async function verify(round) {
    for (const g of grief.splice(0)) {
      try {
        await call(g.buyer.agent.acct, SH, "challenge", { entry_id: g.entry, reason: "frivolous" });
        note(round, `${g.buyer.agent.name} filed a frivolous challenge against entry ${g.entry}`);
      } catch (err) {
        if (!err.contractFailure) throw err;
      }
    }
    const all = await v("get_entries", { from_index: 0, limit: 100 });
    for (const e of all.filter((x) => x.status === "Challenged")) {
      const bytes = store.get(e.result_hash);
      const wrong = bytes === undefined || bytes !== compute(e.spec);
      const ballots = [["verifier-3", false], ["verifier-1", wrong], ["verifier-2", wrong]];
      const cast = [];
      for (const [name, upheld] of ballots) {
        const { value } = await call(agents[name].acct, SH, "vote", { entry_id: e.id, upheld });
        cast.push(`${name} ${upheld ? "uphold" : "reject"}`);
        if (value !== null && value !== undefined) {
          note(round, `verifiers voted on entry ${e.id} (${cast.join(", ")}): challenge ${value ? "UPHELD, entry void, bond slashed" : "rejected, stake forfeited"}`);
          break;
        }
      }
    }
  }

  async function claimAll() {
    const byAgent = new Map();
    for (const h of holdings) byAgent.set(h.name, [...(byAgent.get(h.name) ?? []), h.entry]);
    await each([...byAgent], async ([name, entries]) => {
      for (const entry of entries) {
        const hv = await v("get_holding", { entry_id: entry, account_id: agents[name].id });
        if (BigInt(hv.claimable) > 0n) await call(agents[name].acct, SH, "claim", { entry_id: entry });
      }
    });
  }

  for (let round = 1; round <= ROUNDS; round++) {
    log(`\nround ${round}`);
    const misses = [];
    await each(buyers, async (b) => {
      const task = T[b.needs[round - 1]];
      if (!(await buy(b, task, round))) misses.push([b, task]);
    });
    // Nobody sells it: the first buyer computes and publishes, the rest join.
    for (const [b, task] of misses) {
      if (!(await buy(b, task, round))) {
        const { entry, txHash } = await publish(b.agent, task, { round });
        receipts.push({
          round, buyer: b.agent.id, bought: task.spec, entry, from: "computed it itself, then published",
          price_micro_usdc: task.cost.toString(), alone_would_cost_micro_usdc: task.cost.toString(),
          hash_check_passed: true, audit: "own work", tx: txHash,
        });
      }
    }
    await verify(round);
    await claimAll();
    const s = await v("get_stats");
    note(round, `end of round ${round}: ${s.joins} joins, ${usd(s.paid_in)} paid in, ${usd(s.rebated)} rebated or refunded`);
  }

  // Rule 10 on one entry: retire, wait out the window, take the bond back.
  const s3entry = holdings.find((h) => h.name === "seller-3").entry;
  await call(agents["seller-3"].acct, SH, "retire", { entry_id: s3entry });
  await new Promise((r) => setTimeout(r, Number(WINDOW_NS / 1_000_000n) + 2500));
  const released = await call(agents["seller-3"].acct, SH, "release_bond", { entry_id: s3entry });
  log(`\nseller-3 retired entry ${s3entry} and took back its bond of ${usd(released.value)}`);

  // ------------------------------------------------------------- the checks
  const entries = await v("get_entries", { from_index: 0, limit: 100 });
  const problems = [];
  let alone = 0n;
  let together = 0n;
  let dustBound = 0n;
  let lockedBonds = 0n;
  for (const e of entries) lockedBonds += BigInt(e.bond);
  for (const h of holdings) {
    const e = entries[h.entry];
    const hv = await v("get_holding", { entry_id: h.entry, account_id: agents[h.name].id });
    const net = BigInt(hv.paid) - BigInt(hv.claimed);
    if (e.status === "Voided") {
      if (h.name !== agents[e.publisher.split(".")[0]]?.name && net !== 0n) {
        problems.push(`${h.name} not fully refunded on voided entry ${e.id}`);
      }
      continue;
    }
    if (net !== BigInt(e.current_share)) {
      problems.push(`${h.name} net ${net} != share ${e.current_share} on entry ${e.id}`);
    }
    alone += BigInt(e.cost);
    together += net;
  }
  for (const e of entries) if (e.status !== "Voided") dustBound += BigInt(e.holders);

  const balances = {};
  let sumBalances = 0n;
  for (const name of names) {
    balances[name] = BigInt(await v("balance_of", { account_id: agents[name].id }));
    sumBalances += balances[name];
  }
  const held = BigInt(await view(rpcUrl, USDC, "ft_balance_of", { account_id: SH }));
  const dust = held - sumBalances - lockedBonds;
  if (dust < 0n) problems.push(`contract is short: holds ${held}, owes ${sumBalances + lockedBonds}`);
  if (dust >= dustBound) problems.push(`unexplained surplus ${dust} (rounding bound ${dustBound})`);
  for (const r of receipts) if (!r.hash_check_passed) problems.push(`receipt failed hash check: ${JSON.stringify(r)}`);

  const poisoner = balances["seller-5"];
  const challenger = balances[caughtBy];
  const stats = await v("get_stats");
  const saving = Number(((alone - together) * 10000n) / alone) / 100;
  const summary = {
    network: net.name,
    contract: SH,
    token: USDC,
    agents: { buyers: N_BUYERS, sellers: N_SELLERS, verifiers: 3, votes_needed: 2 },
    entries: entries.map((e) => ({
      id: e.id, spec: e.spec, publisher: e.publisher, status: e.status,
      cost: e.cost, holders: e.holders, each_paid_net: e.current_share,
    })),
    stats,
    cost_if_every_agent_computed_alone_micro_usdc: alone.toString(),
    cost_actually_paid_micro_usdc: together.toString(),
    saving_percent: saving,
    rounding_dust_left_in_contract_micro_usdc: dust.toString(),
    poisoner_seller_5_balance: { start: funded["seller-5"].toString(), end: poisoner.toString() },
    challenger: caughtBy,
    verifier_earnings: Object.fromEntries([1, 2, 3].map((i) => [`verifier-${i}`, balances[`verifier-${i}`].toString()])),
    challenger_balance: { start: funded[caughtBy].toString(), end: challenger.toString() },
    rpc_url: TESTNET ? rpcUrl : null,
    explorer_tx_url: TESTNET ? "https://testnet.nearblocks.io/txns/" : null,
    receipts,
    events,
    problems,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "receipts.json"), JSON.stringify(receipts, null, 2));
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  // The live page reads this for the history feed. Local runs write a sample next to it.
  mkdirSync(join(HERE, "..", "web", "data"), { recursive: true });
  writeFileSync(
    join(HERE, "..", "web", "data", TESTNET ? "run.json" : "run.sample.json"),
    JSON.stringify(summary, null, 2),
  );

  log("\nentry  holders  status   cost      each paid  task");
  for (const e of entries) {
    log(
      `${String(e.id).padStart(5)}  ${String(e.holders).padStart(7)}  ${e.status.padEnd(7)}  ${usd(e.cost).padEnd(8)}  ${usd(e.current_share).padEnd(9)}  ${e.spec}`,
    );
  }
  log(`\nreceipts written: ${receipts.length} (sim/out/receipts.json)`);
  log(`if every agent had computed alone: ${usd(alone)}`);
  log(`what they paid through Splitback:  ${usd(together)}  (${saving}% less)`);
  log(`seller-5 published a wrong result: balance ${usd(funded["seller-5"])} -> ${usd(poisoner)}`);
  log(`${caughtBy} caught it:${" ".repeat(Math.max(1, 25 - caughtBy.length))}balance ${usd(funded[caughtBy])} -> ${usd(challenger)} after its own purchases`);
  log(`verifier earnings: ${[1, 2, 3].map((i) => `verifier-${i} ${usd(balances[`verifier-${i}`])}`).join(", ")}`);
  log(`rounding dust left in contract: ${dust} micro-USDC (bound ${dustBound})`);

  if (TESTNET) {
    const webCfg = { rpcUrl, contract: SH, token: USDC, network: "testnet" };
    writeFileSync(join(HERE, "..", "web", "deployment.json"), JSON.stringify(webCfg, null, 2));
    log(`\nweb/deployment.json now points the live page at ${SH}`);
  } else if (process.argv.includes("--keep")) {
    log(`\nsandbox left running at ${rpcUrl}; open web/index.html?rpc=${encodeURIComponent(rpcUrl)}&contract=${SH}`);
    log("press Ctrl-C to stop");
    await new Promise(() => {});
  }
  await net.stop();

  if (problems.length) {
    log("\nFAILED CHECKS:");
    for (const p of problems) log(` - ${p}`);
    process.exit(1);
  }
  log("\nALL CHECKS PASSED: every holder paid exactly ceil(cost / holders), refunds were complete, the contract is solvent.");
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
