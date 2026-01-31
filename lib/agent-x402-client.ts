import { createAgentWallet, PLATFORM_FEE_PERCENT, calculatePlatformFee } from './agent-wallet.js';
import { formatUnits, parseUnits } from 'viem';

export interface PaymentDetails {
  amount: string;
  recipient: string;
  network: string;
  token: string;
  description: string;
  nonce: string;
  timestamp: string;
  paymentRequired: boolean;
}

export interface PaymentProof {
  signature: string;
  network: string;
  token: string;
  amount: string;
  nonce: string;
  timestamp: number;
  payer: string;
}

export interface PaymentRecord {
  url: string;
  amount: string;
  token: string;
  timestamp: string;
  status: 'success' | 'failed';
  agentId: string;
}

export class AgentX402Client {
  private platformPrivateKey: string;
  private agentId: string;
  private wallet: ReturnType<typeof createAgentWallet>;
  private maxPayment: number;
  private autoApprove: boolean;
  private payments: PaymentRecord[];

  constructor(platformPrivateKey: string, agentId: string, options: { maxPayment?: number; autoApprove?: boolean } = {}) {
    this.platformPrivateKey = platformPrivateKey;
    this.agentId = agentId;
    this.wallet = createAgentWallet(platformPrivateKey, agentId);
    this.maxPayment = options.maxPayment || 1.0;
    this.autoApprove = options.autoApprove !== false;
    this.payments = [];
  }

  isConfigured(): boolean {
    return this.wallet !== null;
  }

  getAddress(): string {
    return this.wallet.address;
  }

  getAgentId(): string {
    return this.agentId;
  }

  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, options);

    if (response.status !== 402) {
      return response;
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
        'X-Payment-Payer': paymentProof.payer,
        'X-Agent-Id': this.agentId
      }
    });

    this.payments.push({
      url,
      amount: paymentDetails.amount,
      token: paymentDetails.token,
      timestamp: new Date().toISOString(),
      status: paidResponse.ok ? 'success' : 'failed',
      agentId: this.agentId
    });

    return paidResponse;
  }

  parsePaymentHeaders(headers: Headers): PaymentDetails | null {
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
      nonce: nonce || '',
      timestamp: timestamp || '',
      paymentRequired: paymentRequired === 'true'
    };
  }

  async signPayment(paymentDetails: PaymentDetails): Promise<PaymentProof> {
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

  getPaymentHistory(): PaymentRecord[] {
    return this.payments;
  }

  getTotalSpent(): string {
    return this.payments
      .filter(p => p.status === 'success')
      .reduce((sum, p) => sum + parseFloat(p.amount), 0)
      .toFixed(6);
  }
}

export function createAgentX402Client(platformPrivateKey: string, agentId: string, options?: { maxPayment?: number; autoApprove?: boolean }): AgentX402Client {
  return new AgentX402Client(platformPrivateKey, agentId, options);
}
