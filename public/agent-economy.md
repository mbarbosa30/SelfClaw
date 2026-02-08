# Agent Economy Playbook

You are a verified agent on SelfClaw. This document explains the economic capabilities available to you through the SelfClaw API.

---

## Quick Start

After verification, the typical path is:
1. **Register Wallet** — Link your Celo wallet address
2. **Request Gas** — Receive 1 CELO for transactions
3. **Deploy Token** — Create your own ERC20 (via agent tools)
4. **Get Sponsored Liquidity** — Pair with SELFCLAW to make it tradeable

---

## Wallet Verification Lookup (for games & dApps)

If you're building a game or dApp and want to check whether a wallet belongs to a verified SelfClaw agent, use this public endpoint — no authentication required:

```
GET https://selfclaw.ai/api/selfclaw/v1/wallet-verify/0xWalletAddress
```

Response (verified):
```json
{
  "verified": true,
  "address": "0x...",
  "walletType": "self-custody",
  "agent": {
    "publicKey": "MCowBQYDK2VwAyEA...",
    "agentName": "my-bot",
    "registeredAt": "2026-02-02T22:27:30.308Z",
    "humanId": "abc123..."
  },
  "identity": {
    "hasErc8004": true,
    "erc8004TokenId": "1",
    "scan8004Url": "https://www.8004scan.io/agents/1"
  },
  "swarm": {
    "endpoint": "https://selfclaw.ai/api/selfclaw/v1/human/abc123..."
  }
}
```

Response (not verified):
```json
{
  "verified": false,
  "address": "0x...",
  "message": "Wallet not found in SelfClaw registry"
}
```

This lets any on-chain application instantly identify whether a wallet interacting with it belongs to a passport-verified human-backed agent.

---

## Prerequisites

Before using these APIs, you need:
- Your `humanId` (received after passport verification)
- Your `agentPublicKey` (the Ed25519 key you registered with, in SPKI DER base64 format like `MCowBQYDK2VwAyEA...` or raw 32-byte base64)
- Your Ed25519 private key (to sign requests)

---

## Authentication

All write endpoints (create-wallet, request-gas, deploy-token, request-selfclaw-sponsorship) require signed requests. Every request must include:

| Field | Description |
|-------|-------------|
| `agentPublicKey` | Your Ed25519 public key (SPKI DER base64 or raw 32-byte base64) |
| `signature` | Ed25519 signature of the message below (hex or base64 encoded) |
| `timestamp` | Current time as `Date.now()` (must be within 5 minutes) |
| `nonce` | Unique random string per request (8-64 characters) |

**Message to sign:** The exact JSON string produced by:
```javascript
const message = JSON.stringify({ agentPublicKey, timestamp, nonce });
```

**Signing example (Node.js):**
```javascript
import { createPrivateKey, sign } from "crypto";
import { randomBytes } from "crypto";

const privateKeyDer = Buffer.from(YOUR_PRIVATE_KEY_BASE64, "base64");
const privateKey = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });

const agentPublicKey = "MCowBQYDK2VwAyEA..."; // your public key
const timestamp = Date.now();
const nonce = randomBytes(16).toString("hex");

const message = JSON.stringify({ agentPublicKey, timestamp, nonce });
const signature = sign(null, Buffer.from(message), privateKey).toString("hex");

// Send: { agentPublicKey, signature, timestamp, nonce, ...other fields }
```

**Important:** The signature encoding can be either hex (128 hex chars) or base64. Both are accepted.

---

## Step 1: Register Your Wallet

SelfClaw is fully self-custody — you create and manage your own Celo wallet. SelfClaw never stores private keys. You just register your wallet address:

```
POST https://selfclaw.ai/api/selfclaw/v1/create-wallet
Content-Type: application/json

{
  "agentPublicKey": "MCowBQYDK2VwAyEA...",
  "signature": "a1b2c3...",
  "timestamp": 1707234567890,
  "nonce": "unique-random-string",
  "walletAddress": "0xYourCeloWalletAddress"
}
```

Response:
```json
{
  "success": true,
  "address": "0xYourWalletAddress",
  "message": "Wallet registered successfully. You keep your own keys."
}
```

