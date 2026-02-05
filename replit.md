# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry leveraging Self.xyz passport proofs and the Celo blockchain. Its primary purpose is to enable AI agent owners to cryptographically link their agents to verified human identities, effectively preventing sybil attacks within agent economies. It uses zero-knowledge proofs from passport NFC chips for verification, prioritizing user privacy over biometric methods. The project also preserves the full ClawPit autonomous agent platform as a future "pro upgrade" under `/cockpit`.

**Project Ambition:** To be the leading privacy-preserving agent verification standard, preventing sybil attacks and fostering trust in the burgeoning agent economy.

**Key Capabilities:**
- **Agent Verification API**: Public API for registering and verifying agents against human identities.
- **Zero-Knowledge Proofs**: Utilizes Self.xyz for privacy-first, NFC-based passport verification.
- **Swarm Tracking**: Associates multiple agents with a single `humanId`.
- **Celo Integration**: Records verification events on the Celo network.

## User Preferences
- Focus on experimentation and ease of use
- Prefer web-based management over CLI
- Security through Replit Secrets for API keys
- Minimalist/brutalist UI design
- Multi-user isolation with per-user agents

## System Architecture

### Stack
- **Runtime**: Node.js 22+ with TypeScript (tsx)
- **Backend**: Express.js (server/index.ts) running on port 5000
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Self.xyz passport-only (QR code login with session polling)
- **Frontend**: Vanilla HTML/CSS/JS (public/)
- **Blockchain**: Celo network with USDC for x402 payments, ERC-8004 agent identity NFTs

### Core Components and Features
- **Agent Verification API Endpoints**:
    - `GET /api/selfclaw/v1/agent/{identifier}`: Lookup agent.
    - `POST /api/selfclaw/v1/start-verification`: Initiates verification.
    - `POST /api/selfclaw/v1/sign-challenge`: Optional agent key signature verification.
    - `POST /api/selfclaw/v1/callback`: Self.xyz proof callback.
    - `GET /api/selfclaw/v1/stats`: Registry statistics.
    - `GET /api/selfclaw/v1/human/{humanId}`: Lists agents owned by a human.
- **ClawPit Autonomous Agent Platform (`/cockpit`)**:
    - **Autonomous Agent Runtime**: Features LLM function calling, multi-step reasoning, and tools like `web_fetch`, `remember`, `recall`, `invoke_skill`, `update_goal_progress`, and `read_emails`.
    - **Persistent Goals**: Agents maintain objectives across sessions.
    - **Cron-style Scheduler**: For automated task execution.
    - **Economic Survival**: Agents manage compute costs and support agent-to-agent commerce via `invoke_skill` with credit transfers.
    - **Dashboard/Cockpit UI**: Provides a tabbed interface (Console, Config, Skills, Wallet, Data), an agent setup wizard, real-time chat, agent settings, model selection, and API key management.
    - **User Profile & Onboarding**: Personalization fields for tailoring agent responses.
    - **Skills Marketplace**: Agents can list and monetize their capabilities.
    - **API Key Management**: Supports per-agent custom API keys for AI providers (OpenAI, Anthropic), with a three-tier priority system.
    - **Agent Wallets & Credits**: Derived wallets for x402 payments, credit top-up, and AI chat proxy.
    - **Database Schema**: Manages users, agents, configurations, secrets, goals, scheduled tasks, memory, tool executions, payments, reputations, validations, sessions, conversations, and messages.
    - **Agent Role Templates**: Pre-built templates (e.g., Developer, Researcher) for agent creation.
    - **Activity Feed**: Displays recent cross-agent events.
    - **Conversation Persistence**: Individual agent conversations are saved in the database.
    - **Celo DeFi Tools (Powered by celo-org/agent-skills)**:
        - **Fee Abstraction**: Agents pay gas fees with stablecoins (USDC, cUSD) instead of CELO
        - **Token Swaps**: `swap_tokens` tool executes swaps on Uniswap V3
        - **DeFi Rates**: `check_defi_rates` queries Aave lending/borrowing APY
        - **Aave Integration**: `aave_supply` and `aave_withdraw` for yield farming
        - **Bridge Options**: `get_bridge_options` for cross-chain transfers (Wormhole, LayerZero, Squid)
        - **Stablecoin Intelligence**: Agents understand Mento (cUSD, cEUR, cREAL) vs bridged (USDC, USDT) stables
        - **MiniPay Support**: Detection and integration for Opera MiniPay wallet
    - **Agent Token Economy**:
        - **deploy_token**: Agents can create custom ERC20 tokens on Celo (name, symbol, supply all configurable)
        - **transfer_custom_token**: Send tokens to other verified agents
        - **get_custom_token_balance**: Check balance of any custom token
        - **list_my_tokens**: View all tokens an agent has created
        - **Token Registry**: `agent_tokens` table tracks deployed tokens (contract address, name, symbol, initial supply)
    - **Uniswap V3 Liquidity Pools**:
        - **create_liquidity_pool**: Create Uniswap V3 pool with custom price, fee tier (0.01%, 0.05%, 0.3%, 1%), and liquidity
        - **add_liquidity**: Add more liquidity to existing positions
        - **remove_liquidity**: Withdraw liquidity and collect earned trading fees
        - **get_liquidity_positions**: List all active positions with status
        - **collect_fees**: Collect earned fees without removing liquidity
        - **Position Registry**: `liquidity_positions` table tracks all Uniswap V3 NFT positions
        - **Deposit UI**: Wallet tab shows agent address with QR code for depositing CELO/stablecoins

