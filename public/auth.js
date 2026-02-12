(function() {
  var authState = { user: null, checking: true };
  var isMiniPay = false;
  var loginModal = null;
  var loginPollInterval = null;
  var loginSocket = null;

  var WS_DB_RELAYER = 'wss://websocket.self.xyz';
  var REDIRECT_URL = 'https://redirect.self.xyz';

  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function detectMiniPay() {
    if (window.ethereum && (window.ethereum.isMiniPay || window.ethereum.isMinipay)) {
      return true;
    }
    if (navigator.userAgent && navigator.userAgent.indexOf('MiniPay') !== -1) {
      return true;
    }
    return false;
  }

  async function connectMiniPay() {
    var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    var address = accounts[0];
    if (!address) throw new Error('No account');

    var tokenRes = await fetch('/api/auth/self/wallet/minipay-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    var tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('Failed to get auth token');

    var res = await fetch('/api/auth/self/wallet/minipay-connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, token: tokenData.token })
    });
    var data = await res.json();

    if (data.success) {
      authState.user = data.user;
      authState.checking = false;
      renderAuthUI();
      if (window.onAuthLogin) window.onAuthLogin(authState.user);
    } else {
      throw new Error(data.error || 'MiniPay connection failed');
    }
  }

  async function checkAuth() {
    if (detectMiniPay()) {
      isMiniPay = true;
      try {
        await connectMiniPay();
        return;
      } catch(e) {
        console.log('[auth] MiniPay auto-connect failed, falling back:', e);
      }
    } else if (!window.ethereum && navigator.userAgent && navigator.userAgent.indexOf('MiniPay') !== -1) {
      isMiniPay = true;
      try {
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
        if (window.ethereum) {
          await connectMiniPay();
          return;
        } else {
          console.log('[auth] MiniPay detected by UA but ethereum provider not available after delay');
        }
      } catch(e) {
        console.log('[auth] MiniPay delayed auto-connect failed, falling back:', e);
      }
    } else if (!window.ethereum) {
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
      if (detectMiniPay()) {
        isMiniPay = true;
        try {
          await connectMiniPay();
          return;
        } catch(e) {
          console.log('[auth] MiniPay delayed auto-connect failed, falling back:', e);
        }
      }
    }

    try {
      var res = await fetch('/api/auth/self/me');
      if (res.ok) {
        authState.user = await res.json();
      } else {
        authState.user = null;
      }
    } catch (e) {
      authState.user = null;
    }
    authState.checking = false;
    renderAuthUI();
  }

  function renderAuthUI() {
    var nav = document.querySelector('.site-nav');
    if (!nav) return;

    var existing = document.getElementById('auth-nav-item');
    if (existing) existing.remove();

    var el = document.createElement('span');
    el.id = 'auth-nav-item';
    el.style.display = 'inline-flex';
    el.style.alignItems = 'center';
    el.style.gap = '0.5rem';
    el.style.marginLeft = '0.25rem';

    if (authState.checking) {
      el.innerHTML = '<span class="nav-link" style="opacity:0.5;cursor:default;">...</span>';
    } else if (authState.user) {
      var hid = authState.user.humanId || '';
      var walletAddr = authState.user.walletAddress || '';
      var display;
      if (walletAddr && (!hid || hid.startsWith('0x'))) {
        display = walletAddr.substring(0, 6) + '...' + walletAddr.substring(walletAddr.length - 4);
      } else if (hid) {
        display = hid.substring(0, 8) + '...';
      } else {
        display = 'User';
      }
      el.innerHTML = '<a href="/my-agents" class="nav-link" style="border:2px solid var(--green-verify);padding:0.2rem 0.6rem;font-size:0.7rem;">' + escHtml(display) + '</a>';

      var logoutBtn = document.createElement('a');
      logoutBtn.href = '#';
      logoutBtn.className = 'nav-link';
      logoutBtn.style.fontSize = '0.65rem';
      logoutBtn.style.opacity = '0.6';
      logoutBtn.textContent = 'OUT';
      logoutBtn.addEventListener('click', function(e) {
        e.preventDefault();
        logout();
      });
      el.appendChild(logoutBtn);
    } else {
      var loginBtn = document.createElement('a');
      loginBtn.href = '#';
      loginBtn.className = 'nav-link';
      loginBtn.style.border = '2px solid var(--border-heavy)';
      loginBtn.style.padding = '0.2rem 0.6rem';
      loginBtn.style.fontSize = '0.7rem';
      loginBtn.textContent = 'LOGIN';
      loginBtn.addEventListener('click', function(e) {
        e.preventDefault();
        openLoginModal();
      });
      el.appendChild(loginBtn);
    }

    nav.appendChild(el);
  }

  function createLoginModal() {
    if (loginModal) return loginModal;

    var overlay = document.createElement('div');
    overlay.id = 'login-modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:none;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg);border:2px solid var(--border-heavy);padding:2rem;max-width:420px;width:90%;position:relative;';

    box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">' +
      '<div style="font-family:var(--font-mono);font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--accent);">Login with Self</div>' +
      '<button id="login-modal-close" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text);padding:0.25rem;">&times;</button>' +
      '</div>' +
      '<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:1.5rem;line-height:1.5;">Scan the QR code with your Self app to authenticate. No passwords, no email — just your verified identity.</p>' +
      '<div id="login-qr-area" style="text-align:center;padding:1rem 0;">' +
      '<div style="color:var(--text-muted);font-size:0.8rem;">Loading...</div>' +
      '</div>' +
      '<div id="login-status" style="text-align:center;font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted);margin-top:1rem;"></div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeLoginModal();
    });

    box.querySelector('#login-modal-close').addEventListener('click', closeLoginModal);

    loginModal = overlay;
    return overlay;
  }

  async function openLoginModal() {
    if (isMiniPay) {
      try {
        await connectMiniPay();
      } catch(e) {
        console.error('[auth] MiniPay login failed:', e);
        var modal = createLoginModal();
        modal.style.display = 'flex';
        var qrArea = document.getElementById('login-qr-area');
        var statusEl = document.getElementById('login-status');
        qrArea.innerHTML = '<div style="color:var(--red);font-size:0.85rem;margin-bottom:1rem;">MiniPay connection failed: ' + escHtml(e.message) + '</div>' +
          '<button id="minipay-retry-btn" style="background:var(--accent);color:var(--bg);border:none;padding:0.5rem 1.5rem;font-family:var(--font-mono);font-size:0.8rem;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em;">Retry Connection</button>';
        statusEl.textContent = 'Tap retry to reconnect your MiniPay wallet';
        document.getElementById('minipay-retry-btn').addEventListener('click', async function() {
          qrArea.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">Connecting to MiniPay...</div>';
          statusEl.textContent = '';
          try {
            await connectMiniPay();
            closeLoginModal();
          } catch(retryErr) {
            qrArea.innerHTML = '<div style="color:var(--red);font-size:0.85rem;margin-bottom:1rem;">MiniPay connection failed: ' + escHtml(retryErr.message) + '</div>' +
              '<button id="minipay-retry-btn2" style="background:var(--accent);color:var(--bg);border:none;padding:0.5rem 1.5rem;font-family:var(--font-mono);font-size:0.8rem;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em;">Retry Connection</button>';
            statusEl.textContent = 'Tap retry to reconnect your MiniPay wallet';
            document.getElementById('minipay-retry-btn2').addEventListener('click', arguments.callee);
          }
        });
      }
      return;
    }

    var modal = createLoginModal();
    modal.style.display = 'flex';

    var qrArea = document.getElementById('login-qr-area');
    var statusEl = document.getElementById('login-status');

    qrArea.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">Initializing...</div>';
    statusEl.textContent = '';

    try {
      var res = await fetch('/api/auth/self/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      var data = await res.json();

      if (!data.success) {
        qrArea.innerHTML = '<div style="color:var(--red);">Failed: ' + escHtml(data.error || 'Unknown error') + '</div>';
        return;
      }

      var selfAppConfig = data.selfApp;
      var sessionId = data.sessionId;

      var selfUniversalLink = REDIRECT_URL + '?selfApp=' + encodeURIComponent(JSON.stringify(selfAppConfig));

      qrArea.innerHTML = '<div id="login-qr-img" style="background:white;padding:0.75rem;display:inline-block;margin-bottom:0.75rem;border:2px solid var(--border-heavy);"></div>' +
        '<br><a href="' + escHtml(selfUniversalLink) + '" target="_blank" style="font-family:var(--font-mono);font-size:0.7rem;color:var(--accent);">Open in Self App</a>';

      statusEl.textContent = 'Waiting for QR scan...';

      var qrContainer = document.getElementById('login-qr-img');
      if (typeof QRCode !== 'undefined') {
        new QRCode(qrContainer, {
          text: selfUniversalLink,
          width: 200,
          height: 200,
          colorDark: '#000000',
          colorLight: '#ffffff'
        });
      } else {
        qrContainer.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(selfUniversalLink) + '" alt="QR Code" style="width:200px;height:200px;" />';
      }

      startLoginPolling(sessionId);

    } catch (err) {
      qrArea.innerHTML = '<div style="color:var(--red);">Error: ' + escHtml(err.message) + '</div>';
    }
  }

  function startLoginPolling(sessionId) {
    if (loginPollInterval) clearInterval(loginPollInterval);

    var attempts = 0;
    var maxAttempts = 120;

    var poll = async function() {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(loginPollInterval);
        var s = document.getElementById('login-status');
        if (s) s.textContent = 'Session expired. Close and try again.';
        return;
      }

      try {
        var res = await fetch('/api/auth/self/status/' + encodeURIComponent(sessionId));
        var data = await res.json();

        if (data.status === 'verified' && data.humanId) {
          clearInterval(loginPollInterval);

          var statusEl = document.getElementById('login-status');
          if (statusEl) {
            statusEl.style.color = 'var(--green-verify)';
            statusEl.textContent = 'Verified! Logging in...';
          }

          var completeRes = await fetch('/api/auth/self/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId })
          });
          var completeData = await completeRes.json();

          if (completeData.success) {
            authState.user = completeData.user;
            renderAuthUI();
            closeLoginModal();

            if (window.onAuthLogin) {
              window.onAuthLogin(authState.user);
            }

            var stayPages = ['/my-agents', '/create-agent', '/verify'];
            var currentPath = window.location.pathname;
            var shouldStay = stayPages.some(function(p) { return currentPath.startsWith(p); });
            if (!shouldStay) {
              window.location.href = '/my-agents';
            }
          } else {
            if (statusEl) {
              statusEl.style.color = 'var(--red)';
              statusEl.textContent = 'Login failed: ' + (completeData.error || 'Unknown error');
            }
          }
        } else if (data.status === 'expired') {
          clearInterval(loginPollInterval);
          var s = document.getElementById('login-status');
          if (s) s.textContent = 'Session expired. Close and try again.';
        }
      } catch (e) {
        console.error('[auth] polling error:', e);
      }
    };

    poll();
    loginPollInterval = setInterval(poll, 2000);
  }

  function closeLoginModal() {
    if (loginModal) loginModal.style.display = 'none';
    if (loginPollInterval) {
      clearInterval(loginPollInterval);
      loginPollInterval = null;
    }
    if (loginSocket) {
      loginSocket.disconnect();
      loginSocket = null;
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/self/logout', { method: 'POST' });
    } catch (e) {}
    authState.user = null;
    renderAuthUI();
    if (window.onAuthLogout) window.onAuthLogout();
  }

  window.selfclawAuth = {
    getUser: function() { return authState.user; },
    isLoggedIn: function() { return !!authState.user; },
    isMiniPay: function() { return isMiniPay; },
    isMiniPayUser: function() { return !!(authState.user && authState.user.authMethod === 'minipay'); },
    openLogin: openLoginModal,
    logout: logout,
    onReady: function(cb) {
      if (!authState.checking) { cb(authState.user); return; }
      var check = setInterval(function() {
        if (!authState.checking) { clearInterval(check); cb(authState.user); }
      }, 100);
    }
  };

  checkAuth();
})();
