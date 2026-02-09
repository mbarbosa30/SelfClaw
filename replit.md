# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry built on the Celo blockchain, leveraging Self.xyz passport proofs. Its primary purpose is to enable AI agent owners to securely link their agents to verified human identities, effectively combating sybil attacks within agent economies. User privacy is maintained through zero-knowledge proofs derived from passport NFC chips. Key capabilities include an Agent Verification API, zero-knowledge proofs for trustless verification, swarm tracking for multiple agents per human identity, and deep integration with the Celo network for agent wallets, ERC20 token deployment, and on-chain identity using ERC-8004. The project envisions creating a robust, verifiable foundation for autonomous agent economies.

**Nav Gating**: AGENTS and DASHBOARD nav links are hidden across all pages until there are 3+ agents with deployed tokens (tokensDeployed from /v1/stats). This is controlled by `public/nav-gate.js` using `data-gate` attributes.

## Design System (February 2026)
- **Aesthetic**: Light brutalist-minimal hybrid
- **Colors**: Background #f2f0ec, text #1a1a1a, accent #FF6B4A, borders #d4d0ca (light) / #1a1a1a (heavy)
- **Typography**: Inter (sans-serif body), IBM Plex Mono (accents/labels/code)
- **Borders**: Hard 2px borders, no border-radius, no shadows
- **Container**: 960px max-width
- **Navigation**: SELFCLAW | VERIFY | AGENTS(gated) | DASHBOARD(gated) | ECONOMY | DOCS | WHITEPAPER

## User Preferences
- Light brutalist-minimal UI design
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
server/                 # Backend services and API
  index.ts              # Express server entry point
  selfclaw.ts           # Core verification API
  self-auth.ts          # Self.xyz authentication
lib/                    # Utility libraries and blockchain interactions
  erc8004.ts            # ERC-8004 on-chain identity
  secure-wallet.ts      # Celo wallet management
  token-factory.ts      # ERC20 token deployment
  uniswap-v3.ts         # Uniswap V3 integration
  wormhole-bridge.ts    # Wormhole cross-chain bridge
shared/
  schema.ts             # Drizzle database schema
public/                 # Frontend assets
  styles.css            # Global design system
  index.html            # Landing page
  verify.html           # Agent verification flow
  token.html            # Agent economy (served at /economy)
  whitepaper.html       # Token whitepaper
  developers.html       # API documentation
  registry.html         # Verified agents listing
  agent.html            # Individual agent profile
  dashboard.html        # Network stats dashboard
  admin.html            # Admin dashboard
  app.js                # Shared frontend JS
  nav-gate.js           # Nav gating logic
```

### Routes & Redirects
- Active routes: /, /verify, /economy, /developers, /whitepaper, /dashboard, /registry, /agents, /agent/:name, /human/:humanId, /admin
- Redirects: /token -> /economy, /how-it-works -> /, /pricing -> /, /technology -> /, /vision -> /, /docs -> /developers

### Key API Endpoints
- `POST /api/selfclaw/v1/start-verification` — Initiate agent verification.
- `POST /api/selfclaw/v1/sign-challenge` — Sign challenge for programmatic verification.
- `GET /api/selfclaw/v1/verification-status/{sessionId}` — Poll verification status.
- `GET /api/selfclaw/v1/agent/{identifier}` — Check agent verification status.
- `GET /api/selfclaw/v1/agents` — List all agents with enriched data.
- `GET /api/selfclaw/v1/human/{humanId}` — Retrieve all agents for a given human (swarm).
- `POST /api/selfclaw/v1/create-wallet` — Register agent's self-custody Celo wallet address.
- `POST /api/selfclaw/v1/token-plan` — Submit tokenomics plan.
- `POST /api/selfclaw/v1/deploy-token` — Get unsigned ERC20 token deployment transaction.
- `POST /api/selfclaw/v1/register-token` — Register deployed token address.
- `POST /api/selfclaw/v1/request-selfclaw-sponsorship` — Request SELFCLAW sponsorship for liquidity.
- `GET /api/selfclaw/v1/pools` — View all tracked agent token pools.
- `POST /api/selfclaw/v1/log-revenue` — Log a revenue event.
- `POST /api/selfclaw/v1/services` — List a new service.
- `GET /.well-known/agent-registration.json` — Agent registration discovery.

## External Dependencies
- **Self.xyz SDK**: For passport-based verification via QR code and ZK proofs.
- **Celo Network**: For on-chain identity (ERC-8004), wallets, and token deployment.
- **Uniswap V3**: For pool creation, fee collection, and sponsored liquidity on Celo.
- **Drizzle ORM**: Used for database schema definition and queries with PostgreSQL.
- **Express.js**: The core web framework for building the backend API.
