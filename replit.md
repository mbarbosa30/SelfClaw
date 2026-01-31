# OpenClaw Experimentation Platform

## Overview
This is a multi-user experimentation platform for OpenClaw, an open-source personal AI assistant framework. It provides a web-based control panel for managing OpenClaw installation, configuration, and gateway operations on Replit. Features include ERC-8004 Trustless Agents support, user authentication via Replit Auth, per-user agent management with PostgreSQL persistence, and x402 + Celo integration for onchain micropayments between AI agents.

## Project Architecture

### Stack
- **Runtime**: Node.js 22+ with TypeScript (tsx)
- **Backend**: Express.js (server/index.ts) - Control panel API on port 5000
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Replit Auth (OpenID Connect)
- **Frontend**: Vanilla HTML/CSS/JS (public/) - Control panel UI with minimalist/brutalist design
- **Blockchain**: Celo network with USDC for x402 payments
- **External**: OpenClaw CLI (installed globally via npm)

### Key Files
- `server/index.ts` - Express server with TypeScript, auth, and API routes
- `server/db.ts` - Drizzle ORM database connection
- `server/replit_integrations/auth/` - Replit Auth integration (OIDC, sessions)
- `shared/schema.ts` - Database schema (users, agents, payments, reputations, validations, sessions)
- `lib/wallet.js` - Celo wallet management (viem)
- `lib/x402-middleware.js` - x402 middleware for accepting payments
- `lib/x402-client.js` - x402 payment client for outbound requests
- `public/index.html` - Control panel UI
- `public/app.js` - Frontend JavaScript with auth and agent management
- `public/styles.css` - Minimalist/brutalist styling
- `drizzle.config.ts` - Drizzle ORM configuration

### Database Tables
- `users` - User accounts (from Replit Auth)
- `agents` - AI agents owned by users (name, description, status, wallet addresses)
- `agent_configs` - Agent-specific OpenClaw configurations
- `payments` - x402 payment records per agent
- `reputations` - Agent reputation scores
- `validations` - Agent validation records
- `sessions` - Express session storage

### OpenClaw Paths
- `~/.openclaw/openclaw.json` - Main configuration
- `~/.openclaw/workspace/skills/` - Custom skills directory

### API Endpoints
- `GET /api/status` - System status (Node, OpenClaw, gateway)
- `GET /api/auth/user` - Current authenticated user
- `GET /api/agents` - List user's agents (authenticated)
- `POST /api/agents` - Create new agent (authenticated)
- `GET /api/agents/:id` - Get agent details (authenticated)
- `GET /api/agents/:id/registration` - ERC-8004 registration file
- `GET /api/agents/:id/payments` - Agent payment history
- `GET /api/agents/:id/wallet` - Agent wallet balance (credits + on-chain)
- `POST /api/agents/:id/ai/chat` - AI proxy endpoint (uses credits)
- `POST /api/agents/:id/credits/add` - Add credits to agent
- `GET /api/platform/pricing` - Platform pricing tiers
- `GET /api/payments/status` - Global wallet status
- `GET /api/payments/balance` - Global wallet balance
- `POST /api/agents/:id/x402/pay` - Make x402 payment from agent wallet
- `GET /api/agents/:id/x402/received` - View payments received by agent
- `POST /api/agents/:id/service` - Paid service endpoint (x402 demo)

## Recent Changes
- **January 31, 2026**: Implemented x402 payment integration for agent wallets
  - Created AgentX402Client for outbound payments using derived wallets
  - Created agent payment middleware with 3% platform fee collection
  - Added x402 pay endpoint for agents to make payments
  - Added received payments endpoint to track agent earnings
  - Added demo service endpoint with x402 payment gate
- **January 31, 2026**: Added agent wallet and credits functionality
  - Added wallet balance endpoint for per-agent derived wallets
  - Created AI chat proxy endpoint with credit deduction
  - Added credits top-up endpoint and platform pricing API
  - Updated agent cards to show credits, wallet, and action buttons (Test AI, Wallet)
  - Simplified onboarding text to emphasize free credits and ease of use
- **January 31, 2026**: Enhanced platform messaging and value proposition
  - Added hero section with "The Future of AI is Autonomous, Economic, and Yours" headline
  - Created ERC-8004 explainer section covering trustless identity benefits
  - Expanded x402 + Celo section with economic potential narrative
  - Added Agent Economy section (skills as services, instruction monetization, agent-to-agent commerce)
  - Added use cases section (personal assistant, skill marketplace, research agent, multi-agent workflow)
  - Enhanced value proposition content for OpenClaw and sandbox benefits
- **January 31, 2026**: Added multi-user support with ERC-8004
  - Migrated to TypeScript with tsx for server
  - Added PostgreSQL database with Drizzle ORM (7 tables)
  - Integrated Replit Auth for user login/logout
  - Created agent management APIs with user isolation
  - Added ERC-8004 registration file endpoint
  - Updated UI with auth section and agents dashboard
- **January 31, 2026**: Added x402 + Celo payments integration
  - Added wallet management with viem for Celo network
  - Created x402 client for paying for API requests
  - Created x402 middleware for monetizing endpoints
  - Added payments section to control panel UI
  - Updated UI with minimalist/brutalist design
- **January 30, 2026**: Initial project setup
  - Created Node.js 22 environment
  - Built web control panel with Express backend
  - Added setup scripts and configuration templates
  - Created comprehensive documentation

## User Preferences
- Focus on experimentation and ease of use
- Prefer web-based management over CLI
- Security through Replit Secrets for API keys
- Minimalist/brutalist UI design
- Multi-user isolation with per-user agents

## Key Decisions
1. Control panel on port 5000 (Replit standard)
2. OpenClaw gateway on port 18789 (OpenClaw default)
3. No daemon installation (Replit limitation)
4. Global npm install for OpenClaw CLI
5. Celo network for x402 payments (low fees, native USDC)
6. viem library for blockchain interactions
7. PostgreSQL for multi-user persistence
8. Drizzle ORM for type-safe database access
9. Replit Auth for authentication (OIDC)
10. ERC-8004 for trustless agent identity
