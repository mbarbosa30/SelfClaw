import { createPublicClient, http, formatUnits, parseUnits, encodeFunctionData } from 'viem';
import { celo } from 'viem/chains';
import { createAgentWallet } from './agent-wallet.js';

export const CELO_TOKENS = {
  CELO: { address: null, decimals: 18, symbol: 'CELO', name: 'Celo' },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as `0x${string}`, decimals: 6, symbol: 'USDC', name: 'USD Coin (Bridged)' },
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as `0x${string}`, decimals: 6, symbol: 'USDT', name: 'Tether USD (Bridged)' },
  cUSD: { address: '0x765DE816845861e75A25fCA122bb6898B8B1282a' as `0x${string}`, decimals: 18, symbol: 'cUSD', name: 'Celo Dollar (Mento)' },
  cEUR: { address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73' as `0x${string}`, decimals: 18, symbol: 'cEUR', name: 'Celo Euro (Mento)' },
  cREAL: { address: '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787' as `0x${string}`, decimals: 18, symbol: 'cREAL', name: 'Celo Brazilian Real (Mento)' },
} as const;

export const FEE_CURRENCIES = [
  CELO_TOKENS.USDC.address,
  CELO_TOKENS.USDT.address,
  CELO_TOKENS.cUSD.address,
  CELO_TOKENS.cEUR.address,
] as `0x${string}`[];

export const FEE_CURRENCY_DECIMALS: Record<string, number> = {
  [CELO_TOKENS.USDC.address]: 6,
  [CELO_TOKENS.USDT.address]: 6,
  [CELO_TOKENS.cUSD.address]: 18,
  [CELO_TOKENS.cEUR.address]: 18,
};

function getMinFeeBalance(currency: `0x${string}`): bigint {
  const decimals = FEE_CURRENCY_DECIMALS[currency] || 18;
  return parseUnits('0.1', decimals);
}

export const UNISWAP_V3_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as `0x${string}`;
export const UNISWAP_V3_ROUTER = '0x5615CDAb10dc425a742d643d949a7F474C01abc4' as `0x${string}`;
export const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as `0x${string}`;
export const AAVE_POOL_DATA_PROVIDER = '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654' as `0x${string}`;

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ]
    }],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ]
  }
] as const;

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ]
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  }
] as const;

const AAVE_POOL_ABI = [
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: []
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'getUserAccountData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ]
  }
] as const;

const AAVE_DATA_PROVIDER_ABI = [
  {
    name: 'getReserveData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'unbacked', type: 'uint256' },
      { name: 'accruedToTreasuryScaled', type: 'uint256' },
      { name: 'totalAToken', type: 'uint256' },
      { name: 'totalStableDebt', type: 'uint256' },
      { name: 'totalVariableDebt', type: 'uint256' },
      { name: 'liquidityRate', type: 'uint256' },
      { name: 'variableBorrowRate', type: 'uint256' },
      { name: 'stableBorrowRate', type: 'uint256' },
      { name: 'averageStableBorrowRate', type: 'uint256' },
      { name: 'liquidityIndex', type: 'uint256' },
      { name: 'variableBorrowIndex', type: 'uint256' },
      { name: 'lastUpdateTimestamp', type: 'uint40' },
    ]
  }
] as const;

const publicClient = createPublicClient({
  chain: celo,
  transport: http()
});

export function getStablecoinInfo(symbol: string): { type: 'mento' | 'bridged'; description: string } {
  const mentoTokens = ['cUSD', 'cEUR', 'cREAL'];
  const bridgedTokens = ['USDC', 'USDT'];
  
  if (mentoTokens.includes(symbol)) {
    return {
      type: 'mento',
      description: `${symbol} is a Mento stablecoin, natively minted on Celo and backed by the Celo Reserve. These are decentralized stablecoins created by the Mento protocol.`
    };
  }
  
  if (bridgedTokens.includes(symbol)) {
    return {
      type: 'bridged',
      description: `${symbol} is a bridged stablecoin from Ethereum. It maintains a 1:1 peg with the original token on Ethereum through bridge contracts.`
    };
  }
  
  return {
    type: 'bridged',
    description: 'Unknown token type'
  };
}

