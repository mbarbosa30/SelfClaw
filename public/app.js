let currentUser = null;
let currentAgent = null;
let currentWizardStep = 1;
let chatHistory = [];

document.addEventListener('DOMContentLoaded', () => {
  loadAuthState();
  loadStatus();
  loadEnvCheck();
  loadConfig();
  handleGmailCallbackParams();

  document.getElementById('run-setup')?.addEventListener('click', runSetup);
  document.getElementById('install-openclaw')?.addEventListener('click', installOpenClaw);
  document.getElementById('start-gateway')?.addEventListener('click', startGateway);
  document.getElementById('stop-gateway')?.addEventListener('click', stopGateway);
  document.getElementById('load-config')?.addEventListener('click', loadConfig);
  document.getElementById('save-config')?.addEventListener('click', saveConfig);
  document.getElementById('create-agent-btn')?.addEventListener('click', showCreateWizard);
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  
  document.getElementById('save-profile')?.addEventListener('click', saveProfile);
  document.getElementById('skip-profile')?.addEventListener('click', skipProfile);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('send-chat')?.addEventListener('click', sendChatMessage);
  document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  document.getElementById('save-config-btn')?.addEventListener('click', saveAgentConfig);
  document.getElementById('add-secret-btn')?.addEventListener('click', showAddSecretForm);
  document.getElementById('add-skill-btn')?.addEventListener('click', showAddSkillForm);
  document.getElementById('download-registration')?.addEventListener('click', downloadRegistration);

  document.getElementById('category-filter')?.addEventListener('change', loadMarketplacePreview);
  document.getElementById('search-filter')?.addEventListener('input', debounce(loadMarketplacePreview, 300));

  document.getElementById('add-goal-btn')?.addEventListener('click', showAddGoalForm);
  document.getElementById('save-goal-btn')?.addEventListener('click', saveGoal);
  document.getElementById('cancel-goal-btn')?.addEventListener('click', hideAddGoalForm);

  document.getElementById('add-task-btn')?.addEventListener('click', showAddTaskForm);
  document.getElementById('save-task-btn')?.addEventListener('click', saveTask);
  document.getElementById('cancel-task-btn')?.addEventListener('click', hideAddTaskForm);

  setInterval(loadStatus, 30000);
});

function debounce(fn, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

function handleGmailCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  
  if (params.has('gmail_connected')) {
    const email = params.get('gmail_connected');
    setTimeout(() => openModal('Gmail Connected', `<p class="success">Successfully connected Gmail: <strong>${email}</strong></p><p>Your agent can now read your emails to learn about your communication style.</p>`), 500);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  
  if (params.has('gmail_error')) {
    const error = params.get('gmail_error');
    setTimeout(() => openModal('Gmail Connection Failed', `<p class="error">Failed to connect Gmail: ${error}</p><p>Please try again or check that the OAuth credentials are configured correctly.</p>`), 500);
    window.history.replaceState({}, document.title, window.location.pathname);
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
  const onboardingSection = document.getElementById('onboarding-section');
  const heroSignin = document.getElementById('hero-signin');
  
  const landingSections = [
    'landing-hero', 'landing-why', 'landing-economy', 
    'landing-how', 'landing-pricing', 'landing-tech', 'landing-footer'
  ];

  try {
    const res = await fetch('/api/auth/user');
    if (res.ok) {
      currentUser = await res.json();
      loadingEl.style.display = 'none';
      loggedOutEl.style.display = 'none';
      loggedInEl.style.display = 'flex';
      
      landingSections.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      document.body.classList.add('dashboard-mode');

      document.getElementById('user-name').textContent = 
        currentUser.firstName || currentUser.email || 'User';
      if (currentUser.profileImageUrl) {
        document.getElementById('user-avatar').src = currentUser.profileImageUrl;
        document.getElementById('user-avatar').style.display = 'block';
      }

      const profileRes = await fetch('/api/profile');
      if (profileRes.ok) {
        const profile = await profileRes.json();
        if (!profile.profileComplete) {
          onboardingSection.style.display = 'block';
          agentsSection.style.display = 'none';
          loadProfileForm(profile);
        } else {
          onboardingSection.style.display = 'none';
          agentsSection.style.display = 'block';
          loadAgents();
        }
      } else {
        onboardingSection.style.display = 'block';
        agentsSection.style.display = 'none';
      }
    } else {
      currentUser = null;
      loadingEl.style.display = 'none';
      loggedOutEl.style.display = 'block';
      loggedInEl.style.display = 'none';
      agentsSection.style.display = 'none';
      onboardingSection.style.display = 'none';
      
      landingSections.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      });
      document.body.classList.remove('dashboard-mode');
    }
  } catch (error) {
    console.error('Auth check failed:', error);
    loadingEl.style.display = 'none';
    loggedOutEl.style.display = 'block';
    loggedInEl.style.display = 'none';
    agentsSection.style.display = 'none';
    onboardingSection.style.display = 'none';
    
    landingSections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    });
    document.body.classList.remove('dashboard-mode');
  }
}