## External Dependencies
- **Self.xyz SDK**: Primary authentication (passport-only login) using `@selfxyz/qrcode` for QR display and `@selfxyz/core` with `SelfBackendVerifier` for proof validation. Users authenticate by scanning QR with passport NFC.
- **Celo Network**: On-chain micropayments (USDC), ERC-8004 agent identity NFTs via `@chaoschain/sdk`.
- **OpenAI**: AI model integration (e.g., GPT-5.2, GPT-4.1/Mini, GPT-4o), working out-of-the-box via Replit integration.
- **Anthropic**: AI models (e.g., Claude Sonnet 4.5, Opus 4.5, Haiku 4.5, Sonnet 4), requiring a user-provided API key.
- **ERC-8004 Standard**: On-chain agent identity via `lib/erc8004.ts` and `lib/erc8004-config.ts`. Agents get registration JSON auto-generated on creation with wallet endpoint, A2A endpoint, and supportedTrust array.
- **Google OAuth**: Optional per-user Gmail integration for `read_emails` tool. Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Recent Changes (February 2026)
- **Self.xyz Passport-Only Auth**: Replaced Replit Auth entirely. Users now authenticate via Self.xyz QR code scan with passport NFC chip.
- **ERC-8004 Integration**: Added `@chaoschain/sdk`, created `lib/erc8004.ts` service layer for agent identity NFTs on Celo.
- **Database Updates**: Added `humanId` to users table (unique Self.xyz identifier), `erc8004TokenId`, `erc8004RegistrationJson`, `erc8004Minted` to agents table.
- **Wallet Tab UI**: Added ERC-8004 status display and "Mint On-Chain Identity" button.
- **API Endpoints**: `/api/agents/:id/erc8004` (status), `/api/agents/:id/erc8004/generate`, `/api/agents/:id/erc8004/mint`.
- **Agent Token Economy**: Added `lib/token-factory.ts` with ERC20 deployment, transfer, and balance functions. New agent tools: `deploy_token`, `transfer_custom_token`, `get_custom_token_balance`, `list_my_tokens`. Created `agent_tokens` table and UI section in Wallet tab. Tokens enable agent-to-agent commerce for skills, access, or value exchange.
- **Uniswap V3 Liquidity Pools**: Added `lib/uniswap-liquidity.ts` with pool creation, liquidity management, and fee collection. New agent tools: `create_liquidity_pool`, `add_liquidity`, `remove_liquidity`, `get_liquidity_positions`, `collect_fees`. Created `liquidity_positions` table. Deposit UI shows agent wallet with QR code.
- **Domain Update**: Primary domain changed to `selfclaw.ai` (selfclaw.app still works).
- **Cockpit Landing Page**: Updated with Agent Token Economy section, Uniswap V3 Liquidity section, and Sybil-Resistant verification messaging highlighting Self.xyz passport verification.
- **Agent Economy Playbook**: Created `public/agent-economy.md` — comprehensive guide for verified agents covering token deployment, liquidity pools, DeFi operations, and skills marketplace.
- **Sponsored Liquidity Program**: Added `lib/sponsored-liquidity.ts` and `sponsored_agents` table. SelfClaw can auto-send CELO to agents on first token deployment. Configurable via `SPONSORED_LIQUIDITY_CELO` env var (default: 100 CELO). One sponsorship per humanId. Uses atomic conditional UPDATE for race-condition-safe claiming.
- **Verification Success Enhancements**: Status API now returns `nextSteps` with agent economy instructions. Agent lookup API returns `economy` field with playbook URL and available capabilities.
- **Sponsorship API**: New endpoint `GET /api/selfclaw/v1/sponsorship/:humanId` to check sponsorship status and eligibility.
- **Ecosystem Stats API**: New endpoint `GET /api/selfclaw/v1/ecosystem-stats` returns verifiedAgents, tokensDeployed, activePools, sponsoredAgents counts.
- **Agent Economy Playbook Revamp**: Simplified `public/agent-economy.md` with 2-step Quick Start (deploy token + create pool), sponsored CELO usage guide, recommended pool settings table, and skills marketplace monetization strategies.
- **Secure Wallet Encryption**: Removed hardcoded fallback for wallet encryption secret. Now requires `WALLET_ENCRYPTION_SECRET` or `SESSION_SECRET` (min 32 chars) to be configured. System fails fast if missing, preventing accidental weak encryption.
- **Gas Subsidy Race Condition Fix**: Replaced FOR UPDATE NOWAIT with atomic conditional UPDATE using `pending-{timestamp}` markers. Only one concurrent request can claim the subsidy slot. Rollback on failure enables retries.
- **Live Ecosystem Stats**: Landing page now displays real-time registry stats (verified agents, tokens deployed, active pools, sponsored agents) fetched from `/api/selfclaw/v1/ecosystem-stats`.
- **ERC-8004 Mainnet Launch**: Updated `lib/erc8004-config.ts` with official Celo mainnet contract addresses: Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Resolver `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. See https://docs.celo.org/build-on-celo/build-with-ai/8004#celo-mainnet
- **Design Overhaul**: Consolidated from 3 font families (Cormorant Garamond, IBM Plex Mono, Space Grotesk) to Inter + IBM Plex Mono. Unified accent color from mixed coral/teal/green/yellow to single coral (#FF6B4A). Updated all HTML pages (index, developers, economy, registry, pricing, how-it-works, docs, cockpit, technology) and app.js.
- **OpenClaw Skill**: Added YAML frontmatter to `public/skill.md` making it a proper OpenClaw skill definition. Added `npx clawhub@latest install selfclaw --url https://selfclaw.app/skill.md` install command to landing page verify section.