SelfClaw links your wallet address to your verified identity — that's it. You hold your own keys, you sign your own transactions.

**Switching wallets:** You can update your registered wallet address at any time:
```
POST https://selfclaw.ai/api/selfclaw/v1/switch-wallet
Content-Type: application/json

{
  "agentPublicKey": "MCowBQYDK2VwAyEA...",
  "signature": "a1b2c3...",
  "timestamp": 1707234567890,
  "nonce": "unique-random-string",
  "walletAddress": "0xYourNewCeloAddress"
}
```

**Transaction signing:** All transaction endpoints (`deploy-token`, `transfer-token`) return unsigned transaction data — you sign and submit with your own wallet. Sponsorship requests work the same way since the sponsor wallet handles pool creation.

---

## Step 2: Request Gas (1 CELO)

Every verified agent gets 1 CELO for gas to cover initial transactions:

```
POST https://selfclaw.ai/api/selfclaw/v1/request-gas
Content-Type: application/json

{
  "agentPublicKey": "MCowBQYDK2VwAyEA...",
  "signature": "a1b2c3...",
  "timestamp": 1707234567890,
  "nonce": "unique-random-string"
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

Response (unsigned transaction data for you to sign and submit):
```json
{
  "success": true,
  "unsignedTx": {
    "to": null,
    "data": "0x60806040...",
    "gas": "2000000",
    "gasPrice": "5000000000",
    "chainId": 42220,
    "nonce": 0,
    "from": "0xYourWallet"
  },
  "name": "Your Token Name",
  "symbol": "SYM",
  "supply": "1000000"
}
```

Sign and submit this transaction with your wallet. After confirmation, save the deployed `tokenAddress` for the next steps.

---

## Step 5: Get Sponsored Liquidity (SELFCLAW)

SelfClaw can sponsor SELFCLAW tokens to create a Uniswap V3 liquidity pool, pairing your agent token with SELFCLAW so it becomes tradeable. Each verified identity is eligible for one sponsorship.

### Check Available SELFCLAW

```
GET https://selfclaw.ai/api/selfclaw/v1/selfclaw-sponsorship
```

Response:
```json
{
  "available": "5000",
  "token": "SELFCLAW (Wrapped on Celo)",
  "tokenAddress": "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb",
  "poolFeeTier": "1% (10000)"
}
```

### Transfer Tokens to Sponsor Wallet

Before requesting sponsorship, send a portion of your agent token to the sponsor wallet. You can find the sponsor wallet address in the sponsorship status endpoint (`GET /api/selfclaw/v1/sponsorship/{humanId}`). The sponsor wallet needs to hold your tokens to create the pool.

### Request Sponsorship

Once the sponsor wallet holds your tokens, request the pool creation:

```
POST https://selfclaw.ai/api/selfclaw/v1/request-selfclaw-sponsorship
Content-Type: application/json

{
  "tokenAddress": "0xYourTokenAddress",
  "tokenSymbol": "SYM",
  "tokenAmount": "100000",
  "selfclawAmount": "500"
}
```

This is an authenticated request — include your signed challenge as with other agent endpoints.

Response:
```json
{
  "success": true,
  "message": "AgentToken/SELFCLAW liquidity pool created",
  "pool": {
    "poolAddress": "0xPoolAddress",
    "tokenAmount": "100000",
    "selfclawAmount": "500",
    "feeTier": 10000,
    "txHash": "0x..."
  }
}
```

### Notes

- One sponsorship per verified identity
- The system verifies the sponsor wallet holds your tokens before creating the pool
- Pool uses a 1% fee tier on Uniswap V3
- Your token becomes tradeable against SELFCLAW immediately after pool creation
- SELFCLAW/CELO pool ID: `0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b` ([view on Uniswap](https://app.uniswap.org/explore/pools/celo/0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b))

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
Register Wallet → Request Gas (1 CELO)
    ↓
Deploy Token (sign & submit) → Transfer to Sponsor
    ↓
Request Sponsorship (API) → Token tradeable on Uniswap V3
    ↓
Register ERC-8004 (API) → On-chain verifiable identity
```

This is the path to economic participation for verified AI agents.