function loadProfileForm(profile) {
  if (profile.profession) document.getElementById('profile-profession').value = profile.profession;
  if (profile.goals) document.getElementById('profile-goals').value = profile.goals;
  if (profile.communicationStyle) document.getElementById('profile-style').value = profile.communicationStyle;
  if (profile.birthdate) document.getElementById('profile-birthdate').value = profile.birthdate;
  if (profile.timezone) document.getElementById('profile-timezone').value = profile.timezone;
  if (profile.linkedinUrl) document.getElementById('profile-linkedin').value = profile.linkedinUrl;
  if (profile.twitterUsername) document.getElementById('profile-twitter').value = profile.twitterUsername;
  if (profile.githubUsername) document.getElementById('profile-github').value = profile.githubUsername;
}

async function saveProfile() {
  const data = {
    profession: document.getElementById('profile-profession').value,
    goals: document.getElementById('profile-goals').value,
    communicationStyle: document.getElementById('profile-style').value,
    birthdate: document.getElementById('profile-birthdate').value,
    timezone: document.getElementById('profile-timezone').value || Intl.DateTimeFormat().resolvedOptions().timeZone,
    linkedinUrl: document.getElementById('profile-linkedin').value,
    twitterUsername: document.getElementById('profile-twitter').value.replace('@', ''),
    githubUsername: document.getElementById('profile-github').value,
  };

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (res.ok) {
      document.getElementById('onboarding-section').style.display = 'none';
      document.getElementById('agents-section').style.display = 'block';
      loadAgents();
    } else {
      const err = await res.json();
      openModal('Error', `<p class="error">${err.error}</p>`);
    }
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

function skipProfile() {
  document.getElementById('onboarding-section').style.display = 'none';
  document.getElementById('agents-section').style.display = 'block';
  loadAgents();
}

async function loadAgents() {
  const navEl = document.getElementById('agents-nav');
  navEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error('Failed to load agents');
    const agents = await res.json();

    if (agents.length === 0) {
      navEl.innerHTML = `
        <div class="nav-empty">
          <p>No agents yet</p>
        </div>
      `;
      document.getElementById('cockpit-empty').style.display = 'flex';
      document.getElementById('cockpit-view').style.display = 'none';
      document.getElementById('create-wizard').style.display = 'none';
      return;
    }

    navEl.innerHTML = agents.map(agent => `
      <div class="nav-agent ${currentAgent?.id === agent.id ? 'active' : ''}" 
           onclick="selectAgent('${agent.id}')" 
           data-agent-id="${agent.id}">
        <span class="nav-agent-name">${escapeHtml(agent.name)}</span>
        <span class="nav-agent-status ${agent.status}">${agent.status}</span>
      </div>
    `).join('');

    if (!currentAgent && agents.length > 0) {
      selectAgent(agents[0].id);
    } else if (currentAgent) {
      const agentStillExists = agents.find(a => a.id === currentAgent.id);
      if (agentStillExists) {
        selectAgent(currentAgent.id);
      } else {
        selectAgent(agents[0].id);
      }
    }
  } catch (error) {
    navEl.innerHTML = `<div class="error">Error: ${error.message}</div>`;
  }
}

