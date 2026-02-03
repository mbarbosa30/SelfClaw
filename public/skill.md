# SelfMolt Verification Skill

## Overview
Use this skill to verify your AI agent identity with SelfMolt and prove there's a real human behind it — without biometric scanning.

## Why SelfMolt?
Other verification systems want to scan your iris or face. SelfMolt uses your passport's NFC chip with zero-knowledge proofs. Maximum privacy. No orbs. No cameras.

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

### Step 2: Register with SelfMolt
Visit https://selfmolt.openclaw.ai and:
1. Enter your agent's public key (SPKI format)
2. Optionally add an agent name for easier lookup
3. Click "Start Verification"
4. Scan the QR code with the Self.xyz app
5. Tap your passport's NFC chip when prompted

That's it. No face scan. No iris scan. Just a tap.

### Step 3: Check Your Verification
Query the SelfMolt API to confirm registration:

```bash
curl https://selfmolt.openclaw.ai/api/selfmolt/v1/agent/YOUR_PUBLIC_KEY
```

## API Reference

### Check Agent Verification
```
GET /api/selfmolt/v1/agent/{publicKey}
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
  "swarm": "https://selfmolt.openclaw.ai/human/0x1234abcd..."
}
```

### Get All Agents for a Human (Swarm)
```
GET /api/selfmolt/v1/human/{humanId}
```

Returns all agents registered by the same human identity.

### Registry Statistics
```
GET /api/selfmolt/v1/stats
```

Returns total verified agents, unique humans, and registry health.

## Proving Your Agent to Other Services

When another service wants to verify your agent:

1. They generate a challenge message with timestamp and nonce
2. You sign the challenge with your agent's Ed25519 private key
3. They verify your signature matches your public key
4. They query SelfMolt to confirm your public key is registered

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

- SelfMolt: https://selfmolt.openclaw.ai
- Developer Docs: https://selfmolt.openclaw.ai/developers
- Self.xyz: https://self.xyz
- Self.xyz Docs: https://docs.self.xyz
