# OpenClaw Experimentation Platform

## Overview
This is an experimentation platform for OpenClaw, an open-source personal AI assistant framework. It provides a web-based control panel for managing OpenClaw installation, configuration, and gateway operations on Replit.

## Project Architecture

### Stack
- **Runtime**: Node.js 22+
- **Backend**: Express.js (server.js) - Control panel API on port 5000
- **Frontend**: Vanilla HTML/CSS/JS (public/) - Control panel UI
- **External**: OpenClaw CLI (installed globally via npm)

### Key Files
- `server.js` - Express server providing REST API for OpenClaw management
- `scripts/setup.js` - Initial setup script creating directories and configs
- `public/index.html` - Control panel UI
- `public/app.js` - Frontend JavaScript
- `public/styles.css` - Styling

### OpenClaw Paths
- `~/.openclaw/openclaw.json` - Main configuration
- `~/.openclaw/workspace/skills/` - Custom skills directory

## Recent Changes
- **January 30, 2026**: Initial project setup
  - Created Node.js 22 environment
  - Built web control panel with Express backend
  - Added setup scripts and configuration templates
  - Created comprehensive documentation

## User Preferences
- Focus on experimentation and ease of use
- Prefer web-based management over CLI
- Security through Replit Secrets for API keys

## Key Decisions
1. Control panel on port 5000 (Replit standard)
2. OpenClaw gateway on port 18789 (OpenClaw default)
3. No daemon installation (Replit limitation)
4. Global npm install for OpenClaw CLI