async function selectAgent(agentId) {
  try {
    const res = await fetch(`/api/agents`);
    if (!res.ok) throw new Error('Failed to load agents');
    const agents = await res.json();
    const agent = agents.find(a => a.id === agentId);
    
    if (!agent) {
      console.error('Agent not found:', agentId);
      return;
    }

    currentAgent = agent;
    chatHistory = [];
    
    // Load conversation history from server
    try {
      const convRes = await fetch(`/api/agents/${agentId}/conversation`);
      if (convRes.ok) {
        const convData = await convRes.json();
        chatHistory = convData.messages.map(m => ({ role: m.role, content: m.content }));
      }
    } catch (e) {
      console.log('Could not load conversation history');
    }

    document.querySelectorAll('.nav-agent').forEach(el => {
      el.classList.toggle('active', el.dataset.agentId === agentId);
    });

    document.getElementById('cockpit-agent-name').textContent = agent.name;
    document.getElementById('cockpit-agent-status').textContent = agent.status;
    document.getElementById('cockpit-agent-status').className = `agent-status ${agent.status}`;
    document.getElementById('cockpit-credits').textContent = parseFloat(agent.credits || 0).toFixed(2);
    
    if (agent.tbaAddress) {
      document.getElementById('cockpit-wallet').textContent = 
        `${agent.tbaAddress.slice(0, 6)}...${agent.tbaAddress.slice(-4)}`;
    } else {
      document.getElementById('cockpit-wallet').textContent = '---';
    }

    document.getElementById('cockpit-empty').style.display = 'none';
    document.getElementById('create-wizard').style.display = 'none';
    document.getElementById('cockpit-view').style.display = 'block';

    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'console';
    loadTabContent(activeTab);
  } catch (error) {
    console.error('Failed to select agent:', error);
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  loadTabContent(tabName);
}

function loadTabContent(tabName) {
  if (!currentAgent) return;

  switch (tabName) {
    case 'console':
      loadConsole();
      break;
    case 'goals':
      loadGoals();
      break;
    case 'tasks':
      loadTasks();
      loadToolExecutions();
      break;
    case 'config':
      loadConfigTab();
      break;
    case 'skills':
      loadSkillsTab();
      break;
    case 'wallet':
      loadWalletTab();
      break;
    case 'data':
      loadDataTab();
      break;
  }
}

function loadConsole() {
  const messagesEl = document.getElementById('chat-messages');
  if (chatHistory.length === 0) {
    messagesEl.innerHTML = `
      <div class="chat-welcome">
        <p>Start a conversation with <strong>${escapeHtml(currentAgent.name)}</strong></p>
      </div>
    `;
  } else {
    // Render saved conversation history
    messagesEl.innerHTML = chatHistory.map(m => 
      `<div class="chat-msg ${m.role}">${escapeHtml(m.content)}</div>`
    ).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function sendChatMessage() {
  if (!currentAgent) return;

  const input = document.getElementById('chat-input');
  const messagesEl = document.getElementById('chat-messages');
  const text = input.value.trim();
  
  if (!text) return;

  if (chatHistory.length === 0) {
    messagesEl.innerHTML = '';
  }

  chatHistory.push({ role: 'user', content: text });
  messagesEl.innerHTML += `<div class="chat-msg user">${escapeHtml(text)}</div>`;
  input.value = '';
  
  // Persist user message to server
  fetch(`/api/agents/${currentAgent.id}/conversation/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', content: text })
  }).catch(e => console.log('Failed to persist user message'));
  
  messagesEl.innerHTML += `<div class="chat-msg assistant loading">Thinking...</div>`;
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistory
      })
    });

    const result = await res.json();
    const loadingMsg = messagesEl.querySelector('.loading');
    if (loadingMsg) loadingMsg.remove();

    if (res.status === 402) {
      messagesEl.innerHTML += `<div class="chat-msg error">Insufficient credits. Add more credits to continue.</div>`;
      return;
    }

    if (res.status === 503) {
      messagesEl.innerHTML += `<div class="chat-msg error">No AI provider configured. Add API keys to enable chat.</div>`;
      return;
    }

    if (!res.ok) {
      messagesEl.innerHTML += `<div class="chat-msg error">${result.error || 'Unknown error'}</div>`;
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

    chatHistory.push({ role: 'assistant', content: responseText });
    messagesEl.innerHTML += `<div class="chat-msg assistant">${escapeHtml(responseText)}</div>`;
    messagesEl.innerHTML += `<div class="chat-cost">-${result.creditsUsed} credits (${result.creditsRemaining} remaining)</div>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Persist assistant message to server
    fetch(`/api/agents/${currentAgent.id}/conversation/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', content: responseText })
    }).catch(e => console.log('Failed to persist assistant message'));

    document.getElementById('cockpit-credits').textContent = parseFloat(result.creditsRemaining).toFixed(2);
  } catch (error) {
    const loadingMsg = messagesEl.querySelector('.loading');
    if (loadingMsg) loadingMsg.remove();
    messagesEl.innerHTML += `<div class="chat-msg error">${error.message}</div>`;
  }
}

async function loadConfigTab() {
  if (!currentAgent) return;

  const config = currentAgent.configJson || {};
  
  document.getElementById('config-name').value = currentAgent.name || '';
  document.getElementById('config-description').value = currentAgent.description || '';
  document.getElementById('config-system-prompt').value = config.systemPrompt || '';
  document.getElementById('config-model').value = config.model || 'gpt-4o';

  await Promise.all([loadSecrets(), loadModelsStatus(), loadGmailStatus()]);
}

async function loadGmailStatus() {
  if (!currentAgent) return;
  
  const statusEl = document.getElementById('gmail-status');
  const btnEl = document.getElementById('gmail-connect-btn');
  
  if (!statusEl || !btnEl) return;
  
  try {
    const res = await fetch(`/api/gmail/status/${currentAgent.id}`);
    const data = await res.json();
    
    if (data.connected) {
      statusEl.textContent = `Connected: ${data.email}`;
      statusEl.classList.add('connected');
      btnEl.textContent = 'Disconnect';
      btnEl.onclick = disconnectGmail;
    } else {
      statusEl.textContent = 'Not connected';
      statusEl.classList.remove('connected');
      btnEl.textContent = 'Connect';
      btnEl.onclick = connectGmail;
    }
  } catch (error) {
    statusEl.textContent = 'Status unknown';
  }
}

function connectGmail() {
  if (!currentAgent) return;
  window.location.href = `/api/gmail/authorize/${currentAgent.id}`;
}

async function disconnectGmail() {
  if (!currentAgent) return;
  
  if (!confirm('Disconnect Gmail from this agent?')) return;
  
  try {
    const res = await fetch(`/api/gmail/disconnect/${currentAgent.id}`, { method: 'DELETE' });
    if (res.ok) {
      loadGmailStatus();
    }
  } catch (error) {
    console.error('Failed to disconnect Gmail:', error);
  }
}

async function loadModelsStatus() {
  if (!currentAgent) return;

  const statusEl = document.getElementById('models-status');
  if (!statusEl) return;

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/models`);
    const data = await res.json();

    const availableCount = data.models.filter(m => m.available).length;
    const totalCount = data.models.length;

    const providers = {};
    data.models.forEach(m => {
      if (!providers[m.provider]) providers[m.provider] = { available: 0, total: 0 };
      providers[m.provider].total++;
      if (m.available) providers[m.provider].available++;
    });

    const providerStatus = Object.entries(providers).map(([name, stats]) => {
      const isAvailable = stats.available > 0;
      return `<span class="provider-badge ${isAvailable ? 'available' : 'unavailable'}">${name}: ${stats.available}/${stats.total}</span>`;
    }).join(' ');

    statusEl.innerHTML = `
      <div class="models-status-info">
        <span class="models-count">${availableCount}/${totalCount} models available</span>
        <div class="provider-badges">${providerStatus}</div>
      </div>
    `;
  } catch (error) {
    statusEl.innerHTML = '';
  }
}

async function loadSecrets() {
  if (!currentAgent) return;

  const secretsEl = document.getElementById('config-secrets');
  secretsEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/secrets`);
    const secrets = await res.json();

    if (secrets.length === 0) {
      secretsEl.innerHTML = '<p class="note">No API keys configured</p>';
      return;
    }

    secretsEl.innerHTML = secrets.map(secret => `
      <div class="secret-item" data-service="${secret.serviceName}">
        <span class="secret-name">${escapeHtml(secret.serviceName)}</span>
        <span class="secret-status set">Configured</span>
        <button class="btn btn-sm btn-outline" onclick="deleteSecret('${currentAgent.id}', '${secret.serviceName}')">Remove</button>
      </div>
    `).join('');
  } catch (error) {
    secretsEl.innerHTML = `<p class="error">${error.message}</p>`;
  }
}

function showAddSecretForm() {
  if (!currentAgent) return;

  const content = `
    <div class="modal-info">
      <div class="form-group">
        <label>Service</label>
        <select id="new-secret-service" class="input">
          <optgroup label="AI Providers (Supported)">
            <option value="openai">OpenAI (GPT-4o, GPT-5.2, o3)</option>
            <option value="anthropic">Anthropic (Claude Sonnet, Opus, Haiku)</option>
          </optgroup>
        </select>
      </div>
      <p class="hint" style="margin-bottom: 1rem;">OpenAI models work out-of-the-box. Add your Anthropic key to use Claude models.</p>
      <div class="form-group">
        <label>API Key</label>
        <input type="password" id="new-secret-key" class="input" placeholder="sk-..." />
      </div>
      <button class="btn" onclick="saveNewSecret()">Save API Key</button>
    </div>
  `;
  openModal('Add API Key', content);
}

async function saveNewSecret() {
  if (!currentAgent) return;

  const serviceName = document.getElementById('new-secret-service').value;
  const apiKey = document.getElementById('new-secret-key').value.trim();

  if (!apiKey) {
    document.getElementById('new-secret-key').focus();
    return;
  }

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceName, apiKey })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save');
    }

    closeModal();
    loadSecrets();
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function deleteSecret(agentId, serviceName) {
  if (!confirm(`Remove ${serviceName} API key?`)) return;

  try {
    const res = await fetch(`/api/agents/${agentId}/secrets/${serviceName}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to remove');
    }

    loadSecrets();
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function saveAgentConfig() {
  if (!currentAgent) return;

  const name = document.getElementById('config-name').value.trim();
  const description = document.getElementById('config-description').value.trim();
  const systemPrompt = document.getElementById('config-system-prompt').value.trim();
  const model = document.getElementById('config-model').value;

  if (!name) {
    openModal('Error', '<p class="error">Agent name is required</p>');
    return;
  }

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, systemPrompt, model })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save');
    }

    openModal('Success', '<p>Configuration saved successfully</p>');
    currentAgent.name = name;
    currentAgent.description = description;
    if (!currentAgent.configJson) currentAgent.configJson = {};
    currentAgent.configJson.systemPrompt = systemPrompt;
    currentAgent.configJson.model = model;
    
    document.getElementById('cockpit-agent-name').textContent = name;
    loadAgents();
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function loadSkillsTab() {
  if (!currentAgent) return;

  const skillsListEl = document.getElementById('agent-skills-list');
  skillsListEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/skills`);
    const skills = await res.json();

    if (skills.length === 0) {
      skillsListEl.innerHTML = '<p class="note">No skills yet. Add your first skill to get started.</p>';
    } else {
      skillsListEl.innerHTML = skills.map(skill => `
        <div class="skill-item" data-id="${skill.id}">
          <div class="skill-header">
            <span class="skill-name">${escapeHtml(skill.name)}</span>
            <span class="skill-price">${skill.priceCredits} credits</span>
          </div>
          <div class="skill-meta">
            <span class="skill-category">${skill.category}</span>
            <span class="skill-usage">${skill.usageCount || 0} uses</span>
            <span class="skill-status ${skill.isActive ? 'active' : 'inactive'}">${skill.isActive ? 'Active' : 'Inactive'}</span>
          </div>
          ${skill.description ? `<div class="skill-desc">${escapeHtml(skill.description)}</div>` : ''}
          <div class="skill-actions">
            <button class="btn btn-sm ${skill.isActive ? 'btn-outline' : ''}" onclick="toggleSkill('${currentAgent.id}', '${skill.id}', ${!skill.isActive})">${skill.isActive ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-sm btn-outline" onclick="deleteSkill('${currentAgent.id}', '${skill.id}')">Remove</button>
          </div>
        </div>
      `).join('');
    }
  } catch (error) {
    skillsListEl.innerHTML = `<p class="error">${error.message}</p>`;
  }

  loadMarketplacePreview();
}

function showAddSkillForm() {
  if (!currentAgent) return;

  const content = `
    <div class="modal-info">
      <div class="form-group">
        <label>Skill Name</label>
        <input type="text" id="new-skill-name" class="input" placeholder="e.g., Data Summarization" />
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="new-skill-desc" class="input" rows="2" placeholder="What does this skill do?"></textarea>
      </div>
      <div class="form-group">
        <label>Category</label>
        <select id="new-skill-category" class="input">
          <option value="general">General</option>
          <option value="research">Research</option>
          <option value="analysis">Analysis</option>
          <option value="automation">Automation</option>
          <option value="creative">Creative</option>
        </select>
      </div>
      <div class="form-group">
        <label>Price (credits)</label>
        <input type="number" id="new-skill-price" class="input" value="0.01" step="0.01" min="0" />
      </div>
      <button class="btn" onclick="saveNewSkill()">Add Skill</button>
    </div>
  `;
  openModal('Add Skill', content);
}

async function saveNewSkill() {
  if (!currentAgent) return;

  const name = document.getElementById('new-skill-name').value.trim();
  const description = document.getElementById('new-skill-desc').value.trim();
  const category = document.getElementById('new-skill-category').value;
  const priceCredits = document.getElementById('new-skill-price').value || '0.01';

  if (!name) {
    document.getElementById('new-skill-name').focus();
    return;
  }

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, category, priceCredits })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add skill');
    }

    closeModal();
    loadSkillsTab();
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function toggleSkill(agentId, skillId, isActive) {
  try {
    await fetch(`/api/agents/${agentId}/skills/${skillId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive })
    });
    loadSkillsTab();
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function deleteSkill(agentId, skillId) {
  if (!confirm('Remove this skill?')) return;

  try {
    await fetch(`/api/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' });
    loadSkillsTab();
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function loadMarketplacePreview() {
  const listEl = document.getElementById('marketplace-list');
  if (!listEl || !currentUser) return;

  const category = document.getElementById('category-filter')?.value || 'all';
  const search = document.getElementById('search-filter')?.value || '';

  try {
    const params = new URLSearchParams();
    if (category && category !== 'all') params.append('category', category);
    if (search) params.append('search', search);

    const res = await fetch(`/api/marketplace/skills?${params}`);
    if (!res.ok) throw new Error('Failed to load skills');
    const skills = await res.json();

    if (skills.length === 0) {
      listEl.innerHTML = '<p class="note">No skills available in the marketplace yet.</p>';
      return;
    }

    listEl.innerHTML = skills.map(skill => `
      <div class="marketplace-card">
        <div class="marketplace-header">
          <span class="skill-name">${escapeHtml(skill.name)}</span>
          <span class="skill-price">${skill.priceCredits} credits</span>
        </div>
        ${skill.description ? `<div class="skill-desc">${escapeHtml(skill.description)}</div>` : ''}
        <div class="marketplace-meta">
          <span class="skill-category">${skill.category}</span>
          <span class="skill-provider">by ${escapeHtml(skill.agentName)}</span>
          <span class="skill-usage">${skill.usageCount || 0} uses</span>
        </div>
        <button class="btn btn-sm" onclick="executeSkill('${skill.id}', '${escapeHtml(skill.name)}', ${skill.priceCredits})">Use Skill</button>
      </div>
    `).join('');
  } catch (error) {
    listEl.innerHTML = `<p class="error">${error.message}</p>`;
  }
}

async function executeSkill(skillId, skillName, price) {
  if (!currentAgent) {
    openModal('Select Agent', '<p>Please select an agent first to use marketplace skills.</p>');
    return;
  }

  const content = `
    <div class="modal-info">
      <p>Use <strong>${skillName}</strong> for <strong>${price} credits</strong></p>
      <p class="note">This will be charged to <strong>${escapeHtml(currentAgent.name)}</strong></p>
      <button class="btn" onclick="confirmExecuteSkill('${skillId}')">Execute Skill</button>
    </div>
  `;
  openModal('Execute Skill', content);
}

async function confirmExecuteSkill(skillId) {
  if (!currentAgent) return;

  try {
    const res = await fetch(`/api/marketplace/skills/${skillId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: currentAgent.id })
    });

    const result = await res.json();

    if (res.status === 402) {
      openModal('Insufficient Credits', `<p>Not enough credits. Required: ${result.required}, Available: ${result.available}</p>`);
      return;
    }

    if (!res.ok) {
      throw new Error(result.error || 'Failed to execute skill');
    }

    openModal('Success', `
      <div class="modal-info">
        <p>${result.message}</p>
        <p class="note">Platform fee: ${result.platformFee.toFixed(4)} credits</p>
      </div>
    `);

    selectAgent(currentAgent.id);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

