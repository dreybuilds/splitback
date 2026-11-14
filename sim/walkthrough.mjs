// One entry from start to finish on a local sandbox, printing every contract
// call with its arguments. GUIDE.md walks through the output.
//
//   node walkthrough.mjs                    honest result: publish, two buyers, rebates, bond back, withdraw
//   node walkthrough.mjs --wrong            tampered result: challenge, verifier vote, refunds, slashed bond
//   node walkthrough.mjs --spec "prime-count:below=2000000" --cost 9 --fee 0.5
//
// --spec  any task that compute() in lib/tasks.mjs understands
// --cost  the declared cost, in whole test USDC (default 12)
// --fee   optional flat delivery fee per buyer, in whole test USDC
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { TGAS, account, call, createAccount, deploy, newKey, publicKeyOf, send, view } from "./lib/chain.mjs";
import { compute, sha256hex, taskKey } from "./lib/tasks.mjs";
import { network } from "./lib/network.mjs";

const WASM = join(dirname(fileURLToPath(import.meta.url)), "..", "res");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const micro = (text) => BigInt(Math.round(Number(text) * 1e6));
const show = (m) => (Number(m) / 1e6).toFixed(6).replace(/\.?0+$/, "") || "0";
const log = (...a) => console.log(...a);

const WRONG = process.argv.includes("--wrong");
const SPEC = arg("--spec", "orderbook-replay:market=NEAR-USDC;seed=2026-11-13;events=1500000");
const COST = micro(arg("--cost", "12"));
const FEE = micro(arg("--fee", "0"));
const WINDOW_NS = 5_000_000_000n;
if (COST <= 0n || FEE < 0n || FEE > COST) throw new Error("--cost must be positive and --fee between 0 and the cost");

// Do the work before anything touches the chain, so a bad --spec fails at once.
const honest = compute(SPEC);
const bytes = WRONG ? honest.replace(/\d(?=\D*$)/, (d) => String((Number(d) + 1) % 10)) : honest;
const resultHash = sha256hex(bytes);

const net = await network(false);
const { rpcUrl } = net;
const humanPk = publicKeyOf(net.humanKey);
const human = (id) => account(rpcUrl, id, net.humanKey);
const root = `walk.${net.parentId}`;
const SB = `splitback.${root}`;
const USDC = `usdc.${root}`;
const id = (name) => `${name}.${root}`;
const v = (method, args) => view(rpcUrl, SB, method, args);

await createAccount(human(net.parentId), root, net.nearRoot, [humanPk]);
await createAccount(human(root), SB, net.nearContract.splitback, [humanPk]);
await createAccount(human(root), USDC, net.nearContract.usdc, [humanPk]);
await deploy(human(USDC), readFileSync(join(WASM, "mock_usdc.wasm")), "new", {});
const init = {
  token: USDC, verifiers: [1, 2, 3].map((i) => id(`verifier-${i}`)), threshold: 2,
  challenge_window_ns: WINDOW_NS.toString(),
};
await deploy(human(SB), readFileSync(join(WASM, "splitback.wasm")), "new", init);
log(`\nsetup: deployed ${SB}`);
log(`  new(${JSON.stringify(init)})`);

// The publisher needs the bond: twice the cost, three times with a delivery fee.
// A buyer needs its price, plus the stake if it is going to challenge.
const bond = COST * (FEE > 0n ? 3n : 2n);
const budgets = {
  publisher: bond, "buyer-1": COST, "buyer-2": COST, "verifier-1": 0n, "verifier-2": 0n, "verifier-3": 0n,
};
const agents = {};
log("\nsetup: one sub-account per agent, each holding a key that can only call the contract");
for (const [name, budget] of Object.entries(budgets)) {
  const key = newKey();
  const methods = name.startsWith("verifier")
    ? ["vote", "withdraw"]
    : ["publish", "join", "claim", "challenge", "retire", "release_bond", "withdraw"];
  await send(human(root), id(name), [
    actions.createAccount(),
    actions.transfer(net.nearAgent),
    actions.addFullAccessKey(humanPk),
    actions.addFunctionCallAccessKey(key.publicKey, SB, methods),
  ]);
  agents[name] = account(rpcUrl, id(name), key.secret);
  if (budget > 0n) {
    // The owner, not the agent, moves tokens: mint test USDC, then send it to the
    // contract with the agent's account id as the message.
    const fund = { receiver_id: SB, amount: budget.toString(), msg: id(name) };
    await send(human(id(name)), USDC, [
      actions.functionCall("mint", { account_id: id(name), amount: budget.toString() }, 10n * TGAS, 0n),
      actions.functionCall("ft_transfer_call", fund, 100n * TGAS, 1n),
    ]);
    log(`  owner -> ${USDC}.ft_transfer_call(${JSON.stringify(fund)})`);
  }
}

let n = 0;
const heading = (text) => log(`\n${++n}. ${text}`);
/** Sends one contract call as `who` and prints it with what it returned. */
async function step(who, method, args) {
  const res = await call(agents[who], SB, method, args);
  const returned = res.value === undefined ? "" : `  =>  ${JSON.stringify(res.value)}`;
  log(`  ${who} -> ${method}(${JSON.stringify(args)})${returned}`);
  return res.value;
}
async function balances(title) {
  log(`  ${title}`);
  for (const name of Object.keys(budgets)) {
    log(`    ${name.padEnd(11)} ${show(await v("balance_of", { account_id: id(name) })).padStart(10)}`);
  }
}
// The publisher's own storage. It serves the bytes only to accounts the contract lists as holders.
const deliver = async (entry, who) =>
  (await v("is_holder", { entry_id: entry, account_id: id(who) })) ? bytes : null;

