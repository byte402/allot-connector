#!/usr/bin/env node
// allot-connector: an MCP server that lets an AI pay x402 APIs from an Allot Vault on Robinhood Chain.
// The AI holds only an agent key. The vault contract enforces every rule (per payment cap, daily x402 limit,
// approved payees, expiry, freeze), so the AI can never spend more than its owner allows.
// Every transaction is simulated on mainnet with eth_simulateV1 before it is sent.
//
// env: ALLOT_VAULT (vault address), ALLOT_AGENT_KEY (the AI's key), ALLOT_RPC (optional),
//      ALLOT_DRY_RUN=1 (simulate only, never send; for testing)
// If the env vars are not set, the "allot" entry of the Claude Desktop config on this machine is used.
//
// Terminal use, where you approve each payment yourself:
//   npx -y github:byte402/allot-connector status
//   npx -y github:byte402/allot-connector pay <url>                 (shows the price, sends nothing)
//   npx -y github:byte402/allot-connector pay <url> --confirm 0.01  (your yes: pays at most 0.01 USDG)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as VIEM from "viem";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeErrorResult, getAddress, toHex, keccak256, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
export const VAULT_ABI = parseAbi([
  "function agents(address) view returns (uint128 perPayment, uint128 perDay, uint128 spentToday, uint32 day, uint64 expiry, bool active)",
  "function payeeAllowed(address agent, address payee) view returns (bool)",
  "function remainingToday(address agent) view returns (uint256)",
  "function frozen() view returns (bool)",
  "function owner() view returns (address)",
  "function pay(address to, uint256 amount, bytes32 ref)",
  "function authorize(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes32 ref) returns (bytes32)",
  "function release(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)",
  "error NotOwner()", "error NotAllowed(string reason)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)"]);
const fmt = (raw) => formatUnits(raw, 6);