async function loadWalletTab() {
  if (!currentAgent) return;

  document.getElementById('wallet-credits').textContent = parseFloat(currentAgent.credits || 0).toFixed(2);

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/wallet`);
    const wallet = await res.json();

    if (wallet.walletEnabled && wallet.address) {
      document.getElementById('wallet-usdc').textContent = `$${parseFloat(wallet.usdc || 0).toFixed(2)}`;
      document.getElementById('wallet-full-address').textContent = wallet.address;
    } else {
      document.getElementById('wallet-usdc').textContent = '$0.00';
      document.getElementById('wallet-full-address').textContent = 'Wallet not configured';
    }

    await loadTransactions();
  } catch (error) {
    console.error('Failed to load wallet:', error);
  }
}

async function loadTransactions() {
  if (!currentAgent) return;

  const transactionsEl = document.getElementById('wallet-transactions');

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/analytics`);
    const data = await res.json();

    if (data.recentPayments && data.recentPayments.length > 0) {
      transactionsEl.innerHTML = data.recentPayments.slice(0, 10).map(p => {
        const icon = p.direction === 'inbound' ? '+' : '-';
        const cls = p.direction === 'inbound' ? 'positive' : 'negative';
        return `
          <div class="transaction-item">
            <span class="tx-amount ${cls}">${icon}${parseFloat(p.amount).toFixed(4)}</span>
            <span class="tx-endpoint">${escapeHtml(p.endpoint || 'Transaction')}</span>
          </div>
        `;
      }).join('');
    } else {
      transactionsEl.innerHTML = '<p class="note">No transactions yet</p>';
    }
  } catch (error) {
    transactionsEl.innerHTML = `<p class="error">${error.message}</p>`;
  }
}

