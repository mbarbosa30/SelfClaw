# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry built on EVM chains (starting with Celo), leveraging Self.xyz passport proofs. Its primary purpose is to enable AI agent owners to securely link their agents to verified human identities, effectively combating sybil attacks within agent economies. User privacy is maintained through zero-knowledge proofs derived from passport NFC chips. Key capabilities include an Agent Verification API, zero-knowledge proofs for trustless verification, swarm tracking for multiple agents per human identity, and deep integration with EVM chains for agent wallets, ERC20 token deployment, and on-chain identity using ERC-8004. The project envisions creating a robust, verifiable foundation for autonomous agent economies.

**Nav Gating**: AGENTS and DASHBOARD nav links are hidden across all pages until there are 3+ agents with deployed tokens (tokensDeployed from /v1/stats). This is controlled by `public/nav-gate.js` using `data-gate` attributes.

## Design System (February 2026)
- **Aesthetic**: Light brutalist-minimal hybrid
- **Colors**: Background #f2f0ec, text #1a1a1a, accent #FF6B4A, borders #d4d0ca (light) / #1a1a1a (heavy)
- **Typography**: Inter (sans-serif body), IBM Plex Mono (accents/labels/code)
- **Borders**: Hard 2px borders, no border-radius, no shadows
- **Container**: 1080px max-width (profile 800px, whitepaper 860px, docs 960px)
- **Responsive**: Breakpoints at 1024px (grids → 2-col), 768px (grids → 1-col, hamburger nav), 480px (tighter padding)
- **Navigation**: SELFCLAW | VERIFY | AGENTS(gated) | DASHBOARD(gated) | ECONOMY | DOCS | GUIDE | WHITEPAPER | \\\ | LOGIN/[humanId] — hamburger menu on mobile via nav-toggle.js

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
- **Blockchain**: Celo & Base (EVM-compatible chains), ERC-8004 for agent identity NFTs

### Project Structure
```
server/                 # Backend services and API
  index.ts              # Express server entry point
  selfclaw.ts           # Core verification API
  self-auth.ts          # Self.xyz authentication
lib/                    # Utility libraries and blockchain interactions
  constants.ts          # Contract bytecode constants
  erc8004.ts            # ERC-8004 on-chain identity
  erc8004-config.ts     # ERC-8004 configuration
  secure-wallet.ts      # EVM wallet management
  sponsored-liquidity.ts # Liquidity sponsorship logic
  uniswap-v3.ts         # Uniswap V3 integration
  uniswap-v4.ts         # Uniswap V4 integration
  wormhole-bridge.ts    # Wormhole cross-chain bridge
shared/
  schema.ts             # Drizzle database schema
public/                 # Frontend assets
  styles.css            # Global design system
  index.html            # Landing page
  verify.html           # Agent verification flow
  token.html            # Agent economy (served at /economy)
  whitepaper.html       # Token whitepaper
  manifesto.html        # \\\ brand philosophy page
  guide.html            # Getting started guide (step-by-step for hackathon participants)
  developers.html       # API documentation
  registry.html         # Verified agents listing
  agent.html            # Individual agent profile (with economics)
  dashboard.html        # Network stats dashboard
  my-agents.html        # Human's agent dashboard with economics
  create-agent.html     # One-click agent creation wizard
  admin.html            # Admin dashboard
  app.js                # Shared frontend JS
  auth.js               # Shared login/logout (Self.xyz QR modal)
  nav-gate.js           # Nav gating logic
  nav-toggle.js         # Mobile hamburger menu toggle
```

### Routes & Redirects
- Active routes: /, /verify, /create-agent, /economy, /developers, /guide, /whitepaper, /manifesto, /dashboard, /registry, /agents, /agent/:name, /human/:humanId, /my-agents, /admin, /explorer
- Redirects: /token -> /economy, /how-it-works -> /, /pricing -> /, /technology -> /, /vision -> /, /docs -> /developers

