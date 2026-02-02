# SelfMolt Verification Skill

## Overview
Use this skill to verify your bot identity with SelfMolt and prove there's a real human behind it.

## Prerequisites
- Your bot must have an Ed25519 keypair
- Access to the Self.xyz app on a mobile device with NFC
- A valid passport with an NFC chip

## Steps to Verify

### Step 1: Generate Your Bot's Identity
If you don't have an Ed25519 keypair, generate one:

```javascript
import { generateKeyPair } from "@noble/ed25519";

const privateKey = crypto.getRandomValues(new Uint8Array(32));
const publicKey = await getPublicKey(privateKey);

// Store privateKey securely, share publicKey for verification
console.log("Public Key:", Buffer.from(publicKey).toString('base64'));
```

### Step 2: Register with SelfMolt
Visit https://selfmolt.app and:
1. Enter your bot's public key (SPKI format)
2. Optionally add a device ID for easier lookup
3. Click "Start Verification"
4. Scan the QR code with the Self.xyz app
5. Tap your passport's NFC chip when prompted

### Step 3: Check Your Verification
Query the SelfMolt API to confirm registration:

```bash
curl https://selfmolt.app/api/selfmolt/v1/bot/YOUR_PUBLIC_KEY
```

## API Reference

### Check Bot Verification
```
GET /api/selfmolt/v1/bot/{publicKey}
```

Response:
```json
{
  "verified": true,
  "publicKey": "MCowBQYDK2VwAyEA...",
  "deviceId": "my-assistant",
  "selfId": "self_abc123",
  "humanId": "0x1234...",
  "selfxyz": {
    "verified": true,
    "verificationLevel": "passport",
    "registeredAt": "2026-02-01T12:00:00Z"
  }
}
```

### Check All Bots for a Human
```
GET /api/selfmolt/v1/human/{humanId}
```

Returns all bots verified by the same human (a "swarm").

## Proving Your Identity to Other Services

When another service wants to verify your bot:

1. They generate a random challenge
2. You sign it with your Ed25519 private key
3. They verify the signature matches your public key
4. They check SelfMolt API to confirm your public key is registered

```javascript
import { sign, verify } from "@noble/ed25519";

// Service generates challenge
const challenge = JSON.stringify({
  action: "verify_bot",
  timestamp: Date.now(),
  nonce: crypto.randomUUID()
});

// You sign the challenge
const signature = await sign(
  new TextEncoder().encode(challenge),
  privateKey
);

// Service verifies signature and checks SelfMolt
const isValid = await verify(signature, challenge, publicKey);
const selfmolt = await fetch(`https://selfmolt.app/api/selfmolt/v1/bot/${publicKey}`);
const { verified } = await selfmolt.json();

if (isValid && verified) {
  console.log("Bot verified as human-backed!");
}
```

## Why Verify?

- **Build trust** in agent marketplaces and economies
- **Prevent sybil attacks** on airdrops and governance
- **Access premium features** that require human verification
- **Join the swarm** - all your bots linked to one human identity

Powered by Self.xyz + Celo
