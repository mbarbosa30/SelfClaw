import { createCeloWallet, CELO_CONFIG } from './wallet.js';
import { formatUnits, parseUnits } from 'viem';

export class X402Client {
  constructor(privateKey, options = {}) {
    this.wallet = privateKey ? createCeloWallet(privateKey) : null;
    this.maxPayment = options.maxPayment || 1.0;
    this.autoApprove = options.autoApprove !== false;
    this.payments = [];
  }
  
  isConfigured() {
    return this.wallet !== null;
  }
  
  getAddress() {
    return this.wallet?.address || null;
  }
  
  async fetch(url, options = {}) {
    const response = await fetch(url, options);
    
    if (response.status !== 402) {
      return response;
    }
    
    if (!this.wallet) {
      throw new Error('Payment required but no wallet configured');
    }
    
    const paymentDetails = this.parsePaymentHeaders(response.headers);
    
    if (!paymentDetails) {
      throw new Error('Invalid 402 response: missing payment details');
    }
    
    if (parseFloat(paymentDetails.amount) > this.maxPayment) {
      throw new Error(`Payment amount ${paymentDetails.amount} exceeds max ${this.maxPayment}`);
    }
    
    if (!this.autoApprove) {
      throw new Error('Payment required: ' + JSON.stringify(paymentDetails));
    }
    
    const paymentProof = await this.signPayment(paymentDetails);
    
    const paidResponse = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-Payment-Signature': paymentProof.signature,
        'X-Payment-Network': paymentProof.network,
        'X-Payment-Token': paymentProof.token,
        'X-Payment-Amount': paymentProof.amount,
        'X-Payment-Nonce': paymentProof.nonce,
        'X-Payment-Timestamp': paymentProof.timestamp.toString(),
        'X-Payment-Payer': paymentProof.payer
      }
    });
    
    this.payments.push({
      url,
      amount: paymentDetails.amount,
      token: paymentDetails.token,
      timestamp: new Date().toISOString(),
      status: paidResponse.ok ? 'success' : 'failed'
    });
    
    return paidResponse;
  }
  
  parsePaymentHeaders(headers) {
    const paymentRequired = headers.get('X-Payment-Required');
    const amount = headers.get('X-Payment-Amount');
    const recipient = headers.get('X-Payment-Recipient');
    const network = headers.get('X-Payment-Network') || 'celo';
    const token = headers.get('X-Payment-Token') || 'USDC';
    const description = headers.get('X-Payment-Description') || '';
    const nonce = headers.get('X-Payment-Nonce');
    const timestamp = headers.get('X-Payment-Timestamp');
    
    if (!amount || !recipient) {
      return null;
    }
    
    return {
      amount,
      recipient,
      network,
      token,
      description,
      nonce,
      timestamp,
      paymentRequired: paymentRequired === 'true'
    };
  }
  
  async signPayment(paymentDetails) {
    const nonce = paymentDetails.nonce || crypto.randomUUID();
    const timestamp = Date.now();
    const message = `x402:${nonce}:${paymentDetails.amount}:${paymentDetails.recipient}:${timestamp}`;
    
    const signature = await this.wallet.walletClient.signMessage({
      message
    });
    
    return {
      signature,
      network: 'celo',
      token: paymentDetails.token,
      amount: paymentDetails.amount,
      nonce,
      timestamp,
      payer: this.wallet.address
    };
  }
  
  getPaymentHistory() {
    return this.payments;
  }
  
  getTotalSpent() {
    return this.payments
      .filter(p => p.status === 'success')
      .reduce((sum, p) => sum + parseFloat(p.amount), 0)
      .toFixed(6);
  }
}

export function createX402Client(privateKey, options) {
  return new X402Client(privateKey, options);
}
