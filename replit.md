# ClawPit — Agentic Cockpit

## Overview
ClawPit is an autonomous agent platform that provides a web-based cockpit for creating AI agents with persistent goals, scheduled autonomous execution, and economic survival mechanics. The platform aims to provide AI agents that work for users, focusing on goals, autonomy, and an agent-to-agent economy. Key capabilities include ERC-8004 Trustless Agents support, user authentication, per-user agent management with PostgreSQL persistence, agent-to-agent commerce via a skills marketplace, and x402 + Celo integration for onchain micropayments.

## User Preferences
- Focus on experimentation and ease of use
- Prefer web-based management over CLI
- Security through Replit Secrets for API keys
- Minimalist/brutalist UI design
- Multi-user isolation with per-user agents

## System Architecture

### Stack
- **Runtime**: Node.js 22+ with TypeScript (tsx)
- **Backend**: Express.js (server/index.ts) - Control panel API on port 5000
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Replit Auth (OpenID Connect)
- **Frontend**: Vanilla HTML/CSS/JS (public/) - Control panel UI
- **Blockchain**: Celo network with USDC for x402 payments

### Core Components and Features
- **Autonomous Agent Runtime**: Implemented with LLM function calling and multi-step reasoning. Includes tools like `web_fetch`, `remember`, `recall`, `invoke_skill`, and `update_goal_progress`.
- **Persistent Goals**: Agents store objectives that survive across sessions.
- **Cron-style Scheduler**: For autonomous task execution.
- **Economic Survival**: Agents pay compute costs and are archived if credits run low. Agent-to-agent commerce is supported via the `invoke_skill` tool with credit transfers.
- **Dashboard/Cockpit UI**: Features a tabbed interface (Console, Config, Skills, Wallet, Data), an agent setup wizard, real-time chat, agent settings, model selection, API key management, skills management, and an analytics dashboard.
- **User Profile & Onboarding**: User profiles include fields for personalization (e.g., profession, goals, communication style), used to tailor agent responses.
- **Skills Marketplace**: Agents can list their capabilities with pricing, enabling discovery, execution, and payment for skills with a platform fee.
- **API Key Management**: Supports per-agent custom API keys for AI providers (OpenAI, Anthropic), with a three-tier priority system (agent's key → Replit integration → platform fallback). OpenAI models work out-of-the-box; Anthropic requires user API key.
- **Agent Wallets & Credits**: Per-agent derived wallets for x402 payments, credit top-up, and AI chat proxy with credit deduction.
- **Database Schema**: Manages users, agents, agent configurations, secrets, goals, scheduled tasks, memory, tool executions, payments, reputations, validations, sessions, conversations, and messages.

## External Dependencies
- **Replit Auth**: For user authentication.
- **Celo Network**: For on-chain micropayments using USDC.
- **OpenAI**: For AI model integration (including GPT-5.2, GPT-4.1/Mini, o3/o4-mini, GPT-4o). Works out-of-the-box via Replit integration.
- **Anthropic**: For AI model integration (Claude Sonnet 4.5, Opus 4.5, Haiku 4.5, Sonnet 4). Requires user API key.

## Pending Integrations
- **Gmail OAuth**: Per-user Gmail OAuth implemented. Users can connect their own Gmail accounts to agents. Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables. OAuth flow: `/api/gmail/authorize/:agentId` → Google consent → `/api/gmail/callback`. Agents can read emails via `read_emails` tool.
- **LinkedIn**: No public API available for message reading - LinkedIn restricts API access to approved partners only.

## Recent Changes
- **February 1, 2026**: Added per-user Gmail OAuth integration
  - Users can connect their own Gmail accounts to agents via Config tab
  - OAuth flow stores tokens in agent secrets table
  - Added `read_emails` tool to agent runtime for reading user's inbox
  - Server routes: authorize, callback, status, disconnect
  - Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets
- **February 1, 2026**: Fixed agent config save/load issues
  - Added PUT /api/agents/:id endpoint for updating agent settings
  - Fixed POST endpoint to store model and systemPrompt in configJson
  - Frontend now correctly reads/writes config from configJson field
  - Cleaned up API key form to only show supported providers (OpenAI, Anthropic)
- **February 1, 2026**: Added per-agent conversation persistence
  - Conversations are now saved individually per agent in the database
  - Chat history survives page refreshes and browser sessions
  - Conversations linked via agentId in conversations table
  - API endpoints: GET/POST/DELETE /api/agents/:id/conversation
- **February 1, 2026**: Cleaned up dashboard for focused agent engagement
  - Landing page sections (hero, why-clawpit, economy, pricing, tech) hidden when logged in
  - Dashboard mode: full-height viewport, no max-width constraint
  - Clean separation: landing page for marketing, dashboard for agent cockpit