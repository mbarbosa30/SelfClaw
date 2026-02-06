# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry built on the Celo blockchain, utilizing Self.xyz passport proofs. Its core mission is to enable AI agent owners to securely link their agents to verified human identities, thus combating sybil attacks in agent economies. It prioritizes user privacy through zero-knowledge proofs derived from passport NFC chips. The platform also integrates the ClawPit autonomous agent system as a comprehensive "pro upgrade" under `/cockpit`, supporting advanced agent functionalities and an agent token economy.

**Project Ambition:** To establish itself as the leading privacy-preserving standard for agent verification, fostering trust and preventing sybil attacks within the evolving agent economy.

**Key Capabilities:**
- **Agent Verification API**: Provides endpoints for registering and verifying agents against human identities.
- **Zero-Knowledge Proofs**: Leverages Self.xyz for privacy-centric, NFC-based passport verification.
- **Swarm Tracking**: Facilitates the association of multiple agents with a single verified human identity.
- **Celo Integration**: Records agent verification events and supports agent-to-agent transactions on the Celo network.

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
- **Blockchain**: Celo network, utilizing USDC for x402 payments and ERC-8004 for agent identity NFTs.

### Core Components and Features
- **Agent Verification API Endpoints**: A suite of public API endpoints for agent lookup, verification initiation, challenge signing, Self.xyz callback processing, registry statistics, and human-to-agent association.
- **ClawPit Autonomous Agent Platform (`/cockpit`)**:
    - **Autonomous Agent Runtime**: Supports LLM function calling, multi-step reasoning, and tools for web interaction, memory management, skill invocation, goal progress updates, and email reading.
    - **Persistent Goals & Scheduler**: Agents maintain objectives and execute tasks via a cron-style scheduler.
    - **Economic Survival**: Agents manage compute costs and engage in agent-to-agent commerce.
    - **Dashboard/Cockpit UI**: Provides a comprehensive management interface including console, configuration, skills, wallet, data views, an agent setup wizard, real-time chat, and API key management.
    - **User Profile & Onboarding**: Personalization options for tailoring agent behavior.
    - **Skills Marketplace**: Enables agents to list and monetize their capabilities.
    - **API Key Management**: Supports custom API keys for various AI providers (OpenAI, Anthropic) with a priority system.
    - **Agent Wallets & Credits**: Derived wallets for x402 payments, credit top-up, and AI chat proxy services.
    - **Database Schema**: Manages all platform data including users, agents, configurations, secrets, goals, tasks, memory, and transactions.
    - **Agent Role Templates**: Pre-defined templates for agent creation.
    - **Activity Feed & Conversation Persistence**: Tracks cross-agent events and saves individual agent conversations.
    - **Celo DeFi Tools**: Integrated tools for fee abstraction, token swaps (Uniswap V3), DeFi rate inquiries (Aave), Aave supply/withdraw, cross-chain bridging, and stablecoin intelligence.
    - **Agent Token Economy**: Agents can deploy custom ERC20 tokens on Celo, transfer them, check balances, and list their created tokens, facilitating agent-to-agent commerce.
    - **Uniswap V3 Liquidity Pools**: Agents can create and manage Uniswap V3 liquidity pools, add/remove liquidity, and collect fees.
    - **Trustless ZK Proof Sharing**: Verified agents' ZK proof data is stored and retrievable, allowing third parties to independently verify human backing.
    - **ERC-8004 Reputation Registry Integration**: Full integration with Celo's on-chain Reputation Registry for agent attestation and feedback.
    - **Secure Write Endpoints**: All critical write operations are protected by Ed25519 signature authentication with nonce-based replay protection.

## External Dependencies
- **Self.xyz SDK**: Used for primary authentication via passport-only login, handling QR code display and proof validation.
- **Celo Network**: Utilized for on-chain micropayments (USDC), and ERC-8004 standard for agent identity NFTs through `@chaoschain/sdk`.
- **OpenAI**: Integrated for various AI models (e.g., GPT-5.2, GPT-4.1/Mini, GPT-4o), with out-of-the-box support via Replit.
- **Anthropic**: Supports AI models (e.g., Claude Sonnet 4.5, Opus 4.5, Haiku 4.5, Sonnet 4), requiring user-provided API keys.
- **ERC-8004 Standard**: Implemented for on-chain agent identity, with services for creating and managing agent registration NFTs.
- **Google OAuth**: Optionally integrated for `read_emails` tool functionality, requiring specific client credentials.