import { createCeloWallet, CELO_CONFIG } from './wallet.js';

export function createPaymentMiddleware(options = {}) {
  const {
    recipient,
    defaultPrice = '0.01',
    token = 'USDC',
    network = 'celo',
    verifyPayment = null
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
      
      if (!paymentSignature) {
        res.setHeader('X-Payment-Required', 'true');
        res.setHeader('X-Payment-Amount', price);
        res.setHeader('X-Payment-Recipient', recipient || 'not-configured');
        res.setHeader('X-Payment-Network', network);
        res.setHeader('X-Payment-Token', token);
        res.setHeader('X-Payment-Description', description);
        
        return res.status(402).json({
          error: 'Payment Required',
          payment: {
            amount: price,
            token,
            network,
            recipient: recipient || 'not-configured',
            description
          }
        });
      }
      
      if (verifyPayment) {
        try {
          const isValid = await verifyPayment({
            signature: paymentSignature,
            amount: paymentAmount,
            network: paymentNetwork,
            recipient
          });
          
          if (!isValid) {
            return res.status(402).json({
              error: 'Invalid payment',
              message: 'Payment verification failed'
            });
          }
        } catch (error) {
          console.error('[x402] Payment verification error:', error.message);
          return res.status(500).json({
            error: 'Payment verification error',
            message: error.message
          });
        }
      }
      
      req.payment = {
        signature: paymentSignature,
        amount: paymentAmount,
        network: paymentNetwork,
        verified: true
      };
      
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