// ---------------- x402 parsing ----------------
// Reads a 402 response: x402 v2 PAYMENT-REQUIRED header (base64 JSON), or a JSON body with `accepts`.
export async function readRequirements(res) {
  const h = res.headers.get("payment-required");
  let doc = null;
  if (h) { try { doc = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch {} }
  if (!doc) { try { doc = await res.clone().json(); } catch {} }
  const accepts = Array.isArray(doc?.accepts) ? doc.accepts : [];
  const pick = accepts.find((a) => a.scheme === "exact" && String(a.network).toLowerCase() === "eip155:4663" && getAddress(a.asset) === USDG);
  return { doc, pick, accepts };
}

export function buildPaymentHeader(req, auth, settlementTx = null) {
  const payload = { x402Version: 2, accepted: req, payload: { signature: "0x", ...(settlementTx ? { settlementTx } : {}), authorization: Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ---------------- the connector ----------------
export function makeAllot({ vault, agentKey, rpc = CHAIN.rpcUrls.default.http[0], dryRun = false, fetchImpl = fetch, prelude = null }) {
  const account = privateKeyToAccount(agentKey), V = getAddress(vault);
  const transport = http(rpc, { retryCount: 4, retryDelay: 1500, timeout: 45_000 });
  const pub = createPublicClient({ chain: CHAIN, transport }), wal = createWalletClient({ chain: CHAIN, transport, account });
  const rawRpc = (method, params) => pub.request({ method, params });

  // reads: plain eth_call, or (tests) inside one simulation after the prelude
  async function reads(list) {
    if (!prelude) return Promise.all(list.map((r) => pub.readContract(r)));
    const calls = list.map((r) => ({ from: account.address, to: r.address, data: encodeFunctionData(r) }));
    const sim = await rawRpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: prelude.stateOverrides, calls: [...prelude.calls, ...calls] }], validation: false }, "latest"]);
    const res = sim[0].calls.slice(prelude.calls.length);
    return res.map((c, i) => { if (c.status !== "0x1") throw new Error("read failed"); const { decodeFunctionResult } = VIEM; return decodeFunctionResult({ ...list[i], data: c.returnData }); });
  }
  async function status() {
    const [a, remaining, frozen, bal] = await reads([
      { address: V, abi: VAULT_ABI, functionName: "agents", args: [account.address] },
      { address: V, abi: VAULT_ABI, functionName: "remainingToday", args: [account.address] },
      { address: V, abi: VAULT_ABI, functionName: "frozen" },
      { address: USDG, abi: ERC20, functionName: "balanceOf", args: [V] },
    ]);
    const gas = await pub.getBalance({ address: account.address });
    const [perPayment, perDay, , , expiry, active] = a;
    return { vault: V, agent: account.address, active, frozen, perPayment, perDay, remaining, vaultBalance: bal, expiry, gasEth: gas };
  }

  // simulate on mainnet, then send (or stop, in dry run). Returns {hash?, simulated}
  async function exec(fn, args, target = V, abi = VAULT_ABI) {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    const pre = prelude || { stateOverrides: undefined, calls: [] };
    const sim = await rawRpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: pre.stateOverrides, calls: [...pre.calls, ...(exec.chain || []), { from: account.address, to: target, data, gas: "0x2dc6c0" }] }], validation: false }, "latest"]);
    const c = sim[0].calls[pre.calls.length];
    if (c.status !== "0x1") {
      const rd = c.error?.data || c.returnData; let why = "the vault refused";
      try { const d = decodeErrorResult({ abi: VAULT_ABI, data: rd }); why = d.args?.[0] || d.errorName; } catch {}
      throw new Error(`refused by the vault contract: ${why}`);
    }
    if (dryRun) { (exec.chain ||= []).push({ from: account.address, to: target, data, gas: "0x2dc6c0" }); return { simulated: true, data, gas: parseInt(c.gasUsed, 16) }; }
    const hash = await wal.sendTransaction({ to: target, data, gas: BigInt(Math.ceil(parseInt(c.gasUsed, 16) * 1.3 + 20000)) });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (rc.status !== "success") throw new Error("the transaction failed on chain: " + hash);
    return { simulated: true, hash, data };
  }

  async function payX402({ url, method = "GET", body, headers = {}, maxUsdg }) {
    const init = { method, headers: { ...headers }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) };
    if (body != null && typeof body !== "string") init.headers["content-type"] ??= "application/json";
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return { paid: false, status: first.status, body: await first.text() };
    const { pick, accepts } = await readRequirements(first);
    if (!pick) throw new Error(`the API asks for payment, but not in USDG on Robinhood Chain (offers: ${accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") || "none"})`);
    const amount = BigInt(pick.amount ?? pick.maxAmountRequired), to = getAddress(pick.payTo);
    if (maxUsdg != null && amount > parseUnits(String(maxUsdg), 6)) throw new Error(`the API asks ${fmt(amount)} USDG, over the ${maxUsdg} USDG you allowed for this call`);
    // pre-check rules for a clear message; the contract enforces them again on chain
    const s = await status();
    if (!s.active) throw new Error("this AI key is not active in the vault");
    if (s.frozen) throw new Error("the vault is frozen by its owner");
    if (!(await reads([{ address: V, abi: VAULT_ABI, functionName: "payeeAllowed", args: [account.address, to] }]))[0]) throw new Error(`the payee ${to} is not on this AI's approved list`);
    if (amount > s.perPayment) throw new Error(`the API asks ${fmt(amount)} USDG, over the ${fmt(s.perPayment)} USDG cap per payment`);
    if (amount > s.remaining) throw new Error(`the API asks ${fmt(amount)} USDG, but only ${fmt(s.remaining)} USDG is left of today's x402 limit`);
    if (amount > s.vaultBalance) throw new Error(`the vault holds ${fmt(s.vaultBalance)} USDG, not enough for ${fmt(amount)}`);
    const now = BigInt(Math.floor(Date.now() / 1000)), timeout = BigInt(pick.maxTimeoutSeconds || 120);
    const auth = { from: V, to, value: amount, validAfter: 0n, validBefore: now + timeout, nonce: /^0x[0-9a-fA-F]{64}$/.test(pick.extra?.nonce || "") ? pick.extra.nonce : keccak256(toHex(`${V}:${account.address}:${now}:${Math.random()}`)) };
    const ref = keccak256(toHex(url)).slice(0, 66);
    const tx = await exec("authorize", [auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, ref]);
    // payer settlement: the API holds no key, so the AI settles its own authorization and sends the tx hash
    let settlementTx = null;
    if (pick.extra?.settlement === "payer") {
      const st = await exec("transferWithAuthorization", [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, "0x"], USDG, ERC20);
      settlementTx = st.hash || (dryRun ? keccak256(st.data) : null);
    }
    const paymentHeader = buildPaymentHeader(pick, auth, settlementTx);
    let res = await fetchImpl(url, { ...init, headers: { ...init.headers, "payment-signature": paymentHeader } });
    // already paid on chain: if the API fails on its side, retry the same payment, it is not charged twice
    for (let k = 0; settlementTx && res.status >= 500 && k < 4; k++) { await new Promise((r) => setTimeout(r, 4000)); res = await fetchImpl(url, { ...init, headers: { ...init.headers, "payment-signature": paymentHeader } }); }
    const text = await res.text();
    if (!res.ok && !settlementTx) {
      let released = null; try { released = await exec("release", [auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce]); } catch (e) { released = { error: e.message }; }
      return { paid: false, status: res.status, body: text, authorizeTx: tx.hash, released: released.hash || released.error || (released.simulated ? "simulated" : null) };
    }
    if (!res.ok) return { paid: true, delivered: false, status: res.status, body: text, settlementTx, paymentHeader, note: "paid on chain but the API did not deliver; send the same paymentHeader again as the payment-signature header" };
    return { paid: true, status: res.status, amount: fmt(amount), payTo: to, settlementTx, authorizeTx: tx.hash || (tx.simulated ? "simulated" : null), settlement: res.headers.get("payment-response"), body: text, auth };
  }

  async function pay({ to, amountUsdg, memo = "" }) {
    const tx = await exec("pay", [getAddress(to), parseUnits(String(amountUsdg), 6), keccak256(toHex(memo || "allot")).slice(0, 66)]);
    return { paid: true, to: getAddress(to), amount: String(amountUsdg), tx: tx.hash || "simulated" };
  }
  return { status, payX402, pay, account, vault: V };
}

