// Thin helpers over near-api-js: accounts, calls, views.
import { Account, KeyPair, actions } from "near-api-js";

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;

export function newKey() {
  const kp = KeyPair.fromRandom("ed25519");
  return { secret: kp.toString(), publicKey: kp.getPublicKey() };
}

export function publicKeyOf(secret) {
  return KeyPair.fromString(secret).getPublicKey();
}

export function account(rpcUrl, id, secret) {
  return new Account(id, rpcUrl, secret);
}

/** Read-only contract call over plain JSON-RPC. */
export async function view(rpcUrl, contractId, method, args = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await viewOnce(rpcUrl, contractId, method, args);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function viewOnce(rpcUrl, contractId, method, args) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "v",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) {
    throw new Error(`view ${contractId}.${method}: ${JSON.stringify(body.error ?? body.result.error)}`);
  }
  return JSON.parse(Buffer.from(body.result.result).toString());
}

function outcomeOf(resp) {
  const logs = [];
  let failure = null;
  for (const r of resp.receipts_outcome ?? []) {
    logs.push(...(r.outcome.logs ?? []));
    if (r.outcome.status?.Failure && !failure) failure = r.outcome.status.Failure;
  }
  let value;
  const sv = resp.status?.SuccessValue;
  if (typeof sv === "string" && sv.length) {
    try {
      value = JSON.parse(Buffer.from(sv, "base64").toString());
    } catch {
      value = undefined;
    }
  }
  if (resp.status?.Failure && !failure) failure = resp.status.Failure;
  return { value, logs, failure, txHash: resp.transaction?.hash };
}

/** Sends actions and returns { value, logs, txHash }. Throws on any failed receipt. */
export async function send(acct, receiverId, acts) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const resp = await acct.signAndSendTransaction({
        receiverId,
        actions: acts,
        waitUntil: "EXECUTED_OPTIMISTIC",
        throwOnFailure: false,
      });
      const out = outcomeOf(resp);
      if (out.failure) {
        const err = new Error(`${acct.accountId} -> ${receiverId}: ${JSON.stringify(out.failure)}`);
        err.contractFailure = true;
        throw err;
      }
      return out;
    } catch (e) {
      if (e.contractFailure) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function call(acct, contractId, method, args = {}, { gas = 60n * TGAS, deposit = 0n } = {}) {
  return send(acct, contractId, [actions.functionCall(method, args, gas, deposit)]);
}

/** Creates `id` funded with `amount` yoctoNEAR, with the given full-access public keys. */
export function createAccount(parent, id, amount, publicKeys) {
  return send(parent, id, [
    actions.createAccount(),
    actions.transfer(amount),
    ...publicKeys.map((pk) => actions.addFullAccessKey(pk)),
  ]);
}

export function deploy(acct, wasm, initMethod, initArgs) {
  return send(acct, acct.accountId, [
    actions.deployContract(wasm),
    actions.functionCall(initMethod, initArgs, 30n * TGAS, 0n),
  ]);
}

export async function exists(rpcUrl, id) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "a",
      method: "query",
      params: { request_type: "view_account", finality: "optimistic", account_id: id },
    }),
  });
  const body = await res.json();
  return !body.error && !body.result?.error;
}
