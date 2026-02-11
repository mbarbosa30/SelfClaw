import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, maxUint256 } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const CELO_RPC = 'https://forno.celo.org';
const WRAPPED_SELFCLAW_CELO = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb' as `0x${string}`;
const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;

const V3_FACTORY = '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc' as `0x${string}`;
const V3_POSITION_MANAGER = '0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A' as `0x${string}`;
const V3_SWAP_ROUTER = '0x5615CDAb10dc425a742d643d949a7F474C01abc4' as `0x${string}`;

export const SELFCLAW_CELO_V3_POOL = '0x2728F9cd10Ae89E071a05eF9e06562E00AF1125b' as `0x${string}`;

const MAX_UINT128 = (2n ** 128n) - 1n;

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
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

const V3_POSITION_MANAGER_ABI = [
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
      ],
    }],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
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
      ],
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
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
    ],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const V3_POOL_ABI = [
  {
    name: 'slot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    name: 'token0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'token1',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'liquidity',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    name: 'fee',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
  },
] as const;

const V3_FACTORY_ABI = [
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

function getAccount(privateKey?: string) {
  const key = privateKey || process.env.CELO_PRIVATE_KEY;
  if (!key) throw new Error('No private key configured');
  const formatted = key.startsWith('0x') ? key : `0x${key}`;
  return privateKeyToAccount(formatted as `0x${string}`);
}

function getWalletClient(privateKey?: string) {
  const account = getAccount(privateKey);
  return createWalletClient({
    account,
    chain: celo,
    transport: http(CELO_RPC),
  });
}

function sortTokens(tokenA: string, tokenB: string, amountA: bigint, amountB: bigint) {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a < b) {
    return { token0: tokenA as `0x${string}`, token1: tokenB as `0x${string}`, amount0: amountA, amount1: amountB };
  }
  return { token0: tokenB as `0x${string}`, token1: tokenA as `0x${string}`, amount0: amountB, amount1: amountA };
}