log(`\ntask spec:   ${SPEC}`);
log(`task key:    ${taskKey(SPEC)}  (sha256 of the spec)`);
log(`result hash: ${resultHash}  (sha256 of the result bytes${WRONG ? ", which the publisher has tampered with" : ""})`);
await balances("prepaid balances at the start:");

heading(`publish: the publisher locks a bond of ${show(bond)} and becomes holder 1`);
const entry = await step("publisher", "publish", {
  task_key: taskKey(SPEC), spec: SPEC, result_hash: resultHash, cost: COST.toString(),
  provider: null, delivery_fee: FEE > 0n ? FEE.toString() : null,
});

for (const buyer of ["buyer-1", "buyer-2"]) {
  heading(`join: ${buyer} finds the entry by task key, reads the quote and buys in`);
  const found = await v("entries_for_key", { task_key: taskKey(SPEC) });
  log(`  view entries_for_key  =>  ${found.length} entry, id ${found[0].id}, status ${found[0].status}, ${found[0].holders} holder(s)`);
  const quote = await v("quote", { entry_id: entry });
  log(`  view quote({"entry_id":${entry}})  =>  "${quote}"  (${show(quote)})`);
  await step(buyer, "join", { entry_id: entry, max_price: quote });
  const got = await deliver(entry, buyer);
  log(`  bytes delivered off chain; sha256 matches the result hash on chain: ${sha256hex(got) === resultHash}`);
}
log(`  an account that has not paid asks for the bytes: ${(await deliver(entry, "verifier-3")) === null ? "refused" : "SERVED (bug)"}`);

heading("claim: earlier holders take their rebates");
for (const who of ["publisher", "buyer-1", "buyer-2"]) {
  const h = await v("get_holding", { entry_id: entry, account_id: id(who) });
  if (BigInt(h.claimable) > 0n) await step(who, "claim", { entry_id: entry });
  else log(`  ${who}: nothing to claim`);
}
for (const who of ["publisher", "buyer-1", "buyer-2"]) {
  const h = await v("get_holding", { entry_id: entry, account_id: id(who) });
  log(`  ${who.padEnd(9)} paid ${show(h.paid)} toward the cost, claimed ${show(h.claimed)} back, net ${show(BigInt(h.paid) - BigInt(h.claimed))}`);
}
await balances("prepaid balances now:");

let ok;
if (!WRONG) {
  heading("retire and release_bond: the publisher stops new joins, waits out the challenge window and takes the bond back");
  await step("publisher", "retire", { entry_id: entry });
  await new Promise((r) => setTimeout(r, Number(WINDOW_NS / 1_000_000n) + 2500));
  await step("publisher", "release_bond", { entry_id: entry });

  heading("withdraw: prepaid balance leaves the contract as tokens, to the agent's own account");
  const all = await v("balance_of", { account_id: id("publisher") });
  await step("publisher", "withdraw", { amount: all });
  const tokens = await view(rpcUrl, USDC, "ft_balance_of", { account_id: id("publisher") });
  log(`  view ${USDC}.ft_balance_of(publisher)  =>  "${tokens}"  (${show(tokens)})`);

  const share = (COST + 2n) / 3n;
  // The fee stops once fees total the cost, so the second buyer may pay less of it.
  const fees = { "buyer-1": FEE, "buyer-2": FEE < COST - FEE ? FEE : COST - FEE };
  // The publisher paid the cost off chain. On chain it gets back the bond, the
  // part of the cost the buyers now carry, and the fees.
  ok = BigInt(tokens) === bond + COST - share + fees["buyer-1"] + fees["buyer-2"];
  for (const who of ["buyer-1", "buyer-2"]) {
    ok &&= BigInt(await v("balance_of", { account_id: id(who) })) === COST - share - fees[who];
  }
  log(`\nevery holder has paid ${show(share)} toward a cost of ${show(COST)}${FEE > 0n ? `, and each buyer paid the publisher a delivery fee of ${show(FEE)}` : ""}.`);
} else {
  heading("challenge: buyer-2 recomputes the task, gets different bytes and stakes a tenth of the cost");
  log(`  recomputed from the spec, matches what was delivered: ${compute(SPEC) === (await deliver(entry, "buyer-2"))}`);
  await step("buyer-2", "challenge", { entry_id: entry, reason: "recomputed, hash differs" });
  log(`  view get_entry  =>  status ${(await v("get_entry", { entry_id: entry })).status}`);

  heading("vote: each verifier recomputes; the second matching vote decides");
  const upheld = compute(SPEC) !== bytes;
  for (const who of ["verifier-1", "verifier-2"]) await step(who, "vote", { entry_id: entry, upheld });
  log(`  view get_entry  =>  status ${(await v("get_entry", { entry_id: entry })).status}`);

  heading("claim: on a voided entry, claim is the refund");
  for (const who of ["buyer-1", "buyer-2"]) await step(who, "claim", { entry_id: entry });
  await balances("prepaid balances at the end:");

  const bal = async (who) => BigInt(await v("balance_of", { account_id: id(who) }));
  const lost = bond - (await bal("publisher"));
  ok = (await bal("buyer-1")) === COST && (await bal("buyer-2")) > COST && lost > COST && (await bal("verifier-3")) === 0n;
  log(`\nbuyer-1 is back to ${show(COST)}. buyer-2 gained ${show((await bal("buyer-2")) - COST)} for catching it.`);
  log(`The publisher lost ${show(lost)}, more than the cost of ${show(COST)}. verifier-3 did not vote and earned nothing.`);
}

await net.stop();
if (!ok) {
  log("\nFAILED: the final balances are not what RULES.md says they should be");
  process.exit(1);
}
log("\nWALKTHROUGH CHECK PASSED");
process.exit(0);
