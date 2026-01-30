document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadEnvCheck();
  loadConfig();

  document.getElementById('refresh-status').addEventListener('click', loadStatus);
  document.getElementById('run-setup').addEventListener('click', runSetup);
  document.getElementById('install-openclaw').addEventListener('click', installOpenClaw);
  document.getElementById('start-gateway').addEventListener('click', startGateway);
  document.getElementById('stop-gateway').addEventListener('click', stopGateway);
  document.getElementById('load-config').addEventListener('click', loadConfig);
  document.getElementById('save-config').addEventListener('click', saveConfig);

  setInterval(loadStatus, 10000);
});

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    
    document.getElementById('node-version').textContent = status.nodeVersion;
    document.getElementById('node-version').className = 'value success';
    
    const openclawEl = document.getElementById('openclaw-version');
    if (status.openclawInstalled) {
      openclawEl.textContent = status.openclawVersion;
      openclawEl.className = 'value success';
    } else {
      openclawEl.textContent = 'Not installed';
      openclawEl.className = 'value warning';
    }
    
    const configEl = document.getElementById('config-status');
    if (status.configExists) {
      configEl.textContent = 'Found';
      configEl.className = 'value success';
    } else {
      configEl.textContent = 'Not found';
      configEl.className = 'value warning';
    }
    
    const gatewayEl = document.getElementById('gateway-status');
    if (status.gatewayRunning) {
      gatewayEl.textContent = 'Running';
      gatewayEl.className = 'value success';
    } else {
      gatewayEl.textContent = 'Stopped';
      gatewayEl.className = 'value danger';
    }
  } catch (error) {
    console.error('Failed to load status:', error);
  }
}

async function loadEnvCheck() {
  try {
    const res = await fetch('/api/env-check');
    const envVars = await res.json();
    
    updateEnvStatus('env-anthropic', envVars.ANTHROPIC_API_KEY);
    updateEnvStatus('env-openai', envVars.OPENAI_API_KEY);
    updateEnvStatus('env-telegram', envVars.TELEGRAM_BOT_TOKEN);
    updateEnvStatus('env-discord', envVars.DISCORD_BOT_TOKEN);
    updateEnvStatus('env-slack', envVars.SLACK_BOT_TOKEN);
  } catch (error) {
    console.error('Failed to check env vars:', error);
  }
}

function updateEnvStatus(elementId, isSet) {
  const el = document.getElementById(elementId);
  if (isSet) {
    el.textContent = 'Set';
    el.className = 'env-status set';
  } else {
    el.textContent = 'Not set';
    el.className = 'env-status not-set';
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const config = await res.json();
      document.getElementById('config-editor').value = JSON.stringify(config, null, 2);
    } else {
      document.getElementById('config-editor').value = '// Configuration not found. Run setup first.';
    }
  } catch (error) {
    document.getElementById('config-editor').value = '// Error loading configuration: ' + error.message;
  }
}

async function saveConfig() {
  const editor = document.getElementById('config-editor');
  try {
    const config = JSON.parse(editor.value);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const result = await res.json();
    if (result.success) {
      alert('Configuration saved successfully!');
    } else {
      alert('Failed to save: ' + result.error);
    }
  } catch (error) {
    alert('Invalid JSON: ' + error.message);
  }
}

async function runSetup() {
  const outputBox = document.getElementById('setup-output');
  outputBox.textContent = 'Running setup...';
  
  try {
    const res = await fetch('/api/setup', { method: 'POST' });
    const result = await res.json();
    if (result.success) {
      outputBox.textContent = 'Setup completed successfully!';
      loadStatus();
      loadConfig();
    } else {
      outputBox.textContent = 'Setup failed: ' + result.error;
    }
  } catch (error) {
    outputBox.textContent = 'Error: ' + error.message;
  }
}

async function installOpenClaw() {
  const outputBox = document.getElementById('setup-output');
  outputBox.textContent = 'Installing OpenClaw... This may take a few minutes.';
  
  try {
    const res = await fetch('/api/install-openclaw', { method: 'POST' });
    const result = await res.json();
    if (result.success) {
      outputBox.textContent = 'OpenClaw installed successfully!\n\n' + (result.output || '');
      loadStatus();
    } else {
      outputBox.textContent = 'Installation failed: ' + result.error + '\n\n' + (result.output || '');
    }
  } catch (error) {
    outputBox.textContent = 'Error: ' + error.message;
  }
}

async function startGateway() {
  const outputBox = document.getElementById('gateway-output');
  outputBox.textContent = 'Starting gateway on port 18789...';
  
  try {
    const res = await fetch('/api/gateway/start', { method: 'POST' });
    const result = await res.json();
    if (result.success) {
      outputBox.textContent = 'Gateway started! PID: ' + result.pid + '\nListening on port 18789';
    } else {
      outputBox.textContent = result.message || 'Failed to start gateway';
    }
    loadStatus();
  } catch (error) {
    outputBox.textContent = 'Error: ' + error.message;
  }
}

async function stopGateway() {
  const outputBox = document.getElementById('gateway-output');
  outputBox.textContent = 'Stopping gateway...';
  
  try {
    const res = await fetch('/api/gateway/stop', { method: 'POST' });
    const result = await res.json();
    outputBox.textContent = result.message || 'Gateway stopped';
    loadStatus();
  } catch (error) {
    outputBox.textContent = 'Error: ' + error.message;
  }
}