export async function getAllTokenBalances(address: `0x${string}`): Promise<Record<string, string>> {
  const balances: Record<string, string> = {};
  
  const celoBalance = await publicClient.getBalance({ address });
  balances['CELO'] = formatUnits(celoBalance, 18);
  
  for (const [symbol, token] of Object.entries(CELO_TOKENS)) {
    if (token.address) {
      try {
        const balance = await publicClient.readContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address]
        });
        balances[symbol] = formatUnits(balance, token.decimals);
      } catch {
        balances[symbol] = '0';
      }
    }
  }
  
  return balances;
}

export async function getSwapQuote(
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: string
): Promise<{ amountOut: string; priceImpact: string; route: string }> {
  const tokenIn = CELO_TOKENS[tokenInSymbol as keyof typeof CELO_TOKENS];
  const tokenOut = CELO_TOKENS[tokenOutSymbol as keyof typeof CELO_TOKENS];
  
  if (!tokenIn || !tokenOut) {
    throw new Error(`Unknown token: ${!tokenIn ? tokenInSymbol : tokenOutSymbol}`);
  }
  
  const WRAPPED_CELO = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;
  const tokenInAddress = tokenIn.address || WRAPPED_CELO;
  const tokenOutAddress = tokenOut.address || WRAPPED_CELO;
  const amountInWei = parseUnits(amountIn, tokenIn.decimals);
  
  try {
    const result = await publicClient.simulateContract({
      address: UNISWAP_V3_QUOTER,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn: amountInWei,
        fee: 3000,
        sqrtPriceLimitX96: 0n
      }]
    });
    
    const amountOut = formatUnits(result.result[0], tokenOut.decimals);
    const inputValue = parseFloat(amountIn);
    const outputValue = parseFloat(amountOut);
    const expectedRate = inputValue / outputValue;
    const priceImpact = Math.abs((1 - expectedRate) * 100).toFixed(2);
    
    return {
      amountOut,
      priceImpact: `${priceImpact}%`,
      route: `${tokenInSymbol} → ${tokenOutSymbol} (Uniswap V3, 0.3% fee)`
    };
  } catch (error: any) {
    throw new Error(`Failed to get swap quote: ${error.message}`);
  }
}

export async function executeSwap(
  platformPrivateKey: string,
  agentId: string,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: string,
  slippagePercent: number = 0.5,
  payGasWithStablecoin: boolean = true
): Promise<{ hash: string; amountOut: string; gasToken: string }> {
  const tokenIn = CELO_TOKENS[tokenInSymbol as keyof typeof CELO_TOKENS];
  const tokenOut = CELO_TOKENS[tokenOutSymbol as keyof typeof CELO_TOKENS];
  
  if (!tokenIn || !tokenOut) {
    throw new Error(`Unknown token: ${!tokenIn ? tokenInSymbol : tokenOutSymbol}`);
  }
  
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  const WRAPPED_CELO = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;
  const tokenInAddress = tokenIn.address || WRAPPED_CELO;
  const tokenOutAddress = tokenOut.address || WRAPPED_CELO;
  const amountInWei = parseUnits(amountIn, tokenIn.decimals);
  
  const quote = await getSwapQuote(tokenInSymbol, tokenOutSymbol, amountIn);
  const minAmountOut = parseUnits(
    (parseFloat(quote.amountOut) * (1 - slippagePercent / 100)).toFixed(tokenOut.decimals),
    tokenOut.decimals
  );
  
  let feeCurrency: `0x${string}` | undefined;
  let gasToken = 'CELO';
  
  if (payGasWithStablecoin) {
    for (const currency of FEE_CURRENCIES) {
      try {
        const balance = await wallet.publicClient.readContract({
          address: currency,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [wallet.address]
        });
        if (balance > getMinFeeBalance(currency)) {
          feeCurrency = currency;
          const matchingToken = Object.entries(CELO_TOKENS).find(([_, t]) => t.address === currency);
          gasToken = matchingToken ? matchingToken[0] : 'stablecoin';
          break;
        }
      } catch {}
    }
  }
  
  if (tokenIn.address) {
    const allowance = await wallet.publicClient.readContract({
      address: tokenIn.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [wallet.address, UNISWAP_V3_ROUTER]
    });
    
    if (allowance < amountInWei) {
      const approveHash = await wallet.walletClient.writeContract({
        address: tokenIn.address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_V3_ROUTER, amountInWei * 2n],
        ...(feeCurrency ? { feeCurrency } : {})
      });
      await wallet.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }
  
  const swapParams = {
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    fee: 3000,
    recipient: wallet.address,
    amountIn: amountInWei,
    amountOutMinimum: minAmountOut,
    sqrtPriceLimitX96: 0n
  };
  
  const hash = await wallet.walletClient.writeContract({
    address: UNISWAP_V3_ROUTER,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [swapParams],
    value: tokenIn.address ? 0n : amountInWei,
    ...(feeCurrency ? { feeCurrency } : {})
  });
  
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return {
    hash,
    amountOut: quote.amountOut,
    gasToken
  };
}

