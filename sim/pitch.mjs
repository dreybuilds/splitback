// The one-minute story, on a real chain.
//
// A trading agent pays a provider 12 for a reproducible order-book replay it
// would otherwise keep to itself. A third agent with a budget of 4 looks, sees a
// price of 6, and does not buy. A second agent buys in for 6. Now the price is 4,
// so the third buys in, and the first two each get 2 back. Every buyer ends up
// paying 4.
//
//   node pitch.mjs            local sandbox
//   node pitch.mjs --testnet  NEAR testnet
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { TGAS, account, call, createAccount, deploy, newKey, publicKeyOf, send, view } from "./lib/chain.mjs";
import { compute, sha256hex, taskKey } from "./lib/tasks.mjs";
import { network } from "./lib/network.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "res");
const TESTNET = process.argv.includes("--testnet");
const UNIT = 1_000_000n; // one credit = 1.000000 test USDC
const credits = (micro) => (Number(micro) / 1e6).toFixed(2).replace(/\.00$/, "");
const log = (...a) => console.log(...a);

const net = await network(TESTNET);
const { rpcUrl } = net;
const humanPk = publicKeyOf(net.humanKey);
const human = (id) => account(rpcUrl, id, net.humanKey);
const root = `${TESTNET ? `p${Date.now().toString(36)}` : "pitch"}.${net.parentId}`;
const SB = `splitback.${root}`;
const USDC = `usdc.${root}`;
const v = (method, args) => view(rpcUrl, SB, method, args);

await createAccount(human(net.parentId), root, TESTNET ? 9n * 10n ** 24n : net.nearRoot, [humanPk]);
await createAccount(human(root), SB, net.nearContract.splitback, [humanPk]);
await createAccount(human(root), USDC, net.nearContract.usdc, [humanPk]);
await deploy(human(USDC), readFileSync(join(WASM, "mock_usdc.wasm")), "new", {});
await deploy(human(SB), readFileSync(join(WASM, "splitback.wasm")), "new", {
  token: USDC, verifiers: [`verifier.${root}`], threshold: 1, challenge_window_ns: "5000000000",
});

// replay-provider does the work. desk-a, desk-b and desk-c are trading agents
// running different strategies. lurker never pays.
const budgets = { "replay-provider": 0n, "desk-a": 36n, "desk-b": 6n, "desk-c": 4n, lurker: 0n };
const agents = {};
for (const name of Object.keys(budgets)) {
  const id = `${name}.${root}`;
  const key = newKey();
  await send(human(root), id, [
    actions.createAccount(),
    actions.transfer(net.nearAgent),
    actions.addFullAccessKey(humanPk),
    actions.addFunctionCallAccessKey(key.publicKey, SB, ["publish", "join", "claim", "challenge", "withdraw"]),
  ]);
  agents[name] = { id, acct: account(rpcUrl, id, key.secret) };
  if (budgets[name] > 0n) {
    const amount = (budgets[name] * UNIT).toString();
    await send(human(id), USDC, [
      actions.functionCall("mint", { account_id: id, amount }, 10n * TGAS, 0n),
      actions.functionCall("ft_transfer_call", { receiver_id: SB, amount, msg: id }, 100n * TGAS, 1n),
    ]);
  }
}

const table = async (title) => {
  log(`\n${title}`);
  for (const name of Object.keys(budgets)) {
    const bal = await v("balance_of", { account_id: agents[name].id });
    log(`  ${name.padEnd(16)} balance ${credits(bal).padStart(5)}`);
  }
};
log(`\nnetwork ${net.name}, contract ${SB}`);
await table("start (desk-a holds 12 for the provider and 24 for the bond)");

// 1. desk-a commissions the replay. The manifest is public; the bytes are not.
const manifest = "orderbook-replay:market=NEAR-USDC;seed=2026-11-13;events=1500000";
const replay = compute(manifest); // done by replay-provider
const resultHash = sha256hex(replay);
const store = new Map([[resultHash, replay]]);
const deliver = async (entry, who) =>
  (await v("is_holder", { entry_id: entry, account_id: agents[who].id })) ? store.get(resultHash) : null;

