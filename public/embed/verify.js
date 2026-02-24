(function(global) {
  'use strict';

  var API_BASE = 'https://selfclaw.ai/api/selfclaw/v1';

  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    API_BASE = window.location.origin + '/api/selfclaw/v1';
  }

  var STYLES = [
    '.sc-verify { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }',
    '.sc-verify * { box-sizing: border-box; margin: 0; padding: 0; }',
    '.sc-verify-card { border: 2px solid #333; padding: 1.5rem; max-width: 400px; }',
    '.sc-verify-card[data-theme="dark"] { background: #1a1a1a; color: #e8e4df; border-color: #444; }',
    '.sc-verify-card[data-theme="light"] { background: #f2f0ec; color: #1a1a1a; border-color: #1a1a1a; }',
    '.sc-verify-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 1rem; }',
    '.sc-verify-title span { color: #FF6B4A; }',
    '.sc-verify-status { font-size: 0.85rem; line-height: 1.6; margin-bottom: 1rem; }',
    '.sc-verify-qr { text-align: center; padding: 1rem 0; }',
    '.sc-verify-qr canvas, .sc-verify-qr img { max-width: 200px; max-height: 200px; }',
    '.sc-verify-qr-fallback { border: 2px solid #333; padding: 1rem; font-family: monospace; font-size: 0.7rem; word-break: break-all; max-height: 120px; overflow: auto; }',
    '.sc-verify-hint { font-size: 0.75rem; color: #888; margin-top: 0.5rem; text-align: center; }',
    '.sc-verify-success { color: #22c55e; font-weight: 600; }',
    '.sc-verify-error { color: #ef4444; font-size: 0.8rem; margin-top: 0.5rem; }',
    '.sc-verify-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #888; border-top-color: #FF6B4A; border-radius: 50%; animation: sc-spin 0.8s linear infinite; margin-right: 0.4rem; vertical-align: middle; }',
    '@keyframes sc-spin { to { transform: rotate(360deg); } }',
    '.sc-verify-btn { background: #FF6B4A; color: #fff; border: 2px solid #1a1a1a; padding: 0.6rem 1.2rem; font-size: 0.8rem; font-weight: 600; cursor: pointer; font-family: inherit; text-transform: uppercase; letter-spacing: 0.05em; }',
    '.sc-verify-btn:hover { background: #e55a3a; }',
    '.sc-verify-btn:disabled { opacity: 0.5; cursor: not-allowed; }'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('sc-verify-styles')) return;
    var style = document.createElement('style');
    style.id = 'sc-verify-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function detectTheme() {
    if (document.documentElement.getAttribute('data-theme') === 'dark') return 'dark';
    if (document.documentElement.getAttribute('data-theme') === 'light') return 'light';
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  function SelfClawVerify(options) {
    if (!options.container) throw new Error('SelfClaw.verify: container is required');
    if (!options.agentName) throw new Error('SelfClaw.verify: agentName is required');
    if (!options.onVerified) throw new Error('SelfClaw.verify: onVerified callback is required');

    injectStyles();

    var el = typeof options.container === 'string'
      ? document.querySelector(options.container)
      : options.container;

    if (!el) throw new Error('SelfClaw.verify: container element not found');

    var theme = options.theme || detectTheme();
    var pollInterval = options.pollInterval || 3000;
    var polling = null;
    var sessionId = null;

    el.innerHTML = '';
    el.classList.add('sc-verify');

    var card = document.createElement('div');
    card.className = 'sc-verify-card';
    card.setAttribute('data-theme', theme);
    el.appendChild(card);

    function render(content) {
      card.innerHTML = '<div class="sc-verify-title">\\\\ <span>SELFCLAW</span> VERIFY</div>' + content;
    }

    function renderError(msg) {
      render('<div class="sc-verify-error">' + msg + '</div>' +
        '<button class="sc-verify-btn" style="margin-top:1rem" onclick="this.closest(\'.sc-verify\').selfclawRetry()">RETRY</button>');
    }

    el.selfclawRetry = function() { startVerification(); };

    async function startVerification() {
      render('<div class="sc-verify-status"><span class="sc-verify-spinner"></span> Starting verification&hellip;</div>');

      try {
        var body = {
          agentPublicKey: options.agentPublicKey || '',
          agentName: options.agentName,
          agentDescription: options.agentDescription || '',
          category: options.category || 'general'
        };
        if (options.referralCode) body.referralCode = options.referralCode;

        var res = await fetch(API_BASE + '/start-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          throw new Error(errData.error || 'Verification request failed (' + res.status + ')');
        }

        var data = await res.json();
        sessionId = data.sessionId;

        var qrHtml = '<div class="sc-verify-qr">';
        if (data.qrData) {
          qrHtml += '<div class="sc-verify-qr-fallback">' + escapeHtml(data.qrData) + '</div>';
          qrHtml += '<div class="sc-verify-hint">Open the Self app and scan this code.<br>Your passport NFC chip will be read for verification.</div>';
        }
        qrHtml += '</div>';

        render(
          '<div class="sc-verify-status">Scan with the <strong>Self</strong> app to verify your identity.</div>' +
          qrHtml +
          '<div class="sc-verify-status" style="margin-top:1rem"><span class="sc-verify-spinner"></span> Waiting for verification&hellip;</div>'
        );

        startPolling();
      } catch (err) {
        renderError(err.message);
        if (options.onError) options.onError(err);
      }
    }

    function startPolling() {
      if (polling) clearInterval(polling);
      polling = setInterval(async function() {
        try {
          var res = await fetch(API_BASE + '/verification-status/' + sessionId);
          if (!res.ok) return;
          var data = await res.json();
          if (data.status === 'verified') {
            clearInterval(polling);
            polling = null;
            render(
              '<div class="sc-verify-status sc-verify-success">' +
              '&#10003; Verified</div>' +
              '<div class="sc-verify-status" style="font-size:0.8rem;">Agent: ' + escapeHtml(options.agentName) + '</div>'
            );
            options.onVerified({
              humanId: data.humanId,
              publicKey: data.publicKey || options.agentPublicKey,
              agentName: options.agentName,
              sessionId: sessionId
            });
          }
        } catch (e) {
          // polling error, keep trying
        }
      }, pollInterval);
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str || '';
      return div.innerHTML;
    }

    startVerification();

    return {
      destroy: function() {
        if (polling) clearInterval(polling);
        el.innerHTML = '';
        el.classList.remove('sc-verify');
      }
    };
  }

  var SelfClaw = { verify: SelfClawVerify, API_BASE: API_BASE };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SelfClaw;
  } else {
    global.SelfClaw = SelfClaw;
  }
})(typeof window !== 'undefined' ? window : this);
