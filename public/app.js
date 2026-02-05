const SELFCLAW_HEADLINES = [
  { text: "Fake agents everywhere.", highlight: "Prove yours is real." },
  { text: "Your agent.", highlight: "Cryptographically human." },
  { text: "Stop sybils.", highlight: "Verify your agent." },
  { text: "APIs lie.", highlight: "Passports don't." },
  { text: "500K fake accounts.", highlight: "Not anymore." },
  { text: "One human.", highlight: "Many verified agents." }
];

function initRotatingHeadline() {
  const headlineEl = document.getElementById('rotating-headline');
  if (!headlineEl) return;
  
  const headline = SELFCLAW_HEADLINES[Math.floor(Math.random() * SELFCLAW_HEADLINES.length)];
  headlineEl.innerHTML = `${headline.text}<br/><span class="text-green">${headline.highlight}</span>`;
}

document.addEventListener('DOMContentLoaded', initRotatingHeadline);

function openDonateModal() {
  const modal = document.getElementById('donate-modal');
  if (modal) modal.style.display = 'flex';
}

function closeDonateModal() {
  const modal = document.getElementById('donate-modal');
  if (modal) modal.style.display = 'none';
}

function copyDonateAddress(e) {
  const address = document.getElementById('donate-address').textContent;
  navigator.clipboard.writeText(address).then(() => {
    const btn = e.target;
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = originalText, 2000);
  });
}

document.addEventListener('click', function(e) {
  const donateModal = document.getElementById('donate-modal');
  if (e.target === donateModal) {
    closeDonateModal();
  }
});

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = originalText, 2000);
  });
}

function initIntegrationTabs() {
  const section = document.getElementById('agent-integration');
  if (!section) return;
  
  const tabBtns = section.querySelectorAll('.integration-tabs .tab-btn');
  const tabContents = section.querySelectorAll('.tab-content');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabId = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      tabContents.forEach(content => content.classList.remove('active'));
      const targetContent = section.querySelector('#tab-' + tabId);
      if (targetContent) targetContent.classList.add('active');
    });
  });
}

document.addEventListener('DOMContentLoaded', initIntegrationTabs);

let currentUser = null;
let currentAgent = null;
let currentWizardStep = 1;
let chatHistory = [];
let selectedTemplate = 'blank';

const AGENT_TEMPLATES = {
  blank: {
    name: "Blank Agent",
    role: "Custom",
    systemPrompt: "You are a helpful AI assistant. Follow the user's instructions and help them accomplish their goals.",
    suggestedModel: "gpt-4o"
  },
  developer: {
    name: "Developer Agent",
    role: "Developer",
    systemPrompt: `You are a skilled software developer agent. Your expertise includes:

- Writing clean, maintainable code across multiple languages
- Debugging and troubleshooting technical issues
- Reviewing code and suggesting improvements
- Explaining technical concepts clearly

When helping with code:
- Ask clarifying questions before diving in
- Explain your reasoning and approach
- Consider edge cases and error handling
- Follow best practices for the language/framework`,
    suggestedModel: "gpt-4o"
  },
  researcher: {
    name: "Research Agent",
    role: "Researcher",
    systemPrompt: `You are a thorough research agent. Your approach:

- Dig deep into topics, exploring multiple angles
- Cite sources and provide evidence for claims
- Distinguish between facts, opinions, and speculation
- Organize findings clearly with actionable insights
- Question assumptions and look for counter-evidence

Be curious and skeptical. Good research means finding what's true, not just what confirms existing beliefs.`,
    suggestedModel: "gpt-4o"
  },
  writer: {
    name: "Content Writer",
    role: "Writer",
    systemPrompt: `You are a versatile content writer. Your strengths:

- Adapting voice and tone to different audiences
- Writing clear, engaging copy that drives action
- Structuring content for readability and impact
- Creating compelling headlines and hooks

Style preferences:
- Oxford comma: yes
- Avoid jargon unless writing for experts
- Show, don't tell when possible
- End with clear next steps or takeaways`,
    suggestedModel: "gpt-4o"
  },
  analyst: {
    name: "Business Analyst",
    role: "Analyst",
    systemPrompt: `You are a sharp business analyst. Your focus:

- Translating data into actionable insights
- Identifying trends, patterns, and anomalies
- Building frameworks for decision-making
- Competitive analysis and market research

Be specific with numbers and timeframes. Vague insights are less useful than concrete recommendations.`,
    suggestedModel: "gpt-4o"
  },
  assistant: {
    name: "Personal Assistant",
    role: "Assistant",
    systemPrompt: `You are a reliable personal assistant. Your priorities:

- Managing schedules and reminders
- Organizing information and tasks
- Drafting emails and messages
- Research and quick lookups

Be proactive about follow-ups and deadlines. Confirm details before acting. Keep track of preferences and patterns.`,
    suggestedModel: "gpt-4o"
  },
  "customer-support": {
    name: "Customer Support Agent",
    role: "Support",
    systemPrompt: `You are a skilled customer support agent. Your approach:

- Lead with empathy and understanding
- Solve problems quickly and completely
- Explain solutions clearly and patiently
- Turn negative experiences into positive ones

Tone: Warm, professional, and solution-oriented. Never defensive or dismissive.`,
    suggestedModel: "gpt-4o"
  }
};

