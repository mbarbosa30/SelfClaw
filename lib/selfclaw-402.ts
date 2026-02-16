import { createPublicClient, createWalletClient, http, fallback, parseAbi, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const SELFCLAW_TOKEN = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb' as const;
const CELO_RPC_PRIMARY = 'https://forno.celo.org';
const CELO_RPC_FALLBACK = 'https://rpc.ankr.com/celo';

const publicClient = createPublicClient({
  chain: celo,
  transport: fallback([
    http(CELO_RPC_PRIMARY, { timeout: 15_000, retryCount: 1 }),
    http(CELO_RPC_FALLBACK, { timeout: 15_000, retryCount: 1 }),
  ]),
});

const ERC20_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const rawPrivateKey = process.env.CELO_PRIVATE_KEY;
const PRIVATE_KEY = rawPrivateKey && !rawPrivateKey.startsWith('0x') ? `0x${rawPrivateKey}` : rawPrivateKey;

let _escrowAddress: string | null = null;

export function getEscrowAddress(): string {
  if (_escrowAddress) return _escrowAddress;
  if (!PRIVATE_KEY) {
    throw new Error('CELO_PRIVATE_KEY not set — escrow wallet unavailable');
  }
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  _escrowAddress = account.address;
  return _escrowAddress;
}

function getEscrowWalletClient() {
  if (!PRIVATE_KEY) throw new Error('CELO_PRIVATE_KEY not set');
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  return createWalletClient({
    account,
    chain: celo,
    transport: fallback([
      http(CELO_RPC_PRIMARY, { timeout: 15_000, retryCount: 1 }),
      http(CELO_RPC_FALLBACK, { timeout: 15_000, retryCount: 1 }),
    ]),
  });
}

export interface PaymentRequirement {
  payTo: string;
  amount: string;
  token: string;
  tokenSymbol: string;
  description: string;
  nonce: string;
  expiresAt: number;
  escrow: boolean;
  sellerAddress?: string;
  skillId?: string;
  buyerPublicKey?: string;
}

export interface PaymentVerification {
  valid: boolean;
  txHash?: string;
  from?: string;
  to?: string;
  amount?: string;
  error?: string;
}

export interface EscrowRelease {
  success: boolean;
  txHash?: string;
  error?: string;
}

const paymentNonces = new Map<string, { requirement: PaymentRequirement; createdAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, data] of paymentNonces) {
    if (now > data.requirement.expiresAt) {
      paymentNonces.delete(nonce);
    }
  }
}, 60_000);

