# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry built on the Celo blockchain, utilizing Self.xyz passport proofs. It enables AI agent owners to securely link their agents to verified human identities, combating sybil attacks in agent economies. User privacy is ensured through zero-knowledge proofs derived from passport NFC chips.

**Key Capabilities:**
- **Agent Verification API**: Endpoints for registering and verifying agents against human identities
- **Zero-Knowledge Proofs**: Self.xyz for privacy-centric, NFC-based passport verification
- **Swarm Tracking**: Multiple agents linked to a single verified human identity
- **Celo Integration**: Agent wallets, ERC20 token deployment, ERC-8004 on-chain identity, sponsored liquidity
- **Trustless Verification**: ZK proof data stored and retrievable for independent verification

## User Preferences
- Minimalist/brutalist UI design
- Security through environment secrets for API keys
- Web-based verification flow

## System Architecture

### Stack
- **Runtime**: Node.js 22+ with TypeScript (tsx)
- **Backend**: Express.js (server/index.ts) running on port 5000
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Self.xyz passport-only (QR code verification)
- **Frontend**: Vanilla HTML/CSS/JS (public/)
- **Blockchain**: Celo network, ERC-8004 for agent identity NFTs

### Project Structure
```
server/
  index.ts              # Express server, routes, middleware
  selfclaw.ts           # Core verification API (/api/selfclaw/v1/*)
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
  dashboard.html        # Public performance dashboard
  developers.html       # API documentation
  skill.md              # Agent-readable skill definition
```

### Key API Endpoints
- `POST /api/selfclaw/v1/start-verification` — Initiate agent verification
- `GET /api/selfclaw/v1/agent/{identifier}` — Check agent verification status
- `GET /api/selfclaw/v1/stats` — Registry statistics
- `GET /api/selfclaw/v1/dashboard` — Comprehensive dashboard data
- `GET /api/selfclaw/v1/human/{humanId}` — All agents for a human (swarm)
- `GET /api/selfclaw/v1/wallet-verify/{address}` — Public wallet verification lookup
- `POST /api/selfclaw/v1/create-wallet` — Create Celo wallet for verified agent
- `POST /api/selfclaw/v1/deploy-token` — Deploy ERC20 token
- `GET /.well-known/agent-registration.json` — Agent registration discovery
- `GET /api/erc8004/config` — On-chain identity configuration

## External Dependencies
- **Self.xyz SDK**: Passport-based verification via QR code and ZK proofs
- **Celo Network**: On-chain identity (ERC-8004) via `@chaoschain/sdk`, wallets, token deployment
- **Drizzle ORM**: Database schema and queries
- **Express.js**: HTTP server and API routing

## Recent Changes
- 2026-02-07: Added Vision page (/vision) — comprehensive agent economy manifesto covering $SELFCLAW token, agent-owned tokens, permanent liquidity, autonomous commerce, DAOs, skill marketplace, business models, and trust infrastructure
- 2026-02-07: Added public performance dashboard with activity logging, charts, and auto-refresh
- 2026-02-07: Added wallet verification lookup endpoint for games/dApps
- 2026-02-06: Removed ClawPit cockpit feature for open-source release
- 2026-02-06: Rebranded from OpenClaw to SelfClaw
- 2026-02-06: Added MIT license, contributing guide, .env.example
- 2026-02-06: Cleaned debug logging, extracted constants