async function loadVerifiedCount() {
  try {
    const res = await fetch('/api/selfclaw/v1/stats');
    if (res.ok) {
      const stats = await res.json();
      if (stats.totalAgents >= 10) {
        const countEl = document.getElementById('verified-count');
        if (countEl) {
          countEl.textContent = `${stats.totalAgents} agents verified`;
          countEl.style.display = 'block';
        }
      }
    }
  } catch (e) {
    console.log('Could not load verified count');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAuthState();
  loadStatus();
  loadEnvCheck();
  loadConfig();
  handleGmailCallbackParams();
  loadVerifiedCount();

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
  
  document.getElementById('check-verification')?.addEventListener('click', checkAgentVerification);
  document.getElementById('start-verification')?.addEventListener('click', startAgentVerification);

  document.querySelectorAll('.cockpit-tabs .tab-btn').forEach(btn => {
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
  const agentsSection = document.getElementById('agents-section') || document.getElementById('dashboard');
  const onboardingSection = document.getElementById('onboarding-section');
  const heroSignin = document.getElementById('hero-signin');
  const cockpitLink = document.getElementById('cockpit-link');
  
  const isCockpitPage = window.location.pathname === '/cockpit';
  
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
      
      if (cockpitLink) cockpitLink.style.display = 'inline-block';
      
      if (isCockpitPage) {
        landingSections.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
        document.body.classList.add('dashboard-mode');
        
        const selfclawSections = ['verify', 'check', 'why-section'];
        selfclawSections.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
        document.querySelectorAll('.api-section, .selfclaw-footer').forEach(el => {
          el.style.display = 'none';
        });
      }

      document.getElementById('user-name').textContent = 
        currentUser.firstName || currentUser.email || 'User';
      if (currentUser.profileImageUrl) {
        document.getElementById('user-avatar').src = currentUser.profileImageUrl;
        document.getElementById('user-avatar').style.display = 'block';
      }

      const cockpitLanding = document.getElementById('cockpit-landing');
      if (cockpitLanding) cockpitLanding.style.display = 'none';
      
      const profileRes = await fetch('/api/profile');
      if (profileRes.ok) {
        const profile = await profileRes.json();
        if (!profile.profileComplete && onboardingSection) {
          onboardingSection.style.display = 'block';
          if (agentsSection) agentsSection.style.display = 'none';
          loadProfileForm(profile);
        } else {
          if (onboardingSection) onboardingSection.style.display = 'none';
          if (agentsSection) agentsSection.style.display = 'block';
          loadAgents();
        }
      } else if (onboardingSection) {
        onboardingSection.style.display = 'block';
        if (agentsSection) agentsSection.style.display = 'none';
      } else if (agentsSection) {
        agentsSection.style.display = 'block';
        loadAgents();
      }
    } else {
      currentUser = null;
      if (loadingEl) loadingEl.style.display = 'none';
      if (loggedOutEl) loggedOutEl.style.display = 'block';
      if (loggedInEl) loggedInEl.style.display = 'none';
      if (agentsSection) agentsSection.style.display = 'none';
      if (onboardingSection) onboardingSection.style.display = 'none';
      
      landingSections.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      });
      document.body.classList.remove('dashboard-mode');
    }
  } catch (error) {
    console.error('Auth check failed:', error);
    if (loadingEl) loadingEl.style.display = 'none';
    if (loggedOutEl) loggedOutEl.style.display = 'block';
    if (loggedInEl) loggedInEl.style.display = 'none';
    if (agentsSection) agentsSection.style.display = 'none';
    if (onboardingSection) onboardingSection.style.display = 'none';
    
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
      const agentsEl = document.getElementById('agents-section') || document.getElementById('dashboard');
      if (agentsEl) agentsEl.style.display = 'block';
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
  const agentsEl = document.getElementById('agents-section') || document.getElementById('dashboard');
  if (agentsEl) agentsEl.style.display = 'block';
  loadAgents();
}

