// Picks the network: a local sandbox by default, NEAR testnet on request.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NEAR } from "./chain.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a) => console.log(...a);

export async function network(testnet) {
  if (testnet) {
    const cfg = JSON.parse(readFileSync(join(HERE, "keys", "testnet.json"), "utf8"));
    return {
      name: "testnet",
      rpcUrl: cfg.rpcUrl ?? "https://test.rpc.fastnear.com",
      parentId: cfg.accountId,
      humanKey: cfg.privateKey,
      nearRoot: 9n * NEAR + NEAR / 2n,
      nearContract: { splitback: 5n * NEAR, usdc: 3n * NEAR },
      nearAgent: NEAR / 25n,
      stop: async () => {},
    };
  }
  const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = await import("near-sandbox");
  log("starting local NEAR sandbox ...");
  const sandbox = await Sandbox.start({});
  return {
    name: "sandbox",
    rpcUrl: sandbox.rpcUrl,
    parentId: DEFAULT_ACCOUNT_ID,
    humanKey: DEFAULT_PRIVATE_KEY,
    nearRoot: 400n * NEAR,
    nearContract: { splitback: 20n * NEAR, usdc: 20n * NEAR },
    nearAgent: 5n * NEAR,
    stop: () => sandbox.tearDown(),
  };
}

