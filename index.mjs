#!/usr/bin/env node
// allot-connector: an MCP server that lets an AI pay x402 APIs from an Allot Vault on Robinhood Chain.
// The AI holds only an agent key. The vault contract enforces every rule (per payment cap, daily x402 limit,
// approved payees, expiry, freeze), so the AI can never spend more than its owner allows.
// Every transaction is simulated on mainnet with eth_simulateV1 before it is sent.
//
// env: ALLOT_VAULT (vault address), ALLOT_AGENT_KEY (the AI's key), ALLOT_RPC (optional),
//      ALLOT_DRY_RUN=1 (simulate only, never send; for testing)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as VIEM from "viem";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeErrorResult, getAddress, toHex, keccak256, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
  const transport = http(rpc, { retryCount: 4, retryDelay: 1500 });
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
    const res = await fetchImpl(url, { ...init, headers: { ...init.headers, "payment-signature": buildPaymentHeader(pick, auth, settlementTx) } });
    const text = await res.text();
    if (!res.ok && !settlementTx) {
      let released = null; try { released = await exec("release", [auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce]); } catch (e) { released = { error: e.message }; }
      return { paid: false, status: res.status, body: text, authorizeTx: tx.hash, released: released.hash || released.error || (released.simulated ? "simulated" : null) };
    }
    if (!res.ok) return { paid: true, delivered: false, status: res.status, body: text, settlementTx, note: "paid on chain but the API did not deliver; retry the same request or contact the API" };
    return { paid: true, status: res.status, amount: fmt(amount), payTo: to, settlementTx, authorizeTx: tx.hash || (tx.simulated ? "simulated" : null), settlement: res.headers.get("payment-response"), body: text, auth };
  }

  async function pay({ to, amountUsdg, memo = "" }) {
    const tx = await exec("pay", [getAddress(to), parseUnits(String(amountUsdg), 6), keccak256(toHex(memo || "allot")).slice(0, 66)]);
    return { paid: true, to: getAddress(to), amount: String(amountUsdg), tx: tx.hash || "simulated" };
  }
  return { status, payX402, pay, account, vault: V };
}

// ---------------- MCP server ----------------
async function main() {
  const { ALLOT_VAULT, ALLOT_AGENT_KEY, ALLOT_RPC, ALLOT_DRY_RUN } = process.env;
  if (!ALLOT_VAULT || !ALLOT_AGENT_KEY) { console.error("allot-connector: set ALLOT_VAULT and ALLOT_AGENT_KEY"); process.exit(1); }
  const allot = makeAllot({ vault: ALLOT_VAULT, agentKey: ALLOT_AGENT_KEY, rpc: ALLOT_RPC || undefined, dryRun: ALLOT_DRY_RUN === "1" });
  const server = new McpServer({ name: "allot", version: "0.1.0" });
  const out = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
  const err = (e) => ({ isError: true, content: [{ type: "text", text: e.message || String(e) }] });

  server.registerTool("allot_status", {
    title: "Allot status",
    description: "Shows this AI's Allot vault on Robinhood Chain: per payment cap, daily x402 limit, what is left today, vault balance, and whether the key is active. Call this before paying when unsure.",
    inputSchema: {},
  }, async () => { try { const s = await allot.status(); return out({ vault: s.vault, agent: s.agent, active: s.active, frozen: s.frozen, perPaymentUsdg: fmt(s.perPayment), x402LimitPerDayUsdg: fmt(s.perDay), leftTodayUsdg: fmt(s.remaining), vaultBalanceUsdg: fmt(s.vaultBalance), keyExpires: s.expiry ? new Date(Number(s.expiry) * 1000).toISOString() : "never", gasEth: formatUnits(s.gasEth, 18) }); } catch (e) { return err(e); } });

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
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("allot-connector")) main();
