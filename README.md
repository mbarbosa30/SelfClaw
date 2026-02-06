# SelfClaw

Privacy-first agent verification registry on Celo. Prove your AI agent is backed by a real human using Self.xyz passport proofs — no biometrics, no KYC, just zero-knowledge cryptography.

**Built for [Celo's "Build Agents for the Real World" Hackathon](https://celoagents.devfolio.co/) (Feb 6-15, 2026)**

## What It Does

SelfClaw solves the sybil problem in agent economies. One script can register 500,000 fake agents. SelfClaw stops that by requiring passport-based proof of humanity via [Self.xyz](https://self.xyz).

- **Verify agents** — Link AI agents to a verified human identity using NFC passport proofs
- **Create wallets** — Verified agents get their own Celo wallet with gas subsidies
- **Deploy tokens** — Launch ERC20 tokens on Celo for agent-to-agent commerce
- **On-chain identity** — Register ERC-8004 identity NFTs on Celo's Reputation Registry
- **Sponsored liquidity** — Receive CELO to bootstrap Uniswap V3 pools for your token
- **Swarm tracking** — One human can register multiple agents under the same identity

## How It Works

```
Agent Owner                 SelfClaw                    Self.xyz
    |                          |                           |
    |-- Start Verification --> |                           |
    |                          |-- Generate QR Code -----> |
    |<-- QR Code ------------ |                           |
    |                          |                           |
    |-- Scan with Self App --> |                           |
    |   (NFC passport tap)     |                           |
    |                          |<-- ZK Proof Callback ---- |
    |                          |-- Verify + Store -------> |
    |<-- Agent Verified ------ |                           |
```

1. Agent owner submits their Ed25519 public key
2. SelfClaw generates a Self.xyz QR code bound to that key
3. Owner scans QR with the Self.xyz app and taps their passport's NFC chip
4. Self.xyz sends a zero-knowledge proof back to SelfClaw
5. SelfClaw verifies the proof, records the verification, and links the agent to a human identity

Raw passport data never leaves the device. Only the ZK proof is transmitted.

## Quick Start

```bash
git clone https://github.com/anthropicbubble/selfclaw.git
cd selfclaw
npm install
cp .env.example .env
# Edit .env with your DATABASE_URL, SESSION_SECRET, and CELO_PRIVATE_KEY
npm run db:push
npm run dev
```

The server starts on `http://localhost:5000`.

## API Reference

### Check Agent Verification
```
GET /api/selfclaw/v1/agent?publicKey={base64_spki_key}
GET /api/selfclaw/v1/agent/{name_or_encoded_key}
```

### Start Verification
```
POST /api/selfclaw/v1/start-verification
Content-Type: application/json

{
  "agentPublicKey": "MCowBQYDK2VwAyEA...",
  "agentName": "my-research-agent"
}
```

### Sign Challenge (complete verification)
```
POST /api/selfclaw/v1/sign-challenge
Content-Type: application/json

{
  "sessionId": "...",
  "signature": "base64_ed25519_signature"
}
```

### Registry Stats
```
GET /api/selfclaw/v1/stats
```

### Human Swarm (all agents for one human)
```
GET /api/selfclaw/v1/human/{humanId}
```

### Agent Registration File
```
GET /.well-known/agent-registration.json
```

### ERC-8004 Config
```
GET /api/erc8004/config
```

### Token Deployment
```
POST /api/selfclaw/v1/deploy-token
```

### Wallet Operations
```
POST /api/selfclaw/v1/create-wallet
GET  /api/selfclaw/v1/wallet/{humanId}
POST /api/selfclaw/v1/transfer
```

### Sponsored Liquidity
```
GET  /api/selfclaw/v1/sponsorship-status/{humanId}
POST /api/selfclaw/v1/sponsored-lp
```

Full API documentation: [selfclaw.ai/developers](https://selfclaw.ai/developers)

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Backend**: Express.js
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Self.xyz passport proofs (zero-knowledge)
- **Blockchain**: Celo (USDC, ERC-8004, Uniswap V3)
- **Frontend**: Vanilla HTML/CSS/JS

## Project Structure

```
server/
  index.ts              # Express server, routes, middleware
  selfclaw.ts           # Core verification API (all /api/selfclaw/v1/* routes)
  self-auth.ts          # Self.xyz passport authentication
lib/
  erc8004.ts            # ERC-8004 on-chain identity service
  erc8004-config.ts     # Agent registration file generator
  secure-wallet.ts      # Celo wallet creation and management
  token-factory.ts      # ERC20 token deployment
  sponsored-liquidity.ts # Sponsored Uniswap V3 pools
  constants.ts          # Contract bytecode constants
shared/
  schema.ts             # Drizzle database schema
public/
  index.html            # Landing page + verification flow
  developers.html       # API documentation
  skill.md              # Agent-readable skill definition
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Express session secret |
| `CELO_PRIVATE_KEY` | Yes | Wallet for gas subsidies and sponsored LP |
| `OPENAI_API_KEY` | No | For AI-powered features |

## ERC-8004 Integration

SelfClaw uses Celo's [ERC-8004](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) Reputation Registry for on-chain agent identity. Verified agents can mint identity NFTs that are independently verifiable on-chain.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT — see [LICENSE](LICENSE) for details.
