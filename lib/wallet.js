import { createWalletClient, createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  }
];

export function createCeloWallet(privateKey) {
  if (!privateKey) {
    return null;
  }
  
  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(formattedKey);
  
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
    address: account.address
  };
}

export async function getWalletBalance(wallet) {
  if (!wallet) return null;
  
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
      celo: formatUnits(celoBalance, 18),
      usdc: formatUnits(usdcBalance, USDC_DECIMALS),
      address: wallet.address
    };
  } catch (error) {
    console.error('Failed to get wallet balance:', error.message);
    return {
      celo: '0',
      usdc: '0',
      address: wallet.address,
      error: error.message
    };
  }
}

export async function transferUSDC(wallet, to, amount) {
  if (!wallet) throw new Error('Wallet not initialized');
  
  const amountInUnits = parseUnits(amount.toString(), USDC_DECIMALS);
  
  const hash = await wallet.walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [to, amountInUnits]
  });
  
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return {
    hash,
    status: receipt.status === 'success' ? 'confirmed' : 'failed',
    blockNumber: receipt.blockNumber.toString()
  };
}

export async function approveUSDC(wallet, spender, amount) {
  if (!wallet) throw new Error('Wallet not initialized');
  
  const amountInUnits = parseUnits(amount.toString(), USDC_DECIMALS);
  
  const hash = await wallet.walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [spender, amountInUnits]
  });
  
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return {
    hash,
    status: receipt.status === 'success' ? 'confirmed' : 'failed'
  };
}

export const CELO_CONFIG = {
  chainId: 42220,
  name: 'Celo',
  rpcUrl: 'https://forno.celo.org',
  explorer: 'https://celoscan.io',
  usdc: {
    address: USDC_ADDRESS,
    decimals: USDC_DECIMALS,
    symbol: 'USDC'
  }
};
