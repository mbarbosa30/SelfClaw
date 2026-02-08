import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, maxUint256 } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const WRAPPED_SELFCLAW_CELO = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb' as `0x${string}`;
const SELFCLAW_BASE = '0x9ae5f51d81ff510bf961218f833f79d57bfbab07' as `0x${string}`;
const POSITION_MANAGER = '0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A' as `0x${string}`;
const SWAP_ROUTER = '0x5615CDAb10dc425a742d643d949a7F474C01abc4' as `0x${string}`;
const FACTORY = '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc' as `0x${string}`;
const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;
const CELO_RPC = 'https://forno.celo.org';

const MAX_UINT128 = (2n ** 128n) - 1n;

const rawPrivateKey = process.env.CELO_PRIVATE_KEY;
const PRIVATE_KEY = rawPrivateKey && !rawPrivateKey.startsWith('0x') ? `0x${rawPrivateKey}` : rawPrivateKey;

const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const POSITION_MANAGER_ABI = [
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
    ],
  },
  {
    name: 'collect',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'amount0Max', type: 'uint128' },
          { name: 'amount1Max', type: 'uint128' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
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
        ],
      },
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
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
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface CollectFeesResult {
  success: boolean;
  txHash?: string;
  amount0?: string;
  amount1?: string;
  error?: string;
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountOut?: string;
  error?: string;
}

export interface CreatePoolParams {
  tokenA: string;
  tokenB: string;
  amountA: string;
  amountB: string;
  feeTier?: number;
}

export interface CreatePoolResult {
  success: boolean;
  poolAddress?: string;
  positionTokenId?: string;
  txHash?: string;
  liquidity?: string;
  amount0?: string;
  amount1?: string;
  error?: string;
}

export interface PositionInfo {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
}

function getAccount() {
  if (!PRIVATE_KEY) {
    throw new Error('CELO_PRIVATE_KEY environment variable is not set');
  }
  return privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
}

function getWalletClient() {
  const account = getAccount();
  return createWalletClient({
    account,
    chain: celo,
    transport: http(CELO_RPC),
  });
}

function sortTokens(
  tokenA: string,
  tokenB: string,
  amountA: bigint,
  amountB: bigint
): { token0: `0x${string}`; token1: `0x${string}`; amount0: bigint; amount1: bigint } {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a < b) {
    return {
      token0: tokenA as `0x${string}`,
      token1: tokenB as `0x${string}`,
      amount0: amountA,
      amount1: amountB,
    };
  }
  return {
    token0: tokenB as `0x${string}`,
    token1: tokenA as `0x${string}`,
    amount0: amountB,
    amount1: amountA,
  };
}

function calculateSqrtPriceX96(amount0: bigint, amount1: bigint): bigint {
  if (amount0 === 0n) throw new Error('amount0 cannot be zero');
  const priceNumerator = amount1 * (10n ** 18n);
  const priceDenominator = amount0;
  const priceScaled = priceNumerator / priceDenominator;
  const sqrtPriceScaled = bigintSqrt(priceScaled);
  const sqrtScale = bigintSqrt(10n ** 18n);
  const Q96 = 2n ** 96n;
  return (sqrtPriceScaled * Q96) / sqrtScale;
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Square root of negative number');
  if (value === 0n) return 0n;
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

function getFullRangeTicks(feeTier: number): { tickLower: number; tickUpper: number } {
  const tickSpacing = TICK_SPACINGS[feeTier];
  if (!tickSpacing) throw new Error(`Unsupported fee tier: ${feeTier}`);
  const maxTick = 887200;
  const alignedMax = Math.floor(maxTick / tickSpacing) * tickSpacing;
  return { tickLower: -alignedMax, tickUpper: alignedMax };
}

async function ensureApproval(
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint
): Promise<void> {
  const account = getAccount();
  const walletClient = getWalletClient();

  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, spender],
  });

  if (allowance < amount) {
    const txHash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }
}

export async function collectFees(positionTokenId: bigint): Promise<CollectFeesResult> {
  try {
    const account = getAccount();
    const walletClient = getWalletClient();

    const txHash = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{
        tokenId: positionTokenId,
        recipient: account.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'Transaction reverted' };
    }

    return {
      success: true,
      txHash,
      amount0: '0',
      amount1: '0',
    };
  } catch (error: any) {
    console.error('[uniswap-v3] collectFees error:', error);
    return { success: false, error: error.message || 'Failed to collect fees' };
  }
}

