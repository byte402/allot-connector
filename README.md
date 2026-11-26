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
- `allot_find`: search the [Allot directory](https://allot.dev/directory) of x402 APIs that take USDG on Robinhood Chain; each result has the URL, price, what it returns, the payee and whether that payee is approved for this AI. Pays nothing.
- `allot_pay_x402`: fetch a URL; if it answers 402 with a USDG offer on Robinhood Chain, pay it from the vault and return the response.
- `allot_pay`: send USDG to an approved payee.

Every transaction is simulated on Robinhood Chain mainnet with `eth_simulateV1` before it is sent. If an API does not deliver after payment was authorized, the connector releases the authorization so it cannot be settled.

Payments use x402 v2 "exact" with EIP-3009 on USDG, signed by the vault through ERC-1271.

## Pay from your terminal

You approve each payment yourself. The connector reads the `allot` entry of your Claude Desktop config (or `ALLOT_VAULT` and `ALLOT_AGENT_KEY`), checks your vault rules and shows the price. Nothing is sent until you run the command again with `--confirm` and the most you accept. Each transaction is simulated on mainnet first.

```
npx -y github:byte402/allot-connector find price          (searches the directory, needs no key)
npx -y github:byte402/allot-connector status
npx -y github:byte402/allot-connector pay https://allot-api.polished-dream-0948.workers.dev/v1/price?symbol=NVDA
npx -y github:byte402/allot-connector pay https://allot-api.polished-dream-0948.workers.dev/v1/price?symbol=NVDA --confirm 0.01
```
