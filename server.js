import express from 'express';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializePayments, getPaymentStatus, getBalance, getPaymentHistory, getTotalSpent, getTotalReceived, CELO_CONFIG } from './lib/payments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');
const WORKSPACE_DIR = join(OPENCLAW_DIR, 'workspace');
const SKILLS_DIR = join(WORKSPACE_DIR, 'skills');

let gatewayProcess = null;

function getSystemStatus() {
  const nodeVersion = process.version;
  let openclawVersion = 'Not installed';
  let openclawInstalled = false;
  
  try {
    openclawVersion = execSync('openclaw --version 2>/dev/null', { encoding: 'utf8' }).trim();
    openclawInstalled = true;
  } catch {}
  
  const configExists = existsSync(CONFIG_FILE);
  const gatewayRunning = gatewayProcess !== null && !gatewayProcess.killed;
  
  return {
    nodeVersion,
    openclawVersion,
    openclawInstalled,
    configExists,
    gatewayRunning,
    configPath: CONFIG_FILE,
    skillsPath: SKILLS_DIR
  };
}

function getConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

app.get('/api/status', (req, res) => {
  res.json(getSystemStatus());
});

app.get('/api/config', (req, res) => {
  const config = getConfig();
  if (config) {
    res.json(config);
  } else {
    res.status(404).json({ error: 'Configuration not found' });
  }
});

app.post('/api/config', (req, res) => {
  try {
    saveConfig(req.body);
    res.json({ success: true, message: 'Configuration saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/setup', (req, res) => {
  try {
    execSync('node scripts/setup.js', { encoding: 'utf8', stdio: 'pipe' });
    res.json({ success: true, message: 'Setup completed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/install-openclaw', (req, res) => {
  try {
    const output = execSync('npm install -g openclaw@latest 2>&1', { encoding: 'utf8' });
    res.json({ success: true, message: 'OpenClaw installed', output });
  } catch (error) {
    res.status(500).json({ error: error.message, output: error.stdout || error.stderr });
  }
});

app.post('/api/gateway/start', (req, res) => {
  if (gatewayProcess && !gatewayProcess.killed) {
    return res.json({ success: false, message: 'Gateway is already running' });
  }
  
  try {
    gatewayProcess = spawn('openclaw', ['gateway', '--port', '18789', '--verbose'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    let output = '';
    
    gatewayProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log('[Gateway]', data.toString());
    });
    
    gatewayProcess.stderr.on('data', (data) => {
      output += data.toString();
      console.error('[Gateway Error]', data.toString());
    });
    
    gatewayProcess.on('close', (code) => {
      console.log(`[Gateway] Process exited with code ${code}`);
      gatewayProcess = null;
    });
    
    res.json({ success: true, message: 'Gateway started', pid: gatewayProcess.pid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gateway/stop', (req, res) => {
  if (!gatewayProcess || gatewayProcess.killed) {
    return res.json({ success: false, message: 'Gateway is not running' });
  }
  
  try {
    gatewayProcess.kill('SIGTERM');
    gatewayProcess = null;
    res.json({ success: true, message: 'Gateway stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gateway/status', (req, res) => {
  const running = gatewayProcess !== null && !gatewayProcess.killed;
  res.json({ running, pid: running ? gatewayProcess.pid : null });
});

app.get('/api/env-check', (req, res) => {
  const envVars = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
    DISCORD_BOT_TOKEN: !!process.env.DISCORD_BOT_TOKEN,
    CELO_PRIVATE_KEY: !!process.env.CELO_PRIVATE_KEY
  };
  res.json(envVars);
});

app.get('/api/skills', (req, res) => {
  try {
    if (!existsSync(SKILLS_DIR)) {
      return res.json({ skills: [] });
    }
    
    const skills = readdirSync(SKILLS_DIR)
      .filter(name => statSync(join(SKILLS_DIR, name)).isDirectory())
      .map(name => ({ name, path: join(SKILLS_DIR, name) }));
    
    res.json({ skills });
  } catch (error) {
    res.json({ skills: [], error: error.message });
  }
});

app.get('/api/payments/status', async (req, res) => {
  try {
    const status = getPaymentStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payments/balance', async (req, res) => {
  try {
    const balance = await getBalance();
    res.json(balance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payments/history', (req, res) => {
  try {
    const history = getPaymentHistory();
    res.json({ 
      history,
      totalSpent: getTotalSpent(),
      totalReceived: getTotalReceived()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payments/config', (req, res) => {
  res.json({
    network: CELO_CONFIG,
    hasPrivateKey: !!process.env.CELO_PRIVATE_KEY
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`╔════════════════════════════════════════════════════════════╗`);
  console.log(`║     OpenClaw Control Panel running on port ${PORT}           ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log('');
  console.log(`Access the control panel at: http://0.0.0.0:${PORT}`);
  console.log('');
  
  const status = getSystemStatus();
  console.log('System Status:');
  console.log(`  Node.js: ${status.nodeVersion}`);
  console.log(`  OpenClaw: ${status.openclawVersion}`);
  console.log(`  Config: ${status.configExists ? 'Found' : 'Not found (run setup)'}`);
  console.log('');
  
  const paymentResult = initializePayments(process.env.CELO_PRIVATE_KEY);
  if (paymentResult.initialized) {
    console.log('Payments:');
    console.log(`  Network: Celo (${CELO_CONFIG.chainId})`);
    console.log(`  Address: ${paymentResult.address}`);
    console.log('');
  } else {
    console.log('Payments: Not configured (add CELO_PRIVATE_KEY to Secrets)');
    console.log('');
  }
});
