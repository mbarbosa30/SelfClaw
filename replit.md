# OpenClaw Experimentation Platform

## Overview
This is an experimentation platform for OpenClaw, an open-source personal AI assistant framework. It provides a web-based control panel for managing OpenClaw installation, configuration, and gateway operations on Replit. Includes experimental x402 + Celo integration for onchain micropayments between AI agents.

## Project Architecture

### Stack
- **Runtime**: Node.js 22+
- **Backend**: Express.js (server.js) - Control panel API on port 5000
- **Frontend**: Vanilla HTML/CSS/JS (public/) - Control panel UI with minimalist/brutalist design
- **Blockchain**: Celo network with USDC for x402 payments
- **External**: OpenClaw CLI (installed globally via npm)

### Key Files
- `server.js` - Express server providing REST API for OpenClaw management
- `scripts/setup.js` - Initial setup script creating directories and configs
- `lib/wallet.js` - Celo wallet management (viem)
- `lib/x402-client.js` - x402 payment client for outbound requests
- `lib/x402-middleware.js` - x402 middleware for accepting payments
- `lib/payments.js` - Unified payment management interface
- `public/index.html` - Control panel UI
- `public/app.js` - Frontend JavaScript
- `public/styles.css` - Minimalist/brutalist styling

### OpenClaw Paths
- `~/.openclaw/openclaw.json` - Main configuration
- `~/.openclaw/workspace/skills/` - Custom skills directory

## Recent Changes
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

## Key Decisions
1. Control panel on port 5000 (Replit standard)
2. OpenClaw gateway on port 18789 (OpenClaw default)
3. No daemon installation (Replit limitation)
4. Global npm install for OpenClaw CLI
5. Celo network for x402 payments (low fees, native USDC)
6. viem library for blockchain interactions