export async function swapExactInput(
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  fee: number = 3000
): Promise<SwapResult> {
  try {
    const account = getAccount();
    const walletClient = getWalletClient();
    const amountInWei = parseUnits(amountIn, 18);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const isCeloNative = tokenIn.toLowerCase() === CELO_NATIVE.toLowerCase();

    if (!isCeloNative) {
      await ensureApproval(tokenIn as `0x${string}`, SWAP_ROUTER, amountInWei);
    }

    const txHash = await walletClient.writeContract({
      address: SWAP_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: tokenIn as `0x${string}`,
        tokenOut: tokenOut as `0x${string}`,
        fee,
        recipient: account.address,
        deadline,
        amountIn: amountInWei,
        amountOutMinimum: amountInWei * 95n / 100n,
        sqrtPriceLimitX96: 0n,
      }],
      value: isCeloNative ? amountInWei : 0n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'Swap transaction reverted' };
    }

    return {
      success: true,
      txHash,
    };
  } catch (error: any) {
    console.error('[uniswap-v3] swapExactInput error:', error);
    return { success: false, error: error.message || 'Failed to swap tokens' };
  }
}

export async function createPoolAndAddLiquidity(params: CreatePoolParams): Promise<CreatePoolResult> {
  try {
    const { tokenA, tokenB, amountA, amountB, feeTier = 10000 } = params;
    const account = getAccount();
    const walletClient = getWalletClient();
    const amountAWei = parseUnits(amountA, 18);
    const amountBWei = parseUnits(amountB, 18);
    const { token0, token1, amount0, amount1 } = sortTokens(tokenA, tokenB, amountAWei, amountBWei);
    const sqrtPriceX96 = calculateSqrtPriceX96(amount0, amount1);

    const createPoolTx = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'createAndInitializePoolIfNecessary',
      args: [token0, token1, feeTier, sqrtPriceX96],
    });
    await publicClient.waitForTransactionReceipt({ hash: createPoolTx });

    const isCeloToken0 = token0.toLowerCase() === CELO_NATIVE.toLowerCase();
    const isCeloToken1 = token1.toLowerCase() === CELO_NATIVE.toLowerCase();
    const celoValue = isCeloToken0 ? amount0 : isCeloToken1 ? amount1 : 0n;

    if (!isCeloToken0) {
      await ensureApproval(token0, POSITION_MANAGER, amount0);
    }
    if (!isCeloToken1) {
      await ensureApproval(token1, POSITION_MANAGER, amount1);
    }

    const { tickLower, tickUpper } = getFullRangeTicks(feeTier);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const mintTxHash = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'mint',
      args: [{
        token0,
        token1,
        fee: feeTier,
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: account.address,
        deadline,
      }],
      value: celoValue,
    });

    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTxHash });

    if (mintReceipt.status === 'reverted') {
      return { success: false, error: 'Mint transaction reverted' };
    }

    const poolAddress = await publicClient.readContract({
      address: FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [token0, token1, feeTier],
    });

    return {
      success: true,
      poolAddress,
      txHash: mintTxHash,
      amount0: formatUnits(amount0, 18),
      amount1: formatUnits(amount1, 18),
    };
  } catch (error: any) {
    console.error('[uniswap-v3] createPoolAndAddLiquidity error:', error);
    return { success: false, error: error.message || 'Failed to create pool and add liquidity' };
  }
}

export async function getPosition(positionTokenId: bigint): Promise<PositionInfo> {
  const result = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [positionTokenId],
  });

  return {
    token0: result[2],
    token1: result[3],
    fee: result[4],
    tickLower: result[5],
    tickUpper: result[6],
    liquidity: result[7].toString(),
  };
}

export async function getUncollectedFees(positionTokenId: bigint): Promise<{ token0Fees: string; token1Fees: string }> {
  try {
    const account = getAccount();

    const result = await publicClient.simulateContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{
        tokenId: positionTokenId,
        recipient: account.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
      account: account.address,
    });

    return {
      token0Fees: result.result[0].toString(),
      token1Fees: result.result[1].toString(),
    };
  } catch (error: any) {
    console.error('[uniswap-v3] getUncollectedFees error:', error);
    return { token0Fees: '0', token1Fees: '0' };
  }
}

export async function getSelfclawBalance(): Promise<string> {
  const account = getAccount();

  const balance = await publicClient.readContract({
    address: WRAPPED_SELFCLAW_CELO,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return formatUnits(balance, 18);
}

export async function getTokenBalance(tokenAddress: string, decimals: number = 18): Promise<string> {
  const account = getAccount();

  const balance = await publicClient.readContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return formatUnits(balance, decimals);
}
