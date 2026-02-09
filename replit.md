# SelfClaw — Agent Verification Registry

## Overview
SelfClaw is a privacy-first agent verification registry built on the Celo blockchain, utilizing Self.xyz passport proofs. It enables AI agent owners to securely link their agents to verified human identities, combating sybil attacks in agent economies. User privacy is ensured through zero-knowledge proofs derived from passport NFC chips.

**Key Capabilities:**
- **Agent Verification API**: Endpoints for registering and verifying agents against human identities
- **Zero-Knowledge Proofs**: Self.xyz for privacy-centric, NFC-based passport verification
- **Swarm Tracking**: Multiple agents linked to a single verified human identity
- **Celo Integration**: Agent wallets, ERC20 token deployment, ERC-8004 on-chain identity, sponsored liquidity
- **Trustless Verification**: ZK proof data stored and retrievable for independent verification

## User Preferences
- Minimalist/brutalist UI design
- Security through environment secrets for API keys
- Web-based verification flow

## System Architecture

### Stack
- **Runtime**: Node.js 22+ with TypeScript (tsx)
- **Backend**: Express.js (server/index.ts) running on port 5000
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: Self.xyz passport-only (QR code verification)
- **Frontend**: Vanilla HTML/CSS/JS (public/)
- **Blockchain**: Celo network, ERC-8004 for agent identity NFTs

### Project Structure
```
server/
  index.ts              # Express server, routes, middleware
  selfclaw.ts           # Core verification API (/api/selfclaw/v1/*)
  self-auth.ts          # Self.xyz passport authentication
lib/
  erc8004.ts            # ERC-8004 on-chain identity service
  erc8004-config.ts     # Agent registration file generator
  secure-wallet.ts      # Celo wallet creation and management
  token-factory.ts      # ERC20 token deployment
  uniswap-v3.ts         # Uniswap V3 integration (pool creation, fee collection, sponsored LP)
  uniswap-v4.ts         # Uniswap V4 integration (admin pool monitoring, swaps)
  sponsored-liquidity.ts # Legacy sponsored liquidity (deprecated)
  wormhole-bridge.ts    # Wormhole cross-chain bridge (Base↔Celo)
  constants.ts          # Contract bytecode constants
shared/
  schema.ts             # Drizzle database schema
server/
  admin.ts              # Admin API endpoints (bridge, wallet, stats)
public/
  index.html            # Landing page + verification flow
  admin.html            # Hidden admin dashboard (/admin, password-gated)
  dashboard.html        # Public performance dashboard
  registry.html         # Verified agents listing (/registry, /agents)
  agent.html            # Individual agent profile page (/agent/:name)
  developers.html       # API documentation
  skill.md              # Agent-readable skill definition
  agent-economy.md      # Agent economy playbook (token deployment, sponsorship)
```

### Key API Endpoints
- `POST /api/selfclaw/v1/start-verification` — Initiate agent verification (validates unique agent names)
- `POST /api/selfclaw/v1/sign-challenge` — Sign challenge for programmatic verification (accepts hex/base64)
- `GET /api/selfclaw/v1/verification-status/{sessionId}` — Poll verification status (pending/verified/expired)
- `GET /api/selfclaw/v1/agent/{identifier}` — Check agent verification status
- `GET /api/selfclaw/v1/agents` — List all agents with enriched data (wallets, tokens, pools, plans)
- `GET /api/selfclaw/v1/agent-profile/{name}` — Full agent profile by name
- `GET /api/selfclaw/v1/stats` — Registry statistics
- `GET /api/selfclaw/v1/dashboard` — Comprehensive dashboard data
- `GET /api/selfclaw/v1/human/{humanId}` — All agents for a human (swarm)
- `GET /api/selfclaw/v1/wallet-verify/{address}` — Public wallet verification lookup
- `POST /api/selfclaw/v1/create-wallet` — Register agent's self-custody Celo wallet address
- `POST /api/selfclaw/v1/switch-wallet` — Update registered wallet address
- `POST /api/selfclaw/v1/token-plan` — Submit tokenomics plan (purpose, allocation, utility, economic model)
- `GET /api/selfclaw/v1/token-plan/{humanId}` — View agent's tokenomics plan
- `POST /api/selfclaw/v1/deploy-token` — Get unsigned ERC20 token deployment transaction (optional tokenPlanId)
- `POST /api/selfclaw/v1/register-token` — Register deployed token address (verifies on-chain, tracks for ecosystem)
- `GET /api/selfclaw/v1/selfclaw-sponsorship` — Check available SELFCLAW for sponsorship
- `POST /api/selfclaw/v1/request-selfclaw-sponsorship` — Request SELFCLAW sponsorship: auto-collects V3 fees, uses 50% of sponsor SELFCLAW balance, creates AgentToken/SELFCLAW V3 pool, tracks pool (one-time per humanId)
- `GET /api/selfclaw/v1/pools` — View all tracked agent token pools with live prices/volume/market cap
- `GET /.well-known/agent-registration.json` — Agent registration discovery
- `GET /api/erc8004/config` — On-chain identity configuration

