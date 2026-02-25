(function() {
  var state = {
    initialized: false,
    connected: false,
    address: null,
    provider: null,
    modal: null,
    initPromise: null
  };

  var REOWN_PROJECT_ID = '096df07199db5fd480157215d0fd2e9f';

  var celoChain = {
    id: 'eip155:42220',
    chainId: 42220,
    name: 'Celo',
    currency: 'CELO',
    explorerUrl: 'https://celoscan.io',
    rpcUrl: 'https://forno.celo.org',
    chainNamespace: 'eip155'
  };

  function ensureInit() {
    if (state.initPromise) return state.initPromise;

    state.initPromise = new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.type = 'module';

      var code = 'import{createAppKit}from"https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.18/+esm";' +
        'window._reownCreateAppKit=createAppKit;' +
        'window.dispatchEvent(new Event("reown-ready"));';

      script.textContent = code;
      document.head.appendChild(script);

      function onReady() {
        window.removeEventListener('reown-ready', onReady);
        try {
          state.modal = window._reownCreateAppKit({
            projectId: REOWN_PROJECT_ID,
            networks: [celoChain],
            themeMode: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
            themeVariables: {
              '--w3m-accent': '#FF6B4A',
              '--w3m-border-radius-master': '0px'
            },
            features: {
              analytics: false
            },
            metadata: {
              name: 'SelfClaw',
              description: 'Agent Verification Registry',
              url: 'https://selfclaw.ai',
              icons: ['https://selfclaw.ai/claw-icon.svg']
            }
          });
          state.initialized = true;
          resolve(state.modal);
        } catch (e) {
          reject(e);
        }
      }

      window.addEventListener('reown-ready', onReady);

      setTimeout(function() {
        window.removeEventListener('reown-ready', onReady);
        if (!state.initialized) {
          reject(new Error('Reown AppKit failed to load from CDN'));
        }
      }, 15000);
    });

    return state.initPromise;
  }

  async function connectWallet() {
    var modal = await ensureInit();

    modal.open();

    var address = await new Promise(function(resolve, reject) {
      var timeout = setTimeout(function() {
        reject(new Error('Wallet connection timed out'));
      }, 120000);

      var checkInterval = setInterval(function() {
        try {
          var addr = modal.getAddress();
          if (addr) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve(addr);
          }
        } catch (e) {}
      }, 500);

      var handleClose = function() {
        if (!modal.getAddress()) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          reject(new Error('Wallet connection cancelled'));
        }
      };

      var closeCheck = setInterval(function() {
        try {
          if (!modal.getIsConnected() && !document.querySelector('w3m-modal[open]')) {
            clearInterval(closeCheck);
          }
        } catch(e) {}
      }, 1000);
    });

    state.connected = true;
    state.address = address;
    state.provider = modal.getWalletProvider();

    return {
      address: address,
      provider: state.provider
    };
  }

  async function signMessage(message) {
    if (!state.connected || !state.address) {
      throw new Error('Wallet not connected. Call connectWallet() first.');
    }

    await ensureInit();

    var provider = state.modal.getWalletProvider();
    if (!provider) {
      throw new Error('Wallet provider not available');
    }

    var hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
      .map(function(b) { return b.toString(16).padStart(2, '0'); })
      .join('');

    var signature = await provider.request({
      method: 'personal_sign',
      params: [hexMessage, state.address]
    });

    return signature;
  }

  function getAddress() {
    return state.address;
  }

  function isConnected() {
    return state.connected;
  }

  function disconnect() {
    if (state.modal) {
      try { state.modal.disconnect(); } catch(e) {}
    }
    state.connected = false;
    state.address = null;
    state.provider = null;
  }

  window.selfclawWaaP = {
    connectWallet: connectWallet,
    signMessage: signMessage,
    getAddress: getAddress,
    isConnected: isConnected,
    disconnect: disconnect
  };
})();