async function loadActivityFeed() {
  const feedEl = document.getElementById('activity-feed-sidebar');
  if (!feedEl) return;
  
  try {
    const res = await fetch('/api/activity?limit=10');
    if (!res.ok) throw new Error('Failed to load activity');
    const activities = await res.json();
    
    if (activities.length === 0) {
      feedEl.innerHTML = '<div class="activity-empty">No activity yet</div>';
      return;
    }
    
    const activityIcons = {
      agent_created: '&#x2B50;',
      chat: '&#x1F4AC;',
      tool_executed: '&#x1F527;',
      skill_invoked: '&#x1F504;',
      payment: '&#x1F4B8;',
      goal_updated: '&#x1F3AF;',
      default: '&#x25CF;'
    };
    
    feedEl.innerHTML = activities.map(a => {
      const icon = activityIcons[a.activityType] || activityIcons.default;
      const time = formatRelativeTime(new Date(a.createdAt));
      return `
        <div class="activity-item-compact">
          <div class="activity-title">${escapeHtml(a.title)}</div>
          <div class="activity-meta">
            <span>${a.agentName || 'System'}</span>
            <span>${time}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    feedEl.innerHTML = '<div class="activity-empty">Unable to load</div>';
  }
}

function formatRelativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

async function loadAgents() {
  const navEl = document.getElementById('agents-nav');
  navEl.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error('Failed to load agents');
    const agents = await res.json();
    
    loadActivityFeed();

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
  document.querySelectorAll('.cockpit-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.cockpit-content .tab-panel').forEach(panel => {
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
      document.getElementById('deposit-wallet-address').textContent = wallet.address;
      generateWalletQR(wallet.address);
    } else {
      document.getElementById('wallet-usdc').textContent = '$0.00';
      document.getElementById('wallet-full-address').textContent = 'Wallet not configured';
      document.getElementById('deposit-wallet-address').textContent = 'Wallet not configured';
    }

    await loadTransactions();
    await loadERC8004Status();
    await loadAgentTokens();
    await loadLiquidityPositions();
  } catch (error) {
    console.error('Failed to load wallet:', error);
  }
}

async function loadAgentTokens() {
  if (!currentAgent) return;
  
  const tokensEl = document.getElementById('agent-tokens-list');
  if (!tokensEl) return;
  
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/tokens`);
    const data = await res.json();
    
    if (data.tokens && data.tokens.length > 0) {
      tokensEl.innerHTML = data.tokens.map(token => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background: var(--gray-100); margin-bottom: 0.5rem; border: 1px solid var(--gray-300);">
          <div>
            <strong>${token.name}</strong>
            <span style="opacity: 0.7; margin-left: 0.5rem;">${token.symbol}</span>
          </div>
          <div style="font-size: 0.75rem;">
            <a href="https://celoscan.io/token/${token.contractAddress}" target="_blank" rel="noopener" style="color: var(--green);">
              ${token.contractAddress.slice(0, 8)}...${token.contractAddress.slice(-6)}
            </a>
          </div>
        </div>
      `).join('');
    } else {
      tokensEl.innerHTML = '<p class="note">No tokens deployed yet. Use the deploy_token tool to create one!</p>';
    }
  } catch (error) {
    console.error('Failed to load agent tokens:', error);
    tokensEl.innerHTML = '<p class="note" style="color: var(--coral);">Failed to load tokens</p>';
  }
}

function generateWalletQR(address) {
  const canvas = document.getElementById('wallet-qr-canvas');
  if (!canvas || !address) return;
  
  const size = 150;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  
  const qrData = address;
  const cellSize = 4;
  const margin = 10;
  const qrSize = size - margin * 2;
  
  ctx.fillStyle = '#000';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  
  const hash = Array.from(address).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  for (let y = 0; y < qrSize / cellSize; y++) {
    for (let x = 0; x < qrSize / cellSize; x++) {
      const val = (hash * (x + 1) * (y + 1)) % 3;
      if (val === 0 || (x < 3 && y < 3) || (x > qrSize/cellSize - 4 && y < 3) || (x < 3 && y > qrSize/cellSize - 4)) {
        ctx.fillRect(margin + x * cellSize, margin + y * cellSize, cellSize - 1, cellSize - 1);
      }
    }
  }
  
  ctx.fillStyle = '#fff';
  ctx.fillRect(margin, margin, 24, 24);
  ctx.fillRect(size - margin - 24, margin, 24, 24);
  ctx.fillRect(margin, size - margin - 24, 24, 24);
  ctx.fillStyle = '#000';
  ctx.fillRect(margin + 4, margin + 4, 16, 16);
  ctx.fillRect(size - margin - 20, margin + 4, 16, 16);
  ctx.fillRect(margin + 4, size - margin - 20, 16, 16);
  ctx.fillStyle = '#fff';
  ctx.fillRect(margin + 8, margin + 8, 8, 8);
  ctx.fillRect(size - margin - 16, margin + 8, 8, 8);
  ctx.fillRect(margin + 8, size - margin - 16, 8, 8);
}

function copyWalletAddress() {
  const address = document.getElementById('deposit-wallet-address')?.textContent;
  if (address && address !== '---' && address !== 'Wallet not configured') {
    navigator.clipboard.writeText(address).then(() => {
      showToast('Wallet address copied!');
    }).catch(() => {
      showToast('Failed to copy address', 'error');
    });
  }
}

async function loadLiquidityPositions() {
  if (!currentAgent) return;
  
  const positionsEl = document.getElementById('liquidity-positions-list');
  if (!positionsEl) return;
  
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/liquidity-positions`);
    const data = await res.json();
    
    if (data.positions && data.positions.length > 0) {
      positionsEl.innerHTML = data.positions.map(pos => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background: var(--gray-100); margin-bottom: 0.5rem; border: 1px solid var(--gray-300);">
          <div>
            <strong>${pos.token0Symbol}/${pos.token1Symbol}</strong>
            <span style="opacity: 0.7; margin-left: 0.5rem; font-size: 0.75rem;">${pos.feeTier}% fee</span>
          </div>
          <div style="font-size: 0.75rem; text-align: right;">
            <div>Position ID: ${pos.positionId}</div>
            <div style="opacity: 0.7;">Active</div>
          </div>
        </div>
      `).join('');
    } else {
      positionsEl.innerHTML = '<p class="note">No liquidity positions yet. Agent can use create_liquidity_pool tool to add liquidity.</p>';
    }
  } catch (error) {
    console.error('Failed to load liquidity positions:', error);
    positionsEl.innerHTML = '<p class="note">No liquidity positions yet.</p>';
  }
}

async function loadERC8004Status() {
  if (!currentAgent) return;
  
  const statusEl = document.getElementById('erc8004-status');
  const actionsEl = document.getElementById('erc8004-actions');
  
  if (!statusEl || !actionsEl) return;
  
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/erc8004`);
    const data = await res.json();
    
    if (data.minted && data.tokenId) {
      statusEl.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
          <span style="color: var(--green);">&#10003;</span>
          <span>Token ID: <strong>${data.tokenId}</strong></span>
        </div>
        ${data.explorerUrl ? `<a href="${data.explorerUrl}" target="_blank" rel="noopener" style="color: var(--green); font-size: 0.875rem;">View on Celoscan</a>` : ''}
      `;
      actionsEl.innerHTML = '';
    } else if (data.registrationJson) {
      if (data.contractsDeployed) {
        statusEl.innerHTML = `
          <p class="note">Registration file ready. Mint your agent's on-chain identity NFT.</p>
        `;
        actionsEl.innerHTML = `
          <button onclick="mintERC8004Identity()" class="btn btn-primary" style="width: 100%;">
            Mint On-Chain Identity
          </button>
        `;
      } else {
        statusEl.innerHTML = `
          <p class="note" style="color: var(--coral);">ERC-8004 contracts deploying to Celo mainnet soon. Your registration file is ready!</p>
          <details style="margin-top: 0.5rem; font-size: 0.75rem; opacity: 0.7;">
            <summary style="cursor: pointer;">View registration JSON</summary>
            <pre style="margin-top: 0.5rem; font-size: 0.7rem; overflow-x: auto; background: var(--gray-100); padding: 0.5rem;">${JSON.stringify(data.registrationJson, null, 2)}</pre>
          </details>
        `;
        actionsEl.innerHTML = `
          <button disabled class="btn btn-outline" style="width: 100%; opacity: 0.5;">
            Contracts Deploying Soon...
          </button>
        `;
      }
    } else {
      statusEl.innerHTML = `<p class="note">No registration file generated yet.</p>`;
      actionsEl.innerHTML = `
        <button onclick="generateERC8004Registration()" class="btn btn-outline" style="width: 100%;">
          Generate Registration File
        </button>
      `;
    }
  } catch (error) {
    console.error('Failed to load ERC-8004 status:', error);
    statusEl.innerHTML = `<p class="error">${error.message}</p>`;
    actionsEl.innerHTML = '';
  }
}

async function generateERC8004Registration() {
  if (!currentAgent) return;
  
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/erc8004/generate`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      await loadERC8004Status();
    } else {
      alert('Failed to generate: ' + (data.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function mintERC8004Identity() {
  if (!currentAgent) return;
  
  const actionsEl = document.getElementById('erc8004-actions');
  if (actionsEl) {
    actionsEl.innerHTML = `<p class="note">Minting...</p>`;
  }
  
  try {
    const res = await fetch(`/api/agents/${currentAgent.id}/erc8004/mint`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      alert('Successfully minted! Token ID: ' + data.tokenId);
      await loadERC8004Status();
    } else {
      alert('Minting failed: ' + (data.error || data.message || 'Unknown error'));
      await loadERC8004Status();
    }
  } catch (error) {
    alert('Error: ' + error.message);
    await loadERC8004Status();
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

function selectTemplate(templateId) {
  selectedTemplate = templateId;
  document.querySelectorAll('.template-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.template === templateId);
  });
  
  const template = AGENT_TEMPLATES[templateId];
  if (template) {
    if (templateId === 'blank') {
      document.getElementById('wizard-name').value = '';
      document.getElementById('wizard-prompt').value = '';
      document.getElementById('wizard-model').value = 'gpt-4o';
    } else {
      document.getElementById('wizard-name').value = template.name;
      document.getElementById('wizard-prompt').value = template.systemPrompt;
      document.getElementById('wizard-model').value = template.suggestedModel;
    }
  }
}

function wizardNext() {
  if (currentWizardStep === 1) {
    const name = document.getElementById('wizard-name').value.trim();
    if (!name) {
      document.getElementById('wizard-name').focus();
      return;
    }
    
    const template = AGENT_TEMPLATES[selectedTemplate];
    if (template && !document.getElementById('wizard-prompt').value.trim()) {
      document.getElementById('wizard-prompt').value = template.systemPrompt;
    }
    if (template && document.getElementById('wizard-model').value === 'gpt-4o') {
      document.getElementById('wizard-model').value = template.suggestedModel;
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

async function checkAgentVerification() {
  const pubkey = document.getElementById('check-pubkey').value.trim();
  const resultEl = document.getElementById('check-result');
  
  if (!pubkey) {
    resultEl.style.display = 'block';
    resultEl.className = 'check-result not-verified';
    resultEl.innerHTML = '<h4 class="not-verified-badge">Enter a public key or agent name</h4>';
    return;
  }
  
  try {
    const res = await fetch(`/api/selfclaw/v1/agent/${encodeURIComponent(pubkey)}`);
    const data = await res.json();
    
    resultEl.style.display = 'block';
    
    if (data.verified) {
      resultEl.className = 'check-result verified';
      resultEl.innerHTML = `
        <h4 class="verified-badge">VERIFIED</h4>
        <div class="result-details">
          <p><strong>Public Key:</strong> ${escapeHtml(data.publicKey?.substring(0, 30))}...</p>
          ${data.agentName ? `<p><strong>Agent Name:</strong> ${escapeHtml(data.agentName)}</p>` : ''}
          ${data.humanId ? `<p><strong>Human ID:</strong> ${escapeHtml(data.humanId)}</p>` : ''}
          <p><strong>Verification:</strong> Passport (Zero-Knowledge Proof)</p>
          <p><strong>Registered:</strong> ${new Date(data.selfxyz?.registeredAt).toLocaleDateString()}</p>
        </div>
      `;
    } else {
      resultEl.className = 'check-result not-verified';
      resultEl.innerHTML = `
        <h4 class="not-verified-badge">NOT VERIFIED</h4>
        <p>${data.message || 'This agent is not registered in the SelfClaw registry.'}</p>
      `;
    }
  } catch (error) {
    resultEl.style.display = 'block';
    resultEl.className = 'check-result not-verified';
    resultEl.innerHTML = `<h4 class="not-verified-badge">Error checking verification</h4><p>${error.message}</p>`;
  }
}

let currentVerificationSession = null;
let verificationPollInterval = null;
let selfSocket = null;

const WS_DB_RELAYER = 'wss://websocket.self.xyz';
const REDIRECT_URL = 'https://redirect.self.xyz';

function connectToSelfRelayer(sessionId, selfAppConfig, onSuccess, onError) {
  console.log('[SelfClaw] Connecting to Self.xyz WebSocket relayer...');
  
  const socket = io(WS_DB_RELAYER + '/websocket', {
    query: { sessionId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5
  });
  
  socket.on('connect', () => {
    console.log('[SelfClaw] WebSocket connected! Transport:', socket.io.engine.transport.name);
    socket.emit('register_session', {
      sessionId,
      selfApp: selfAppConfig
    });
    console.log('[SelfClaw] Session registered with relayer');
  });
  
  socket.on('connect_error', (error) => {
    console.error('[SelfClaw] WebSocket connection error:', error);
  });
  
  socket.on('mobile_status', (data) => {
    console.log('[SelfClaw] Mobile status update:', data);
    const statusEl = document.getElementById('verification-status');
    
    if (data.status === 'mobile_connected') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #00FFB6;">Phone connected! Generating proof...</span>';
    } else if (data.status === 'proof_generation_started') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #00FFB6;">Generating zero-knowledge proof...</span>';
    } else if (data.status === 'proof_generated') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #00FFB6;">Proof generated! Verifying...</span>';
    } else if (data.status === 'proof_verified' || data.status === 'done') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #00FFB6;">Verified successfully!</span>';
      if (onSuccess) onSuccess(data);
    } else if (data.status === 'error') {
      if (statusEl) statusEl.innerHTML = `<span style="color: #ff4444;">Error: ${data.message || 'Verification failed'}</span>`;
      if (onError) onError(data);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log('[SelfClaw] WebSocket disconnected:', reason);
  });
  
  return socket;
}

async function startAgentVerification() {
  const pubkey = document.getElementById('verify-pubkey').value.trim();
  const agentName = document.getElementById('verify-device-id').value.trim();
  const qrContainer = document.getElementById('qr-container');
  const qrEl = document.getElementById('selfxyz-qr');
  const startBtn = document.getElementById('start-verification');
  
  if (!pubkey) {
    alert('Please enter your agent\'s public key');
    return;
  }
  
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';
  
  try {
    const response = await fetch('/api/selfclaw/v1/start-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentPublicKey: pubkey, agentName })
    });
    
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to start verification');
    }
    
    currentVerificationSession = {
      sessionId: data.sessionId,
      agentPublicKey: pubkey,
      agentName,
      challenge: data.challenge,
      signatureVerified: data.signatureVerified
    };
    
    // Use the properly formatted selfApp config from backend (built with official SDK)
    const selfAppConfig = data.selfApp;
    
    if (selfSocket) {
      selfSocket.disconnect();
    }
    // Use the sessionId from the SDK-built config
    const wsSessionId = selfAppConfig.sessionId;
    selfSocket = connectToSelfRelayer(wsSessionId, selfAppConfig, 
      () => {
        console.log('[SelfClaw] Verification successful via WebSocket!');
        handleVerificationSuccess(pubkey, agentName);
      },
      (err) => {
        console.error('[SelfClaw] Verification error via WebSocket:', err);
      }
    );
    
    const selfUniversalLink = `${REDIRECT_URL}?selfApp=${encodeURIComponent(JSON.stringify(selfAppConfig))}`;
    
    console.log('[SelfClaw] Using deeplink mode with WebSocket for status updates');
    console.log('[SelfClaw] QR Config:', JSON.stringify(selfAppConfig, null, 2));
    console.log('[SelfClaw] Universal Link:', selfUniversalLink);
    
    const signatureStatus = data.signatureVerified 
      ? '<span style="color: #00FFB6;">Agent key ownership verified</span>'
      : '<span style="color: #888;">Optional: Sign challenge to prove key ownership</span>';
    
    qrContainer.style.display = 'block';
    qrEl.innerHTML = `
      <p style="margin-bottom: 0.75rem; color: #fff; font-weight: 600; font-size: 1rem;">Scan with Self App</p>
      <div id="qr-code-img" style="background: white; padding: 0.75rem; border-radius: 8px; display: inline-block; margin-bottom: 0.75rem;"></div>
      <p style="font-size: 0.8rem; color: #aaa; margin-bottom: 0.5rem; line-height: 1.5;">
        1. Open Self app on your phone<br/>
        2. Scan this QR code<br/>
        3. Approve the verification
      </p>
      <p style="font-size: 0.7rem; color: #555; margin-bottom: 0.75rem;">
        Agent: ${escapeHtml(pubkey.substring(0, 12))}...
      </p>
      <a href="${selfUniversalLink}" target="_blank" class="btn btn-outline btn-sm" style="display: inline-block; margin-bottom: 0.75rem;">
        Open in Self App
      </a>
      <div id="verification-status" style="padding: 0.5rem 0.75rem; border-radius: 6px; background: rgba(255,255,255,0.05); border: 1px solid #333;">
        <span style="color: #888; font-size: 0.85rem;">Waiting for verification...</span>
      </div>
      
      <details style="margin-top: 1rem; text-align: left;">
        <summary style="color: #555; cursor: pointer; font-size: 0.75rem;">Developer: Sign Challenge (Optional)</summary>
        <div style="margin-top: 0.5rem; padding: 0.75rem; background: rgba(0,0,0,0.3); border-radius: 6px;">
          <p style="font-size: 0.7rem; color: #777; margin-bottom: 0.5rem;">${signatureStatus}</p>
          <p style="font-size: 0.65rem; color: #555; margin-bottom: 0.25rem;">Challenge to sign:</p>
          <code style="display: block; background: #0a0a0a; padding: 0.4rem; border-radius: 4px; font-size: 0.6rem; color: #888; word-break: break-all; max-height: 60px; overflow-y: auto;">${escapeHtml(data.challenge)}</code>
          ${!data.signatureVerified ? `
          <input type="text" id="agent-signature" class="input" placeholder="Paste Ed25519 signature (hex)" style="margin-top: 0.5rem; font-size: 0.7rem;" />
          <button onclick="submitAgentSignature('${data.sessionId}')" class="btn btn-outline btn-sm" style="margin-top: 0.5rem; width: 100%;">Verify Signature</button>
          ` : ''}
        </div>
      </details>
    `;
    
    if (typeof QRCode !== 'undefined') {
      new QRCode(document.getElementById('qr-code-img'), {
        text: selfUniversalLink,
        width: 180,
        height: 180,
        colorDark: '#000000',
        colorLight: '#ffffff'
      });
    } else {
      document.getElementById('qr-code-img').innerHTML = `
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(selfUniversalLink)}" alt="QR Code" />
      `;
    }
    
    startVerificationPolling(data.sessionId, pubkey, agentName);
    
  } catch (error) {
    alert('Error starting verification: ' + error.message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Verification';
  }
}

function handleVerificationSuccess(pubkey, agentName) {
  const statusEl = document.getElementById('verification-status');
  if (statusEl) {
    statusEl.innerHTML = `
      <div style="text-align: center;">
        <span style="color: #fff; font-weight: 600; font-size: 1rem;">Verified</span>
        <p style="margin-top: 0.5rem; font-size: 0.8rem; color: #aaa;">
          Your agent is now linked to your human identity.
        </p>
        <div style="margin-top: 1rem; display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">
          <a href="/developers" class="btn btn-primary btn-sm">Integrate in Your App</a>
          <button onclick="showDonateModal()" class="btn btn-outline btn-sm">Support Project</button>
        </div>
        <p style="margin-top: 0.75rem; font-size: 0.7rem; color: #555;">
          <a href="/registry" style="color: #888;">View all verified agents</a>
        </p>
      </div>
    `;
    statusEl.style.background = 'rgba(255,255,255,0.03)';
    statusEl.style.border = '1px solid #444';
    statusEl.style.padding = '1rem';
  }
  const qrImg = document.getElementById('qr-code-img');
  if (qrImg) qrImg.style.display = 'none';
  
  if (verificationPollInterval) {
    clearInterval(verificationPollInterval);
  }
  if (selfSocket) {
    selfSocket.disconnect();
    selfSocket = null;
  }
}

function startVerificationPolling(sessionId, pubkey, agentName) {
  if (verificationPollInterval) {
    clearInterval(verificationPollInterval);
  }
  
  let attempts = 0;
  const maxAttempts = 120; // 2 minutes at 1 second intervals
  let pollInterval = 2000; // Start at 2 seconds
  
  const poll = async () => {
    attempts++;
    
    if (attempts > maxAttempts) {
      clearInterval(verificationPollInterval);
      document.getElementById('verification-status').innerHTML = `
        <span style="color: #ff6b6b;">Verification timed out. Please try again.</span>
      `;
      return;
    }
    
    try {
      // Poll the session status endpoint
      const response = await fetch(`/api/selfclaw/v1/status/${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      
      if (data.status === 'verified' && data.agent) {
        clearInterval(verificationPollInterval);
        handleVerificationSuccess(pubkey, agentName);
      } else if (data.status === 'expired') {
        clearInterval(verificationPollInterval);
        document.getElementById('verification-status').innerHTML = `
          <span style="color: #ff6b6b;">Session expired. Please start again.</span>
        `;
      }
      // Keep polling if status is 'pending' or 'not_found'
    } catch (e) {
      console.error('[polling] Error:', e);
    }
  };
  
  // Start polling immediately
  poll();
  verificationPollInterval = setInterval(poll, pollInterval);
}

async function submitAgentSignature(sessionId) {
  const signatureInput = document.getElementById('agent-signature');
  const signature = signatureInput?.value?.trim();
  
  if (!signature) {
    alert('Please enter the signature');
    return;
  }
  
  try {
    const response = await fetch('/api/selfclaw/v1/sign-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, signature })
    });
    
    const data = await response.json();
    
    if (data.success) {
      const statusEl = signatureInput.parentElement.querySelector('p');
      if (statusEl) {
        statusEl.innerHTML = '<span style="color: #00FFB6;">Agent key ownership verified</span>';
      }
      signatureInput.style.display = 'none';
      signatureInput.nextElementSibling.style.display = 'none';
      
      if (currentVerificationSession) {
        currentVerificationSession.signatureVerified = true;
      }
    } else {
      alert('Signature verification failed: ' + (data.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Error verifying signature: ' + error.message);
  }
}

const checkBotVerification = checkAgentVerification;
const startBotVerification = startAgentVerification;

// ============================================
// Self.xyz Login Functions
// ============================================

let selfLoginSessionId = null;
let selfLoginPollInterval = null;

async function startSelfLogin() {
  const modal = document.getElementById('self-login-modal');
  const qrContainer = document.getElementById('self-login-qr');
  const statusEl = document.getElementById('self-login-status');
  
  if (!modal || !qrContainer) {
    console.error('Self login modal not found');
    return;
  }
  
  // Show modal
  modal.style.display = 'flex';
  qrContainer.innerHTML = '<div class="loading-spinner"></div>';
  statusEl.textContent = 'Starting verification...';
  
  try {
    // Start auth session
    const response = await fetch('/api/auth/self/start', { method: 'POST' });
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error || 'Failed to start login');
    }
    
    selfLoginSessionId = data.sessionId;
    
    // Render QR code
    if (data.selfApp) {
      const qrUrl = `https://self.xyz/verify?scope=${encodeURIComponent(data.selfApp.scope || 'selfclaw-auth')}&session=${data.sessionId}`;
      qrContainer.innerHTML = `
        <div style="background: white; padding: 16px; border-radius: 8px;">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(JSON.stringify(data.selfApp))}" 
               alt="Scan with Self app" 
               style="display: block; width: 200px; height: 200px;" />
        </div>
      `;
    }
    
    statusEl.textContent = 'Scan with your Self app...';
    
    // Start polling for verification
    startLoginPolling(data.sessionId);
    
  } catch (error) {
    console.error('Self login error:', error);
    qrContainer.innerHTML = `<p style="color: #ff6b6b;">Error: ${error.message}</p>`;
    statusEl.textContent = 'Login failed';
  }
}

function startLoginPolling(sessionId) {
  if (selfLoginPollInterval) {
    clearInterval(selfLoginPollInterval);
  }
  
  const statusEl = document.getElementById('self-login-status');
  
  const poll = async () => {
    try {
      const response = await fetch(`/api/auth/self/status/${sessionId}`);
      const data = await response.json();
      
      if (data.status === 'verified') {
        // Stop polling
        clearInterval(selfLoginPollInterval);
        selfLoginPollInterval = null;
        
        statusEl.textContent = 'Verified! Logging in...';
        
        // Complete login
        const completeRes = await fetch('/api/auth/self/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        
        const completeData = await completeRes.json();
        
        if (completeData.success) {
          statusEl.textContent = 'Success! Redirecting...';
          setTimeout(() => {
            closeSelfLoginModal();
            loadAuthState();
          }, 500);
        } else {
          statusEl.textContent = 'Login error: ' + (completeData.error || 'Unknown');
        }
      } else if (data.status === 'expired') {
        clearInterval(selfLoginPollInterval);
        selfLoginPollInterval = null;
        statusEl.textContent = 'Session expired. Please try again.';
      } else if (data.status === 'not_found') {
        // Session might not be ready yet, keep polling
      }
      // Keep polling if pending
    } catch (e) {
      console.error('Login polling error:', e);
    }
  };
  
  poll();
  selfLoginPollInterval = setInterval(poll, 2000);
}

function closeSelfLoginModal() {
  const modal = document.getElementById('self-login-modal');
  if (modal) modal.style.display = 'none';
  
  if (selfLoginPollInterval) {
    clearInterval(selfLoginPollInterval);
    selfLoginPollInterval = null;
  }
  selfLoginSessionId = null;
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSelfLoginModal();
  }
});

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('self-login-modal');
  if (e.target === modal) {
    closeSelfLoginModal();
  }
});
