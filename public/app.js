let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
  loadAuthState();
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
  document.getElementById('create-agent').addEventListener('click', createAgent);

  setInterval(() => {
    loadStatus();
    loadWalletStatus();
  }, 15000);
});

async function loadAuthState() {
  const loadingEl = document.getElementById('auth-loading');
  const loggedOutEl = document.getElementById('auth-logged-out');
  const loggedInEl = document.getElementById('auth-logged-in');
  const agentsSection = document.getElementById('agents-section');

  try {
    const res = await fetch('/api/auth/user');
    if (res.ok) {
      currentUser = await res.json();
      loadingEl.style.display = 'none';
      loggedOutEl.style.display = 'none';
      loggedInEl.style.display = 'flex';
      agentsSection.style.display = 'block';

      document.getElementById('user-name').textContent = 
        currentUser.firstName || currentUser.email || 'User';
      if (currentUser.profileImageUrl) {
        document.getElementById('user-avatar').src = currentUser.profileImageUrl;
        document.getElementById('user-avatar').style.display = 'block';
      }

      loadAgents();
    } else {
      currentUser = null;
      loadingEl.style.display = 'none';
      loggedOutEl.style.display = 'block';
      loggedInEl.style.display = 'none';
      agentsSection.style.display = 'none';
    }
  } catch (error) {
    console.error('Auth check failed:', error);
    loadingEl.style.display = 'none';
    loggedOutEl.style.display = 'block';
    loggedInEl.style.display = 'none';
    agentsSection.style.display = 'none';
  }
}

async function loadAgents() {
  const listEl = document.getElementById('agents-list');
  listEl.innerHTML = '<div class="loading">Loading agents...</div>';

  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error('Failed to load agents');
    const agents = await res.json();

    if (agents.length === 0) {
      listEl.innerHTML = '<div class="no-agents">No agents yet. Create your first agent below.</div>';
      return;
    }

    listEl.innerHTML = agents.map(agent => `
      <div class="agent-card">
        <div class="agent-header">
          <span class="agent-name">${escapeHtml(agent.name)}</span>
          <span class="agent-status ${agent.status}">${agent.status.toUpperCase()}</span>
        </div>
        ${agent.description ? `<div class="agent-desc">${escapeHtml(agent.description)}</div>` : ''}
        <div class="agent-details">
          <div class="agent-detail">
            <span class="detail-label">CREDITS</span>
            <span class="detail-value credits-value">${parseFloat(agent.credits || 0).toFixed(2)}</span>
          </div>
          ${agent.tbaAddress ? `
            <div class="agent-detail">
              <span class="detail-label">WALLET</span>
              <code class="detail-value wallet-address">${agent.tbaAddress.slice(0, 8)}...${agent.tbaAddress.slice(-6)}</code>
            </div>
          ` : ''}
          <div class="agent-detail">
            <span class="detail-label">CREATED</span>
            <span class="detail-value">${new Date(agent.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        <div class="agent-actions">
          <button class="btn btn-sm" onclick="viewWallet('${agent.id}')">WALLET</button>
          <button class="btn btn-sm" onclick="testAI('${agent.id}')">TEST AI</button>
          <button class="btn btn-sm btn-outline" onclick="viewRegistration('${agent.id}')">REG FILE</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    listEl.innerHTML = `<div class="error">Error: ${error.message}</div>`;
  }
}

async function createAgent() {
  const nameInput = document.getElementById('agent-name');
  const descInput = document.getElementById('agent-description');
  const outputEl = document.getElementById('agent-output');
  
  const name = nameInput.value.trim();
  if (!name) {
    outputEl.style.display = 'block';
    outputEl.textContent = 'Please enter an agent name.';
    return;
  }

  outputEl.style.display = 'block';
  outputEl.textContent = 'Creating agent...';

  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: descInput.value.trim() || null
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create agent');
    }

    const agent = await res.json();
    outputEl.textContent = `Agent "${agent.name}" created successfully!`;
    nameInput.value = '';
    descInput.value = '';
    loadAgents();
  } catch (error) {
    outputEl.textContent = 'Error: ' + error.message;
  }
}

async function viewRegistration(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/registration`);
    const data = await res.json();
    alert('ERC-8004 Registration:\n\n' + JSON.stringify(data, null, 2));
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function viewPayments(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/payments`);
    const payments = await res.json();
    if (payments.length === 0) {
      alert('No payments recorded for this agent yet.');
    } else {
      alert('Agent Payments:\n\n' + JSON.stringify(payments, null, 2));
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function viewWallet(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/wallet`);
    const wallet = await res.json();
    
    let message = `Agent Wallet\n\n`;
    message += `Credits: ${parseFloat(wallet.credits || 0).toFixed(2)}\n`;
    
    if (wallet.walletEnabled) {
      message += `\nOn-Chain Wallet:\n`;
      message += `Address: ${wallet.address}\n`;
      message += `USDC: ${wallet.usdc}\n`;
      message += `CELO: ${wallet.celo}\n`;
    } else {
      message += `\nOn-chain wallet not configured. Add CELO_PRIVATE_KEY to enable.`;
    }
    
    alert(message);
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function testAI(agentId) {
  const userMessage = prompt('Enter a message to test your agent:');
  if (!userMessage) return;
  
  try {
    const res = await fetch(`/api/agents/${agentId}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    
    const result = await res.json();
    
    if (res.status === 402) {
      alert(`Insufficient credits!\n\nRequired: ${result.required}\nAvailable: ${result.available}\n\nAdd more credits to continue.`);
      return;
    }
    
    if (res.status === 503) {
      alert('No AI provider configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to Secrets.');
      return;
    }
    
    if (!res.ok) {
      alert('Error: ' + (result.error || 'Unknown error'));
      return;
    }
    
    let responseText = '';
    if (result.response?.content?.[0]?.text) {
      responseText = result.response.content[0].text;
    } else if (result.response?.choices?.[0]?.message?.content) {
      responseText = result.response.choices[0].message.content;
    } else {
      responseText = JSON.stringify(result.response, null, 2);
    }
    
    alert(`AI Response:\n\n${responseText}\n\n---\nCredits used: ${result.creditsUsed}\nCredits remaining: ${result.creditsRemaining}`);
    loadAgents();
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
