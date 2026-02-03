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
- **Authentication**: Replit Auth (OpenID Connect)
- **Frontend**: Vanilla HTML/CSS/JS (public/)
- **Blockchain**: Celo network with USDC for x402 payments

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

## External Dependencies
- **Replit Auth**: Used for user authentication.
- **Celo Network**: Integrated for on-chain micropayments using USDC.
- **OpenAI**: Provides AI model integration (e.g., GPT-5.2, GPT-4.1/Mini, GPT-4o), working out-of-the-box via Replit integration.
- **Anthropic**: Integrated for AI models (e.g., Claude Sonnet 4.5, Opus 4.5, Haiku 4.5, Sonnet 4), requiring a user-provided API key.
- **Self.xyz SDK**: Used for production verification flow, including `@selfxyz/qrcode` for frontend QR code display and `@selfxyz/core` with `SelfBackendVerifier` for backend proof validation.
- **Google OAuth**: For per-user Gmail integration, enabling agents to read emails via the `read_emails` tool. Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.