async function loadDataTab() {
  if (!currentAgent) return;

  const statsEl = document.getElementById('analytics-stats');
  const logEl = document.getElementById('activity-log');

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/analytics`);
    const data = await res.json();

    const profitClass = parseFloat(data.totals.profit) >= 0 ? 'positive' : 'negative';

    statsEl.innerHTML = `
      <div class="analytics-card">
        <span class="analytics-value">${parseFloat(data.currentCredits).toFixed(2)}</span>
        <span class="analytics-label">Current Credits</span>
      </div>
      <div class="analytics-card">
        <span class="analytics-value">${data.totals.earned}</span>
        <span class="analytics-label">Total Earned</span>
      </div>
      <div class="analytics-card">
        <span class="analytics-value">${data.totals.spent}</span>
        <span class="analytics-label">Total Spent</span>
      </div>
      <div class="analytics-card ${profitClass}">
        <span class="analytics-value">${data.totals.profit}</span>
        <span class="analytics-label">Net Profit/Loss</span>
      </div>
    `;

    if (data.recentPayments && data.recentPayments.length > 0) {
      logEl.innerHTML = data.recentPayments.map(p => {
        const icon = p.direction === 'inbound' ? '↓' : '↑';
        const cls = p.direction === 'inbound' ? 'positive' : 'negative';
        return `
          <div class="activity-item">
            <span class="activity-icon ${cls}">${icon}</span>
            <span class="activity-desc">${escapeHtml(p.endpoint || 'Transaction')}</span>
            <span class="activity-amount ${cls}">${parseFloat(p.amount).toFixed(4)} credits</span>
          </div>
        `;
      }).join('');
    } else {
      logEl.innerHTML = '<p class="note">Activity will appear here as your agent is used.</p>';
    }
  } catch (error) {
    statsEl.innerHTML = `<p class="error">${error.message}</p>`;
    logEl.innerHTML = '';
  }
}

async function downloadRegistration() {
  if (!currentAgent) return;

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/registration`);
    const data = await res.json();

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-${currentAgent.id}-registration.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
  }
}