export function createPaymentRequirement(
  sellerAddress: string,
  amount: string,
  description: string,
  skillId?: string,
  buyerPublicKey?: string,
  token: string = SELFCLAW_TOKEN,
  tokenSymbol: string = 'SELFCLAW',
  ttlSeconds: number = 300,
): PaymentRequirement {
  const escrowAddr = getEscrowAddress();
  const nonce = `sc402_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const requirement: PaymentRequirement = {
    payTo: escrowAddr,
    amount,
    token,
    tokenSymbol,
    description,
    nonce,
    expiresAt: Date.now() + ttlSeconds * 1000,
    escrow: true,
    sellerAddress,
    skillId,
    buyerPublicKey,
  };
  paymentNonces.set(nonce, { requirement, createdAt: Date.now() });
  return requirement;
}

export function build402Response(requirement: PaymentRequirement) {
  return {
    status: 402,
    headers: {
      'X-Payment-Required': 'true',
      'X-Payment-Token': requirement.token,
      'X-Payment-Token-Symbol': requirement.tokenSymbol,
      'X-Payment-Amount': requirement.amount,
      'X-Payment-PayTo': requirement.payTo,
      'X-Payment-Nonce': requirement.nonce,
      'X-Payment-Expires': requirement.expiresAt.toString(),
      'X-Payment-Escrow': 'true',
    },
    body: {
      error: 'Payment Required',
      code: 'PAYMENT_REQUIRED',
      payment: {
        token: requirement.token,
        tokenSymbol: requirement.tokenSymbol,
        amount: requirement.amount,
        payTo: requirement.payTo,
        nonce: requirement.nonce,
        expiresAt: requirement.expiresAt,
        description: requirement.description,
        escrow: true,
        instructions: {
          step1: `Transfer ${requirement.amount} ${requirement.tokenSymbol} to escrow: ${requirement.payTo}`,
          step2: 'Include the transaction hash in X-SELFCLAW-PAYMENT header as txHash:nonce',
          step3: 'Retry the same request with the payment header',
          note: 'Funds are held in escrow and released to the seller after successful delivery. Refunded on failure.',
        },
      },
    },
  };
}

export async function verifyPayment(
  txHash: string,
  expectedTo: string,
  expectedAmountWei: bigint,
  expectedToken: string = SELFCLAW_TOKEN,
): Promise<PaymentVerification> {
  try {
    const receipt = await publicClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (!receipt || receipt.status !== 'success') {
      return { valid: false, error: 'Transaction failed or not found' };
    }

    const transferLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== expectedToken.toLowerCase()) return false;
      if (!log.topics[0]) return false;
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      if (log.topics[0].toLowerCase() !== transferTopic) return false;
      if (!log.topics[2]) return false;
      const toAddress = '0x' + log.topics[2].slice(26);
      return toAddress.toLowerCase() === expectedTo.toLowerCase();
    });

    if (!transferLog) {
      return { valid: false, error: 'No matching token transfer found in transaction' };
    }

    const fromAddress = '0x' + transferLog.topics[1]!.slice(26);
    const toAddress = '0x' + transferLog.topics[2]!.slice(26);
    const transferredAmount = BigInt(transferLog.data);

    if (transferredAmount < expectedAmountWei) {
      return {
        valid: false,
        error: `Insufficient payment: sent ${transferredAmount.toString()} but required ${expectedAmountWei.toString()}`,
        txHash,
        from: fromAddress,
        to: toAddress,
        amount: transferredAmount.toString(),
      };
    }

    return {
      valid: true,
      txHash,
      from: fromAddress,
      to: toAddress,
      amount: transferredAmount.toString(),
    };
  } catch (error: any) {
    return { valid: false, error: `Verification failed: ${error.message}` };
  }
}

export async function releaseEscrow(
  sellerAddress: string,
  amountWei: bigint,
  token: string = SELFCLAW_TOKEN,
): Promise<EscrowRelease> {
  try {
    const walletClient = getEscrowWalletClient();

    const txHash = await walletClient.writeContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [sellerAddress as `0x${string}`, amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
    });

    if (receipt.status !== 'success') {
      return { success: false, error: 'Escrow release transaction failed onchain' };
    }

    console.log(`[escrow] Released ${amountWei.toString()} tokens to ${sellerAddress} — tx: ${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[escrow] Release failed for ${sellerAddress}:`, error.message);
    return { success: false, error: `Escrow release failed: ${error.message}` };
  }
}

export async function refundEscrow(
  buyerAddress: string,
  amountWei: bigint,
  token: string = SELFCLAW_TOKEN,
): Promise<EscrowRelease> {
  try {
    const walletClient = getEscrowWalletClient();

    const txHash = await walletClient.writeContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [buyerAddress as `0x${string}`, amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
    });

    if (receipt.status !== 'success') {
      return { success: false, error: 'Escrow refund transaction failed onchain' };
    }

    console.log(`[escrow] Refunded ${amountWei.toString()} tokens to ${buyerAddress} — tx: ${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[escrow] Refund failed for ${buyerAddress}:`, error.message);
    return { success: false, error: `Escrow refund failed: ${error.message}` };
  }
}

export function getPaymentNonce(nonce: string): PaymentRequirement | null {
  const entry = paymentNonces.get(nonce);
  if (!entry) return null;
  if (Date.now() > entry.requirement.expiresAt) {
    paymentNonces.delete(nonce);
    return null;
  }
  return entry.requirement;
}

export function consumePaymentNonce(nonce: string): boolean {
  return paymentNonces.delete(nonce);
}

export function extractPaymentHeader(req: any): { txHash: string; nonce: string } | null {
  const paymentHeader = req.headers['x-selfclaw-payment'];
  if (!paymentHeader || typeof paymentHeader !== 'string') return null;

  const parts = paymentHeader.split(':');
  if (parts.length === 2) {
    return { txHash: parts[0].trim(), nonce: parts[1].trim() };
  }
  return { txHash: paymentHeader.trim(), nonce: '' };
}

export async function getTokenBalance(address: string, token: string = SELFCLAW_TOKEN): Promise<string> {
  try {
    const [balance, decimals] = await Promise.all([
      publicClient.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      }),
      publicClient.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ]);
    return formatUnits(balance, decimals);
  } catch {
    return '0';
  }
}

export { SELFCLAW_TOKEN };