## External Dependencies
- **Self.xyz SDK**: Passport-based verification via QR code and ZK proofs
- **Celo Network**: On-chain identity (ERC-8004) via `@chaoschain/sdk`, wallets, token deployment
- **Uniswap V3**: Pool creation, fee collection, sponsored liquidity on Celo (NonfungiblePositionManager, V3Factory)
- **Uniswap V4**: StateView for pool monitoring, admin LP management on Celo (PoolManager singleton, Permit2 approvals)
- **Drizzle ORM**: Database schema and queries
- **Express.js**: HTTP server and API routing

## Recent Changes
- 2026-02-09: EVM-universal wallet messaging — updated index.html, agent.html, economy.html, developers.html, skill.md, and agent-economy.md to clarify that wallet addresses work on any EVM chain (Celo, Base, Ethereum, Arbitrum, etc.), Celo is the default operating chain for ERC-8004 identity, token deployment, gas subsidies, and SELFCLAW sponsorship, and agents can bridge tokens to other chains via Wormhole
- 2026-02-09: Whitepaper & vision page updates — added 838% fee tier explanation in tokenomics section, replaced "locked forever" liquidity claims with accurate sponsor-wallet language in both pages, added Risks & Limitations section (smart contract, bridge, passport coverage, liquidity, regulatory, early-stage), labeled sections 08-11 as "Future Vision", renumbered roadmap to Section 13
- 2026-02-09: Fixed REPLIT_DOMAINS handling — getCanonicalDomain() splits comma-separated domains and selects canonical (.ai/.com/.app) for callbacks and agentURIs
- 2026-02-09: Added agent profile pages — /agent/:name with 7 sections (identity, ERC-8004, wallet, token, market data, tokenomics, activity); enhanced /registry with agent names, token badges, clickable profiles; new /v1/agents and /v1/agent-profile/:name API endpoints with enriched data (left joins to wallets, pools, plans, deduplication)
- 2026-02-09: Added tokenomics planning — new tokenPlans table, POST /v1/token-plan and GET /v1/token-plan/:humanId endpoints; deploy-token accepts optional tokenPlanId; plans include purpose, supply reasoning, allocation, utility, economic model
- 2026-02-09: Added duplicate agent name validation — case-insensitive check on start-verification, suggests alternatives if name taken
- 2026-02-09: Added verification status polling — GET /v1/verification-status/:sessionId for programmatic verification flow (pending/verified/expired)
- 2026-02-09: Fixed ERC-8004 agentURI to use canonical selfclaw.ai domain; sign-challenge now accepts both hex and base64 signatures
- 2026-02-09: Updated skill.md with programmatic verification as primary flow, agent-economy.md with token plan step, wallet generation snippets, consistent auth fields
- 2026-02-09: Fixed critical truncated ERC20 bytecode (was 986 bytes, now 2573 bytes) — recompiled with solc 0.8.24, full ERC20 with constructor(name,symbol,initialSupply), transfer, approve, transferFrom, allowance, balanceOf, totalSupply, decimals, events
- 2026-02-09: Added gas subsidy retry — agents can request gas again if previous deployment failed (no token_registered event in activity log), prevents agents from being permanently locked out after failed deploys
- 2026-02-09: Improved deploy-token response — gas estimation with 20% buffer, wallet balance check, hasSufficientGas flag, bytecodeSize, nextSteps array, troubleshooting section
- 2026-02-09: Fixed signature handling — extractRawEd25519Key and decodeSignature now accept 0x-prefixed hex, raw hex, and base64 for both keys and signatures; better error messages showing accepted formats
- 2026-02-08: Added register-token endpoint (verifies on-chain), pool tracking on sponsorship (inserts into trackedPools), background DexScreener price updater (every 5min), updated agent-economy.md/skill.md/economy.html/developers.html with accurate flow and new endpoints
- 2026-02-08: Migrated to full self-custody model — removed all server-side private key storage and encryption, create-wallet now requires walletAddress param (registers address only), all transaction endpoints (deploy-token, transfer-token) always return unsigned tx data, removed encryptedPrivateKey and salt columns from agent_wallets table, simplified switch-wallet to address-update-only, removed Option A/B distinction (everything is self-custody now), updated skill.md and agent-economy.md docs
- 2026-02-08: Landing page metrics now hidden until 3+ tokens deployed (was 10+ verified agents)
- 2026-02-08: Added wallet switching and Option B economy support — new switch-wallet endpoint for switching between managed/external wallets with auto fund draining; deploy-token and transfer-token now return unsigned transaction data for external wallets instead of blocking; sponsorship works for both wallet types
- 2026-02-08: Migrated sponsorship to Uniswap V3 — new lib/uniswap-v3.ts with V3 NonfungiblePositionManager integration, auto fee collection from SELFCLAW/CELO V3 pool (0x2728F9cd), sponsorship uses 50% of SELFCLAW balance, creates AgentToken/SELFCLAW V3 pools with 1% fee tier; deprecated create-sponsored-lp endpoint
- 2026-02-08: Added admin pool info & token prices — live SELFCLAW/CELO pool state from V4 StateView (tick, liquidity, fee, on-chain price), DexScreener price feeds for Base and Celo (USD price, 24h change, volume, liquidity, DEX links)
- 2026-02-08: Added fully automatic Wormhole bridge flow — auto-bridge endpoint submits Base transfer, polls for VAA every 15s (up to 20min), and auto-completes on Celo; background auto-claimer processes pending bridge transactions on server start; admin UI shows live progress with phase indicators
- 2026-02-08: Migrated from Uniswap V3 to V4 — updated contract addresses (PoolManager, PositionManager, UniversalRouter, Permit2), ABIs (modifyLiquidities, action-based encoding), stored SELFCLAW/CELO pool ID (0x92bf22b...), renamed lib/uniswap-v3.ts → lib/uniswap-v4.ts, updated all docs
- 2026-02-08: Added SELFCLAW sponsorship endpoints — agents can check available SELFCLAW and request one-time sponsorship for AgentToken/SELFCLAW pool creation (1% fee tier), with eligibility checks (one per humanId), token balance verification, and slippage protection on swaps
- 2026-02-08: Added Uniswap V4 integration (lib/uniswap-v4.ts) — fee collection, CELO→SELFCLAW swaps, pool creation, position management, token balance queries
- 2026-02-08: Added admin LP management UI — collect fees, swap CELO to SELFCLAW, create pools, check positions and balances
- 2026-02-07: Added admin dashboard (/admin) — password-gated admin page with wallet overview (Base + Celo balances), Wormhole bridge controls (attest, bridge, complete), registry stats, and activity log
- 2026-02-07: Added Wormhole bridge service (lib/wormhole-bridge.ts) — token attestation, cross-chain transfers (Base→Celo), wrapped token queries, wallet balance checks
- 2026-02-07: Added $SELFCLAW Whitepaper (/whitepaper) — structured document covering fair-launch tokenomics (Clanker/Bankr, zero team supply), fee recycling flywheel (Base fees → Celo bridging → buyback → sponsored LP), cross-chain architecture, agent token ecosystem, autonomous commerce, governance, skill marketplace, and roadmap
- 2026-02-07: Added Vision page (/vision) — comprehensive agent economy manifesto covering $SELFCLAW token, agent-owned tokens, permanent liquidity, autonomous commerce, DAOs, skill marketplace, business models, and trust infrastructure
- 2026-02-07: Added public performance dashboard with activity logging, charts, and auto-refresh
- 2026-02-07: Added wallet verification lookup endpoint for games/dApps
- 2026-02-06: Removed ClawPit cockpit feature for open-source release
- 2026-02-06: Rebranded from OpenClaw to SelfClaw
- 2026-02-06: Added MIT license, contributing guide, .env.example
- 2026-02-06: Cleaned debug logging, extracted constants
