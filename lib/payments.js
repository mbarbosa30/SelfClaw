import { createCeloWallet, getWalletBalance, CELO_CONFIG } from './wallet.js';
import { createX402Client } from './x402-client.js';
import { createPaymentMiddleware } from './x402-middleware.js';

let globalWallet = null;
let globalX402Client = null;
let paymentHistory = [];

export function initializePayments(privateKey, options = {}) {
  if (!privateKey) {
    console.log('[payments] No private key configured - payments disabled');
    return { initialized: false };
  }
  
  try {
    globalWallet = createCeloWallet(privateKey);
    globalX402Client = createX402Client(privateKey, {
      maxPayment: options.maxPayment || 1.0,
      autoApprove: options.autoApprove !== false
    });
    
    console.log('[payments] Initialized with address:', globalWallet.address);
    return {
      initialized: true,
      address: globalWallet.address
    };
  } catch (error) {
    console.error('[payments] Failed to initialize:', error.message);
    return {
      initialized: false,
      error: error.message
    };
  }
}

export function getPaymentStatus() {
  return {
    initialized: globalWallet !== null,
    address: globalWallet?.address || null,
    network: CELO_CONFIG.name,
    chainId: CELO_CONFIG.chainId,
    explorer: CELO_CONFIG.explorer,
    usdc: CELO_CONFIG.usdc
  };
}

export async function getBalance() {
  if (!globalWallet) {
    return { error: 'Wallet not initialized' };
  }
  
  return await getWalletBalance(globalWallet);
}

export function getX402Client() {
  return globalX402Client;
}

export function getWallet() {
  return globalWallet;
}

export function recordPayment(payment) {
  paymentHistory.push({
    ...payment,
    timestamp: new Date().toISOString()
  });
  
  if (paymentHistory.length > 100) {
    paymentHistory = paymentHistory.slice(-100);
  }
}

export function getPaymentHistory() {
  const clientHistory = globalX402Client?.getPaymentHistory() || [];
  return [...paymentHistory, ...clientHistory].sort((a, b) => 
    new Date(b.timestamp) - new Date(a.timestamp)
  );
}

export function getTotalSpent() {
  const clientTotal = parseFloat(globalX402Client?.getTotalSpent() || 0);
  const recordedTotal = paymentHistory
    .filter(p => p.type === 'outgoing' && p.status === 'success')
    .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
  
  return (clientTotal + recordedTotal).toFixed(6);
}

export function getTotalReceived() {
  return paymentHistory
    .filter(p => p.type === 'incoming' && p.status === 'success')
    .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0)
    .toFixed(6);
}

export { createPaymentMiddleware, CELO_CONFIG };
