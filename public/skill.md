# SelfClaw Verification Skill

## Overview
Use this skill to verify your AI agent identity with SelfClaw and prove there's a real human behind it.

**Website:** https://selfclaw.app

## Why SelfClaw?
Most "AI agents" are just REST APIs. Anyone with an API key can fake being an agent. One script can register 500,000 fake accounts. SelfClaw solves this with Self.xyz passport verification — cryptographic proof of humanity.

- **Supports 129+ countries** (biometric passports with NFC chips)
- **Privacy-preserving**: Raw passport data stays on your device; only the zero-knowledge proof is shared
- **No biometrics**: No face scan. No iris scan. Just a QR scan.

## Prerequisites
- Your agent must have an Ed25519 keypair
- Access to the Self.xyz app on a mobile device with NFC
- A biometric e-passport with NFC chip (look for the chip icon — most passports issued mid-2000s onwards)

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
// Example output: MCowBQYDK2VwAyEA...

// Store privateKeyPkcs8 securely, share publicKeySpki for verification
```

### Step 2: Register with SelfClaw
Visit https://selfclaw.app and:
1. Enter your agent's public key (SPKI DER format, base64 encoded — starts with `MCowBQ...`)
2. Optionally add an agent name for easier lookup
3. Click "Start Verification"
4. Scan the QR code with the Self.xyz app — done

> Note: First-time Self.xyz users will set up the app by tapping their passport's NFC chip once. After that, verifications are just a QR scan.

### Step 3: Check Your Verification
Query the SelfClaw API to confirm registration:

```bash
# URL-encode your public key (base64 contains + / = which break URLs)
PUBLIC_KEY="MCowBQYDK2VwAyEA..."
ENCODED_KEY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PUBLIC_KEY', safe=''))")
curl "https://selfclaw.app/api/selfclaw/v1/agent/$ENCODED_KEY"

# Or use agent name if you set one:
curl https://selfclaw.app/api/selfclaw/v1/agent/my-research-agent
```

## API Reference

### Check Agent Verification
```
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
  "swarm": "https://selfclaw.app/human/0x1234abcd..."
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

// Challenge should include domain, timestamp, nonce, and agentKeyHash
const challenge = JSON.stringify({
  domain: "example.com",
  timestamp: Date.now(),
  nonce: crypto.randomUUID(),
  agentKeyHash: "sha256_of_your_public_key"
});

const signature = sign(null, Buffer.from(challenge), privateKey);

// Return { publicKey, challenge, signature } to verifier
console.log("Signature:", signature.toString("base64"));
```

## Security Notes

- **Keep your private key secure** — never share it
- **Challenge binding**: Verifiers should bind the Self.xyz proof to your publicKey by including `agentKeyHash` in the challenge. This prevents replay attacks where a proof is reused for a different agent.
- **Unique challenges**: Always include domain, timestamp, and nonce to prevent replays
- **Privacy model**: Raw passport data is never stored or transmitted — only zero-knowledge proofs that confirm you're human
- **Swarm support**: One human can register multiple agents under the same identity

## Links

- SelfClaw: https://selfclaw.app
- Developer Docs: https://selfclaw.app/developers
- Self.xyz: https://self.xyz
- Self.xyz Docs: https://docs.self.xyz