// ---------------- MCP server ----------------
// settings: env vars first, then the "allot" entry in the Claude Desktop config on this machine
function claudeConfigFiles() {
  const home = os.homedir(), out = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"));
  if (process.env.LOCALAPPDATA) { const pk = path.join(process.env.LOCALAPPDATA, "Packages"); try { for (const d of fs.readdirSync(pk)) if (/^Claude/i.test(d)) out.push(path.join(pk, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json")); } catch {} }
  out.push(path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), path.join(home, ".config", "Claude", "claude_desktop_config.json"));
  return out;
}
export function loadSettings(env = process.env) {
  let { ALLOT_VAULT: vault, ALLOT_AGENT_KEY: key, ALLOT_RPC: rpc } = env, source = "environment";
  if (!vault || !key) for (const f of claudeConfigFiles()) {
    try { const e = JSON.parse(fs.readFileSync(f, "utf8")).mcpServers?.allot?.env; if (e?.ALLOT_VAULT && e?.ALLOT_AGENT_KEY) { vault ||= e.ALLOT_VAULT; key ||= e.ALLOT_AGENT_KEY; rpc ||= e.ALLOT_RPC; source = f; break; } } catch {}
  }
  if (!vault || !key) throw new Error("set ALLOT_VAULT and ALLOT_AGENT_KEY, or add the allot entry to your Claude Desktop config");
  key = String(key).trim(); if (!key.startsWith("0x")) key = "0x" + key;
  return { vault: String(vault).trim(), agentKey: key, rpc: rpc || undefined, source };
}

// ---------------- the Allot directory: x402 APIs that take USDG on Robinhood Chain ----------------
export const DIRECTORY_URL = "https://allot.dev/directory.json";
export async function findApis(query = "", { fetchImpl = fetch, url = DIRECTORY_URL } = {}) {
  const r = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`the directory answered ${r.status}`);
  const d = await r.json(), words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const a of d.apis || []) for (const e of a.endpoints || []) {
    const text = [a.name, a.by, a.category, e.path, e.what].join(" ").toLowerCase();
    if (words.every((w) => text.includes(w))) out.push({ api: a.name, by: a.by, category: a.category, url: a.base.replace(/\/+$/, "") + e.path, priceUsdg: e.price, what: e.what, payTo: a.payTo, source: a.source });
  }
  return out;
}

// ---------------- terminal: you approve each payment ----------------
async function cli(cmd, args) {
  if (cmd === "find") { // needs no key: reads the public directory
    const list = await findApis(args.join(" "));
    if (!list.length) { console.log("No listed x402 API matches. See https://allot.dev/directory"); return; }
    for (const x of list) console.log(`${x.priceUsdg.padEnd(6)} USDG  ${x.url}\n        ${x.what} · ${x.api} · payee ${x.payTo}`);
    console.log(`\n${list.length} endpoint${list.length === 1 ? "" : "s"}. To pay one: npx -y github:byte402/allot-connector pay <url>  (shows the price, sends nothing)`); return;
  }
  const cfg = loadSettings(), allot = makeAllot(cfg);
  const s = await allot.status();
  console.log(`Allot · Robinhood Chain mainnet\nvault   ${s.vault}\nAI key  ${s.agent}  ${s.active ? "active" : "NOT ACTIVE"}${s.frozen ? " · VAULT FROZEN" : ""}\nrules   ${fmt(s.perPayment)} USDG per payment · ${fmt(s.perDay)} per day · ${fmt(s.remaining)} left today\nvault   ${fmt(s.vaultBalance)} USDG · gas ${formatUnits(s.gasEth, 18)} ETH`);
  if (cmd === "status") return;
  if (cmd === "resend") { // deliver a payment that was settled but not served, with the header printed earlier; pays nothing
    const [u, h] = args; if (!/^https?:\/\//.test(u || "") || !h) { console.log("\nusage: allot-connector resend <url> <payment header>"); process.exitCode = 1; return; }
    const res = await fetch(u, { headers: { "payment-signature": h } }); console.log(`\nHTTP ${res.status} (nothing new was paid)\n\n${await res.text()}`); return;
  }
  const url = args.find((a) => /^https?:\/\//.test(a));
  if (cmd !== "pay" || !url) { console.log("\nusage: allot-connector pay <url>   |   allot-connector status   |   allot-connector find <words>"); process.exitCode = 1; return; }
  const first = await fetch(url);
  if (first.status !== 402) { console.log(`\n${url} answered ${first.status}, no payment needed:\n${await first.text()}`); return; }
  const { pick } = await readRequirements(first);
  if (!pick) throw new Error("the API asks for payment, but not in USDG on Robinhood Chain");
  const amount = BigInt(pick.amount ?? pick.maxAmountRequired), to = getAddress(pick.payTo);
  const allowed = (await createPublicClient({ chain: CHAIN, transport: http(cfg.rpc || CHAIN.rpcUrls.default.http[0], { timeout: 45_000 }) }).readContract({ address: s.vault, abi: VAULT_ABI, functionName: "payeeAllowed", args: [s.agent, to] }));
  console.log(`\nThe API asks ${fmt(amount)} USDG, paid to ${to}${allowed ? " (on the approved list)" : " (NOT on the approved list)"}`);
  const why = !s.active ? "this AI key is not active" : s.frozen ? "the vault is frozen" : !allowed ? "the payee is not approved" : amount > s.perPayment ? "over the per payment cap" : amount > s.remaining ? "over what is left of today's x402 limit" : amount > s.vaultBalance ? "the vault does not hold enough USDG" : null;
  if (why) { console.log(`Refused before signing: ${why}. Nothing was sent.`); process.exitCode = 1; return; }
  // your yes is the --confirm amount: no typing while the program runs (npx on Windows mixes up the prompt)
  const ci = args.indexOf("--confirm"), confirm = ci >= 0 ? args[ci + 1] : null;
  if (!confirm) { console.log(`\nNothing was sent. To pay, run the same command again with your yes and the most you accept:\n\n  npx -y github:byte402/allot-connector pay ${url} --confirm ${fmt(amount)}\n`); return; }
  if (!/^\d+(\.\d{1,6})?$/.test(confirm)) throw new Error("--confirm needs an amount in USDG, like --confirm 0.01");
  if (amount > parseUnits(confirm, 6)) { console.log(`Refused: the API now asks ${fmt(amount)} USDG, more than the ${confirm} you confirmed. Nothing was sent.`); process.exitCode = 1; return; }
  console.log(`You confirmed up to ${confirm} USDG. Simulating on mainnet, then paying ${fmt(amount)} USDG…`);
  const r = await allot.payX402({ url, maxUsdg: Number(confirm) });
  console.log(`\n${r.paid ? "Paid" : "Not paid"}${r.delivered === false ? " · NOT DELIVERED" : ""} · HTTP ${r.status}${r.authorizeTx ? `\nauthorize tx   ${r.authorizeTx}` : ""}${r.settlementTx ? `\nsettlement tx  ${r.settlementTx}` : ""}\n\n${r.body}`);
  if (r.delivered === false && r.paymentHeader) console.log(`\nYour payment is settled. To get the data later without paying again, run:\n\n  npx -y github:byte402/allot-connector resend ${url} ${r.paymentHeader}\n`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd) { try { await cli(cmd, rest); } catch (e) { console.error("allot: " + (e.shortMessage || e.message)); process.exitCode = 1; } return; }
  let cfg; try { cfg = loadSettings(); } catch (e) { console.error("allot-connector: " + e.message); process.exit(1); }
  const allot = makeAllot({ ...cfg, dryRun: process.env.ALLOT_DRY_RUN === "1" });
  const server = new McpServer({ name: "allot", version: "0.2.0" });
  const out = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
  const err = (e) => ({ isError: true, content: [{ type: "text", text: e.message || String(e) }] });

  server.registerTool("allot_status", {
    title: "Allot status",
    description: "Shows this AI's Allot vault on Robinhood Chain: per payment cap, daily x402 limit, what is left today, vault balance, and whether the key is active. Call this before paying when unsure.",
    inputSchema: {},
  }, async () => { try { const s = await allot.status(); return out({ vault: s.vault, agent: s.agent, active: s.active, frozen: s.frozen, perPaymentUsdg: fmt(s.perPayment), x402LimitPerDayUsdg: fmt(s.perDay), leftTodayUsdg: fmt(s.remaining), vaultBalanceUsdg: fmt(s.vaultBalance), keyExpires: s.expiry ? new Date(Number(s.expiry) * 1000).toISOString() : "never", gasEth: formatUnits(s.gasEth, 18) }); } catch (e) { return err(e); } });

  server.registerTool("allot_find", {
    title: "Find an x402 API",
    description: "Searches the Allot directory of x402 APIs that take USDG on Robinhood Chain: each result has the endpoint URL, its price, what it returns, the payee, and whether that payee is already approved for this AI. Use it to find an API before paying with allot_pay_x402. Finding pays nothing.",
    inputSchema: { query: z.string().optional().describe("words to match, e.g. 'price' or 'wallet balances'; empty lists everything") },
  }, async (a) => { try {
    const list = await findApis(a.query || ""), s = await allot.status(), pc = createPublicClient({ chain: CHAIN, transport: http(cfg.rpc || CHAIN.rpcUrls.default.http[0], { timeout: 45_000 }) });
    const seen = new Map(); for (const x of list) if (!seen.has(x.payTo)) seen.set(x.payTo, await pc.readContract({ address: s.vault, abi: VAULT_ABI, functionName: "payeeAllowed", args: [s.agent, getAddress(x.payTo)] }).catch(() => null));
    return out({ results: list.map((x) => ({ ...x, payeeApprovedForThisAI: seen.get(x.payTo) })), note: list.length ? "A payee that is not approved must be added by the vault owner in the Allot app before this AI can pay it." : "No listed API matches: https://allot.dev/directory" });
  } catch (e) { return err(e); } });

  server.registerTool("allot_pay_x402", {
    title: "Pay an x402 API",
    description: "Fetches a URL. If the API answers 402 Payment Required with an x402 offer in USDG on Robinhood Chain, pays it from the Allot vault (only if the owner's rules allow it) and returns the API's response. Only use when the user asked for data or a service that needs payment.",
    inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).optional(), body: z.any().optional(), maxUsdg: z.number().positive().optional().describe("Refuse if the API asks more than this, in USDG") },
  }, async (a) => { try { return out(await allot.payX402(a)); } catch (e) { return err(e); } });

  server.registerTool("allot_pay", {
    title: "Pay an approved address",
    description: "Sends USDG from the Allot vault to an address on this AI's approved payee list, within the owner's per payment cap and daily x402 limit. Only use when the user explicitly asks to pay someone.",
    inputSchema: { to: z.string(), amountUsdg: z.number().positive(), memo: z.string().optional() },
  }, async (a) => { try { return out(await allot.pay(a)); } catch (e) { return err(e); } });

  await server.connect(new StdioServerTransport());
}
// run when started directly (node, npx, or the Windows npx shim), not when imported by tests
function startedDirectly() {
  const a = process.argv[1]; if (!a) return false;
  try { if (import.meta.url.toLowerCase() === pathToFileURL(fs.realpathSync(a)).href.toLowerCase()) return true; } catch {}
  return /allot-connector(\.cmd|\.ps1)?$/i.test(a) || /[\\/]allot-connector[\\/]index\.mjs$/i.test(a);
}
if (startedDirectly()) main();
