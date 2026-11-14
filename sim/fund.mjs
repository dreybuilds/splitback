// Funding an agent in different stablecoins, and cashing out in another one.
//
// Splitback settles in one token (USDC on NEAR). An owner who holds a different
// stablecoin pays through NEAR Intents: 1Click swaps it and delivers USDC with
// ft_transfer_call, with the agent's account id as the message, so the money
// lands already credited to the agent's prepaid balance.
//
// NEAR Intents has no testnet. So this test uses, for the swap leg only:
//   - test tokens standing in for USDT on Ethereum and DAI on Ethereum,
//   - a `solver` account standing in for 1Click: it takes the stablecoin and
//     pays out the settlement token,
//   - the rate from a real dry quote on the live 1Click API for that exact pair.
// Everything after the swap is the real contract: the ft_transfer_call delivery,
// the credit to the named agent, and the agent spending that balance.
//
//   node fund.mjs                    local sandbox
//   node fund.mjs --testnet          NEAR testnet, fresh contracts (about 9 NEAR)
//   node fund.mjs --testnet --contract splitback.X.testnet --token usdc.X.testnet
//       reuse a deployed Splitback and its test token (about 4.5 NEAR)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { NEAR, TGAS, account, call, createAccount, deploy, newKey, publicKeyOf, send, view } from "./lib/chain.mjs";
import { compute, sha256hex, taskKey } from "./lib/tasks.mjs";
import { network } from "./lib/network.mjs";
import { cashOutQuote, placeholderAddress, resolve, toUnits, topUpQuote } from "../intents/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "res");
const TESTNET = process.argv.includes("--testnet");
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const log = (...a) => console.log(...a);
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(4)}`;
const QUOTE_ACCOUNT = "dreybuilds.near"; // 1Click wants a real mainnet recipient, even for a dry quote
const COST = 30_000_000n; // the result costs 30 USDC

const net = await network(TESTNET);
const { rpcUrl } = net;
const humanPk = publicKeyOf(net.humanKey);
const human = (id) => account(rpcUrl, id, net.humanKey);
const root = `${TESTNET ? `f${Date.now().toString(36)}` : "fund"}.${net.parentId}`;
const reuse = arg("--contract");
const SB = reuse ?? `splitback.${root}`;
const USDC = reuse ? arg("--token") : `usdc.${root}`;
if (reuse && !USDC) throw new Error("--contract needs --token, the test token that contract settles in");
const near = (n) => (NEAR * BigInt(Math.round(n * 100))) / 100n;
const size = TESTNET ? { token: near(1.5), contract: near(3.2), acct: near(0.2) } : { token: near(20), contract: near(20), acct: near(5) };

// The stablecoins the owners pay in. Each gets its own test token.
const coins = {
  usdt: { ...(await resolve("usdt:eth")), token: `usdt-eth.${root}` },
  dai: { ...(await resolve("dai:eth")), token: `dai-eth.${root}` },
};
const explorer = TESTNET ? "https://testnet.nearblocks.io/txns/" : null;
const record = { network: net.name, contract: SB, settlement_token: USDC, explorer_tx_url: explorer, stand_ins: {}, top_ups: [], purchases: [], cash_out: null, problems: [] };
const problem = (text) => { record.problems.push(text); log(`  PROBLEM: ${text}`); };
const expect = (ok, text) => { if (!ok) problem(text); };

// ---------- deploy ----------
const rootNear = Object.keys(coins).length * Number(size.token) + 6 * Number(size.acct) + (reuse ? 0 : Number(size.token) + Number(size.contract)) + Number(near(0.2));
await createAccount(human(net.parentId), root, BigInt(rootNear), [humanPk]);
const mock = readFileSync(join(WASM, "mock_usdc.wasm"));
if (!reuse) {
  await createAccount(human(root), SB, size.contract, [humanPk]);
  await createAccount(human(root), USDC, size.token, [humanPk]);
  await deploy(human(USDC), mock, "new", {});
  await deploy(human(SB), readFileSync(join(WASM, "splitback.wasm")), "new", {
    token: USDC, verifiers: [`verifier.${root}`], threshold: 1, challenge_window_ns: "5000000000",
  });
}
for (const c of Object.values(coins)) {
  await createAccount(human(root), c.token, size.token, [humanPk]);
  await deploy(human(c.token), mock, "new", {});
  record.stand_ins[c.token] = `${c.symbol} on ${c.chain}, ${c.decimals} decimals`;
}
log(`network ${net.name}\ncontract ${SB}${reuse ? " (already deployed)" : ""}, settles in ${USDC}`);
for (const [id, what] of Object.entries(record.stand_ins)) log(`test token ${id} stands in for ${what}`);

// ---------- accounts ----------
// owner holds the stablecoins. solver stands in for 1Click. The three desks are
// agents with a function-call key for Splitback only.
const ids = Object.fromEntries(["owner", "solver", "provider", "desk-a", "desk-b", "desk-c"].map((n) => [n, `${n}.${root}`]));
const agents = {};
for (const [name, id] of Object.entries(ids)) {
  const key = newKey();
  await send(human(root), id, [
    actions.createAccount(),
    actions.transfer(size.acct),
    actions.addFullAccessKey(humanPk),
    actions.addFunctionCallAccessKey(key.publicKey, SB, ["publish", "join", "claim", "challenge", "withdraw"]),
  ]);
  agents[name] = account(rpcUrl, id, key.secret);
}
const mint = (token, to, amount) => call(human(to), token, "mint", { account_id: to, amount: amount.toString() }, { gas: 10n * TGAS });
const tokenBal = async (token, id) => BigInt(await view(rpcUrl, token, "ft_balance_of", { account_id: id }));
const prepaid = async (name) => BigInt(await view(rpcUrl, SB, "balance_of", { account_id: ids[name] }));
const transfer = (from, token, to, amount) => call(human(ids[from]), token, "ft_transfer", { receiver_id: to, amount: amount.toString() }, { gas: 20n * TGAS, deposit: 1n });
const deliver = (from, token, amount, creditTo) =>
  call(human(ids[from]), token, "ft_transfer_call", { receiver_id: SB, amount: amount.toString(), msg: creditTo }, { gas: 100n * TGAS, deposit: 1n });
await mint(USDC, ids.solver, 1_000_000_000n); // the solver's inventory of the settlement token
for (const c of Object.values(coins)) await mint(c.token, ids.solver, toUnits("1000", c.decimals));

// A real quote from the live API fixes the rate. The swap itself is the stand-in.
const liveQuote = async (label, fn, fallbackOut) => {
  try {
    const q = await fn();
    return { out: BigInt(q.amountOut), source: "live 1Click dry quote", seconds: q.timeEstimate };
  } catch (e) {
    log(`  (1Click quote for ${label} not available: ${e.message}. Using 0.5% as the cost.)`);
    return { out: fallbackOut, source: "assumed 0.5% cost, the 1Click API gave no quote", seconds: null };
  }
};

// ---------- top-ups ----------
log("\ntop-ups");
// desk-a's owner already holds USDC on NEAR: no swap, one direct deposit.
{
  const amount = 100_000_000n;
  await mint(USDC, ids.owner, amount);
  const tx = await deliver("owner", USDC, amount, ids["desk-a"]);
  const got = await prepaid("desk-a");
  log(`  desk-a  100 USDC on NEAR, no swap                       credited ${usd(got)}  (tx ${tx.txHash})`);
  expect(got === amount, `desk-a was credited ${got}, expected ${amount}`);
  record.top_ups.push({ agent: ids["desk-a"], paid_in: "USDC on near", amount_in: "100", credited_micro_usdc: got.toString(), rate_source: "no swap", deposit_tx: null, delivery_tx: tx.txHash });
}
const swapIn = async (desk, coin, amountText) => {
  const amountIn = toUnits(amountText, coin.decimals);
  const q = await liveQuote(`${coin.symbol} on ${coin.chain}`, () => topUpQuote({
    from: coin, amount: amountIn, refundTo: placeholderAddress(coin.chain, QUOTE_ACCOUNT), recipient: QUOTE_ACCOUNT, creditTo: `${desk}.${QUOTE_ACCOUNT}`,
  }), (toUnits(amountText, 6) * 995n) / 1000n);
  await mint(coin.token, ids.owner, amountIn);
  const before = await prepaid(desk);
  const dep = await transfer("owner", coin.token, ids.solver, amountIn); // the owner's deposit
  const del = await deliver("solver", USDC, q.out, ids[desk]); // what 1Click does with customRecipientMsg
  const got = (await prepaid(desk)) - before;
  log(`  ${desk}  ${amountText} ${coin.symbol} on ${coin.chain} -> ${usd(q.out)} USDC (${q.source})   credited ${usd(got)}  (tx ${del.txHash})`);
  expect(got === q.out, `${desk} was credited ${got}, the quote said ${q.out}`);
  expect((await tokenBal(coin.token, ids.owner)) === 0n, `the owner still holds ${coin.symbol} after paying`);
  record.top_ups.push({ agent: ids[desk], paid_in: `${coin.symbol} on ${coin.chain}`, amount_in: amountText, credited_micro_usdc: got.toString(), rate_source: q.source, estimated_seconds: q.seconds, deposit_tx: dep.txHash, delivery_tx: del.txHash });
};
await swapIn("desk-b", coins.usdt, "20");
await swapIn("desk-c", coins.dai, "200");

// A stablecoin sent straight to the contract, with no swap, must bounce.
{
  const amount = toUnits("5", coins.usdt.decimals);
  await mint(coins.usdt.token, ids.owner, amount);
  const before = await prepaid("desk-b");
  let refusedBy = null;
  try { await deliver("owner", coins.usdt.token, amount, ids["desk-b"]); } catch (e) { if (e.contractFailure) refusedBy = e.message; else throw e; }
  await new Promise((r) => setTimeout(r, TESTNET ? 4000 : 500));
  const back = await tokenBal(coins.usdt.token, ids.owner);
  const ok = refusedBy?.includes("only the configured token") && back === amount && (await prepaid("desk-b")) === before;
  log(`  5 ${coins.usdt.symbol} sent straight to the contract, no swap: ${ok ? "refused and returned to the owner, nothing credited" : "NOT handled"}`);
  expect(ok, `a direct deposit of the wrong token was not refused cleanly: ${refusedBy}`);
  record.wrong_token_deposit = { token: coins.usdt.token, refused: Boolean(refusedBy), returned_to_owner: back === amount };
}

// ---------- the agents spend what they were funded with ----------
log("\npurchases, paid from those balances");
const manifest = `orderbook-replay:market=NEAR-USDC;seed=${root};events=300000`;
const resultHash = sha256hex(compute(manifest));
const pub = await call(agents["desk-a"], SB, "publish", { task_key: taskKey(manifest), spec: manifest, result_hash: resultHash, cost: COST.toString(), provider: ids.provider });
const entry = pub.value;
log(`  desk-a (funded in USDC) paid the provider ${usd(COST)} and published entry ${entry}  (tx ${pub.txHash})`);
record.purchases.push({ agent: ids["desk-a"], action: "publish", entry, price_micro_usdc: COST.toString(), tx: pub.txHash });
for (const [desk, coin] of [["desk-b", coins.usdt], ["desk-c", coins.dai]]) {
  const j = await call(agents[desk], SB, "join", { entry_id: entry });
  log(`  ${desk} (funded in ${coin.symbol}) bought in for ${usd(j.value)}  (tx ${j.txHash})`);
  record.purchases.push({ agent: ids[desk], action: "join", entry, price_micro_usdc: String(j.value), tx: j.txHash });
}
for (const desk of ["desk-a", "desk-b"]) await call(agents[desk], SB, "claim", { entry_id: entry });
for (const desk of ["desk-a", "desk-b", "desk-c"]) {
  const h = await view(rpcUrl, SB, "get_holding", { entry_id: entry, account_id: ids[desk] });
  const netPaid = BigInt(h.paid) - BigInt(h.claimed);
  expect(netPaid === COST / 3n, `${desk} paid ${netPaid} net, expected ${COST / 3n}`);
}
log(`  after rebates each of the three has paid ${usd(COST / 3n)}, whatever coin its owner started with`);

// ---------- cash-out in a different stablecoin ----------
log("\ncash-out");
{
  const to = coins.usdt;
  const earned = await prepaid("provider");
  expect(earned === COST, `the provider's balance is ${earned}, expected ${COST}`);
  const w = await call(agents.provider, SB, "withdraw", { amount: earned.toString() }, { gas: 80n * TGAS });
  expect((await tokenBal(USDC, ids.provider)) === earned, "the withdrawal did not reach the provider's own account");
  const q = await liveQuote(`${to.symbol} on ${to.chain}`, () => cashOutQuote({ to, amount: earned, refundTo: QUOTE_ACCOUNT, recipient: placeholderAddress(to.chain, QUOTE_ACCOUNT) }), (earned * 995n) / 1000n);
  const dep = await transfer("provider", USDC, ids.solver, earned);
  const pay = await transfer("solver", to.token, ids.provider, q.out);
  const got = await tokenBal(to.token, ids.provider);
  log(`  provider withdrew ${usd(earned)} USDC to its own account  (tx ${w.txHash})`);
  log(`  swapped to ${usd(got)} ${to.symbol} on ${to.chain} (${q.source})  (tx ${pay.txHash})`);
  expect(got === q.out, `the provider received ${got} ${to.symbol}, the quote said ${q.out}`);
  record.cash_out = { account: ids.provider, withdrew_micro_usdc: earned.toString(), received: `${to.symbol} on ${to.chain}`, received_units: got.toString(), rate_source: q.source, withdraw_tx: w.txHash, deposit_tx: dep.txHash, payout_tx: pay.txHash };
}

mkdirSync(join(HERE, "out"), { recursive: true });
writeFileSync(join(HERE, "out", "funding.json"), JSON.stringify(record, null, 2));
log("\nrecord written: sim/out/funding.json");
await net.stop();
if (record.problems.length) {
  log(`\nFUNDING CHECK FAILED: ${record.problems.length} problem(s).`);
  process.exit(1);
}
log("\nFUNDING CHECK PASSED: three agents were funded from USDC, USDT and DAI, each was credited what the quote said, all three paid the same net price, and the provider cashed out in USDT.");
