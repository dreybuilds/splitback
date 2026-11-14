// Creates a funded NEAR testnet account through the public faucet helper and
// saves its key to keys/testnet.json (git-ignored).
import { writeFileSync, existsSync } from "node:fs";
import { KeyPair } from "near-api-js";

const out = new URL("./keys/testnet.json", import.meta.url);
if (existsSync(out) && !process.argv.includes("--force")) {
  console.log("keys/testnet.json already exists; pass --force to replace it");
  process.exit(0);
}
const accountId = process.argv.find((a) => a.endsWith(".testnet")) ?? `splitback-${Date.now().toString(36)}.testnet`;
const kp = KeyPair.fromRandom("ed25519");
const res = await fetch("https://helper.testnet.near.org/account", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`faucet refused (${res.status}): ${text.slice(0, 300)}`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify({ accountId, privateKey: kp.toString() }, null, 2), { mode: 0o600 });
console.log(`created ${accountId}; key saved to sim/keys/testnet.json`);