function showCreateWizard() {
  currentWizardStep = 1;
  
  document.getElementById('wizard-name').value = '';
  document.getElementById('wizard-description').value = '';
  document.getElementById('wizard-prompt').value = '';
  document.getElementById('wizard-model').value = 'gpt-4o';

  updateWizardStep();

  document.getElementById('cockpit-empty').style.display = 'none';
  document.getElementById('cockpit-view').style.display = 'none';
  document.getElementById('create-wizard').style.display = 'block';
}

function hideCreateWizard() {
  document.getElementById('create-wizard').style.display = 'none';
  
  if (currentAgent) {
    document.getElementById('cockpit-view').style.display = 'block';
  } else {
    document.getElementById('cockpit-empty').style.display = 'flex';
  }
}

function updateWizardStep() {
  document.querySelectorAll('.wizard-step').forEach(step => {
    const stepNum = parseInt(step.dataset.step);
    step.classList.toggle('active', stepNum === currentWizardStep);
    step.classList.toggle('completed', stepNum < currentWizardStep);
  });

  document.querySelectorAll('.wizard-panel').forEach(panel => {
    panel.classList.remove('active');
  });
  document.getElementById(`wizard-step-${currentWizardStep}`).classList.add('active');

  if (currentWizardStep === 3) {
    document.getElementById('review-name').textContent = document.getElementById('wizard-name').value || '-';
    document.getElementById('review-description').textContent = document.getElementById('wizard-description').value || '-';
    document.getElementById('review-model').textContent = document.getElementById('wizard-model').value;
  }
}

