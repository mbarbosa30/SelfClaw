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
    id: 42220,
    chainId: 42220,
    name: 'Celo',
    currency: 'CELO',
    explorerUrl: 'https://celoscan.io',
    rpcUrl: 'https://forno.celo.org',
    chainNamespace: 'eip155'
  };

  function ensureInit() {
    if (state.initPromise) return state.initPromise;

    state.initPromise = (async function() {
      var mod = await import('/reown-cdn/appkit.js');

      state.modal = mod.createAppKit({
        projectId: REOWN_PROJECT_ID,
        networks: [celoChain],
        enableInjected: true,
        enableCoinbase: true,
        themeMode: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
        themeVariables: {
          '--w3m-accent': '#FF6B4A',
          '--w3m-border-radius-master': '0px'
        },
        features: {
          analytics: false,
          email: false,
          socials: false
        },
        metadata: {
          name: 'SelfClaw',
          description: 'Agent Verification Registry',
          url: window.location.origin,
          icons: ['https://selfclaw.ai/claw-icon.svg']
        }
      });

      state.initialized = true;
      return state.modal;
    })();

    return state.initPromise;
  }

  async function connectWallet() {
    var modal = await ensureInit();

    if (state.connected && state.address) {
      return { address: state.address, provider: state.provider };
    }

    modal.open();

    var address = await new Promise(function(resolve, reject) {
      var resolved = false;
      var timeout = setTimeout(function() {
        if (!resolved) {
          resolved = true;
          clearInterval(checkInterval);
          reject(new Error('Wallet connection timed out after 2 minutes. Please try again.'));
        }
      }, 120000);

      var checkInterval = setInterval(function() {
        try {
          var addr = modal.getAddress();
          if (addr && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve(addr);
          }
          if (!resolved && !modal.getIsConnected() && !document.querySelector('w3m-modal[open]')) {
            var stillOpen = document.querySelector('w3m-modal');
            if (!stillOpen) {
              resolved = true;
              clearTimeout(timeout);
              clearInterval(checkInterval);
              reject(new Error('Wallet connection cancelled'));
            }
          }
        } catch (e) {}
      }, 500);
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
      throw new Error('Wallet provider not available. Please reconnect your wallet.');
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

  async function disconnect() {
    if (state.modal) {
      try { await state.modal.disconnect(); } catch(e) {}
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
