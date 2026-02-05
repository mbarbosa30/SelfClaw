import { createPublicClient, http, parseUnits, formatUnits, encodeFunctionData, maxUint256 } from 'viem';
import { celo } from 'viem/chains';
import { createAgentWallet, deriveAgentWalletAddress } from './agent-wallet.js';
import { CELO_TOKENS, UNISWAP_V3_ROUTER } from './celo-defi.js';

const publicClient = createPublicClient({
  chain: celo,
  transport: http()
});

export const UNISWAP_V3_FACTORY = '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc' as `0x${string}`;
export const UNISWAP_V3_POSITION_MANAGER = '0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A' as `0x${string}`;

export const FEE_TIERS = {
  '0.01': 100,
  '0.05': 500,
  '0.3': 3000,
  '1': 10000,
} as const;

export type FeeTierKey = keyof typeof FEE_TIERS;

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

const POSITION_MANAGER_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickLower', type: 'int24' },
        { name: 'tickUpper', type: 'int24' },
        { name: 'amount0Desired', type: 'uint256' },
        { name: 'amount1Desired', type: 'uint256' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ]
    }],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ]
  },
  {
    name: 'increaseLiquidity',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'amount0Desired', type: 'uint256' },
        { name: 'amount1Desired', type: 'uint256' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ]
    }],
    outputs: [
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ]
  },
  {
    name: 'decreaseLiquidity',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'liquidity', type: 'uint128' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ]
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ]
  },
  {
    name: 'collect',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'amount0Max', type: 'uint128' },
        { name: 'amount1Max', type: 'uint128' },
      ]
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ]
  },
  {
    name: 'positions',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ]
  },
  {
    name: 'createAndInitializePoolIfNecessary',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceX96', type: 'uint160' },
    ],
    outputs: [{ name: 'pool', type: 'address' }]
  },
] as const;

export interface CreatePoolResult {
  success: boolean;
  positionId?: string;
  txHash?: string;
  token0Amount?: string;
  token1Amount?: string;
  liquidity?: string;
  error?: string;
}

export interface LiquidityResult {
  success: boolean;
  txHash?: string;
  amount0?: string;
  amount1?: string;
  liquidity?: string;
  error?: string;
}

export interface PositionInfo {
  positionId: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwed0: string;
  tokensOwed1: string;
}

function priceToSqrtPriceX96(price: number): bigint {
  const sqrtPrice = Math.sqrt(price);
  const sqrtPriceX96 = sqrtPrice * (2 ** 96);
  return BigInt(Math.floor(sqrtPriceX96));
}

function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

function getTickSpacing(fee: number): number {
  if (fee === 100) return 1;
  if (fee === 500) return 10;
  if (fee === 3000) return 60;
  if (fee === 10000) return 200;
  return 60;
}

function alignTickToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

async function getTokenInfo(tokenAddress: `0x${string}`): Promise<{ decimals: number; symbol: string }> {
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals'
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'symbol'
    }),
  ]);
  return { decimals, symbol };
}

async function approveToken(
  wallet: any,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint
): Promise<void> {
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [wallet.address, spender]
  });

  if (allowance < amount) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, maxUint256]
    });

    const hash = await wallet.walletClient.sendTransaction({
      to: tokenAddress,
      data: approveData,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

export async function createLiquidityPool(
  platformPrivateKey: string,
  agentId: string,
  token0Address: string,
  token1Address: string,
  feeTier: FeeTierKey,
  initialPrice: number,
  amount0: string,
  amount1: string,
  priceRangeLower: number,
  priceRangeUpper: number
): Promise<CreatePoolResult> {
  try {
    const wallet = createAgentWallet(platformPrivateKey, agentId);
    const fee = FEE_TIERS[feeTier];
    const tickSpacing = getTickSpacing(fee);

    let addr0 = token0Address as `0x${string}`;
    let addr1 = token1Address as `0x${string}`;
    let amt0 = amount0;
    let amt1 = amount1;
    let priceLower = priceRangeLower;
    let priceUpper = priceRangeUpper;
    let price = initialPrice;

    if (addr0.toLowerCase() > addr1.toLowerCase()) {
      [addr0, addr1] = [addr1, addr0];
      [amt0, amt1] = [amt1, amt0];
      price = 1 / price;
      [priceLower, priceUpper] = [1 / priceUpper, 1 / priceLower];
    }

    const [info0, info1] = await Promise.all([
      getTokenInfo(addr0),
      getTokenInfo(addr1)
    ]);

    const sqrtPriceX96 = priceToSqrtPriceX96(price);
    
    const createPoolData = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'createAndInitializePoolIfNecessary',
      args: [addr0, addr1, fee, sqrtPriceX96]
    });

    const createPoolHash = await wallet.walletClient.sendTransaction({
      to: UNISWAP_V3_POSITION_MANAGER,
      data: createPoolData,
      gas: 5000000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: createPoolHash });

    const tickLower = alignTickToSpacing(priceToTick(priceLower), tickSpacing);
    const tickUpper = alignTickToSpacing(priceToTick(priceUpper), tickSpacing);

    const amount0Desired = parseUnits(amt0, info0.decimals);
    const amount1Desired = parseUnits(amt1, info1.decimals);

    await approveToken(wallet, addr0, UNISWAP_V3_POSITION_MANAGER, amount0Desired);
    await approveToken(wallet, addr1, UNISWAP_V3_POSITION_MANAGER, amount1Desired);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const mintData = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'mint',
      args: [{
        token0: addr0,
        token1: addr1,
        fee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: wallet.address,
        deadline,
      }]
    });

    const mintHash = await wallet.walletClient.sendTransaction({
      to: UNISWAP_V3_POSITION_MANAGER,
      data: mintData,
      gas: 5000000n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const mintLog = receipt.logs.find(log => 
      log.address.toLowerCase() === UNISWAP_V3_POSITION_MANAGER.toLowerCase()
    );

    const positionId = mintLog ? BigInt(mintLog.topics[1] || '0').toString() : 'unknown';

    return {
      success: true,
      positionId,
      txHash: mintHash,
      token0Amount: amt0,
      token1Amount: amt1,
      liquidity: 'created',
    };
  } catch (error: any) {
    console.error('[uniswap-liquidity] Create pool error:', error);
    return { success: false, error: error.message };
  }
}

