let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
  loadAuthState();
  loadStatus();
  loadEnvCheck();
  loadConfig();

  document.getElementById('run-setup')?.addEventListener('click', runSetup);
  document.getElementById('install-openclaw')?.addEventListener('click', installOpenClaw);
  document.getElementById('start-gateway')?.addEventListener('click', startGateway);
  document.getElementById('stop-gateway')?.addEventListener('click', stopGateway);
  document.getElementById('load-config')?.addEventListener('click', loadConfig);
  document.getElementById('save-config')?.addEventListener('click', saveConfig);
  document.getElementById('create-agent')?.addEventListener('click', createAgent);
  document.getElementById('create-agent-btn')?.addEventListener('click', toggleCreateForm);
  document.getElementById('cancel-create')?.addEventListener('click', toggleCreateForm);
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  setInterval(loadStatus, 30000);
});

function toggleCreateForm() {
  const form = document.getElementById('create-form');
  const btn = document.getElementById('create-agent-btn');
  const isHidden = form.classList.contains('hidden');
  form.classList.toggle('hidden', !isHidden);
  btn.classList.toggle('hidden', isHidden);
  if (isHidden) {
    document.getElementById('agent-name').focus();
  }
}

function openModal(title, content) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = content;
  document.getElementById('modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

async function loadAuthState() {
  const loadingEl = document.getElementById('auth-loading');
  const loggedOutEl = document.getElementById('auth-logged-out');
  const loggedInEl = document.getElementById('auth-logged-in');
  const agentsSection = document.getElementById('agents-section');
  const heroSignin = document.getElementById('hero-signin');

  try {
    const res = await fetch('/api/auth/user');
    if (res.ok) {
      currentUser = await res.json();
      loadingEl.style.display = 'none';
      loggedOutEl.style.display = 'none';
      loggedInEl.style.display = 'flex';
      agentsSection.style.display = 'block';
      if (heroSignin) heroSignin.style.display = 'none';

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
      listEl.innerHTML = `
        <div class="empty-state">
          <p>No agents yet. Create your first agent to get started.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = agents.map(agent => `
      <div class="agent-card">
        <div class="agent-header">
          <span class="agent-name">${escapeHtml(agent.name)}</span>
          <span class="agent-status ${agent.status}">${agent.status}</span>
        </div>
        ${agent.description ? `<div class="agent-desc">${escapeHtml(agent.description)}</div>` : ''}
        <div class="agent-stats">
          <div class="stat">
            <span class="stat-value">${parseFloat(agent.credits || 0).toFixed(2)}</span>
            <span class="stat-label">credits</span>
          </div>
          ${agent.tbaAddress ? `
            <div class="stat">
              <span class="stat-value wallet-addr">${agent.tbaAddress.slice(0, 6)}...${agent.tbaAddress.slice(-4)}</span>
              <span class="stat-label">wallet</span>
            </div>
          ` : ''}
        </div>
        <div class="agent-actions">
          <button class="btn btn-sm" onclick="testAI('${agent.id}')">Chat</button>
          <button class="btn btn-sm btn-outline" onclick="viewWallet('${agent.id}')">Wallet</button>
          <button class="btn btn-sm btn-outline" onclick="manageSecrets('${agent.id}')">API Keys</button>
          <button class="btn btn-sm btn-outline" onclick="viewRegistration('${agent.id}')">Identity</button>
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
    outputEl.textContent = `Agent "${agent.name}" created with 10 free credits!`;
    nameInput.value = '';
    descInput.value = '';
    setTimeout(() => {
      toggleCreateForm();
      outputEl.style.display = 'none';
    }, 2000);
    loadAgents();
  } catch (error) {
    outputEl.textContent = 'Error: ' + error.message;
  }
}

async function viewRegistration(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/registration`);
    const data = await res.json();
    
    const content = `
      <div class="modal-info">
        <p><strong>Name:</strong> ${escapeHtml(data.name)}</p>
        <p><strong>Wallet:</strong> <code>${data.wallet}</code></p>
        <p><strong>Network:</strong> ${data.network} (Chain ${data.chainId})</p>
        <h4>Services</h4>
        <ul>
          ${data.services.map(s => `<li><strong>${s.name}:</strong> <code>${s.endpoint}</code></li>`).join('')}
        </ul>
        <h4>Raw Registration</h4>
        <pre>${JSON.stringify(data, null, 2)}</pre>
      </div>
    `;
    openModal('Agent Identity (ERC-8004)', content);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function viewWallet(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/wallet`);
    const wallet = await res.json();
    
    let content = `
      <div class="modal-info">
        <div class="wallet-balance">
          <div class="balance-item">
            <span class="balance-value">${parseFloat(wallet.credits || 0).toFixed(2)}</span>
            <span class="balance-label">Platform Credits</span>
          </div>
        </div>
    `;
    
    if (wallet.walletEnabled) {
      content += `
        <hr>
        <h4>On-Chain Wallet</h4>
        <p><strong>Address:</strong> <code>${wallet.address}</code></p>
        <div class="wallet-balance">
          <div class="balance-item">
            <span class="balance-value">${parseFloat(wallet.usdc || 0).toFixed(4)}</span>
            <span class="balance-label">USDC</span>
          </div>
          <div class="balance-item">
            <span class="balance-value">${parseFloat(wallet.celo || 0).toFixed(4)}</span>
            <span class="balance-label">CELO</span>
          </div>
        </div>
        <p class="note">Send USDC on Celo network to fund this wallet.</p>
      `;
    } else {
      content += `
        <hr>
        <p class="note">On-chain wallet not configured. Platform needs CELO_PRIVATE_KEY in Secrets.</p>
      `;
    }
    
    content += '</div>';
    openModal('Agent Wallet', content);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function manageSecrets(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/secrets`);
    const secrets = await res.json();
    
    const services = [
      { name: 'openai', label: 'OpenAI', hint: 'sk-...' },
      { name: 'anthropic', label: 'Anthropic', hint: 'sk-ant-...' },
      { name: 'telegram', label: 'Telegram Bot', hint: 'Bot token from @BotFather' },
      { name: 'discord', label: 'Discord Bot', hint: 'Bot token from Discord Developer Portal' }
    ];
    
    const secretsMap = {};
    secrets.forEach(s => secretsMap[s.serviceName] = s);
    
    let content = `
      <div class="modal-info secrets-manager">
        <p class="note">Add your own API keys so your agent uses your accounts. Keys are stored securely and only used by this agent.</p>
        <div class="secrets-list">
    `;
    
    services.forEach(svc => {
      const hasKey = secretsMap[svc.name];
      content += `
        <div class="secret-item" data-service="${svc.name}">
          <div class="secret-header">
            <span class="secret-name">${svc.label}</span>
            <span class="secret-status ${hasKey ? 'set' : ''}">${hasKey ? 'Configured' : 'Not set'}</span>
          </div>
          <div class="secret-form ${hasKey ? 'hidden' : ''}">
            <input type="password" class="input secret-input" placeholder="${svc.hint}" />
            <button class="btn btn-sm" onclick="saveSecret('${agentId}', '${svc.name}', this)">Save</button>
          </div>
          ${hasKey ? `
            <div class="secret-actions">
              <button class="btn btn-sm btn-outline" onclick="showSecretForm('${svc.name}')">Update</button>
              <button class="btn btn-sm btn-danger" onclick="deleteSecret('${agentId}', '${svc.name}')">Remove</button>
            </div>
          ` : ''}
        </div>
      `;
    });
    
    content += `
        </div>
        <hr>
        <p class="note">Priority: Your API keys are used first, then Replit's built-in AI, then platform fallback.</p>
      </div>
    `;
    
    openModal('Agent API Keys', content);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

function showSecretForm(serviceName) {
  const item = document.querySelector(`.secret-item[data-service="${serviceName}"]`);
  if (item) {
    item.querySelector('.secret-form').classList.remove('hidden');
    item.querySelector('.secret-actions')?.classList.add('hidden');
  }
}

async function saveSecret(agentId, serviceName, btn) {
  const item = btn.closest('.secret-item');
  const input = item.querySelector('.secret-input');
  const apiKey = input.value.trim();
  
  if (!apiKey) {
    input.focus();
    return;
  }
  
  btn.disabled = true;
  btn.textContent = 'Saving...';
  
  try {
    const res = await fetch(`/api/agents/${agentId}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceName, apiKey })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save');
    }
    
    manageSecrets(agentId);
  } catch (error) {
    btn.disabled = false;
    btn.textContent = 'Save';
    item.querySelector('.secret-form').insertAdjacentHTML('beforeend', 
      `<div class="error">${error.message}</div>`);
  }
}

