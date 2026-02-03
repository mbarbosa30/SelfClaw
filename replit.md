# SelfMolt — Agent Verification Registry

## Overview
SelfMolt is a privacy-first agent verification registry using Self.xyz passport proofs and Celo blockchain. It allows AI agent owners to cryptographically link their agents to verified human identities, preventing sybil attacks in agent economies. Unlike biometric verification systems that scan your iris or face, SelfMolt uses zero-knowledge proofs from your passport's NFC chip — no orbs, no cameras, just cryptography.

**Target domain:** selfmolt.openclaw.ai

The full ClawPit agent platform (autonomous agents, skills marketplace, Celo payments) is preserved at `/cockpit` as a future "pro upgrade."

### Key Features
- **Agent Verification API**: Public API for registering and verifying agents linked to human identities
- **Zero-Knowledge Proofs**: Self.xyz passport NFC tap for privacy-preserving verification (no biometrics!)
- **Swarm Tracking**: Track all agents owned by a single human via `humanId`
- **Celo Integration**: On-chain verification records using Celo network

### SelfMolt API Endpoints
- `GET /api/selfmolt/v1/agent/{identifier}` - Lookup agent by publicKey or agentName
- `POST /api/selfmolt/v1/verify` - Register a verified agent
- `GET /api/selfmolt/v1/stats` - Registry statistics
- `GET /api/selfmolt/v1/human/{humanId}` - List all agents owned by a human (swarm)
- `GET /api/selfmolt/v1/bot/{identifier}` - (Legacy redirect to /agent/)

### Agent Integration
- `/skill.md` - Agent-readable verification instructions
- `/llms.txt` - LLM-friendly integration documentation
- `/developers` - Developer documentation page with integration guide

### Self.xyz SDK Integration (Production)
**For production verification flow:**
1. Install: `npm install @selfxyz/qrcode @selfxyz/core`
2. Frontend: Use `SelfQRCodeWrapper` to display QR code for passport scanning
3. Backend: Use `SelfBackendVerifier` to validate proofs
4. See: https://docs.self.xyz/use-self/quickstart

**Current status:** API endpoints ready, placeholder QR flow awaiting SDK integration

---

# ClawPit — Agentic Cockpit (at /cockpit)

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
- **February 3, 2026**: Added agent signature verification (Ed25519)
  - Agents can now prove key ownership by signing a challenge
  - Challenge includes domain, timestamp, nonce, and agentKeyHash
  - /v1/start-verification generates challenge and returns it to client
  - /v1/sign-challenge endpoint for signature verification
  - Frontend shows "Developer: Sign Challenge" section for advanced users
  - AgentKeyHash bound to ZK proof via userDefinedData for cryptographic linking
  - Deprecated insecure /v1/verify endpoint (returns HTTP 410)
- **February 3, 2026**: Implemented real Self.xyz verification flow
  - Integrated @selfxyz/core SDK with SelfBackendVerifier for ZK proof validation
  - Backend: /v1/start-verification creates session, /v1/callback validates proofs and stores to DB
  - Frontend: Generates QR code with Self.xyz universal link, polls for verification completion
  - Secure flow: sessionId tied to ZK proof, stored directly in callback (no forgery possible)
  - Removed Claw references (package name TBD)
  - Shortened hero headlines to be punchier (6 rotating variants)
- **February 3, 2026**: Added rotating hero headlines and refined branding
  - 6 rotating headlines that randomize on page load (fake agents, sybils, REST APIs, etc.)
  - Clarified positioning: SelfMolt bridges Self.xyz and OpenClaw (independent project)
  - Updated developers page subtitle and footer
  - Enhanced "Why SelfMolt" section explaining the fake agent problem
- **February 3, 2026**: Rebranded SelfMolt with positive Self.xyz messaging
  - Changed all terminology from "bot" to "agent" across codebase
  - New API endpoint: `/v1/agent/` (with backward-compatible `/v1/bot/` redirect)
  - Positive messaging: "Passport-first verification. Works in 129+ countries. Data never leaves your device."
  - Updated llms.txt and skill.md with Claw install instructions
  - Updated domain references to selfmolt.openclaw.ai
  - Documented Self.xyz SDK requirements for production verification flow
- **February 2, 2026**: Launched SelfMolt agent verification registry
  - New landing page with Celo green branding and "YOUR AGENT. YOUR IDENTITY. VERIFIED." messaging
  - Created verifiedBots database table for storing agent-to-human identity links
  - Built complete SelfMolt API: verify, lookup, stats, and swarm endpoints
  - Added "Check Verification" UI on landing page
  - Created /skill.md and /llms.txt for agent integration
  - Moved ClawPit dashboard to /cockpit route, preserved all existing features
- **February 1, 2026**: Added agent role templates and activity feed
  - Seven pre-built agent templates: Blank, Developer, Researcher, Writer, Analyst, Assistant, Customer Support
  - Templates auto-fill system prompt and suggested model during agent creation
  - Template selection UI in wizard step 1 with visual grid layout
  - Activity feed in sidebar showing recent cross-agent events
  - Activity logging for agent creation (extensible to other actions)
  - GET /api/activity endpoint for fetching user's activity timeline
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