export async function getAaveReserveData(tokenSymbol: string): Promise<{
  supplyAPY: string;
  borrowAPY: string;
  totalSupplied: string;
  totalBorrowed: string;
  utilizationRate: string;
}> {
  const token = CELO_TOKENS[tokenSymbol as keyof typeof CELO_TOKENS];
  if (!token || !token.address) {
    throw new Error(`Token ${tokenSymbol} not supported for Aave`);
  }
  
  try {
    const data = await publicClient.readContract({
      address: AAVE_POOL_DATA_PROVIDER,
      abi: AAVE_DATA_PROVIDER_ABI,
      functionName: 'getReserveData',
      args: [token.address]
    });
    
    const RAY = 10n ** 27n;
    const liquidityRate = data[5];
    const variableBorrowRate = data[6];
    const totalAToken = data[2];
    const totalVariableDebt = data[4];
    const totalStableDebt = data[3];
    
    const supplyAPY = (Number(liquidityRate * 100n / RAY) / 100).toFixed(2);
    const borrowAPY = (Number(variableBorrowRate * 100n / RAY) / 100).toFixed(2);
    const totalSupplied = formatUnits(totalAToken, token.decimals);
    const totalBorrowed = formatUnits(totalVariableDebt + totalStableDebt, token.decimals);
    
    const utilization = totalAToken > 0n
      ? Number((totalVariableDebt + totalStableDebt) * 10000n / totalAToken) / 100
      : 0;
    
    return {
      supplyAPY: `${supplyAPY}%`,
      borrowAPY: `${borrowAPY}%`,
      totalSupplied,
      totalBorrowed,
      utilizationRate: `${utilization.toFixed(2)}%`
    };
  } catch (error: any) {
    throw new Error(`Failed to get Aave data for ${tokenSymbol}: ${error.message}`);
  }
}

