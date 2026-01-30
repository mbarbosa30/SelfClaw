#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');
const WORKSPACE_DIR = join(OPENCLAW_DIR, 'workspace');
const SKILLS_DIR = join(WORKSPACE_DIR, 'skills');

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║       OpenClaw Experimentation Platform - Setup            ║');
console.log('║                      on Replit                             ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0]);
  console.log(`[CHECK] Node.js version: ${version}`);
  if (major < 22) {
    console.error('[ERROR] Node.js ≥22 is required. Current version:', version);
    process.exit(1);
  }
  console.log('[OK] Node.js version meets requirements');
}

function checkOpenClawInstalled() {
  try {
    const version = execSync('openclaw --version 2>/dev/null', { encoding: 'utf8' }).trim();
    console.log(`[OK] OpenClaw is installed: ${version}`);
    return true;
  } catch {
    console.log('[INFO] OpenClaw is not installed yet');
    return false;
  }
}

function installOpenClaw() {
  console.log('[INSTALL] Installing OpenClaw globally...');
  try {
    execSync('npm install -g openclaw@latest', { stdio: 'inherit' });
    console.log('[OK] OpenClaw installed successfully');
    return true;
  } catch (error) {
    console.error('[ERROR] Failed to install OpenClaw:', error.message);
    console.log('[INFO] You can try manual installation: npm install -g openclaw@latest');
    return false;
  }
}

function createDirectories() {
  console.log('[SETUP] Creating OpenClaw directories...');
  
  const dirs = [OPENCLAW_DIR, WORKSPACE_DIR, SKILLS_DIR];
  
  dirs.forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`[OK] Created: ${dir}`);
    } else {
      console.log(`[OK] Exists: ${dir}`);
    }
  });
}

function createDefaultConfig() {
  if (existsSync(CONFIG_FILE)) {
    console.log('[OK] Configuration file already exists');
    return;
  }
  
  console.log('[SETUP] Creating default configuration...');
  
  const defaultConfig = {
    version: "1.0",
    gateway: {
      port: 18789,
      host: "0.0.0.0"
    },
    agents: {
      default: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        fallback: {
          provider: "openai",
          model: "gpt-4o"
        }
      }
    },
    channels: {
      telegram: {
        enabled: false,
        token: "${TELEGRAM_BOT_TOKEN}"
      },
      discord: {
        enabled: false,
        token: "${DISCORD_BOT_TOKEN}"
      },
      slack: {
        enabled: false,
        token: "${SLACK_BOT_TOKEN}"
      },
      webchat: {
        enabled: true,
        allowedOrigins: ["*"]
      }
    },
    security: {
      pairingPolicy: "dm_only",
      allowPublicChannels: false
    },
    skills: {
      bundled: [],
      workspace: []
    }
  };
  
  writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
  console.log(`[OK] Created configuration: ${CONFIG_FILE}`);
}

function createSampleSkill() {
  const sampleSkillDir = join(SKILLS_DIR, 'hello-world');
  const sampleSkillFile = join(sampleSkillDir, 'index.js');
  
  if (existsSync(sampleSkillFile)) {
    console.log('[OK] Sample skill already exists');
    return;
  }
  
  console.log('[SETUP] Creating sample skill...');
  
  mkdirSync(sampleSkillDir, { recursive: true });
  
  const sampleSkill = `export default {
  name: 'hello-world',
  description: 'A simple greeting skill for testing',
  version: '1.0.0',
  
  triggers: [
    { pattern: /^hello$/i, handler: 'greet' },
    { pattern: /^ping$/i, handler: 'ping' }
  ],
  
  handlers: {
    greet: async (context) => {
      return {
        text: \`Hello! I'm your OpenClaw assistant running on Replit. How can I help you today?\`
      };
    },
    
    ping: async (context) => {
      return {
        text: \`Pong! Gateway is responding at \${new Date().toISOString()}\`
      };
    }
  }
};
`;
  
  writeFileSync(sampleSkillFile, sampleSkill);
  console.log(`[OK] Created sample skill: ${sampleSkillFile}`);
}

function printNextSteps() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    Next Steps                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('1. Set up your API keys in Replit Secrets:');
  console.log('   - ANTHROPIC_API_KEY (for Claude models)');
  console.log('   - OPENAI_API_KEY (for GPT models)');
  console.log('   - TELEGRAM_BOT_TOKEN (optional, for Telegram)');
  console.log('   - DISCORD_BOT_TOKEN (optional, for Discord)');
  console.log('');
  console.log('2. Run the onboarding wizard:');
  console.log('   $ openclaw onboard');
  console.log('');
  console.log('3. Start the gateway:');
  console.log('   $ openclaw gateway --port 18789 --verbose');
  console.log('');
  console.log('4. Access the web control panel at the Replit webview URL');
  console.log('');
  console.log('5. Install skills from ClawHub:');
  console.log('   $ openclaw skills install <skill-name>');
  console.log('');
  console.log('For troubleshooting, see the README.md file.');
  console.log('');
}

async function main() {
  console.log('Starting setup process...\n');
  
  checkNodeVersion();
  console.log('');
  
  const isInstalled = checkOpenClawInstalled();
  if (!isInstalled) {
    console.log('');
    console.log('[INFO] OpenClaw will be installed when you run:');
    console.log('       npm run install-openclaw');
    console.log('');
  }
  
  createDirectories();
  console.log('');
  
  createDefaultConfig();
  console.log('');
  
  createSampleSkill();
  
  printNextSteps();
  
  console.log('[DONE] Setup complete!');
}

main().catch(console.error);
