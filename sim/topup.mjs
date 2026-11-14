// Testnet only: the faucet gives 10 NEAR per account and a full simulation needs
// about 27. This creates throwaway faucet accounts and forwards their NEAR to the
// account in keys/testnet.json.   node topup.mjs [count]
import { readFileSync } from "node:fs";
import { KeyPair, actions } from "near-api-js";
import { account, send, NEAR } from "./lib/chain.mjs";

const cfg = JSON.parse(readFileSync(new URL("./keys/testnet.json", import.meta.url), "utf8"));
const rpcUrl = cfg.rpcUrl ?? "https://test.rpc.fastnear.com";
const count = Number(process.argv[2] ?? 2);
for (let i = 0; i < count; i++) {
  const id = `sb-donor-${Date.now().toString(36)}${i}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  const res = await fetch("https://helper.testnet.near.org/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) {
    console.error(`faucet refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2500));
  await send(account(rpcUrl, id, kp.toString()), cfg.accountId, [actions.transfer((NEAR * 99n) / 10n)]);
  console.log(`${id} sent 9.9 NEAR to ${cfg.accountId}`);
}