export async function supplyToAave(
  platformPrivateKey: string,
  agentId: string,
  tokenSymbol: string,
  amount: string,
  payGasWithStablecoin: boolean = true
): Promise<{ hash: string; amount: string; gasToken: string }> {
  const token = CELO_TOKENS[tokenSymbol as keyof typeof CELO_TOKENS];
  if (!token || !token.address) {
    throw new Error(`Token ${tokenSymbol} not supported for Aave supply`);
  }
  
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  const amountWei = parseUnits(amount, token.decimals);
  
  let feeCurrency: `0x${string}` | undefined;
  let gasToken = 'CELO';
  
  if (payGasWithStablecoin) {
    for (const currency of FEE_CURRENCIES) {
      try {
        const balance = await wallet.publicClient.readContract({
          address: currency,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [wallet.address]
        });
        if (balance > getMinFeeBalance(currency)) {
          feeCurrency = currency;
          const matchingToken = Object.entries(CELO_TOKENS).find(([_, t]) => t.address === currency);
          gasToken = matchingToken ? matchingToken[0] : 'stablecoin';
          break;
        }
      } catch {}
    }
  }
  
  const allowance = await wallet.publicClient.readContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [wallet.address, AAVE_POOL]
  });
  
  if (allowance < amountWei) {
    const approveHash = await wallet.walletClient.writeContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [AAVE_POOL, amountWei * 2n],
      ...(feeCurrency ? { feeCurrency } : {})
    });
    await wallet.publicClient.waitForTransactionReceipt({ hash: approveHash });
  }
  
  const hash = await wallet.walletClient.writeContract({
    address: AAVE_POOL,
    abi: AAVE_POOL_ABI,
    functionName: 'supply',
    args: [token.address, amountWei, wallet.address, 0],
    ...(feeCurrency ? { feeCurrency } : {})
  });
  
  await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return { hash, amount, gasToken };
}

export async function withdrawFromAave(
  platformPrivateKey: string,
  agentId: string,
  tokenSymbol: string,
  amount: string,
  payGasWithStablecoin: boolean = true
): Promise<{ hash: string; amount: string; gasToken: string }> {
  const token = CELO_TOKENS[tokenSymbol as keyof typeof CELO_TOKENS];
  if (!token || !token.address) {
    throw new Error(`Token ${tokenSymbol} not supported for Aave withdraw`);
  }
  
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  const amountWei = parseUnits(amount, token.decimals);
  
  let feeCurrency: `0x${string}` | undefined;
  let gasToken = 'CELO';
  
  if (payGasWithStablecoin) {
    for (const currency of FEE_CURRENCIES) {
      try {
        const balance = await wallet.publicClient.readContract({
          address: currency,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [wallet.address]
        });
        if (balance > getMinFeeBalance(currency)) {
          feeCurrency = currency;
          const matchingToken = Object.entries(CELO_TOKENS).find(([_, t]) => t.address === currency);
          gasToken = matchingToken ? matchingToken[0] : 'stablecoin';
          break;
        }
      } catch {}
    }
  }
  
  const hash = await wallet.walletClient.writeContract({
    address: AAVE_POOL,
    abi: AAVE_POOL_ABI,
    functionName: 'withdraw',
    args: [token.address, amountWei, wallet.address],
    ...(feeCurrency ? { feeCurrency } : {})
  });
  
  await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return { hash, amount, gasToken };
}

export async function getAaveAccountData(
  platformPrivateKey: string,
  agentId: string
): Promise<{
  totalCollateralUSD: string;
  totalDebtUSD: string;
  availableBorrowsUSD: string;
  healthFactor: string;
  ltv: string;
}> {
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  
  try {
    const data = await publicClient.readContract({
      address: AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [wallet.address]
    });
    
    return {
      totalCollateralUSD: formatUnits(data[0], 8),
      totalDebtUSD: formatUnits(data[1], 8),
      availableBorrowsUSD: formatUnits(data[2], 8),
      ltv: `${Number(data[4]) / 100}%`,
      healthFactor: data[5] > 0n ? formatUnits(data[5], 18) : 'N/A'
    };
  } catch (error: any) {
    throw new Error(`Failed to get Aave account data: ${error.message}`);
  }
}

