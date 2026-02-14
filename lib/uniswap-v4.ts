import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, maxUint256, encodePacked, encodeAbiParameters, parseAbiParameters, keccak256 } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const WRAPPED_SELFCLAW_CELO = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb' as `0x${string}`;
const SELFCLAW_BASE = '0x9ae5f51d81ff510bf961218f833f79d57bfbab07' as `0x${string}`;
const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;
const CELO_RPC = 'https://forno.celo.org';

const POOL_MANAGER = '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC' as `0x${string}`;
const POSITION_MANAGER = '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9' as `0x${string}`;
const UNIVERSAL_ROUTER = '0xcb695bc5d3aa22cad1e6df07801b061a05a0233a' as `0x${string}`;
const STATE_VIEW = '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb' as `0x${string}`;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`;

export const SELFCLAW_CELO_POOL_ID = '0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b' as `0x${string}`;

const MAX_UINT128 = (2n ** 128n) - 1n;

const rawPrivateKey = process.env.CELO_PRIVATE_KEY;
const PRIVATE_KEY = rawPrivateKey && !rawPrivateKey.startsWith('0x') ? `0x${rawPrivateKey}` : rawPrivateKey;

const V4_ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  INCREASE_LIQUIDITY_FROM_DELTAS: 0x04,
  MINT_POSITION_FROM_DELTAS: 0x05,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
  SWEEP: 0x14,
} as const;

const COMMANDS = {
  V4_SWAP: 0x10,
} as const;

const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC, { timeout: 15_000, retryCount: 1 }),
});

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const POSITION_MANAGER_ABI = [
  {
    name: 'modifyLiquidities',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'unlockData', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'getPoolAndPositionInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'info', type: 'uint256' },
    ],
  },
  {
    name: 'getPositionLiquidity',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
  {
    name: 'nextTokenId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const POOL_MANAGER_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'sqrtPriceX96', type: 'uint160' },
    ],
    outputs: [{ name: 'tick', type: 'int24' }],
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
] as const;

const STATE_VIEW_ABI = [
  {
    name: 'getSlot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    name: 'getLiquidity',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const;

export interface PoolState {
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: string;
  price: string;
  inversePrice: string;
}

export async function getPoolState(poolId: `0x${string}`): Promise<PoolState> {
  const [slot0Result, liquidityResult] = await Promise.all([
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
    }),
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [poolId],
    }),
  ]);

  const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0Result;
  const liquidity = liquidityResult;

  const Q96 = 2n ** 96n;
  const priceRaw = Number(sqrtPriceX96) / Number(Q96);
  const price = priceRaw * priceRaw;
  const inversePrice = price > 0 ? 1 / price : 0;

  return {
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    protocolFee,
    lpFee,
    liquidity: liquidity.toString(),
    price: price.toFixed(18),
    inversePrice: inversePrice.toFixed(18),
  };
}

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
  privateKey?: string;
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
  receipt?: any;
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

function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = Math.abs(tick);
  const Q96 = 2n ** 96n;

  let ratio = 1n << 128n;
  if (absTick & 0x1) ratio = (ratio * 0xfffcb933bd6fad37aa2d162d1a594001n) >> 128n;
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) {
    ratio = ((1n << 256n) - 1n) / ratio;
  }

  return (ratio >> 32n) + (ratio % (1n << 32n) > 0n ? 1n : 0n) >> 32n;
}

function calculateLiquidityForFullRange(
  sqrtPriceX96: bigint,
  amount0: bigint,
  amount1: bigint,
  tickLower: number,
  tickUpper: number
): bigint {
  const Q96 = 2n ** 96n;
  const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
  const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

  let liquidity0 = 0n;
  let liquidity1 = 0n;

  if (sqrtPriceX96 > sqrtPriceLower && sqrtPriceUpper > sqrtPriceLower) {
    const denom = sqrtPriceX96 - sqrtPriceLower;
    if (denom > 0n) {
      liquidity1 = (amount1 * Q96) / denom;
    }
  }

  if (sqrtPriceUpper > sqrtPriceX96 && sqrtPriceUpper > sqrtPriceLower) {
    const numerator = sqrtPriceX96 * sqrtPriceUpper;
    const denom = sqrtPriceUpper - sqrtPriceX96;
    if (denom > 0n && numerator > 0n) {
      liquidity0 = (amount0 * numerator) / (denom * Q96);
    }
  }

  if (liquidity0 === 0n && liquidity1 === 0n) {
    return bigintSqrt(amount0 * amount1);
  }

  if (liquidity0 === 0n) return liquidity1;
  if (liquidity1 === 0n) return liquidity0;
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
}

async function ensurePermit2Approval(
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  overrideAccount?: ReturnType<typeof privateKeyToAccount>,
  overrideWalletClient?: ReturnType<typeof createWalletClient>,
  forceRenew: boolean = false
): Promise<void> {
  const account = overrideAccount || getAccount();
  const walletClient = overrideWalletClient || getWalletClient();
  const tokenShort = token.substring(0, 10);
  const spenderShort = spender.substring(0, 10);

  const tokenBalance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  }) as bigint;
  console.log(`[uniswap-v4] Token balance for ${tokenShort}...: ${formatUnits(tokenBalance, 18)} (need ${formatUnits(amount, 18)})`);

  if (tokenBalance < amount) {
    console.warn(`[uniswap-v4] WARNING: Wallet balance (${formatUnits(tokenBalance, 18)}) < required amount (${formatUnits(amount, 18)}) for ${tokenShort}...`);
  }

  const erc20Allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, PERMIT2],
  }) as bigint;
  console.log(`[uniswap-v4] ERC-20 allowance ${tokenShort}... → Permit2: ${erc20Allowance > 10n ** 30n ? 'maxUint' : formatUnits(erc20Allowance, 18)}`);

  if (forceRenew || erc20Allowance < amount) {
    console.log(`[uniswap-v4] Setting ERC-20 approval: ${tokenShort}... → Permit2 (${forceRenew ? 'forced' : 'insufficient'})`);
    const approveTx = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [PERMIT2, maxUint256],
      chain: celo,
      account,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`[uniswap-v4] ERC-20 approval tx: ${approveTx} (status: ${approveReceipt.status})`);

    const verifyAllowance = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, PERMIT2],
    }) as bigint;
    if (verifyAllowance < amount) {
      throw new Error(`ERC-20 approval verification failed for ${tokenShort}...: allowance=${formatUnits(verifyAllowance, 18)}, needed=${formatUnits(amount, 18)}`);
    }
  }

  const permit2Result = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [account.address, token, spender],
  });

  const permit2Amount = BigInt(permit2Result[0]);
  const permit2Expiry = Number(permit2Result[1]);
  const now = Math.floor(Date.now() / 1000);
  const safetyMargin = 300;
  const needsRenewal = forceRenew || permit2Amount < amount || permit2Expiry < (now + safetyMargin);

  console.log(`[uniswap-v4] Permit2 state for ${tokenShort}... → ${spenderShort}...: amount=${permit2Amount > 10n ** 30n ? 'maxUint160' : formatUnits(permit2Amount, 18)}, expiry=${permit2Expiry} (${permit2Expiry > 0 ? new Date(permit2Expiry * 1000).toISOString() : 'never'}), needsRenewal=${needsRenewal}`);

  if (needsRenewal) {
    const maxUint160 = (2n ** 160n) - 1n;
    const expiration = now + 86400 * 30;
    const permit2ApproveTx = await walletClient.writeContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [token, spender, maxUint160, expiration],
      chain: celo,
      account,
    });
    const p2Receipt = await publicClient.waitForTransactionReceipt({ hash: permit2ApproveTx });
    console.log(`[uniswap-v4] Permit2 approval tx: ${permit2ApproveTx} (status: ${p2Receipt.status}), expiry=${expiration} (${new Date(expiration * 1000).toISOString()})`);

    const verifyP2 = await publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [account.address, token, spender],
    });
    const verifiedAmount = BigInt(verifyP2[0]);
    const verifiedExpiry = Number(verifyP2[1]);
    if (verifiedAmount < amount || verifiedExpiry < now) {
      throw new Error(`Permit2 approval verification failed for ${tokenShort}...: amount=${formatUnits(verifiedAmount, 18)}, expiry=${verifiedExpiry}`);
    }
    console.log(`[uniswap-v4] Permit2 verified OK: ${tokenShort}... → ${spenderShort}...`);
  } else {
    console.log(`[uniswap-v4] Permit2 allowance valid for ${tokenShort}... (${Math.floor((permit2Expiry - now) / 3600)}h remaining)`);
  }
}

function decodePositionInfo(info: bigint): { hasSubscriber: boolean; tickLower: number; tickUpper: number; poolId: `0x${string}` } {
  const poolId = ('0x' + (info >> 32n).toString(16).padStart(50, '0')) as `0x${string}`;
  const tickUpper = Number((info >> 8n) & 0xFFFFFFn) - 8388608;
  const tickLower = Number((info >> 32n) & 0xFFFFFFn) - 8388608;
  const hasSubscriber = (info & 1n) === 1n;
  return { hasSubscriber, tickLower, tickUpper, poolId };
}

export async function collectFees(positionTokenId: bigint): Promise<CollectFeesResult> {
  try {
    const account = getAccount();
    const walletClient = getWalletClient();

    const [poolKey] = await publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [positionTokenId],
    });

    const actions = encodePacked(
      ['uint8', 'uint8'],
      [V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR]
    );

    const decreaseParams = encodeAbiParameters(
      parseAbiParameters('uint256, uint256, uint128, uint128, bytes'),
      [positionTokenId, 0n, 0n, 0n, '0x']
    );

    const takePairParams = encodeAbiParameters(
      parseAbiParameters('address, address, address'),
      [poolKey.currency0, poolKey.currency1, account.address]
    );

    const unlockData = encodeAbiParameters(
      parseAbiParameters('bytes, bytes[]'),
      [actions, [decreaseParams, takePairParams]]
    );

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const txHash = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline],
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
    console.error('[uniswap-v4] collectFees error:', error);
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

    const { token0, token1 } = sortTokens(tokenIn, tokenOut, 0n, 0n);
    const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();

    const tickSpacing = TICK_SPACINGS[fee] || 60;

    if (!isCeloNative) {
      await ensurePermit2Approval(tokenIn as `0x${string}`, UNIVERSAL_ROUTER, amountInWei);
    }

    const swapActions = encodePacked(
      ['uint8', 'uint8', 'uint8'],
      [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
    );

    const poolKey = {
      currency0: token0,
      currency1: token1,
      fee,
      tickSpacing,
      hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    };

    const minAmountOut = amountInWei * 95n / 100n;

    const swapParams = encodeAbiParameters(
      parseAbiParameters('(address, address, uint24, int24, address), bool, uint128, uint128, bytes'),
      [
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
        zeroForOne,
        amountInWei,
        minAmountOut,
        '0x',
      ]
    );

    const settleParams = encodeAbiParameters(
      parseAbiParameters('address, uint256'),
      [tokenIn as `0x${string}`, amountInWei]
    );

    const takeParams = encodeAbiParameters(
      parseAbiParameters('address, uint256'),
      [tokenOut as `0x${string}`, minAmountOut]
    );

    const v4SwapInput = encodeAbiParameters(
      parseAbiParameters('bytes, bytes[]'),
      [swapActions, [swapParams, settleParams, takeParams]]
    );

    const commands = encodePacked(['uint8'], [COMMANDS.V4_SWAP]);

    const txHash = await walletClient.writeContract({
      address: UNIVERSAL_ROUTER,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, [v4SwapInput], deadline],
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
    console.error('[uniswap-v4] swapExactInput error:', error);
    return { success: false, error: error.message || 'Failed to swap tokens' };
  }
}

export async function createPoolAndAddLiquidity(params: CreatePoolParams): Promise<CreatePoolResult> {
  try {
    const { tokenA, tokenB, amountA, amountB, feeTier = 10000, privateKey: overrideKey } = params;
    const account = overrideKey
      ? privateKeyToAccount(overrideKey as `0x${string}`)
      : getAccount();
    const walletClient = overrideKey
      ? createWalletClient({ account, chain: celo, transport: http(CELO_RPC) })
      : getWalletClient();
    const amountAWei = parseUnits(amountA, 18);
    const amountBWei = parseUnits(amountB, 18);
    const { token0, token1, amount0, amount1 } = sortTokens(tokenA, tokenB, amountAWei, amountBWei);
    const sqrtPriceX96 = calculateSqrtPriceX96(amount0, amount1);

    const tickSpacing = TICK_SPACINGS[feeTier] || 200;
    const poolKey = {
      currency0: token0,
      currency1: token1,
      fee: feeTier,
      tickSpacing,
      hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    };

    const poolId = computePoolId(token0, token1, feeTier, tickSpacing);
    let poolAlreadyExists = false;

    try {
      const existingState = await getPoolState(poolId as `0x${string}`);
      const existingSqrtPrice = BigInt(existingState.sqrtPriceX96);
      if (existingSqrtPrice > 0n) {
        poolAlreadyExists = true;
        console.log(`[uniswap-v4] Pool already initialized, skipping initialize. poolId=${poolId}, sqrtPriceX96=${existingState.sqrtPriceX96}, tick=${existingState.tick}`);
      }
    } catch (_checkErr: any) {
    }

    if (!poolAlreadyExists) {
      console.log(`[uniswap-v4] Initializing new pool: ${token0} / ${token1}, fee=${feeTier}, sqrtPriceX96=${sqrtPriceX96}`);
      try {
        const initTx = await walletClient.writeContract({
          address: POOL_MANAGER,
          abi: POOL_MANAGER_ABI,
          functionName: 'initialize',
          args: [poolKey, sqrtPriceX96],
        });
        const initReceipt = await publicClient.waitForTransactionReceipt({ hash: initTx });
        if (initReceipt.status === 'reverted') {
          return { success: false, error: `Pool initialize transaction reverted: ${initTx}` };
        }
        console.log(`[uniswap-v4] Pool initialized: ${initTx}`);
      } catch (initErr: any) {
        const msg = (initErr.message || '') + (initErr.shortMessage || '');
        if (msg.includes('PoolAlreadyInitialized') || msg.includes('already initialized')) {
          console.log('[uniswap-v4] Pool already initialized (caught during init), continuing...');
        } else {
          return { success: false, error: `Pool initialization failed: ${initErr.shortMessage || initErr.message}` };
        }
      }
    }

    const isCeloToken0 = token0.toLowerCase() === CELO_NATIVE.toLowerCase();
    const isCeloToken1 = token1.toLowerCase() === CELO_NATIVE.toLowerCase();

    const amount0Max = amount0 + (amount0 * 10n / 100n);
    const amount1Max = amount1 + (amount1 * 10n / 100n);

    console.log(`[uniswap-v4] Approving tokens via Permit2... amount0Max=${formatUnits(amount0Max, 18)}, amount1Max=${formatUnits(amount1Max, 18)}`);
    console.log(`[uniswap-v4] Wallet: ${account.address}, token0=${token0}, token1=${token1}`);
    console.log(`[uniswap-v4] isCeloToken0=${isCeloToken0}, isCeloToken1=${isCeloToken1}`);

    if (!isCeloToken0) {
      await ensurePermit2Approval(token0, POSITION_MANAGER, amount0Max, account, walletClient, true);
    }
    if (!isCeloToken1) {
      await ensurePermit2Approval(token1, POSITION_MANAGER, amount1Max, account, walletClient, true);
    }

    console.log(`[uniswap-v4] All approvals set. Verifying final state before modifyLiquidities...`);
    const preflightErrors: string[] = [];
    for (const [label, tkn, amt] of [['token0', token0, amount0Max], ['token1', token1, amount1Max]] as const) {
      if (tkn.toLowerCase() === CELO_NATIVE.toLowerCase()) continue;
      const bal = await publicClient.readContract({ address: tkn, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as bigint;
      const erc20 = await publicClient.readContract({ address: tkn, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, PERMIT2] }) as bigint;
      const p2 = await publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, tkn, POSITION_MANAGER] });
      const p2Amt = BigInt(p2[0]);
      const p2Exp = Number(p2[1]);
      const now = Math.floor(Date.now() / 1000);
      console.log(`[uniswap-v4] FINAL CHECK ${label} (${tkn.substring(0,10)}...): balance=${formatUnits(bal, 18)}, erc20→Permit2=${erc20 > 10n**30n ? 'MAX' : formatUnits(erc20, 18)}, permit2→PM: amt=${p2Amt > 10n**30n ? 'MAX' : formatUnits(p2Amt, 18)}, exp=${p2Exp} (${p2Exp > now ? 'valid' : 'EXPIRED'}), needed=${formatUnits(amt, 18)}`);
      if (bal < amt) preflightErrors.push(`${label} balance insufficient: has ${formatUnits(bal, 18)}, needs ${formatUnits(amt, 18)}`);
      if (erc20 < amt) preflightErrors.push(`${label} ERC-20 allowance to Permit2 insufficient`);
      if (p2Amt < amt) preflightErrors.push(`${label} Permit2 allowance to PositionManager insufficient`);
      if (p2Exp <= now) preflightErrors.push(`${label} Permit2 allowance EXPIRED (exp=${p2Exp}, now=${now})`);
    }
    if (preflightErrors.length > 0) {
      const errMsg = `Pre-flight check failed: ${preflightErrors.join('; ')}`;
      console.error(`[uniswap-v4] ${errMsg}`);
      return { success: false, error: errMsg };
    }
    console.log(`[uniswap-v4] Pre-flight checks passed.`);

    const { tickLower, tickUpper } = getFullRangeTicks(feeTier);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const liquidity = calculateLiquidityForFullRange(sqrtPriceX96, amount0, amount1, tickLower, tickUpper);

    console.log(`[uniswap-v4] Minting position: liquidity=${liquidity}, ticks=[${tickLower}, ${tickUpper}]`);

    const actions = encodePacked(
      ['uint8', 'uint8', 'uint8', 'uint8'],
      [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR, V4_ACTIONS.CLOSE_CURRENCY, V4_ACTIONS.CLOSE_CURRENCY]
    );

    const mintParams = encodeAbiParameters(
      parseAbiParameters('(address, address, uint24, int24, address), int24, int24, uint256, uint128, uint128, address, bytes'),
      [
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
        tickLower,
        tickUpper,
        liquidity,
        amount0Max,
        amount1Max,
        account.address,
        '0x',
      ]
    );

    const settlePairParams = encodeAbiParameters(
      parseAbiParameters('address, address'),
      [token0, token1]
    );

    const closeCurrency0Params = encodeAbiParameters(
      parseAbiParameters('address'),
      [token0]
    );

    const closeCurrency1Params = encodeAbiParameters(
      parseAbiParameters('address'),
      [token1]
    );

    const unlockData = encodeAbiParameters(
      parseAbiParameters('bytes, bytes[]'),
      [actions, [mintParams, settlePairParams, closeCurrency0Params, closeCurrency1Params]]
    );

    const celoValue = isCeloToken0 ? amount0Max : isCeloToken1 ? amount1Max : 0n;

    try {
      await publicClient.simulateContract({
        address: POSITION_MANAGER,
        abi: POSITION_MANAGER_ABI,
        functionName: 'modifyLiquidities',
        args: [unlockData, deadline],
        value: celoValue,
        account: account.address,
      });
      console.log('[uniswap-v4] Simulation passed, sending transaction...');
    } catch (simErr: any) {
      console.error('[uniswap-v4] Simulation failed:', simErr.message?.substring(0, 500));
      const details = simErr.cause?.data || simErr.data || simErr.shortMessage || '';
      console.error('[uniswap-v4] Revert details:', typeof details === 'object' ? JSON.stringify(details) : String(details).substring(0, 500));
      return { success: false, error: `Pool creation simulation failed: ${simErr.shortMessage || simErr.message}` };
    }

    const mintTxHash = await walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline],
      value: celoValue,
    });

    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTxHash });

    if (mintReceipt.status === 'reverted') {
      return { success: false, error: `Mint transaction reverted: ${mintTxHash}` };
    }

    console.log(`[uniswap-v4] Position minted successfully: ${mintTxHash}`);

    return {
      success: true,
      txHash: mintTxHash,
      amount0: formatUnits(amount0, 18),
      amount1: formatUnits(amount1, 18),
      receipt: mintReceipt,
    };
  } catch (error: any) {
    console.error('[uniswap-v4] createPoolAndAddLiquidity error:', error.message?.substring(0, 500));
    const details = error.cause?.data || error.data || error.shortMessage || '';
    console.error('[uniswap-v4] Error details:', typeof details === 'object' ? JSON.stringify(details) : String(details).substring(0, 500));
    return { success: false, error: error.shortMessage || error.message || 'Failed to create pool and add liquidity' };
  }
}

export async function getPosition(positionTokenId: bigint): Promise<PositionInfo> {
  const [poolKey, info] = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'getPoolAndPositionInfo',
    args: [positionTokenId],
  });

  const liquidity = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'getPositionLiquidity',
    args: [positionTokenId],
  });

  const decoded = decodePositionInfo(info);

  return {
    token0: poolKey.currency0,
    token1: poolKey.currency1,
    fee: poolKey.fee,
    tickLower: decoded.tickLower,
    tickUpper: decoded.tickUpper,
    liquidity: liquidity.toString(),
  };
}

export async function getUncollectedFees(positionTokenId: bigint): Promise<{ token0Fees: string; token1Fees: string }> {
  try {
    const account = getAccount();

    const [poolKey] = await publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [positionTokenId],
    });

    const actions = encodePacked(
      ['uint8', 'uint8'],
      [V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR]
    );

    const decreaseParams = encodeAbiParameters(
      parseAbiParameters('uint256, uint256, uint128, uint128, bytes'),
      [positionTokenId, 0n, 0n, 0n, '0x']
    );

    const takePairParams = encodeAbiParameters(
      parseAbiParameters('address, address, address'),
      [poolKey.currency0, poolKey.currency1, account.address]
    );

    const unlockData = encodeAbiParameters(
      parseAbiParameters('bytes, bytes[]'),
      [actions, [decreaseParams, takePairParams]]
    );

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    await publicClient.simulateContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline],
      account: account.address,
    });

    return { token0Fees: '0', token1Fees: '0' };
  } catch (error: any) {
    console.error('[uniswap-v4] getUncollectedFees error:', error);
    return { token0Fees: '0', token1Fees: '0' };
  }
}

export function computePoolId(
  tokenA: string,
  tokenB: string,
  fee: number,
  tickSpacing: number,
  hooks: string = '0x0000000000000000000000000000000000000000'
): `0x${string}` {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  const currency0 = (a < b ? tokenA : tokenB) as `0x${string}`;
  const currency1 = (a < b ? tokenB : tokenA) as `0x${string}`;
  const encoded = encodeAbiParameters(
    parseAbiParameters('address, address, uint24, int24, address'),
    [currency0, currency1, fee, tickSpacing, hooks as `0x${string}`]
  );
  return keccak256(encoded);
}

export async function getNextPositionTokenId(): Promise<bigint> {
  const nextId = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'nextTokenId',
    args: [],
  });
  return nextId;
}

export function extractPositionTokenIdFromReceipt(receipt: any): string | null {
  const ERC721_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ZERO_ADDRESS_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

  for (const log of receipt.logs || []) {
    if (
      log.address?.toLowerCase() === POSITION_MANAGER.toLowerCase() &&
      log.topics?.length === 4 &&
      log.topics[0] === ERC721_TRANSFER_TOPIC &&
      log.topics[1] === ZERO_ADDRESS_TOPIC
    ) {
      return BigInt(log.topics[3]).toString();
    }
  }
  return null;
}

export async function collectAllFees(
  positionTokenIds: bigint[],
  overrideKey?: string
): Promise<{ success: boolean; collected: { tokenId: string; txHash: string }[]; errors: string[]; totalCollected: number }> {
  const collected: { tokenId: string; txHash: string }[] = [];
  const errors: string[] = [];

  for (const tokenId of positionTokenIds) {
    try {
      const result = await collectFees(tokenId);
      if (result.success && result.txHash) {
        collected.push({ tokenId: tokenId.toString(), txHash: result.txHash });
      } else if (!result.success) {
        errors.push(`Position ${tokenId}: ${result.error}`);
      }
    } catch (err: any) {
      errors.push(`Position ${tokenId}: ${err.message}`);
    }
  }

  return {
    success: collected.length > 0 || errors.length === 0,
    collected,
    errors,
    totalCollected: collected.length,
  };
}

export async function getSelfclawBalance(overrideKey?: string): Promise<string> {
  const account = overrideKey
    ? privateKeyToAccount(overrideKey as `0x${string}`)
    : getAccount();

  const balance = await publicClient.readContract({
    address: WRAPPED_SELFCLAW_CELO,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return formatUnits(balance, 18);
}

export async function getTokenBalance(tokenAddress: string, decimals: number = 18, overrideKey?: string): Promise<string> {
  const account = overrideKey
    ? privateKeyToAccount(overrideKey as `0x${string}`)
    : getAccount();

  const balance = await publicClient.readContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return formatUnits(balance, decimals);
}

export function getSponsorAddress(overrideKey?: string): string {
  const account = overrideKey
    ? privateKeyToAccount(overrideKey as `0x${string}`)
    : getAccount();
  return account.address;
}
