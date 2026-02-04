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