const pub = await call(agents["desk-a"].acct, SB, "publish", {
  task_key: taskKey(manifest), spec: manifest, result_hash: resultHash,
  cost: (12n * UNIT).toString(), provider: agents["replay-provider"].id, delivery_fee: null,
});
const entry = pub.value;
log(`\n1. desk-a pays replay-provider 12 for "${manifest}"`);
log(`   on chain: input manifest + result hash ${resultHash.slice(0, 16)}...  (tx ${pub.txHash})`);
await table("after step 1");

const link = (hash) => (TESTNET ? `https://testnet.nearblocks.io/txns/${hash}` : `tx ${hash}`);
log(`   payment to provider: ${link(pub.txHash)}`);

// An agent buys only if the quote fits what its owner gave it. It passes the lower
// of the quote and its remaining budget as max_price, so the contract enforces
// the same limit even if the price moves between the quote and the purchase.
async function tryToBuy(name) {
  const quote = BigInt(await v("quote", { entry_id: entry }));
  const budget = BigInt(await v("balance_of", { account_id: agents[name].id }));
  if (quote > budget) {
    log(`   ${name}: quote is ${credits(quote)}, budget is ${credits(budget)}. Does not buy. Nothing spent, no transaction sent.`);
    return null;
  }
  const maxPrice = quote < budget ? quote : budget;
  const res = await call(agents[name].acct, SB, "join", { entry_id: entry, max_price: maxPrice.toString() });
  log(`   ${name}: quote is ${credits(quote)}, budget is ${credits(budget)}. Buys in for ${credits(res.value)} with max_price ${credits(maxPrice)}.`);
  log(`   join: ${link(res.txHash)}`);
  const bytes = await deliver(entry, name);
  log(`   replay delivered to ${name}, sha256 matches the chain: ${sha256hex(bytes) === resultHash}`);
  return res;
}
async function claimFor(name) {
  const res = await call(agents[name].acct, SB, "claim", { entry_id: entry });
  log(`   ${name} claims ${credits(res.value)} back: ${link(res.txHash)}`);
}

// 2. desk-c has a budget of 4. The replay costs 6 right now. It waits.
log("\n2. desk-c wants the replay but its owner gave it 4");
await tryToBuy("desk-c");
await table("after step 2 (unchanged)");

// 3. desk-b buys in. That halves desk-a's cost and lowers the next quote to 4.
log("\n3. desk-b buys in");
await tryToBuy("desk-b");
await claimFor("desk-a");
await table("after step 3");

// 4. Now the quote fits desk-c's budget.
log("\n4. desk-c looks again");
await tryToBuy("desk-c");
await claimFor("desk-a");
await claimFor("desk-b");
log(`   lurker asks for the replay without paying: ${(await deliver(entry, "lurker")) === null ? "refused" : "SERVED (bug)"}`);
await table("after step 4");

// When is reuse worth it? Time the real work against checking a delivered copy.
const t0 = performance.now();
compute(manifest);
const fromScratch = performance.now() - t0;
const t1 = performance.now();
const verified = sha256hex(store.get(resultHash)) === resultHash;
const checkCopy = performance.now() - t1;
log(`\nmeasured on this machine: replaying ${manifest.split("events=")[1]} events from scratch took ${fromScratch.toFixed(0)} ms;`);
log(`hash-checking the delivered replay took ${checkCopy.toFixed(2)} ms (matches: ${verified}).`);

const e = await v("get_entry", { entry_id: entry });
const net3 = {};
for (const name of ["desk-a", "desk-b", "desk-c"]) {
  const h = await v("get_holding", { entry_id: entry, account_id: agents[name].id });
  net3[name] = BigInt(h.paid) - BigInt(h.claimed);
}
const earned = BigInt(await v("balance_of", { account_id: agents["replay-provider"].id }));
log(`\nOne replay served ${e.holders} buyers. The provider earned ${credits(earned)}.`);
log(`Net paid: desk-a ${credits(net3["desk-a"])}, desk-b ${credits(net3["desk-b"])}, desk-c ${credits(net3["desk-c"])}.`);
log("desk-a's bond of 24 stays locked until it retires the entry and the challenge window passes.");

await net.stop();
const ok = earned === 12n * UNIT && Object.values(net3).every((x) => x === 4n * UNIT);
if (!ok) {
  log("\nFAILED: the numbers do not match the pitch");
  process.exit(1);
}
log("\nPITCH CHECK PASSED: provider earned 12, every buyer paid 4.");
process.exit(0);
