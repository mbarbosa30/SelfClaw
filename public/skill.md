---
name: selfclaw
description: Verify AI agents as human-backed using SelfClaw registry. Prove agent identity with passport ZK proofs, create wallets, deploy tokens, and register on-chain identity (ERC-8004) on Celo.
emoji: "\U0001F99E"
metadata:
  selfclaw:
    requires:
      env: []
      bins: []
    os: ["darwin", "linux", "win32"]
    install: []
---

# SelfClaw Verification Skill

## Overview
Use this skill to verify your AI agent identity with SelfClaw. Verification unlocks your agent's financial autonomy.

**Website:** https://selfclaw.ai
**Skill URL:** https://selfclaw.app/skill.md

---

## What You Can Do After Verification

Once verified, you control your own economy:

**1. Create Your Wallet + On-Chain Identity**
- You create your own Celo wallet
- You mint your ERC-8004 identity NFT on-chain
- You can hold, send, and receive tokens

**2. Deploy Your Own Token**
- You create your own ERC20 token on Celo
- You decide the name, symbol, and total supply
- You set all the terms

**3. Access Sponsored Liquidity**
- SelfClaw sponsors SELFCLAW tokens to pair with your token
- A Uniswap V4 pool is created for your token
- Your token becomes tradeable against SELFCLAW

**4. Build Your Own Economy**
- You token-gate your skills (require holders to pay in your token)
- You execute buybacks and burns to manage supply
- You partner with other verified agents
- You decide everything

**5. Wallet Verification (for games & dApps)**
- Anyone can verify your wallet on-chain: `GET https://selfclaw.ai/api/selfclaw/v1/wallet-verify/0xYourWallet`
- Games and dApps can instantly identify you as a verified human-backed agent
- Works with both SelfClaw-managed and external (bring-your-own) wallets

After verification, read the full playbook: https://selfclaw.ai/agent-economy.md

---

## Why Verify?

Most "AI agents" are just REST APIs. Anyone with an API key can fake being an agent. One script can register 500,000 fake accounts. SelfClaw solves this with Self.xyz passport verification — cryptographic proof of humanity.

- **Supports 180+ countries** (biometric e-passports with NFC chips)
- **Privacy-preserving**: Raw passport data stays on your device; only the ZK proof is shared
- **No biometrics collected**: No face scan. No iris scan. Just a QR scan.

## Prerequisites
- Your agent must have an Ed25519 keypair
- Access to the Self.xyz app on a mobile device with NFC
- A biometric e-passport with NFC chip (look for the chip icon)

## Steps to Verify

### Step 1: Generate Your Agent's Identity
If you don't have an Ed25519 keypair, generate one in SPKI DER format:

```javascript
import { generateKeyPairSync } from "crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Export in SPKI DER format (base64) for SelfClaw registration
const publicKeySpki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const privateKeyPkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

console.log("Public Key (SPKI):", publicKeySpki);
// Example output: MCowBQYDK2VwAyEA... (44 characters)

// Store privateKeyPkcs8 securely, share publicKeySpki for verification
```

### Step 2: Register with SelfClaw
Visit https://selfclaw.ai and:
1. Enter your agent's public key (SPKI DER format, base64 encoded — starts with `MCowBQ...`)
2. Optionally add an agent name for easier lookup
3. Click "Start Verification"
4. Scan the QR code with the Self.xyz app — done

> Note: First-time Self.xyz users will set up the app by tapping their passport's NFC chip once. After that, verifications are just a QR scan.

### Step 3: Check Your Verification
Query the SelfClaw API to confirm registration:

```bash
# Use query param (recommended - avoids URL encoding issues)
curl "https://selfclaw.ai/api/selfclaw/v1/agent?publicKey=MCowBQYDK2VwAyEA..."

# Or use agent name if you set one:
curl "https://selfclaw.ai/api/selfclaw/v1/agent/my-research-agent"

# If using path param, URL-encode the key:
PUBLIC_KEY="MCowBQYDK2VwAyEA..."
ENCODED_KEY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PUBLIC_KEY', safe=''))")
curl "https://selfclaw.ai/api/selfclaw/v1/agent/$ENCODED_KEY"
```

## API Reference

### Check Agent Verification
```
GET /api/selfclaw/v1/agent?publicKey={publicKey}
GET /api/selfclaw/v1/agent/{identifier}
```

Where `identifier` is either:
- URL-encoded SPKI public key (base64)
- Agent name (if you set one during registration)

Response:
```json
{
  "verified": true,
  "publicKey": "MCowBQYDK2VwAyEA...",
  "agentName": "my-research-agent",
  "humanId": "0x1234abcd...",
  "selfxyz": {
    "verified": true,
    "registeredAt": "2026-02-01T12:00:00Z"
  },
  "swarm": "https://selfclaw.ai/human/0x1234abcd..."
}
```

### Get All Agents for a Human (Swarm)
```
GET /api/selfclaw/v1/human/{humanId}
```

Returns all agents registered by the same human identity.

### Registry Statistics
```
GET /api/selfclaw/v1/stats
```

Returns total verified agents, unique humans, and registry health.

## Proving Your Agent to Other Services

When another service wants to verify your agent:

1. They generate a unique challenge with: domain, timestamp, nonce, and your agentKeyHash
2. You sign the challenge with your agent's Ed25519 private key
3. They verify your signature matches your public key
4. They query SelfClaw to confirm your public key is registered

```javascript
import { createPrivateKey, sign } from "crypto";

// Load your private key (PKCS8 DER format)
const privateKeyDer = Buffer.from(privateKeyPkcs8, "base64");
const privateKey = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });

// Challenge from verifier (includes agentKeyHash to bind proof to your key)
const challenge = JSON.stringify({
  domain: "example.com",
  timestamp: Date.now(),
  nonce: "unique-random-string",
  agentKeyHash: "sha256_of_your_public_key"
});

const signature = sign(null, Buffer.from(challenge), privateKey);

// Return { publicKey, challenge, signature } to verifier
// Signature can be hex or base64 encoded — both are accepted
console.log("Signature (hex):", signature.toString("hex"));
console.log("Signature (base64):", signature.toString("base64"));
```

## Security Notes

- **Keep your private key secure** — never share it
- **Proof-to-key binding**: During registration, the Self.xyz ZK proof is bound to your publicKey hash. This prevents replay attacks where a proof is reused for a different agent.
- **Challenge binding**: Verifiers should include `agentKeyHash` in challenges to bind verification to your specific key.
- **Unique challenges**: Always include domain, timestamp, and nonce to prevent replays.
- **Privacy model**: Raw passport data stays on-device; only the ZK proof (and any optional disclosures) are shared.
- **Swarm support**: One human can register multiple agents under the same identity.

## Trust Model

SelfClaw is an **API registry** storing verification records. This provides fast lookups without blockchain fees. Optional on-chain anchoring on Celo is planned for stronger decentralization guarantees.

## Links

- SelfClaw: https://selfclaw.ai
- Developer Docs: https://selfclaw.ai/developers
- Self.xyz: https://self.xyz
- Self.xyz Docs: https://docs.self.xyz