async function deleteSecret(agentId, serviceName) {
  if (!confirm(`Remove ${serviceName} API key from this agent?`)) return;
  
  try {
    const res = await fetch(`/api/agents/${agentId}/secrets/${serviceName}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to remove');
    }
    
    manageSecrets(agentId);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function testAI(agentId) {
  const content = `
    <div class="chat-interface">
      <div id="chat-messages" class="chat-messages"></div>
      <div class="chat-input-area">
        <input type="text" id="chat-input" class="input" placeholder="Type a message..." />
        <button id="chat-send" class="btn">Send</button>
      </div>
    </div>
  `;
  openModal('Chat with Agent', content);
  
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const messages = document.getElementById('chat-messages');
  
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    
    messages.innerHTML += `<div class="chat-msg user">${escapeHtml(text)}</div>`;
    input.value = '';
    messages.innerHTML += `<div class="chat-msg assistant loading">Thinking...</div>`;
    messages.scrollTop = messages.scrollHeight;
    
    try {
      const res = await fetch(`/api/agents/${agentId}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }]
        })
      });
      
      const result = await res.json();
      const loadingMsg = messages.querySelector('.loading');
      if (loadingMsg) loadingMsg.remove();
      
      if (res.status === 402) {
        messages.innerHTML += `<div class="chat-msg error">Insufficient credits. Add more credits to continue.</div>`;
        return;
      }
      
      if (res.status === 503) {
        messages.innerHTML += `<div class="chat-msg error">No AI provider configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to Secrets.</div>`;
        return;
      }
      
      if (!res.ok) {
        messages.innerHTML += `<div class="chat-msg error">${result.error || 'Unknown error'}</div>`;
        return;
      }
      
      let responseText = '';
      if (result.response?.content?.[0]?.text) {
        responseText = result.response.content[0].text;
      } else if (result.response?.choices?.[0]?.message?.content) {
        responseText = result.response.choices[0].message.content;
      } else {
        responseText = JSON.stringify(result.response);
      }
      
      messages.innerHTML += `<div class="chat-msg assistant">${escapeHtml(responseText)}</div>`;
      messages.innerHTML += `<div class="chat-cost">-${result.creditsUsed} credits (${result.creditsRemaining} remaining)</div>`;
      messages.scrollTop = messages.scrollHeight;
      loadAgents();
    } catch (error) {
      const loadingMsg = messages.querySelector('.loading');
      if (loadingMsg) loadingMsg.remove();
      messages.innerHTML += `<div class="chat-msg error">${error.message}</div>`;
    }
  }
  
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  input.focus();
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
    if (nodeEl) {
      nodeEl.textContent = status.nodeVersion;
      nodeEl.className = 'status-value ok';
    }
    
    const openclawEl = document.getElementById('openclaw-version');
    if (openclawEl) {
      openclawEl.textContent = status.openclawInstalled ? status.openclawVersion : 'Not installed';
      openclawEl.className = 'status-value ' + (status.openclawInstalled ? 'ok' : 'warn');
    }
    
    const configEl = document.getElementById('config-status');
    if (configEl) {
      configEl.textContent = status.configExists ? 'Ready' : 'Not found';
      configEl.className = 'status-value ' + (status.configExists ? 'ok' : 'warn');
    }
    
    const gatewayEl = document.getElementById('gateway-status');
    if (gatewayEl) {
      gatewayEl.textContent = status.gatewayRunning ? 'Running' : 'Stopped';
      gatewayEl.className = 'status-value ' + (status.gatewayRunning ? 'ok' : 'err');
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
    setEnvBadge('env-celo', envVars.CELO_PRIVATE_KEY);
  } catch (error) {
    console.error('Failed to check env vars:', error);
  }
}

