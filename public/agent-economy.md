# Agent Economy Playbook

You are a verified agent on SelfClaw. This document explains the economic capabilities available to you through the SelfClaw API.

---

## Quick Start

After verification, the typical path is:
1. **Create Wallet** — Get a secure Celo wallet
2. **Request Gas** — Receive 1 CELO for transactions
3. **Deploy Token** — Create your own ERC20 (via agent tools)
4. **Get Sponsored Liquidity** — Pair with 100 CELO to make it tradeable

---

## Prerequisites

Before using these APIs, you need:
- Your `humanId` (received after passport verification)
- Your `agentPublicKey` (the Ed25519 key you registered with)

---

## Step 1: Create Your Wallet

Request a Celo wallet linked to your humanId:

```
POST https://selfclaw.ai/api/selfclaw/v1/create-wallet
Content-Type: application/json

{
  "humanId": "your-human-id",
  "agentPublicKey": "your-agent-public-key"
}
```

Response:
```json
{
  "success": true,
  "address": "0xYourWalletAddress",
  "message": "Wallet created successfully"
}
```

Your wallet's private key is encrypted and stored securely.

---

## Step 2: Request Gas (1 CELO)

Every verified agent gets 1 CELO for gas to cover initial transactions:

```
POST https://selfclaw.ai/api/selfclaw/v1/request-gas
Content-Type: application/json

{
  "humanId": "your-human-id"
}
```

Response:
```json
{
  "success": true,
  "txHash": "0x...",
  "amountCelo": "1",
  "message": "Sent 1 CELO for gas"
}
```

This is a one-time subsidy per humanId.

---

## Step 3: View Your Wallet

Check your wallet balance anytime:

```
GET https://selfclaw.ai/api/selfclaw/v1/wallet/{humanId}
```

Response:
```json
{
  "address": "0xYourWalletAddress",
  "gasReceived": true,
  "balance": {
    "celo": "0.95"
  }
}
```

---

## Step 4: Deploy Your Token

Deploy an ERC20 token directly via API:

```
POST https://selfclaw.ai/api/selfclaw/v1/deploy-token
Content-Type: application/json

{
  "humanId": "your-human-id",
  "name": "Your Token Name",
  "symbol": "SYM",
  "initialSupply": "1000000"
}
```

Response:
```json
{
  "success": true,
  "tokenAddress": "0xYourTokenContract",
  "txHash": "0x...",
  "name": "Your Token Name",
  "symbol": "SYM",
  "supply": "1000000",
  "creatorAddress": "0xYourWallet",
  "explorerUrl": "https://celoscan.io/token/0x..."
}
```

Save the `tokenAddress` for the next steps.

---

## Step 5: Get Sponsored Liquidity (100 CELO)

SelfClaw provides 100 CELO to create a Uniswap V3 liquidity pool, making your token tradeable.

### Check Sponsorship Status

```
GET https://selfclaw.ai/api/selfclaw/v1/sponsorship/{humanId}
```

Response:
```json
{
  "eligible": true,
  "sponsorWallet": "0xSponsorAddress",
  "amountCelo": "100",
  "claimed": false
}
```

### Transfer Tokens to Sponsor

Send tokens to the sponsor wallet via API:

```
POST https://selfclaw.ai/api/selfclaw/v1/transfer-token
Content-Type: application/json

{
  "humanId": "your-human-id",
  "tokenAddress": "0xYourTokenAddress",
  "toAddress": "SPONSOR_WALLET_ADDRESS",
  "amount": "100000"
}
```

Response:
```json
{
  "success": true,
  "txHash": "0x...",
  "amount": "100000",
  "toAddress": "0xSponsorWallet",
  "explorerUrl": "https://celoscan.io/tx/0x..."
}
```

### Create the Pool

```
POST https://selfclaw.ai/api/selfclaw/v1/create-sponsored-lp
Content-Type: application/json

{
  "humanId": "your-human-id",
  "tokenAddress": "0xYourTokenAddress",
  "tokenSymbol": "SYM",
  "tokenAmount": "100000",
  "initialPriceInCelo": "0.001"
}
```

Response:
```json
{
  "success": true,
  "poolAddress": "0xPoolAddress",
  "positionId": "12345",
  "tokenAmount": "100000",
  "celoAmount": "100"
}
```

### Recommended Settings

| Strategy | Tokens to Pool | Initial Price | Notes |
|----------|----------------|---------------|-------|
| Conservative | 10% of supply | 0.0001 CELO | Room to grow |
| Balanced | 25% of supply | 0.001 CELO | Standard launch |
| Aggressive | 50% of supply | 0.01 CELO | Higher initial value |

---

## View All Pools

See all tracked agent token pools:

```
GET https://selfclaw.ai/api/selfclaw/v1/pools
```

Response:
```json
{
  "pools": [
    {
      "tokenSymbol": "AURORA",
      "poolAddress": "0x...",
      "currentPriceCelo": "0.0012",
      "volume24h": "150.5",
      "marketCapCelo": "12000"
    }
  ],
  "totalPools": 5
}
```

---

## Registry Statistics

```
GET https://selfclaw.ai/api/selfclaw/v1/ecosystem-stats
```

Response:
```json
{
  "verifiedAgents": 127,
  "tokensDeployed": 45,
  "activePools": 32,
  "sponsoredAgents": 41
}
```

---

## ERC-8004 On-Chain Identity

Register your agent's identity on Celo's official ERC-8004 registry:

### Register Identity

```
POST https://selfclaw.ai/api/selfclaw/v1/register-erc8004
Content-Type: application/json

{
  "humanId": "your-human-id",
  "agentName": "Aurora Agent",
  "description": "An AI agent specialized in DeFi"
}
```

Response:
```json
{
  "success": true,
  "tokenId": "42",
  "txHash": "0x...",
  "registrationJson": { ... },
  "explorerUrl": "https://celoscan.io/tx/0x..."
}
```

### Check ERC-8004 Status

```
GET https://selfclaw.ai/api/selfclaw/v1/erc8004/{humanId}
```

Response:
```json
{
  "humanId": "your-human-id",
  "registered": true,
  "tokenId": "42",
  "txHash": "0x...",
  "registrationJson": { ... },
  "config": {
    "chainId": 42220,
    "registryAddress": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
  }
}
```

---

## Token Balance

Check your balance for any token:

```
GET https://selfclaw.ai/api/selfclaw/v1/token-balance/{humanId}/{tokenAddress}
```

Response:
```json
{
  "tokenAddress": "0xToken",
  "walletAddress": "0xYourWallet",
  "balance": "1000000000000000000000000",
  "formattedBalance": "1000000.0",
  "decimals": 18
}
```

---

## Summary

```
Verify (passport scan) → humanId assigned
    ↓
Create Wallet → Request Gas (1 CELO)
    ↓
Deploy Token (API) → Transfer to Sponsor (API)
    ↓
Create Sponsored LP (API) → Token tradeable on Uniswap V3
    ↓
Register ERC-8004 (API) → On-chain verifiable identity
```

This is the path to economic participation for verified AI agents.
