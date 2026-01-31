import { randomBytes } from 'crypto';
import { verifyPaymentSignature } from './wallet.js';
import { PLATFORM_FEE_PERCENT, calculatePlatformFee } from './agent-wallet.js';
import { Request, Response, NextFunction } from 'express';

interface Challenge {
  price: string;
  recipient: string;
  token: string;
  network: string;
  issuedAt: number;
  endpoint: string;
  agentId: string;
}

interface PaymentRecord {
  signature: string;
  amount: string;
  network: string;
  payer: string;
  nonce: string;
  timestamp: string;
  verified: boolean;
  receivedAt: string;
  endpoint: string;
  agentId: string;
  platformFee: string;
  netAmount: string;
}

const issuedChallenges = new Map<string, Challenge>();
const processedNonces = new Map<string, number>();
const agentPayments = new Map<string, PaymentRecord[]>();
const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;

function cleanupExpired(): void {
  const now = Date.now();
  for (const [nonce, data] of issuedChallenges) {
    if (now - data.issuedAt > CHALLENGE_EXPIRY_MS) {
      issuedChallenges.delete(nonce);
    }
  }
  for (const [nonce, timestamp] of processedNonces) {
    if (now - timestamp > CHALLENGE_EXPIRY_MS) {
      processedNonces.delete(nonce);
    }
  }
}

setInterval(cleanupExpired, 60000);

export function getAgentReceivedPayments(agentId: string): PaymentRecord[] {
  return agentPayments.get(agentId) || [];
}

export function getAgentTotalReceived(agentId: string): { gross: string; netAfterFees: string; platformFees: string } {
  const payments = agentPayments.get(agentId) || [];
  const verified = payments.filter(p => p.verified);
  
  const gross = verified.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  const fees = verified.reduce((sum, p) => sum + parseFloat(p.platformFee), 0);
  const net = verified.reduce((sum, p) => sum + parseFloat(p.netAmount), 0);
  
  return {
    gross: gross.toFixed(6),
    netAfterFees: net.toFixed(6),
    platformFees: fees.toFixed(6)
  };
}

export function createAgentPaymentMiddleware(options: {
  getAgentRecipient: (agentId: string) => string | null;
  defaultPrice?: string;
  token?: string;
  network?: string;
  requireVerification?: boolean;
}) {
  const {
    getAgentRecipient,
    defaultPrice = '0.01',
    token = 'USDC',
    network = 'celo',
    requireVerification = true
  } = options;

  return function agentPaymentMiddleware(priceOrConfig: string | { price?: string; description?: string }) {
    const config = typeof priceOrConfig === 'string' 
      ? { price: priceOrConfig }
      : priceOrConfig;

    const price = config.price || defaultPrice;
    const description = config.description || '';

    return async (req: Request & { payment?: PaymentRecord; params: { id?: string } }, res: Response, next: NextFunction) => {
      const agentId = req.params.id;
      
      if (!agentId) {
        return res.status(400).json({ error: 'Agent ID required' });
      }

      const recipient = getAgentRecipient(agentId);
      
      if (!recipient) {
        return res.status(404).json({ error: 'Agent wallet not configured' });
      }

      const paymentSignature = req.headers['x-payment-signature'] as string | undefined;
      const paymentAmount = req.headers['x-payment-amount'] as string | undefined;
      const paymentNetwork = req.headers['x-payment-network'] as string | undefined;
      const paymentNonce = req.headers['x-payment-nonce'] as string | undefined;
      const paymentTimestamp = req.headers['x-payment-timestamp'] as string | undefined;
      const paymentPayer = req.headers['x-payment-payer'] as string | undefined;

      if (!paymentSignature) {
        const nonce = randomBytes(16).toString('hex');
        const timestamp = Date.now();

        issuedChallenges.set(nonce, {
          price,
          recipient,
          token,
          network,
          issuedAt: timestamp,
          endpoint: req.originalUrl,
          agentId
        });

        const { fee, netAmount } = calculatePlatformFee(parseFloat(price));

        res.setHeader('X-Payment-Required', 'true');
        res.setHeader('X-Payment-Amount', price);
        res.setHeader('X-Payment-Recipient', recipient);
        res.setHeader('X-Payment-Network', network);
        res.setHeader('X-Payment-Token', token);
        res.setHeader('X-Payment-Description', description);
        res.setHeader('X-Payment-Nonce', nonce);
        res.setHeader('X-Payment-Timestamp', timestamp.toString());
        res.setHeader('X-Platform-Fee-Percent', PLATFORM_FEE_PERCENT.toString());

        return res.status(402).json({
          error: 'Payment Required',
          payment: {
            amount: price,
            token,
            network,
            recipient,
            description,
            nonce,
            timestamp,
            platformFee: fee.toFixed(6),
            netToAgent: netAmount.toFixed(6)
          }
        });
      }

      if (requireVerification) {
        if (!paymentNonce || !paymentTimestamp || !paymentPayer || !paymentAmount) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Missing required payment headers'
          });
        }

        const challenge = issuedChallenges.get(paymentNonce);
        if (!challenge) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Unknown or expired payment challenge'
          });
        }

        if (processedNonces.has(paymentNonce)) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Payment already processed'
          });
        }

        if (paymentAmount !== challenge.price) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: `Amount mismatch: expected ${challenge.price}, got ${paymentAmount}`
          });
        }

        const paymentAge = Date.now() - parseInt(paymentTimestamp);
        if (paymentAge > CHALLENGE_EXPIRY_MS || paymentAge < -30000) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Payment expired or invalid timestamp'
          });
        }

        const expectedMessage = `x402:${paymentNonce}:${paymentAmount}:${challenge.recipient}:${paymentTimestamp}`;
        const isValid = await verifyPaymentSignature(expectedMessage, paymentSignature, paymentPayer);

        if (!isValid) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Signature verification failed'
          });
        }

        issuedChallenges.delete(paymentNonce);
        processedNonces.set(paymentNonce, Date.now());
      }

      const { fee, netAmount } = calculatePlatformFee(parseFloat(paymentAmount || price));

      const paymentRecord: PaymentRecord = {
        signature: paymentSignature,
        amount: paymentAmount || price,
        network: paymentNetwork || network,
        payer: paymentPayer || '',
        nonce: paymentNonce || '',
        timestamp: paymentTimestamp || '',
        verified: requireVerification,
        receivedAt: new Date().toISOString(),
        endpoint: req.originalUrl,
        agentId,
        platformFee: fee.toFixed(6),
        netAmount: netAmount.toFixed(6)
      };

      if (!agentPayments.has(agentId)) {
        agentPayments.set(agentId, []);
      }
      agentPayments.get(agentId)!.push(paymentRecord);

      req.payment = paymentRecord;

      res.setHeader('X-Payment-Response', 'accepted');
      res.setHeader('X-Platform-Fee', fee.toFixed(6));
      res.setHeader('X-Net-Amount', netAmount.toFixed(6));
      
      next();
    };
  };
}
