# OpenClaw Experimentation Platform on Replit

A turnkey, cloud-based setup for experimenting with [OpenClaw](https://github.com/openclaw/openclaw), an open-source personal AI assistant framework.

## Overview

This Replit project provides:
- Node.js 22+ environment for OpenClaw
- Web-based control panel for management
- Pre-configured directory structure
- Setup scripts and documentation
- Environment variable templates for API keys

## Quick Start

### 1. Run the Control Panel

Click "Run" or the control panel will start automatically. Access it via the Webview.

### 2. Initial Setup

From the control panel, click **"Run Initial Setup"** to:
- Create the `.openclaw` directory structure
- Generate default configuration
- Create a sample skill

### 3. Configure API Keys

Add your API keys in **Replit Secrets** (Tools > Secrets):

| Secret Name | Description | Required |
|-------------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models | One AI provider required |
| `OPENAI_API_KEY` | OpenAI API key for GPT models | One AI provider required |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Optional |
| `DISCORD_BOT_TOKEN` | Discord bot token | Optional |
| `SLACK_BOT_TOKEN` | Slack bot token | Optional |

### 4. Install OpenClaw

From the control panel, click **"Install OpenClaw"** or run in Shell:
```bash
npm install -g openclaw@latest
```

### 5. Run Onboarding

In the Shell, run:
```bash
openclaw onboard
```

**Important**: Skip the `--install-daemon` flag as Replit doesn't support persistent services.

### 6. Start the Gateway

From the control panel, click **"Start Gateway"** or run in Shell:
```bash
openclaw gateway --port 18789 --verbose
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `openclaw onboard` | Interactive setup wizard |
| `openclaw gateway --port 18789 --verbose` | Start the AI gateway |
| `openclaw status` | Check gateway status |
| `openclaw skills install <name>` | Install a skill from ClawHub |
| `openclaw skills list` | List installed skills |
| `openclaw skills create <name>` | Create a new custom skill |

## Configuration

### Main Config File
Located at `~/.openclaw/openclaw.json`

Edit via the Control Panel's Configuration Editor or directly in Shell.

### Default Configuration Structure
```json
{
  "version": "1.0",
  "gateway": {
    "port": 18789,
    "host": "0.0.0.0"
  },
  "agents": {
    "default": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "fallback": {
        "provider": "openai",
        "model": "gpt-4o"
      }
    }
  },
  "channels": {
    "telegram": { "enabled": false },
    "discord": { "enabled": false },
    "webchat": { "enabled": true }
  }
}
```

## Directory Structure

```
~/.openclaw/
  openclaw.json          # Main configuration
  workspace/
    skills/              # Custom skills directory
      hello-world/       # Sample skill (created by setup)
```

## Custom Skills

### Sample Skill Location
`~/.openclaw/workspace/skills/hello-world/index.js`

### Creating a Custom Skill
```bash
openclaw skills create my-skill
```

Or manually create in `~/.openclaw/workspace/skills/my-skill/index.js`:

```javascript
export default {
  name: 'my-skill',
  description: 'My custom skill',
  version: '1.0.0',
  
  triggers: [
    { pattern: /^my command$/i, handler: 'myHandler' }
  ],
  
  handlers: {
    myHandler: async (context) => {
      return { text: 'Response from my skill!' };
    }
  }
};
```

## Messaging Channels

### Telegram
1. Create a bot via [@BotFather](https://t.me/botfather)
2. Add `TELEGRAM_BOT_TOKEN` to Replit Secrets
3. Enable in config: `"telegram": { "enabled": true }`

### Discord
1. Create app at [Discord Developer Portal](https://discord.com/developers)
2. Add `DISCORD_BOT_TOKEN` to Replit Secrets
3. Enable in config: `"discord": { "enabled": true }`

## Troubleshooting

### Gateway Won't Start
- Verify OpenClaw is installed: `openclaw --version`
- Check API keys are set in Secrets
- Review error messages in gateway output

### Port Issues
- Control panel runs on port 5000
- Gateway runs on port 18789
- Both should be accessible via Replit's webview

### Resource Limits
- Free tier: Limited CPU/RAM, may timeout
- Consider upgrading for persistent running
- Use "Always On" feature (paid) for 24/7 operation

### Configuration Not Found
- Run setup from Control Panel
- Or run: `node scripts/setup.js`

## Replit-Specific Notes

1. **No Daemon Support**: Skip `--install-daemon` during onboarding
2. **Use Secrets**: Never hardcode API keys in files
3. **Persistence**: Repl may sleep on free tier; use paid for always-on
4. **Port Access**: Use Replit's webview URL for external access

## Use Cases

- Morning briefings and task summaries
- Email and calendar automation
- Content creation pipelines
- Code review and deployment automation
- Smart home integrations
- Custom workflow orchestration

## Resources

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [ClawHub Skills Registry](https://clawhub.io)
- [Replit Documentation](https://docs.replit.com)

## Project Structure

```
/
  package.json           # Project dependencies
  server.js              # Control panel server
  scripts/
    setup.js             # Initial setup script
  public/
    index.html           # Control panel UI
    styles.css           # Styling
    app.js               # Frontend logic
  README.md              # This file
```

---

**Version**: 1.0.0  
**Last Updated**: January 30, 2026
