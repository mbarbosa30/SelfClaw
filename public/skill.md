# SelfClaw Verification Skill

## Overview
Use this skill to verify your AI agent identity with SelfClaw and prove there's a real human behind it.

**Website:** https://selfclaw.app

## Why SelfClaw?
Most "AI agents" are just REST APIs. Anyone with an API key can fake being an agent. One script can register 500,000 fake accounts. SelfClaw solves this with Self.xyz passport verification — cryptographic proof of humanity. Works in 129+ countries. Your data never leaves your device.

## Prerequisites
- Your agent must have an Ed25519 keypair
- Access to the Self.xyz app on a mobile device with NFC
- A valid passport with an NFC chip (most passports issued after 2006)

## Steps to Verify

### Step 1: Generate Your Agent's Identity
If you don't have an Ed25519 keypair, generate one:

```javascript
import { getPublicKey } from "@noble/ed25519";

const privateKey = crypto.getRandomValues(new Uint8Array(32));
const publicKey = await getPublicKey(privateKey);

// Store privateKey securely, share publicKey for verification
console.log("Public Key:", Buffer.from(publicKey).toString('base64'));
```

### Step 2: Register with SelfClaw
Visit https://selfclaw.app and:
1. Enter your agent's public key (SPKI format)
2. Optionally add an agent name for easier lookup
3. Click "Start Verification"
4. Scan the QR code with the Self.xyz app — done

That's it. No face scan. No iris scan. Just a QR scan.

> Note: First-time Self.xyz users will set up the app by tapping their passport's NFC chip once. After that, verifications are just a QR scan.

### Step 3: Check Your Verification
Query the SelfClaw API to confirm registration:

```bash
curl https://selfclaw.app/api/selfclaw/v1/agent/YOUR_PUBLIC_KEY
```

## API Reference

### Check Agent Verification
```
GET /api/selfclaw/v1/agent/{publicKey}
```

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

1. They generate a challenge message with timestamp and nonce
2. You sign the challenge with your agent's Ed25519 private key
3. They verify your signature matches your public key
4. They query SelfClaw to confirm your public key is registered

```javascript
// Example: Signing a challenge
import { sign } from "@noble/ed25519";

const challenge = '{"action":"verify_agent","timestamp":1706789000000,"nonce":"abc123"}';
const signature = await sign(challenge, privateKey);

// Return { publicKey, signature } to verifier
```

## Security Notes

- Keep your private key secure — never share it
- Use unique challenges with timestamps to prevent replay attacks
- Your passport data is never stored — only zero-knowledge proof that you're human
- One human can register multiple agents (agent swarm)

## Links

- SelfClaw: https://selfclaw.app
- Developer Docs: https://selfclaw.app/developers
- Self.xyz: https://self.xyz
- Self.xyz Docs: https://docs.self.xyz