function calculateSqrtPriceX96(amount0: bigint, amount1: bigint): bigint {
  if (amount0 === 0n || amount1 === 0n) throw new Error('Amounts must be non-zero');
  const Q96 = 2n ** 96n;
  const ratio = (amount1 * Q96 * Q96) / amount0;
  return bigintSqrt(ratio);
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Square root of negative number');
  if (value === 0n) return 0n;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

function getFullRangeTicks(feeTier: number): { tickLower: number; tickUpper: number } {
  const tickSpacing = TICK_SPACINGS[feeTier] || 200;
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const tickLower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const tickUpper = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

export async function getSelfclawBalance(privateKey?: string): Promise<string> {
  const account = getAccount(privateKey);
  const balance = await publicClient.readContract({
    address: WRAPPED_SELFCLAW_CELO,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  return formatUnits(balance, 18);
}

export async function getTokenBalance(tokenAddress: string, decimals: number = 18, privateKey?: string): Promise<string> {
  const account = getAccount(privateKey);
  const balance = await publicClient.readContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  return formatUnits(balance, decimals);
}

export function getSponsorAddress(privateKey?: string): string {
  return getAccount(privateKey).address;
}

export async function getV3PoolState(poolAddress: string) {
  const [slot0Data, token0, token1, liquidity, fee] = await Promise.all([
    publicClient.readContract({ address: poolAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'slot0' }),
    publicClient.readContract({ address: poolAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: poolAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'token1' }),
    publicClient.readContract({ address: poolAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'liquidity' }),
    publicClient.readContract({ address: poolAddress as `0x${string}`, abi: V3_POOL_ABI, functionName: 'fee' }),
  ]);

  const [sqrtPriceX96, tick] = slot0Data as [bigint, number, number, number, number, number, boolean];

  const Q96 = 2n ** 96n;
  const priceRaw = Number(sqrtPriceX96) / Number(Q96);
  const price = (priceRaw * priceRaw).toFixed(18);

  return {
    poolAddress,
    token0: token0 as string,
    token1: token1 as string,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(tick),
    fee: Number(fee),
    liquidity: liquidity.toString(),
    price,
  };
}

export async function getOwnedV3PositionIds(privateKey?: string): Promise<bigint[]> {
  const account = getAccount(privateKey);
  const balance = await publicClient.readContract({
    address: V3_POSITION_MANAGER,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const count = Number(balance);
  const ids: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const tokenId = await publicClient.readContract({
      address: V3_POSITION_MANAGER,
      abi: V3_POSITION_MANAGER_ABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [account.address, BigInt(i)],
    });
    ids.push(tokenId);
  }
  return ids;
}

export async function getV3PositionInfo(tokenId: bigint) {
  const result = await publicClient.readContract({
    address: V3_POSITION_MANAGER,
    abi: V3_POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  });

  const [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = result;

  return {
    tokenId: tokenId.toString(),
    token0,
    token1,
    fee: Number(fee),
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    liquidity: liquidity.toString(),
    tokensOwed0: formatUnits(tokensOwed0, 18),
    tokensOwed1: formatUnits(tokensOwed1, 18),
  };
}

export async function collectV3Fees(tokenId: bigint, privateKey?: string): Promise<{
  success: boolean;
  amount0: string;
  amount1: string;
  txHash?: string;
  error?: string;
}> {
  try {
    const account = getAccount(privateKey);
    const walletClient = getWalletClient(privateKey);

    const txHash = await walletClient.writeContract({
      address: V3_POSITION_MANAGER,
      abi: V3_POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{
        tokenId,
        recipient: account.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, amount0: '0', amount1: '0', error: 'Collect transaction reverted' };
    }

    const posInfo = await getV3PositionInfo(tokenId);
    console.log(`[uniswap-v3] Collected fees from position ${tokenId}, tx: ${txHash}`);

    return {
      success: true,
      amount0: posInfo.tokensOwed0,
      amount1: posInfo.tokensOwed1,
      txHash,
    };
  } catch (error: any) {
    console.error('[uniswap-v3] collectV3Fees error:', error);
    return { success: false, amount0: '0', amount1: '0', error: error.message };
  }
}

export async function collectAllV3Fees(privateKey?: string): Promise<{
  success: boolean;
  collected: Array<{ tokenId: string; amount0: string; amount1: string; txHash?: string }>;
  totalSelfclaw: string;
  totalCelo: string;
  error?: string;
}> {
  try {
    const positionIds = await getOwnedV3PositionIds(privateKey);
    if (positionIds.length === 0) {
      return { success: true, collected: [], totalSelfclaw: '0', totalCelo: '0' };
    }

    const collected: Array<{ tokenId: string; amount0: string; amount1: string; txHash?: string }> = [];
    let totalToken0 = 0;
    let totalToken1 = 0;

    for (const tokenId of positionIds) {
      const posInfo = await getV3PositionInfo(tokenId);

      const isSelfclawPool =
        posInfo.token0.toLowerCase() === WRAPPED_SELFCLAW_CELO.toLowerCase() ||
        posInfo.token1.toLowerCase() === WRAPPED_SELFCLAW_CELO.toLowerCase();

      if (!isSelfclawPool) continue;

      const result = await collectV3Fees(tokenId, privateKey);
      if (result.success) {
        collected.push({
          tokenId: tokenId.toString(),
          amount0: result.amount0,
          amount1: result.amount1,
          txHash: result.txHash,
        });
        totalToken0 += parseFloat(result.amount0);
        totalToken1 += parseFloat(result.amount1);
      }
    }

    const firstPos = positionIds.length > 0 ? await getV3PositionInfo(positionIds[0]) : null;
    const selfclawIsToken0 = firstPos && firstPos.token0.toLowerCase() === WRAPPED_SELFCLAW_CELO.toLowerCase();

    return {
      success: true,
      collected,
      totalSelfclaw: selfclawIsToken0 ? totalToken0.toString() : totalToken1.toString(),
      totalCelo: selfclawIsToken0 ? totalToken1.toString() : totalToken0.toString(),
    };
  } catch (error: any) {
    console.error('[uniswap-v3] collectAllV3Fees error:', error);
    return { success: false, collected: [], totalSelfclaw: '0', totalCelo: '0', error: error.message };
  }
}

async function ensureApproval(token: string, spender: string, amount: bigint, privateKey?: string) {
  const account = getAccount(privateKey);
  const walletClient = getWalletClient(privateKey);

  const currentAllowance = await publicClient.readContract({
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, spender as `0x${string}`],
  });

  if (currentAllowance < amount) {
    const approveTx = await walletClient.writeContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as `0x${string}`, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`[uniswap-v3] Approved ${token} for ${spender}`);
  }
}

export interface CreateV3PoolResult {
  success: boolean;
  poolAddress?: string;
  positionTokenId?: string;
  txHash?: string;
  amount0?: string;
  amount1?: string;
  error?: string;
}

export async function createV3PoolAndAddLiquidity(params: {
  tokenA: string;
  tokenB: string;
  amountA: string;
  amountB: string;
  feeTier?: number;
  privateKey?: string;
}): Promise<CreateV3PoolResult> {
  try {
    const { tokenA, tokenB, amountA, amountB, feeTier = 10000, privateKey } = params;
    const account = getAccount(privateKey);
    const walletClient = getWalletClient(privateKey);

    let decimalsA = 18;
    let decimalsB = 18;
    try {
      const [dA, dB] = await Promise.all([
        publicClient.readContract({ address: tokenA as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }),
        publicClient.readContract({ address: tokenB as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }),
      ]);
      decimalsA = Number(dA);
      decimalsB = Number(dB);
    } catch {
      console.log('[uniswap-v3] Could not read token decimals, defaulting to 18');
    }

    const amountAWei = parseUnits(amountA, decimalsA);
    const amountBWei = parseUnits(amountB, decimalsB);
    const { token0, token1, amount0, amount1 } = sortTokens(tokenA, tokenB, amountAWei, amountBWei);
    const sqrtPriceX96 = calculateSqrtPriceX96(amount0, amount1);

    const dec0 = token0.toLowerCase() === tokenA.toLowerCase() ? decimalsA : decimalsB;
    const dec1 = token1.toLowerCase() === tokenA.toLowerCase() ? decimalsA : decimalsB;
    console.log(`[uniswap-v3] Creating pool: ${token0}/${token1}, fee=${feeTier}, amounts=${formatUnits(amount0, dec0)}/${formatUnits(amount1, dec1)}, decimals=${dec0}/${dec1}`);

    const poolAddress = await walletClient.writeContract({
      address: V3_POSITION_MANAGER,
      abi: V3_POSITION_MANAGER_ABI,
      functionName: 'createAndInitializePoolIfNecessary',
      args: [token0, token1, feeTier, sqrtPriceX96],
    });

    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: poolAddress });
    console.log(`[uniswap-v3] Pool created/initialized, tx: ${poolAddress}`);

    const existingPool = await publicClient.readContract({
      address: V3_FACTORY,
      abi: V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [token0, token1, feeTier],
    });

    await ensureApproval(token0, V3_POSITION_MANAGER, amount0, privateKey);
    await ensureApproval(token1, V3_POSITION_MANAGER, amount1, privateKey);

    const { tickLower, tickUpper } = getFullRangeTicks(feeTier);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

    const mintTxHash = await walletClient.writeContract({
      address: V3_POSITION_MANAGER,
      abi: V3_POSITION_MANAGER_ABI,
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
    });

    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTxHash });

    if (mintReceipt.status === 'reverted') {
      return { success: false, error: 'Mint transaction reverted' };
    }

    const transferLog = mintReceipt.logs.find(
      (log: any) => log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
        log.address.toLowerCase() === V3_POSITION_MANAGER.toLowerCase()
    );
    const positionTokenId = transferLog ? BigInt(transferLog.topics[3] || '0').toString() : undefined;

    console.log(`[uniswap-v3] Position minted, tokenId=${positionTokenId}, tx: ${mintTxHash}`);

    return {
      success: true,
      poolAddress: existingPool as string,
      positionTokenId,
      txHash: mintTxHash,
      amount0: formatUnits(amount0, 18),
      amount1: formatUnits(amount1, 18),
    };
  } catch (error: any) {
    console.error('[uniswap-v3] createV3PoolAndAddLiquidity error:', error);
    return { success: false, error: error.message || 'Failed to create V3 pool' };
  }
}

export async function getExistingV3Pool(tokenA: string, tokenB: string, feeTier: number = 10000): Promise<string | null> {
  try {
    const pool = await publicClient.readContract({
      address: V3_FACTORY,
      abi: V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenA as `0x${string}`, tokenB as `0x${string}`, feeTier],
    });
    const addr = pool as string;
    if (addr === '0x0000000000000000000000000000000000000000') return null;
    return addr;
  } catch {
    return null;
  }
}
