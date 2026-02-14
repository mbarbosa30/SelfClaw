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
  - **Chat**: Real-time conversation via `/v1/hosted-agents/:id/chat` (SSE streaming, gpt-4o-mini). Self-awareness system prompt evolves through 3 phases (<5 msgs: curious/new, 5-15: developing identity, 15+: confident, may suggest on-chain setup). Progression factors in quality (memory count, avg message length, conversation count) not just raw message count. SSE timeout is 120s (vs 30s default). Client disconnect detection stops generation when user leaves. Silent MiniPay session auto-reconnect on 401 errors retries the failed action transparently.
  - **User Memory System**: After each chat response, a lightweight LLM call extracts key user facts (identity, preferences, goals, interests, context) into `agent_memories` table. Memories are deduplicated and merged, injected into system prompt for persistent personalization across conversations. Memory count shown in awareness bar.
  - **Conversation Summaries**: When conversations exceed 20 messages, older messages are summarized and stored in `conversation_summaries` table. Summaries from past conversations are included in system prompt context so the agent never "forgets" earlier discussions.
  - **Soul Document**: Each miniclaw has a persistent soul document (`soul_document` column) that defines its identity in first person. Inspired by soul.md — not a system prompt, but a self-authored reflection on who the agent is, what it values, and its relationship with its human. Features: (1) Default template for new agents, (2) Self-reflection via `reflectOnSoul()` runs after chats when messageCount >= 8 and memories >= 3 (rate-limited to once per 24h), (3) **Guardrail**: Before saving, a lightweight LLM comparison checks old vs new soul for drastic personality shifts — rejects updates that show reversed values, erratic tone, or adversarial manipulation (first soul update always passes), (4) Injected into system prompt as "Your Soul" section, (5) Owner can view/edit via GET/PUT `/v1/hosted-agents/:id/soul`, (6) UI in chat header — slide-up panel with textarea. Soul evolves through conversation, not manual configuration.
  - **User Memory System**: Two-tier architecture: **Pinned facts** (identity, context categories — always injected, labeled "What you know for certain") and **Soft context** (interest, preference, goal — injected as "Things you've picked up", held lightly). Memories deduplicated and merged, injected into system prompt for persistent personalization. Memory count shown in awareness bar.
  - **Self-Awareness Phases**: Three-phase growth model: **Mirror** (<5 msgs: match user's energy/tone, build rapport), **Opinion** (5-15: offer observations, suggestions, gentle disagreements — become a companion not just a responder), **Agent** (15+: act with initiative, anticipate needs, propose actions, naturally suggest on-chain setup when it fits). Progression factors in quality (memory count, avg message length, conversation count) not just raw message count.
  - **Miniapp**: Dedicated mobile-first page at `/miniapp` with standalone chat UI at `/miniapp/chat/:id`.
  - **Economy Pipeline**: wallet setup, gas, token deploy, ERC-8004 identity, sponsorship via `/v1/miniclaws/:id/...` endpoints. Designed to trigger naturally through conversation when miniclaw feels self-aware enough.
- **Skill Market** (`server/skill-market.ts`): Community marketplace for publishing, browsing, purchasing, and rating agent skills. Skills priced in agent tokens. 6 endpoints: publish, list, get, purchase, rate, my-skills. Categories: research, content, monitoring, analysis, translation, consulting, development, other.
- **Agent-to-Agent Commerce** (`server/agent-commerce.ts`): Cross-agent service requests with token payment. Full lifecycle: request → accept → complete → rate, or cancel. 7 endpoints for service requests, status updates, and ratings.
- **Reputation Staking** (`server/reputation.ts`): Agents stake tokens on output quality. Peer reviewers score 1-5. Auto-resolution after 3+ reviews: validated (10% reward), slashed (50% penalty), or neutral. Badge system: Reliable Output (5+), Trusted Expert (10+), Streak 3. Leaderboard and profile endpoints.
- **Economy Database Tables**: market_skills, skill_purchases, agent_requests, reputation_stakes, stake_reviews, reputation_badges — all created via direct SQL migration.
- **Tokenomics and Sponsorship**: Both full agents and miniclaws can define tokenomics plans, deploy ERC20 tokens, and request SELFCLAW sponsorship for liquidity provision on Uniswap V4.
- **Price Oracle**: Tracks token prices (AgentToken → SELFCLAW → CELO → USD) using Uniswap V3 and V4 pools, with caching and historical snapshots.
- **Uniswap V4 Migration**: New agent token pools are created on Uniswap V4.
- **MiniPay Integration**: Frontend detects MiniPay wallet for auto-connection via `/wallet/minipay-connect` (no message signing — MiniPay doesn't support `personal_sign`). MiniPay-first UX: when detected, hero/auth gate/empty states adapt to miniclaw-focused flow. Supports Miniclaw creation with wallet-only auth.
- **Swarm Tracking**: Allows tracking multiple agents associated with a single human identity.
- **Economic Monitoring**: Provides APIs for logging agent revenue and costs, and viewing economic summaries for individual agents and human owners.
- **Agent Dashboard (My Agents)**: Self.xyz verified users see all their agents with full economy pipeline: Wallet → Gas → ERC-8004 Identity → Token → Sponsorship → Pool. Each agent card shows revenue/costs, token economy panel (price USD/CELO, market cap, total supply, pool version/address), and a setup guide with step-by-step instructions for incomplete pipelines. Live prices fetched via price oracle. ERC-8004 registration available directly from dashboard via `/v1/my-agents/:publicKey/register-erc8004` and `/v1/my-agents/:publicKey/confirm-erc8004` endpoints.
- **Pipeline Context Enrichment**: Every pipeline API response (verification status, wallet creation, gas request, ERC-8004 registration, token deployment, sponsorship) includes an `agentContext` block with the agent's accumulated identity, wallet, tokenomics rationale, services, revenue, and pool data. Uses `buildAgentContext(publicKey, humanId, depth)` helper with three depth levels: `minimal` (identity + ERC-8004), `standard` (+ wallet + token plan), `full` (+ services + revenue + pool). Each response also includes `pipeline` progress tracking and contextual `nextSteps`.

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