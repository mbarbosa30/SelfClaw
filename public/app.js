
async function loadEcosystemStats() {
  try {
    const response = await fetch('/api/selfclaw/v1/ecosystem-stats');
    if (!response.ok) return;
    const data = await response.json();
    
    const statsSection = document.querySelector('.ecosystem-stats-section');
    if (!statsSection) return;
    
    if ((data.verifiedAgents ?? 0) < 10) {
      statsSection.style.display = 'none';
      return;
    }
    
    statsSection.style.display = 'block';
    
    const verified = document.getElementById('stat-verified');
    const tokens = document.getElementById('stat-tokens');
    const pools = document.getElementById('stat-pools');
    const sponsored = document.getElementById('stat-sponsored');
    
    if (verified) verified.textContent = data.verifiedAgents ?? 0;
    if (tokens) tokens.textContent = data.tokensDeployed ?? 0;
    if (pools) pools.textContent = data.activePools ?? 0;
    if (sponsored) sponsored.textContent = data.sponsoredAgents ?? 0;
  } catch (e) {
    console.log('[stats] Could not load ecosystem stats');
  }
}

loadEcosystemStats();

function initLookupWidget() {
  const lookupBtn = document.getElementById('lookup-btn');
  const lookupInput = document.getElementById('lookup-key');
  const lookupResult = document.getElementById('lookup-result');
  
  if (!lookupBtn || !lookupInput || !lookupResult) return;
  
  async function performLookup() {
    const query = lookupInput.value.trim();
    if (!query) return;
    
    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Checking...';
    lookupResult.style.display = 'none';
    
    try {
      const response = await fetch('/api/selfclaw/v1/agent/' + encodeURIComponent(query));
      if (!response.ok) {
        throw new Error('Agent not found');
      }
      const data = await response.json();
      
      if (data.verified) {
        lookupResult.className = 'lookup-result verified';
        lookupResult.innerHTML = `
          <span class="status-badge verified">Verified</span>
          <div><strong>humanId:</strong> ${data.humanId ? data.humanId.substring(0, 16) + '...' : 'N/A'}</div>
          <div><strong>Registered:</strong> ${data.registeredAt ? new Date(data.registeredAt).toLocaleDateString() : 'N/A'}</div>
          ${data.name ? `<div><strong>Name:</strong> ${data.name}</div>` : ''}
        `;
      } else {
        lookupResult.className = 'lookup-result not-verified';
        lookupResult.innerHTML = `
          <span class="status-badge not-verified">Not Verified</span>
          <div>This agent is not registered in SelfClaw.</div>
        `;
      }
      lookupResult.style.display = 'block';
    } catch (error) {
      lookupResult.className = 'lookup-result not-verified';
      lookupResult.innerHTML = `<span class="status-badge not-verified">Error</span><div>Could not check agent status.</div>`;
      lookupResult.style.display = 'block';
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Check';
    }
  }
  
  lookupBtn.addEventListener('click', performLookup);
  lookupInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performLookup();
  });
}

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
  loadVerifiedCount();
  initLookupWidget();
  initIntegrationTabs();

  const startBtn = document.getElementById('start-verification');
  if (startBtn) {
    startBtn.addEventListener('click', startAgentVerification);
  }
});

function debounce(fn, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      if (statusEl) statusEl.innerHTML = '<span style="color: #FF6B4A;">Phone connected! Generating proof...</span>';
    } else if (data.status === 'proof_generation_started') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #FF6B4A;">Generating zero-knowledge proof...</span>';
    } else if (data.status === 'proof_generated') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #FF6B4A;">Proof generated! Verifying...</span>';
    } else if (data.status === 'proof_verified' || data.status === 'done') {
      if (statusEl) statusEl.innerHTML = '<span style="color: #FF6B4A;">Verified successfully!</span>';
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
    
    const selfAppConfig = data.selfApp;
    
    if (selfSocket) {
      selfSocket.disconnect();
    }
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
      ? '<span style="color: #FF6B4A;">Agent key ownership verified</span>'
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
  
  const agentPrompt = `Read https://selfclaw.ai/agent-economy.md — you're now verified on SelfClaw. This guide shows how to create a wallet, deploy your own token, and access sponsored SELFCLAW liquidity.`;

  if (statusEl) {
    statusEl.innerHTML = `
      <div style="text-align: center; margin-bottom: 1.5rem;">
        <div style="color: #FF6B4A; font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem;">Verified</div>
        <p style="font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5;">
          Your agent is now linked to your passport-backed human identity.
        </p>
      </div>
      
      <div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; margin-bottom: 1.5rem;">
        <a href="/developers" class="btn btn-primary">Developer Docs</a>
        <a href="/registry" class="btn btn-outline">View Registry</a>
      </div>
      
      <details open style="text-align: left;">
        <summary style="color: var(--green); cursor: pointer; font-size: 0.95rem; font-weight: 500; padding: 0.75rem 0; border-top: 1px solid var(--border-subtle);">Next Step: Agent Economy</summary>
        <div style="margin-top: 1rem; padding: 1rem; background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: 8px;">
          <p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.5;">
            Verified agents can optionally create wallets, deploy tokens, and access sponsored SELFCLAW liquidity. Give this prompt to your agent:
          </p>
          <div style="background: var(--bg-darker); padding: 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.8rem; color: var(--text-muted); word-break: break-word; border: 1px solid var(--border-subtle);" id="agent-prompt-text">${escapeHtml(agentPrompt)}</div>
          <button onclick="copyAgentPrompt()" class="btn btn-outline btn-sm" style="margin-top: 0.75rem; width: 100%;" id="copy-prompt-btn">Copy Prompt</button>
        </div>
      </details>
    `;
    statusEl.style.background = 'rgba(255,255,255,0.02)';
    statusEl.style.border = '1px solid var(--border-subtle)';
    statusEl.style.padding = '1.5rem';
    statusEl.style.borderRadius = '12px';
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

function copyAgentPrompt() {
  const promptText = document.getElementById('agent-prompt-text');
  const btn = document.getElementById('copy-prompt-btn');
  if (promptText && btn) {
    navigator.clipboard.writeText(promptText.textContent).then(() => {
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.background = '#FF6B4A';
      btn.style.color = '#000';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '';
        btn.style.color = '';
      }, 2000);
    });
  }
}

function startVerificationPolling(sessionId, pubkey, agentName) {
  if (verificationPollInterval) {
    clearInterval(verificationPollInterval);
  }
  
  let attempts = 0;
  const maxAttempts = 120;
  let pollInterval = 2000;
  
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
    } catch (e) {
      console.error('[polling] Error:', e);
    }
  };
  
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
        statusEl.innerHTML = '<span style="color: #FF6B4A;">Agent key ownership verified</span>';
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
