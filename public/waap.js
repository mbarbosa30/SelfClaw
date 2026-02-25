(function() {
  var waapState = {
    initialized: false,
    connected: false,
    address: null,
    provider: null
  };

  function loadWaaPSDK() {
    return new Promise(function(resolve, reject) {
      if (typeof window.initWaaP === 'function') {
        resolve(true);
        return;
      }

      var script = document.createElement('script');
      script.src = '/waap-sdk.js';
      script.onload = function() {
        if (typeof window.initWaaP === 'function') {
          resolve(true);
        } else {
          reject(new Error('WaaP SDK loaded but initWaaP not found'));
        }
      };
      script.onerror = function() {
        reject(new Error('Failed to load WaaP SDK script'));
      };
      document.head.appendChild(script);
    });
  }

  async function initWaaP() {
    if (waapState.initialized && waapState.provider) {
      return waapState.provider;
    }

    await loadWaaPSDK();

    window.initWaaP();

    var maxWait = 3000;
    var elapsed = 0;
    var interval = 100;
    while (!window.waap && elapsed < maxWait) {
      await new Promise(function(r) { setTimeout(r, interval); });
      elapsed += interval;
    }

    if (window.waap && typeof window.waap.request === 'function') {
      waapState.provider = window.waap;
      waapState.initialized = true;
      return window.waap;
    }

    throw new Error('WaaP SDK initialized but provider not available');
  }

  async function connectWallet() {
    var provider = await initWaaP();

    var accounts = await provider.request({ method: 'eth_requestAccounts' });

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts returned from WaaP');
    }

    var address = accounts[0];
    waapState.connected = true;
    waapState.address = address;

    return {
      address: address,
      provider: provider
    };
  }

  async function signMessage(message) {
    if (!waapState.connected || !waapState.address) {
      throw new Error('Wallet not connected. Call connectWallet() first.');
    }

    var provider = waapState.provider;
    var hexMessage = '0x' + Array.from(new TextEncoder().encode(message))
      .map(function(b) { return b.toString(16).padStart(2, '0'); })
      .join('');

    var signature = await provider.request({
      method: 'personal_sign',
      params: [hexMessage, waapState.address]
    });

    return signature;
  }

  function getAddress() {
    return waapState.address;
  }

  function isConnected() {
    return waapState.connected;
  }

  function disconnect() {
    waapState.connected = false;
    waapState.address = null;
    waapState.provider = null;
    waapState.initialized = false;
  }

  window.selfclawWaaP = {
    connectWallet: connectWallet,
    signMessage: signMessage,
    getAddress: getAddress,
    isConnected: isConnected,
    disconnect: disconnect
  };
})();