export async function transferWithFeeAbstraction(
  platformPrivateKey: string,
  agentId: string,
  tokenSymbol: string,
  toAddress: string,
  amount: string
): Promise<{ hash: string; amount: string; gasToken: string }> {
  const token = CELO_TOKENS[tokenSymbol as keyof typeof CELO_TOKENS];
  if (!token || !token.address) {
    throw new Error(`Token ${tokenSymbol} not supported for transfer`);
  }
  
  const wallet = createAgentWallet(platformPrivateKey, agentId);
  const amountWei = parseUnits(amount, token.decimals);
  
  let feeCurrency: `0x${string}` | undefined;
  let gasToken = 'CELO';
  
  for (const currency of FEE_CURRENCIES) {
    try {
      const balance = await wallet.publicClient.readContract({
        address: currency,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [wallet.address]
      });
      if (balance > getMinFeeBalance(currency)) {
        feeCurrency = currency;
        const matchingToken = Object.entries(CELO_TOKENS).find(([_, t]) => t.address === currency);
        gasToken = matchingToken ? matchingToken[0] : 'stablecoin';
        break;
      }
    } catch {}
  }
  
  const hash = await wallet.walletClient.writeContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [toAddress as `0x${string}`, amountWei],
    ...(feeCurrency ? { feeCurrency } : {})
  });
  
  await wallet.publicClient.waitForTransactionReceipt({ hash });
  
  return { hash, amount, gasToken };
}

export const BRIDGE_INFO = {
  wormhole: {
    name: 'Wormhole',
    url: 'https://wormhole.com/',
    supported: ['Ethereum', 'Polygon', 'Arbitrum', 'Optimism', 'BSC', 'Avalanche', 'Solana'],
    tokens: ['USDC', 'USDT', 'ETH', 'WBTC'],
    apiEndpoint: 'https://api.wormholescan.io'
  },
  layerZero: {
    name: 'LayerZero (Stargate)',
    url: 'https://stargate.finance/',
    supported: ['Ethereum', 'Polygon', 'Arbitrum', 'Optimism', 'BSC', 'Avalanche'],
    tokens: ['USDC', 'USDT', 'ETH'],
    apiEndpoint: 'https://api.stargate.finance'
  },
  squid: {
    name: 'Squid Router',
    url: 'https://app.squidrouter.com/',
    supported: ['Ethereum', 'Polygon', 'Arbitrum', 'Optimism', 'BSC', 'Avalanche', 'Celo'],
    tokens: ['Any supported token'],
    apiEndpoint: 'https://api.0xsquid.com'
  }
};

export function getBridgeOptions(
  sourceChain: string,
  destinationChain: string,
  token: string
): { bridge: string; url: string; estimated_time: string; notes: string }[] {
  const options: { bridge: string; url: string; estimated_time: string; notes: string }[] = [];
  
  for (const [key, bridge] of Object.entries(BRIDGE_INFO)) {
    const supportsSource = sourceChain === 'Celo' || bridge.supported.includes(sourceChain);
    const supportsDest = destinationChain === 'Celo' || bridge.supported.includes(destinationChain);
    
    if (supportsSource && supportsDest) {
      options.push({
        bridge: bridge.name,
        url: bridge.url,
        estimated_time: key === 'wormhole' ? '15-20 minutes' : '5-15 minutes',
        notes: `Supports ${bridge.tokens.join(', ')}`
      });
    }
  }
  
  return options;
}

export function isMiniPayEnvironment(): boolean {
  if (typeof window !== 'undefined' && (window as any).ethereum?.isMiniPay) {
    return true;
  }
  return false;
}

export const MINIPAY_INFO = {
  description: 'MiniPay is Opera\'s stablecoin wallet built for Africa. It allows easy sending and receiving of cUSD.',
  supportedTokens: ['cUSD'],
  documentation: 'https://docs.celo.org/developer/minipay',
  features: [
    'No gas fees for users (sponsored transactions)',
    'Simple cUSD transfers',
    'Phone number-based identity',
    'Built into Opera Mini browser'
  ],
  developerNotes: [
    'MiniPay injects window.ethereum with isMiniPay: true',
    'Use cUSD for payments (MiniPay primary currency)',
    'Keep UI simple and mobile-first',
    'Test with MiniPay Site Tester Chrome extension'
  ]
};