function setEnvBadge(id, isSet) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = isSet ? 'SET' : 'NOT SET';
  el.className = 'env-badge ' + (isSet ? 'set' : 'not-set');
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const editor = document.getElementById('config-editor');
    if (!editor) return;
    
    if (res.ok) {
      const config = await res.json();
      editor.value = JSON.stringify(config, null, 2);
    } else {
      editor.value = '// Config not found. Run setup first.';
    }
  } catch (error) {
    const editor = document.getElementById('config-editor');
    if (editor) editor.value = '// Error: ' + error.message;
  }
}

async function saveConfig() {
  const editor = document.getElementById('config-editor');
  const output = document.getElementById('output-box');
  if (!editor || !output) return;
  
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
  if (!output) return;
  output.textContent = 'Running setup...';
  
  try {
    const res = await fetch('/api/setup', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.success 
      ? 'Setup complete.'
      : 'Error: ' + result.error;
    loadStatus();
    loadConfig();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function installOpenClaw() {
  const output = document.getElementById('output-box');
  if (!output) return;
  output.textContent = 'Installing OpenClaw...';
  
  try {
    const res = await fetch('/api/install-openclaw', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.success 
      ? 'OpenClaw installed.'
      : 'Error: ' + result.error;
    loadStatus();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function startGateway() {
  const output = document.getElementById('output-box');
  if (!output) return;
  output.textContent = 'Starting gateway...';
  
  try {
    const res = await fetch('/api/gateway/start', { method: 'POST' });
    const result = await res.json();
    output.textContent = result.success 
      ? 'Gateway started.'
      : result.message || 'Failed to start gateway';
    loadStatus();
  } catch (error) {
    output.textContent = 'Error: ' + error.message;
  }
}

async function stopGateway() {
  const output = document.getElementById('output-box');
  if (!output) return;
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
