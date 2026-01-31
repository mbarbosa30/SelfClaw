import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, formatUnits } from 'viem';
import { celo } from 'viem/chains';

const USDC_ADDRESS = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
const USDC_DECIMALS = 6;

const USDC_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

export function deriveAgentPrivateKey(platformPrivateKey: string, agentId: string): `0x${string}` {
  const formattedKey = platformPrivateKey.startsWith('0x') ? platformPrivateKey : `0x${platformPrivateKey}`;
  const derivationSeed = `${formattedKey}:agent:${agentId}`;
  const derivedKey = keccak256(toHex(derivationSeed));
  return derivedKey;
}

export function deriveAgentWalletAddress(platformPrivateKey: string, agentId: string): string {
  const derivedPrivateKey = deriveAgentPrivateKey(platformPrivateKey, agentId);
  const account = privateKeyToAccount(derivedPrivateKey);
  return account.address;
}

export function createAgentWallet(platformPrivateKey: string, agentId: string) {
  const derivedPrivateKey = deriveAgentPrivateKey(platformPrivateKey, agentId);
  const account = privateKeyToAccount(derivedPrivateKey);
  
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http()
  });
  
  const publicClient = createPublicClient({
    chain: celo,
    transport: http()
  });
  
  return {
    account,
    walletClient,
    publicClient,
    address: account.address,
    privateKey: derivedPrivateKey
  };
}

export async function getAgentWalletBalance(platformPrivateKey: string, agentId: string) {
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  
  try {
    const [celoBalance, usdcBalance] = await Promise.all([
      wallet.publicClient.getBalance({ address: wallet.address }),
      wallet.publicClient.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [wallet.address]
      })
    ]);
    
    return {
      address: wallet.address,
      celo: formatUnits(celoBalance, 18),
      usdc: formatUnits(usdcBalance, USDC_DECIMALS)
    };
  } catch (error: any) {
    return {
      address: wallet.address,
      celo: '0',
      usdc: '0',
      error: error.message
    };
  }
}

export async function transferFromAgentWallet(
  platformPrivateKey: string, 
  agentId: string, 
  toAddress: string, 
  amountUsdc: string
) {
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  const { parseUnits } = await import('viem');
  const amountInUnits = parseUnits(amountUsdc, USDC_DECIMALS);
  
  const hash = await wallet.walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [toAddress as `0x${string}`, amountInUnits]
  });
  
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return {
    hash,
    status: receipt.status === 'success' ? 'confirmed' : 'failed',
    blockNumber: receipt.blockNumber.toString()
  };
}

export const PLATFORM_FEE_PERCENT = 3;

export function calculatePlatformFee(amount: number): { fee: number; netAmount: number } {
  const fee = amount * (PLATFORM_FEE_PERCENT / 100);
  return {
    fee,
    netAmount: amount - fee
  };
}
