import { createCeloWallet, CELO_CONFIG, verifyPaymentSignature } from './wallet.js';
import { randomBytes } from 'crypto';

const issuedChallenges = new Map();
const processedNonces = new Map();
const receivedPayments = [];
const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;

function cleanupExpired() {
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

export function getReceivedPayments() {
  return [...receivedPayments];
}

export function getTotalReceived() {
  return receivedPayments
    .filter(p => p.verified)
    .reduce((sum, p) => sum + parseFloat(p.amount), 0)
    .toFixed(6);
}

export function createPaymentMiddleware(options = {}) {
  const {
    recipient,
    defaultPrice = '0.01',
    token = 'USDC',
    network = 'celo',
    requireVerification = true
  } = options;
  
  if (!recipient) {
    console.warn('[x402] No recipient address configured - payments will not be verified');
  }
  
  return function paymentMiddleware(priceOrConfig) {
    const config = typeof priceOrConfig === 'string' 
      ? { price: priceOrConfig }
      : priceOrConfig;
    
    const price = config.price || defaultPrice;
    const description = config.description || '';
    
    return async (req, res, next) => {
      const paymentSignature = req.headers['x-payment-signature'];
      const paymentAmount = req.headers['x-payment-amount'];
      const paymentNetwork = req.headers['x-payment-network'];
      const paymentNonce = req.headers['x-payment-nonce'];
      const paymentTimestamp = req.headers['x-payment-timestamp'];
      const paymentPayer = req.headers['x-payment-payer'];
      
      if (!paymentSignature) {
        const nonce = randomBytes(16).toString('hex');
        const timestamp = Date.now();
        
        issuedChallenges.set(nonce, {
          price,
          recipient,
          token,
          network,
          issuedAt: timestamp,
          endpoint: req.originalUrl
        });
        
        res.setHeader('X-Payment-Required', 'true');
        res.setHeader('X-Payment-Amount', price);
        res.setHeader('X-Payment-Recipient', recipient || 'not-configured');
        res.setHeader('X-Payment-Network', network);
        res.setHeader('X-Payment-Token', token);
        res.setHeader('X-Payment-Description', description);
        res.setHeader('X-Payment-Nonce', nonce);
        res.setHeader('X-Payment-Timestamp', timestamp.toString());
        
        return res.status(402).json({
          error: 'Payment Required',
          payment: {
            amount: price,
            token,
            network,
            recipient: recipient || 'not-configured',
            description,
            nonce,
            timestamp
          }
        });
      }
      
      if (requireVerification) {
        if (!paymentNonce || !paymentTimestamp || !paymentPayer || !paymentAmount) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Missing required payment headers (nonce, timestamp, payer, amount)'
          });
        }
        
        const challenge = issuedChallenges.get(paymentNonce);
        if (!challenge) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Unknown or expired payment challenge nonce'
          });
        }
        
        if (processedNonces.has(paymentNonce)) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: 'Payment nonce already used (replay attack detected)'
          });
        }
        
        if (paymentAmount !== challenge.price) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: `Payment amount mismatch: expected ${challenge.price}, got ${paymentAmount}`
          });
        }
        
        if (paymentNetwork && paymentNetwork !== challenge.network) {
          return res.status(402).json({
            error: 'Invalid payment',
            message: `Network mismatch: expected ${challenge.network}, got ${paymentNetwork}`
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
      
      const paymentRecord = {
        signature: paymentSignature,
        amount: paymentAmount,
        network: paymentNetwork,
        payer: paymentPayer,
        nonce: paymentNonce,
        timestamp: paymentTimestamp,
        verified: requireVerification,
        receivedAt: new Date().toISOString(),
        endpoint: req.originalUrl
      };
      
      receivedPayments.push(paymentRecord);
      req.payment = paymentRecord;
      
      res.setHeader('X-Payment-Response', 'accepted');
      next();
    };
  };
}

export function createPricingTable(routes) {
  const table = {};
  
  for (const [route, config] of Object.entries(routes)) {
    table[route] = {
      price: config.price || '0.01',
      token: config.token || 'USDC',
      network: config.network || 'celo',
      description: config.description || ''
    };
  }
  
  return table;
}

export function logPayment(req, res, next) {
  if (req.payment) {
    console.log(`[x402] Payment received: ${req.payment.amount} from ${req.ip}`);
  }
  next();
}