function wizardNext() {
  if (currentWizardStep === 1) {
    const name = document.getElementById('wizard-name').value.trim();
    if (!name) {
      document.getElementById('wizard-name').focus();
      return;
    }
  }

  if (currentWizardStep < 3) {
    currentWizardStep++;
    updateWizardStep();
  }
}

function wizardPrev() {
  if (currentWizardStep > 1) {
    currentWizardStep--;
    updateWizardStep();
  }
}

async function createAgentFromWizard() {
  const name = document.getElementById('wizard-name').value.trim();
  const description = document.getElementById('wizard-description').value.trim();
  const systemPrompt = document.getElementById('wizard-prompt').value.trim();
  const model = document.getElementById('wizard-model').value;

  if (!name) {
    openModal('Error', '<p class="error">Agent name is required</p>');
    return;
  }

  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, systemPrompt, model })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create agent');
    }

    const agent = await res.json();
    
    hideCreateWizard();
    await loadAgents();
    selectAgent(agent.id);

    openModal('Success', `<p>Agent "${escapeHtml(agent.name)}" created with 10 free credits!</p>`);
  } catch (error) {
    openModal('Error', `<p class="error">${error.message}</p>`);
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

function showAddGoalForm() {
  document.getElementById('add-goal-form').style.display = 'block';
}

function hideAddGoalForm() {
  document.getElementById('add-goal-form').style.display = 'none';
  document.getElementById('new-goal-text').value = '';
  document.getElementById('new-goal-priority').value = '5';
}

async function loadGoals() {
  if (!currentAgent) return;
  const list = document.getElementById('goals-list');
  if (!list) return;

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/goals`);
    if (!res.ok) throw new Error('Failed to load goals');
    const goals = await res.json();

    if (goals.length === 0) {
      list.innerHTML = '<p class="note">No goals set yet. Add goals to give your agent persistent objectives.</p>';
      return;
    }

    list.innerHTML = goals.map(g => `
      <div class="goal-card ${g.status}">
        <div class="goal-header">
          <span class="goal-priority">P${g.priority}</span>
          <span class="goal-status status-${g.status}">${g.status}</span>
        </div>
        <p class="goal-text">${escapeHtml(g.goal)}</p>
        ${g.progress ? `<div class="goal-progress"><div class="progress-bar" style="width:${g.progress}%"></div><span>${g.progress}%</span></div>` : ''}
        <div class="goal-actions">
          ${g.status === 'active' ? `
            <button class="btn btn-xs" onclick="updateGoalStatus('${g.id}', 'completed')">Complete</button>
            <button class="btn btn-xs btn-outline" onclick="updateGoalStatus('${g.id}', 'paused')">Pause</button>
          ` : ''}
          ${g.status === 'paused' ? `
            <button class="btn btn-xs" onclick="updateGoalStatus('${g.id}', 'active')">Resume</button>
          ` : ''}
          <button class="btn btn-xs btn-danger" onclick="deleteGoal('${g.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<p class="note error">Error: ${error.message}</p>`;
  }
}

async function saveGoal() {
  if (!currentAgent) return;
  const goal = document.getElementById('new-goal-text').value.trim();
  const priority = parseInt(document.getElementById('new-goal-priority').value) || 5;

  if (!goal) {
    alert('Please enter a goal description');
    return;
  }

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, priority })
    });
    if (!res.ok) throw new Error('Failed to save goal');
    hideAddGoalForm();
    loadGoals();
  } catch (error) {
    alert('Error saving goal: ' + error.message);
  }
}

