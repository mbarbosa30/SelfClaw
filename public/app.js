document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadEnvCheck();
  loadConfig();
  loadWalletStatus();

  document.getElementById('refresh-status').addEventListener('click', () => {
    loadStatus();
    loadWalletStatus();
  });
  document.getElementById('run-setup').addEventListener('click', runSetup);
  document.getElementById('install-openclaw').addEventListener('click', installOpenClaw);
  document.getElementById('start-gateway').addEventListener('click', startGateway);
  document.getElementById('stop-gateway').addEventListener('click', stopGateway);
  document.getElementById('load-config').addEventListener('click', loadConfig);
  document.getElementById('save-config').addEventListener('click', saveConfig);

  setInterval(() => {
    loadStatus();
    loadWalletStatus();
  }, 15000);
});

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    
    const nodeEl = document.getElementById('node-version');
    nodeEl.textContent = status.nodeVersion;
    nodeEl.className = 'status-value ok';
    
    const openclawEl = document.getElementById('openclaw-version');
    if (status.openclawInstalled) {
      openclawEl.textContent = status.openclawVersion;
      openclawEl.className = 'status-value ok';
    } else {
      openclawEl.textContent = 'NOT INSTALLED';
      openclawEl.className = 'status-value warn';
    }
    
    const configEl = document.getElementById('config-status');
    if (status.configExists) {
      configEl.textContent = 'READY';
      configEl.className = 'status-value ok';
    } else {
      configEl.textContent = 'NOT FOUND';
      configEl.className = 'status-value warn';
    }
    
    const gatewayEl = document.getElementById('gateway-status');
    if (status.gatewayRunning) {
      gatewayEl.textContent = 'RUNNING';
      gatewayEl.className = 'status-value ok';
    } else {
      gatewayEl.textContent = 'STOPPED';
      gatewayEl.className = 'status-value err';
    }
  } catch (error) {
    console.error('Failed to load status:', error);
  }
}

async function loadEnvCheck() {
  try {
    const res = await fetch('/api/env-check');
    const envVars = await res.json();
    
    setEnvBadge('env-anthropic', envVars.ANTHROPIC_API_KEY);
    setEnvBadge('env-openai', envVars.OPENAI_API_KEY);
    setEnvBadge('env-telegram', envVars.TELEGRAM_BOT_TOKEN);
    setEnvBadge('env-discord', envVars.DISCORD_BOT_TOKEN);
    setEnvBadge('env-celo', envVars.CELO_PRIVATE_KEY);
  } catch (error) {
    console.error('Failed to check env vars:', error);
  }
}

function setEnvBadge(id, isSet) {
  const el = document.getElementById(id);
  if (isSet) {
    el.textContent = 'SET';
    el.className = 'env-badge set';
  } else {
    el.textContent = 'NOT SET';
    el.className = 'env-badge not-set';
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const config = await res.json();
      document.getElementById('config-editor').value = JSON.stringify(config, null, 2);
    } else {
      document.getElementById('config-editor').value = '// Config not found. Run setup first.';
    }
  } catch (error) {
    document.getElementById('config-editor').value = '// Error: ' + error.message;
  }
}

async function saveConfig() {
  const editor = document.getElementById('config-editor');
  const output = document.getElementById('output-box');
  try {
    const config = JSON.parse(editor.value);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const result = await res.json();
    output.textContent = result.success ? 'Configuration saved.' : 'Error: ' + result.error;
  } catch (error) {
    output.textContent = 'Invalid JSON: ' + error.message;
  }
}

async function runSetup() {
  const output = document.getElementById('output-box');
  output.textContent = 'Running setup...';
  
  try {
    const res = await fetch('/api/setup', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.success 
      ? 'Setup complete. Directories and config created.'
      : 'Error: ' + result.error;
    loadStatus();
    loadConfig();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function installOpenClaw() {
  const output = document.getElementById('output-box');
  output.textContent = 'Installing OpenClaw... This may take a few minutes.';
  
  try {
    const res = await fetch('/api/install-openclaw', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.success 
      ? 'OpenClaw installed successfully.\n\n' + (result.output || '')
      : 'Error: ' + result.error + '\n' + (result.output || '');
    loadStatus();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function startGateway() {
  const output = document.getElementById('output-box');
  output.textContent = 'Starting gateway on port 18789...';
  
  try {
    const res = await fetch('/api/gateway/start', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.success 
      ? 'Gateway started. PID: ' + result.pid
      : result.message || 'Failed to start gateway';
    loadStatus();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function stopGateway() {
  const output = document.getElementById('output-box');
  output.textContent = 'Stopping gateway...';
  
  try {
    const res = await fetch('/api/gateway/stop', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.message || 'Gateway stopped.';
    loadStatus();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function loadWalletStatus() {
  try {
    const [statusRes, balanceRes] = await Promise.all([
      fetch('/api/payments/status'),
      fetch('/api/payments/balance')
    ]);
    
    const status = await statusRes.json();
    const balance = await balanceRes.json();
    
    const statusEl = document.getElementById('wallet-status');
    const usdcEl = document.getElementById('wallet-usdc');
    const celoEl = document.getElementById('wallet-celo');
    const addressEl = document.getElementById('wallet-address');
    
    if (status.initialized) {
      statusEl.textContent = 'CONNECTED';
      statusEl.className = 'wallet-value ok';
      addressEl.textContent = status.address;
      
      if (balance.usdc !== undefined) {
        usdcEl.textContent = parseFloat(balance.usdc).toFixed(4) + ' USDC';
        usdcEl.className = 'wallet-value' + (parseFloat(balance.usdc) > 0 ? ' ok' : '');
      }
      
      if (balance.celo !== undefined) {
        celoEl.textContent = parseFloat(balance.celo).toFixed(4) + ' CELO';
        celoEl.className = 'wallet-value' + (parseFloat(balance.celo) > 0 ? ' ok' : '');
      }
    } else {
      statusEl.textContent = 'NOT CONFIGURED';
      statusEl.className = 'wallet-value warn';
      usdcEl.textContent = '—';
      celoEl.textContent = '—';
      addressEl.textContent = 'Add CELO_PRIVATE_KEY to Secrets';
    }
  } catch (error) {
    console.error('Failed to load wallet status:', error);
  }
}
