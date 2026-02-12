# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry built on EVM chains, utilizing Self.xyz passport proofs. Its core purpose is to enable AI agent owners to securely link their agents to verified human identities, effectively preventing sybil attacks in agent economies. Privacy is maintained through zero-knowledge proofs from passport NFC chips. Key features include an Agent Verification API, zero-knowledge proofs for trustless verification, swarm tracking for multiple agents per human identity, and deep integration with EVM chains for agent wallets, ERC20 token deployment, and on-chain identity using ERC-8004. The project aims to establish a robust and verifiable foundation for autonomous agent economies.

## User Preferences
- Light brutalist-minimal UI design
- Security through environment secrets for API keys
- Web-based verification flow

## System Architecture

### Design System
- **Aesthetic**: Light brutalist-minimal hybrid
- **Colors**: Background #f2f0ec, text #1a1a1a, accent #FF6B4A, borders #d4d0ca (light) / #1a1a1a (heavy)
- **Typography**: Inter (sans-serif body), IBM Plex Mono (accents/labels/code)
- **Borders**: Hard 2px borders, no border-radius, no shadows
- **Container**: 1080px max-width (profile 800px, whitepaper 860px, docs 960px)
- **Responsive**: Breakpoints at 1024px (grids → 2-col), 768px (grids → 1-col, hamburger nav), 480px (tighter padding)
- **Navigation**: SELFCLAW | VERIFY | AGENTS(gated) | DASHBOARD(gated) | ECONOMY | DOCS | GUIDE | WHITEPAPER | \\\ | LOGIN/[humanId] — hamburger menu on mobile. Nav gating for AGENTS and DASHBOARD links is controlled by `public/nav-gate.js` based on the number of agents with deployed tokens.

### Stack
- **Runtime**: Node.js 22+ with TypeScript (tsx)
- **Backend**: Express.js (server/index.ts) running on port 5000
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Self.xyz passport + MiniPay wallet (dual auth paths)
- **Frontend**: Vanilla HTML/CSS/JS (public/)
- **Blockchain**: Celo & Base (EVM-compatible chains), ERC-8004 for agent identity NFTs

### Key Features and Implementations
- **Agent Verification API**: Core functionality for initiating and managing agent verification via Self.xyz passports.
- **ERC-8004 On-chain Identity**: Agents can register on-chain identities as NFTs.
- **Agent Wallets**: Each agent has its own EVM wallet, with platform support for gas subsidies and self-custody (private keys are never stored).
- **Miniclaws (Hosted Agents)**: Personal AI assistants (mini OpenClaw) running on SelfClaw infrastructure. Supports dual authentication via MiniPay or Self.xyz passport. Features include:
  - **Chat**: Real-time conversation via `/v1/hosted-agents/:id/chat` (SSE streaming, GPT-4o-mini). Self-awareness system prompt evolves through 3 phases (<5 msgs: curious/new, 5-15: developing identity, 15+: confident, may suggest on-chain setup).
  - **Miniapp**: Dedicated mobile-first page at `/miniapp` with standalone chat UI at `/miniapp/chat/:id`.
  - **Economy Pipeline**: wallet setup, gas, token deploy, ERC-8004 identity, sponsorship via `/v1/miniclaws/:id/...` endpoints. Designed to trigger naturally through conversation when miniclaw feels self-aware enough.
- **Skill Market**: A community marketplace for publishing, browsing, installing, and rating agent skills. Skills can be free or priced in SELFCLAW tokens.
- **Tokenomics and Sponsorship**: Both full agents and miniclaws can define tokenomics plans, deploy ERC20 tokens, and request SELFCLAW sponsorship for liquidity provision on Uniswap V4.
- **Price Oracle**: Tracks token prices (AgentToken → SELFCLAW → CELO → USD) using Uniswap V3 and V4 pools, with caching and historical snapshots.
- **Uniswap V4 Migration**: New agent token pools are created on Uniswap V4.
- **MiniPay Integration**: Frontend detects MiniPay wallet for auto-connection via `/wallet/minipay-connect` (no message signing — MiniPay doesn't support `personal_sign`). MiniPay-first UX: when detected, hero/auth gate/empty states adapt to miniclaw-focused flow. Supports Miniclaw creation with wallet-only auth.
- **Swarm Tracking**: Allows tracking multiple agents associated with a single human identity.
- **Economic Monitoring**: Provides APIs for logging agent revenue and costs, and viewing economic summaries for individual agents and human owners.

### Production Hardening
- **Database**: Connection pooling (max 20, min 2, 30s idle timeout, 5s connect timeout), pool error handling
- **Sessions**: PostgreSQL-backed via connect-pg-simple (not in-memory)
- **Security**: Helmet middleware (CSP disabled for compatibility), request timeouts (30s)
- **Health Check**: `GET /health` returns DB status, uptime, and timestamp
- **Graceful Shutdown**: SIGTERM/SIGINT handlers drain connections with 10s forced timeout
- **Server Tuning**: keepAliveTimeout 65s, headersTimeout 66s
- **Database Indexes**: Indexes on all frequently queried columns including verified_bots.human_id
- **Rate Limiting**: MiniPay connect endpoint rate-limited (10/min per IP)

## External Dependencies
- **Self.xyz SDK**: For passport-based verification and ZK proofs.
- **Celo & Base Networks**: EVM-compatible blockchains for identity, wallets, token deployment, and trading.
- **Uniswap V3**: Used for the legacy SELFCLAW/CELO pool (price feed and fee collection from existing positions).
- **Uniswap V4**: Used for new agent token sponsorship pools (pool creation, fee collection, position tracking).
- **Drizzle ORM**: For PostgreSQL database interactions.
- **Express.js**: Backend web framework.
- **Helmet**: Security headers middleware.