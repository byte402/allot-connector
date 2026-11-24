# allot-connector

An MCP server that lets Claude, Cursor or any MCP client pay **x402** APIs from an **Allot Vault** on Robinhood Chain.

The AI holds only its own agent key. The vault contract enforces every rule on chain: a cap per payment, a daily x402 limit, approved payees, key expiry and an owner freeze. A leaked or hijacked agent key can never spend more.

## Setup
1. Create a vault and add an AI at https://allot.dev/app.html. You get the AI key once.
2. Send the AI key a little ETH on Robinhood Chain for gas (about 0.0001 ETH).
3. Add to your MCP client config:

```json
{
  "mcpServers": {
    "allot": {
      "command": "npx",
      "args": ["-y", "github:byte402/allot-connector"],
      "env": { "ALLOT_VAULT": "0xYourVault", "ALLOT_AGENT_KEY": "0xYourAIKey" }
    }
  }
}
```

## Tools
- `allot_status`: the vault's rules, what is left today, balance, key state.
- `allot_pay_x402`: fetch a URL; if it answers 402 with a USDG offer on Robinhood Chain, pay it from the vault and return the response.
- `allot_pay`: send USDG to an approved payee.

Every transaction is simulated on Robinhood Chain mainnet with `eth_simulateV1` before it is sent. If an API does not deliver after payment was authorized, the connector releases the authorization so it cannot be settled.

Payments use x402 v2 "exact" with EIP-3009 on USDG, signed by the vault through ERC-1271.

## Pay from your terminal

You approve each payment yourself. The connector reads the `allot` entry of your Claude Desktop config (or `ALLOT_VAULT` and `ALLOT_AGENT_KEY`), shows the price, checks your vault rules, and asks you to type `yes` before anything is sent. Each transaction is simulated on mainnet first.

```
npx -y github:byte402/allot-connector status
npx -y github:byte402/allot-connector pay https://allot-api.polished-dream-0948.workers.dev/v1/price?symbol=NVDA
```