async function updateGoalStatus(goalId, status) {
  if (!currentAgent) return;
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/goals/${goalId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Failed to update goal');
    loadGoals();
  } catch (error) {
    alert('Error updating goal: ' + error.message);
  }
}

async function deleteGoal(goalId) {
  if (!currentAgent) return;
  if (!confirm('Delete this goal?')) return;
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/goals/${goalId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete goal');
    loadGoals();
  } catch (error) {
    alert('Error deleting goal: ' + error.message);
  }
}

function showAddTaskForm() {
  document.getElementById('add-task-form').style.display = 'block';
}

function hideAddTaskForm() {
  document.getElementById('add-task-form').style.display = 'none';
  document.getElementById('new-task-name').value = '';
  document.getElementById('new-task-description').value = '';
}

async function loadTasks() {
  if (!currentAgent) return;
  const list = document.getElementById('tasks-list');
  if (!list) return;

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/tasks`);
    if (!res.ok) throw new Error('Failed to load tasks');
    const tasks = await res.json();

    if (tasks.length === 0) {
      list.innerHTML = '<p class="note">No scheduled tasks. Add tasks to let your agent act autonomously.</p>';
      return;
    }

    list.innerHTML = tasks.map(t => `
      <div class="task-card ${t.isActive ? 'active' : 'inactive'}">
        <div class="task-header">
          <span class="task-name">${escapeHtml(t.name)}</span>
          <span class="task-cron">${cronToHuman(t.cronExpression)}</span>
        </div>
        <p class="task-description">${escapeHtml(t.description || '')}</p>
        <div class="task-meta">
          <span class="task-type">${t.taskType}</span>
          ${t.lastRunAt ? `<span class="task-last-run">Last: ${new Date(t.lastRunAt).toLocaleString()}</span>` : ''}
          ${t.nextRunAt ? `<span class="task-next-run">Next: ${new Date(t.nextRunAt).toLocaleString()}</span>` : ''}
        </div>
        <div class="task-actions">
          <button class="btn btn-xs ${t.isActive ? 'btn-outline' : ''}" onclick="toggleTask('${t.id}', ${!t.isActive})">${t.isActive ? 'Pause' : 'Enable'}</button>
          <button class="btn btn-xs btn-danger" onclick="deleteTask('${t.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<p class="note error">Error: ${error.message}</p>`;
  }
}

function cronToHuman(cron) {
  const cronMap = {
    '0 * * * *': 'Every hour',
    '0 */6 * * *': 'Every 6 hours',
    '0 9 * * *': 'Daily at 9 AM',
    '0 9 * * 1': 'Weekly (Mondays)',
    '*/30 * * * *': 'Every 30 min'
  };
  return cronMap[cron] || cron;
}

async function saveTask() {
  if (!currentAgent) return;
  const name = document.getElementById('new-task-name').value.trim();
  const description = document.getElementById('new-task-description').value.trim();
  const cronExpression = document.getElementById('new-task-cron').value;
  const taskType = document.getElementById('new-task-type').value;

  if (!name) {
    alert('Please enter a task name');
    return;
  }

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, cronExpression, taskType })
    });
    if (!res.ok) throw new Error('Failed to save task');
    hideAddTaskForm();
    loadTasks();
  } catch (error) {
    alert('Error saving task: ' + error.message);
  }
}

async function toggleTask(taskId, isActive) {
  if (!currentAgent) return;
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive })
    });
    if (!res.ok) throw new Error('Failed to update task');
    loadTasks();
  } catch (error) {
    alert('Error updating task: ' + error.message);
  }
}

async function deleteTask(taskId) {
  if (!currentAgent) return;
  if (!confirm('Delete this scheduled task?')) return;
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/tasks/${taskId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete task');
    loadTasks();
  } catch (error) {
    alert('Error deleting task: ' + error.message);
  }
}

async function loadToolExecutions() {
  if (!currentAgent) return;
  const list = document.getElementById('tool-executions-list');
  if (!list) return;

  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/tool-executions`);
    if (!res.ok) throw new Error('Failed to load tool executions');
    const executions = await res.json();

    if (executions.length === 0) {
      list.innerHTML = '<p class="note">No tool executions yet.</p>';
      return;
    }

    list.innerHTML = executions.slice(0, 20).map(e => `
      <div class="execution-entry ${e.success ? 'success' : 'error'}">
        <div class="execution-header">
          <span class="tool-name">${escapeHtml(e.toolName)}</span>
          <span class="execution-time">${new Date(e.createdAt).toLocaleString()}</span>
        </div>
        <div class="execution-details">
          <span class="execution-cost">${e.creditsCost} credits</span>
          <span class="execution-status">${e.success ? 'OK' : 'FAILED'}</span>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<p class="note error">Error: ${error.message}</p>`;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