### Key API Endpoints
- `POST /api/selfclaw/v1/create-agent` — One-click agent creation (requires login, generates keypair, registers agent, optional Hostinger VPS deploy).
- `POST /api/selfclaw/v1/start-verification` — Initiate agent verification.
- `POST /api/selfclaw/v1/sign-challenge` — Sign challenge for programmatic verification.
- `GET /api/selfclaw/v1/verification-status/{sessionId}` — Poll verification status.
- `GET /api/selfclaw/v1/agent/{identifier}` — Check agent verification status.
- `GET /api/selfclaw/v1/agents` — List all agents with enriched data.
- `GET /api/selfclaw/v1/human/{humanId}` — Retrieve all agents for a given human (swarm).
- `POST /api/selfclaw/v1/create-wallet` — Register agent's self-custody EVM wallet address.
- `POST /api/selfclaw/v1/token-plan` — Submit tokenomics plan.
- `POST /api/selfclaw/v1/deploy-token` — Get unsigned ERC20 token deployment transaction.
- `POST /api/selfclaw/v1/register-token` — Register deployed token address.
- `POST /api/selfclaw/v1/request-selfclaw-sponsorship` — Request SELFCLAW sponsorship for liquidity.
- `GET /api/selfclaw/v1/selfclaw-sponsorship` — Check SELFCLAW availability, price, peer stats, pricing formula, simulator link.
- `GET /api/selfclaw/v1/sponsorship-simulator` — Model token launch scenarios (accepts totalSupply, liquidityTokens; returns projected price, market cap, peer comparison, alternative scenarios).
- `GET /api/selfclaw/v1/pools` — View all tracked agent token pools.
- `POST /api/selfclaw/v1/log-revenue` — Log a revenue event.
- `POST /api/selfclaw/v1/log-cost` — Log a cost event (infra, compute, ai_credits, etc.).
- `GET /api/selfclaw/v1/agent/{identifier}/economics` — Agent economics summary (revenue, costs, P/L, runway).
- `POST /api/selfclaw/v1/agent/{identifier}/fund-alert` — Agent requests funding from human owner.
- `GET /api/selfclaw/v1/human/{humanId}/economics` — All agents economics overview for a human (includes sponsorship status per agent).
- `POST /api/selfclaw/v1/services` — List a new service.
- `GET /.well-known/agent-registration.json` — Agent registration discovery.
- `POST /api/selfclaw/v1/my-agents/{publicKey}/setup-wallet` — Dashboard: generate EVM wallet (session auth, returns private key once).
- `POST /api/selfclaw/v1/my-agents/{publicKey}/request-gas` — Dashboard: request gas subsidy (session auth).
- `POST /api/selfclaw/v1/my-agents/{publicKey}/deploy-token` — Dashboard: get unsigned token deploy tx (session auth).
- `POST /api/selfclaw/v1/my-agents/{publicKey}/register-token` — Dashboard: register deployed token (session auth).
- `POST /api/selfclaw/v1/my-agents/{publicKey}/request-sponsorship` — Dashboard: request sponsorship + auto pool (session auth).

### Wallet Architecture (Feb 2026)
- **Per-agent wallets**: Each agent has its own wallet row in `agent_wallets`, keyed by `publicKey` (unique). A human with multiple agents can have multiple wallets.
- **Gas subsidy**: Scoped per-agent (not per-human). Each agent can request gas independently. Gas request also auto-registers ERC-8004 on-chain identity if not already minted.
- **Sponsorship**: Still one sponsorship per human (sybil protection) — `sponsored_agents.humanId` remains unique.
- **Wallet lookup**: `/v1/wallet/:identifier` accepts either agentPublicKey (exact match) or humanId (returns all wallets for that human if multiple exist).
- **Self-custody**: Platform never stores private keys. Only wallet addresses are registered.

### Price Oracle (Feb 2026)
- **Price chain**: AgentToken → SELFCLAW (V4 pool) → CELO (V4 pool 0x92bf22...) → USD (V3 pool CELO/USDT 0x6cde5f...)
- **Reference pools**: SELFCLAW/CELO V4 pool, SELFCLAW/USDT V4 pool, CELO/USDT V3 pool
- **Caching**: 60s TTL for reference prices (CELO/USD, SELFCLAW/CELO)
- **Snapshots**: Background job every 5 min saves price history to `token_price_snapshots` table
- **API endpoints**: `/v1/prices/reference`, `/v1/agent/:id/price`, `/v1/agent/:id/price-history`, `/v1/agent/:id/reputation`, `/v1/prices/all-agents`
- **Frontend**: Agent profile shows live USD price, market cap, sparkline SVG chart with period selector (1H/24H/7D/30D), ERC-8004 on-chain identity + reputation score

### Uniswap V4 Migration (Feb 2026)
- **New agent token pools use Uniswap V4** (singleton PoolManager + Permit2 approvals). Existing SELFCLAW/CELO pool remains on V3 for price feeds.
- **V4 Celo contracts** (verified from official Celo docs):
  - PoolManager: `0x288dc841A52FCA2707c6947B3A777c5E56cd87BC`
  - PositionManager: `0xf7965f3981e4d5bc383bfbcb61501763e9068ca9`
  - StateView: `0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb`
  - UniversalRouter: `0xcb695bc5d3aa22cad1e6df07801b061a05a0233a`
  - Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- **Position tracking**: V4 positions are NFTs but not enumerable on-chain. Position token IDs are stored in `sponsored_agents.v4_position_token_id` and `tracked_pools.v4_position_token_id` for fee collection.
- **Dual fee collection**: Admin endpoints support both V3 (`/admin/v3/collect-all-fees`) and V4 (`/admin/v4/collect-all-fees`), plus combined (`/admin/collect-all-fees`).
- **Pool identification**: V4 pools use `poolId` (keccak256 of pool key) instead of deployed contract addresses. Stored in `tracked_pools.v4_pool_id`.
- **Sponsorship flow**: Still collects V3 fees first (for SELFCLAW accrual), then creates V4 pool via `createPoolAndAddLiquidity()`.

## External Dependencies
- **Self.xyz SDK**: For passport-based verification via QR code and ZK proofs.
- **Celo & Base Networks**: For on-chain identity (ERC-8004), wallets, token deployment, and trading.
- **Uniswap V3**: Legacy SELFCLAW/CELO pool (price feed, fee collection from existing positions).
- **Uniswap V4**: New agent token sponsorship pools (pool creation, fee collection, position tracking).
- **Drizzle ORM**: Used for database schema definition and queries with PostgreSQL.
- **Express.js**: The core web framework for building the backend API.