export async function addLiquidity(
  platformPrivateKey: string,
  agentId: string,
  positionId: string,
  amount0: string,
  amount1: string,
  token0Address: string,
  token1Address: string
): Promise<LiquidityResult> {
  try {
    const wallet = createAgentWallet(platformPrivateKey, agentId);

    const [info0, info1] = await Promise.all([
      getTokenInfo(token0Address as `0x${string}`),
      getTokenInfo(token1Address as `0x${string}`)
    ]);

    const amount0Desired = parseUnits(amount0, info0.decimals);
    const amount1Desired = parseUnits(amount1, info1.decimals);

    await approveToken(wallet, token0Address as `0x${string}`, UNISWAP_V3_POSITION_MANAGER, amount0Desired);
    await approveToken(wallet, token1Address as `0x${string}`, UNISWAP_V3_POSITION_MANAGER, amount1Desired);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const data = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'increaseLiquidity',
      args: [{
        tokenId: BigInt(positionId),
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      }]
    });

    const hash = await wallet.walletClient.sendTransaction({
      to: UNISWAP_V3_POSITION_MANAGER,
      data,
      gas: 3000000n,
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      success: true,
      txHash: hash,
      amount0,
      amount1,
    };
  } catch (error: any) {
    console.error('[uniswap-liquidity] Add liquidity error:', error);
    return { success: false, error: error.message };
  }
}

export async function removeLiquidity(
  platformPrivateKey: string,
  agentId: string,
  positionId: string,
  liquidityPercentage: number
): Promise<LiquidityResult> {
  try {
    const wallet = createAgentWallet(platformPrivateKey, agentId);

    const position = await publicClient.readContract({
      address: UNISWAP_V3_POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'positions',
      args: [BigInt(positionId)]
    });

    const currentLiquidity = position[7];
    const liquidityToRemove = (currentLiquidity * BigInt(Math.floor(liquidityPercentage))) / 100n;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const decreaseData = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'decreaseLiquidity',
      args: [{
        tokenId: BigInt(positionId),
        liquidity: liquidityToRemove,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      }]
    });

    const decreaseHash = await wallet.walletClient.sendTransaction({
      to: UNISWAP_V3_POSITION_MANAGER,
      data: decreaseData,
      gas: 3000000n,
    });

    await publicClient.waitForTransactionReceipt({ hash: decreaseHash });

    const collectData = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{
        tokenId: BigInt(positionId),
        recipient: wallet.address,
        amount0Max: BigInt('340282366920938463463374607431768211455'),
        amount1Max: BigInt('340282366920938463463374607431768211455'),
      }]
    });

    const collectHash = await wallet.walletClient.sendTransaction({
      to: UNISWAP_V3_POSITION_MANAGER,
      data: collectData,
      gas: 2000000n,
    });

    await publicClient.waitForTransactionReceipt({ hash: collectHash });

    return {
      success: true,
      txHash: collectHash,
      liquidity: liquidityToRemove.toString(),
    };
  } catch (error: any) {
    console.error('[uniswap-liquidity] Remove liquidity error:', error);
    return { success: false, error: error.message };
  }
}

export async function getPositionInfo(positionId: string): Promise<PositionInfo | null> {
  try {
    const position = await publicClient.readContract({
      address: UNISWAP_V3_POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'positions',
      args: [BigInt(positionId)]
    });

    return {
      positionId,
      token0: position[2],
      token1: position[3],
      fee: position[4],
      tickLower: position[5],
      tickUpper: position[6],
      liquidity: position[7].toString(),
      tokensOwed0: position[10].toString(),
      tokensOwed1: position[11].toString(),
    };
  } catch (error: any) {
    console.error('[uniswap-liquidity] Get position error:', error);
    return null;
  }
}

export async function collectFees(
  platformPrivateKey: string,
  agentId: string,
  positionId: string
): Promise<LiquidityResult> {
  try {
    const wallet = createAgentWallet(platformPrivateKey, agentId);

    const data = encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{
        tokenId: BigInt(positionId),
        recipient: wallet.address,
        amount0Max: BigInt('340282366920938463463374607431768211455'),
        amount1Max: BigInt('340282366920938463463374607431768211455'),
      }]
    });

    const hash = await wallet.walletClient.sendTransaction({
      to: UNISWAP_V3_POSITION_MANAGER,
      data,
      gas: 2000000n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    return {
      success: true,
      txHash: hash,
    };
  } catch (error: any) {
    console.error('[uniswap-liquidity] Collect fees error:', error);
    return { success: false, error: error.message };
  }
}
