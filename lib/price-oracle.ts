import { createPublicClient, http, formatUnits } from 'viem';
import { celo } from 'viem/chains';

const CELO_RPC = 'https://forno.celo.org';

const SELFCLAW_TOKEN = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb' as `0x${string}`;
const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;

const STATE_VIEW = '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb' as `0x${string}`;

const SELFCLAW_CELO_V4_POOL_ID = '0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b' as `0x${string}`;
const SELFCLAW_USDT_V4_POOL_ID = '0xaa6bb69189b81c0d19e492128d890b2851aae2130f1ba05744db22ebd08d84f9' as `0x${string}`;
const CELO_USDT_V3_POOL = '0x6cde5f5a192fBf3fD84df983aa6DC30dbd9f8Fac' as `0x${string}`;

const Q96 = 2n ** 96n;

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

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
] as const;

const ERC20_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

function sqrtPriceToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const Q192 = 2n ** 192n;
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const PRECISION = 10n ** 18n;
  const scaledPrice = (numerator * PRECISION) / Q192;
  const price = Number(scaledPrice) / 1e18;
  const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
  return price * decimalAdjustment;
}

interface PriceCache {
  celoUsd: number;
  selfclawCelo: number;
  selfclawUsd: number;
  timestamp: number;
}

let priceCache: PriceCache | null = null;
const CACHE_TTL = 60_000;

export async function getCeloUsdPrice(): Promise<number> {
  try {
    const [slot0Data, token0, token1] = await Promise.all([
      publicClient.readContract({ address: CELO_USDT_V3_POOL, abi: V3_POOL_ABI, functionName: 'slot0' }),
      publicClient.readContract({ address: CELO_USDT_V3_POOL, abi: V3_POOL_ABI, functionName: 'token0' }),
      publicClient.readContract({ address: CELO_USDT_V3_POOL, abi: V3_POOL_ABI, functionName: 'token1' }),
    ]);

    const sqrtPriceX96 = slot0Data[0];
    const celoLower = CELO_NATIVE.toLowerCase();
    const t0Lower = (token0 as string).toLowerCase();

    const isCeloToken0 = t0Lower === celoLower;

    const dec0 = isCeloToken0 ? 18 : 6;
    const dec1 = isCeloToken0 ? 6 : 18;

    let price = sqrtPriceToPrice(sqrtPriceX96, dec0, dec1);

    if (!isCeloToken0) {
      price = price > 0 ? 1 / price : 0;
    }

    return price;
  } catch (error: any) {
    console.error('[price-oracle] Failed to get CELO/USD price:', error.message);
    return 0;
  }
}

export async function getSelfclawCeloPrice(): Promise<number> {
  try {
    const slot0Result = await publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [SELFCLAW_CELO_V4_POOL_ID],
    });

    const sqrtPriceX96 = slot0Result[0];

    const selfclawLower = SELFCLAW_TOKEN.toLowerCase();
    const celoLower = CELO_NATIVE.toLowerCase();
    const isSelfclawToken0 = selfclawLower < celoLower;

    let price = sqrtPriceToPrice(sqrtPriceX96, 18, 18);

    if (isSelfclawToken0) {
      return price;
    } else {
      return price > 0 ? 1 / price : 0;
    }
  } catch (error: any) {
    console.error('[price-oracle] Failed to get SELFCLAW/CELO price:', error.message);
    return 0;
  }
}

export async function getReferencePrices(): Promise<PriceCache> {
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_TTL) {
    return priceCache;
  }

  const [celoUsd, selfclawCelo] = await Promise.all([
    getCeloUsdPrice(),
    getSelfclawCeloPrice(),
  ]);

  const selfclawUsd = selfclawCelo * celoUsd;

  priceCache = {
    celoUsd,
    selfclawCelo,
    selfclawUsd,
    timestamp: Date.now(),
  };

  return priceCache;
}

const decimalsCache: Record<string, number> = {};
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const key = tokenAddress.toLowerCase();
  if (decimalsCache[key] !== undefined) return decimalsCache[key];
  try {
    const dec = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    decimalsCache[key] = Number(dec);
    return decimalsCache[key];
  } catch {
    return 18;
  }
}

export async function getV4PoolPrice(poolId: `0x${string}`, tokenAddress: string, pairedWith: string): Promise<{ price: number; liquidity: string }> {
  try {
    const [slot0Result, liquidityResult, tokenDec, pairedDec] = await Promise.all([
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
      getTokenDecimals(tokenAddress),
      getTokenDecimals(pairedWith),
    ]);

    const sqrtPriceX96 = slot0Result[0];
    const liquidity = liquidityResult;

    const tokenLower = tokenAddress.toLowerCase();
    const pairedLower = pairedWith.toLowerCase();
    const isTokenToken0 = tokenLower < pairedLower;

    const dec0 = isTokenToken0 ? tokenDec : pairedDec;
    const dec1 = isTokenToken0 ? pairedDec : tokenDec;

    let price = sqrtPriceToPrice(sqrtPriceX96, dec0, dec1);

    if (!isTokenToken0) {
      price = price > 0 ? 1 / price : 0;
    }

    return { price, liquidity: liquidity.toString() };
  } catch (error: any) {
    console.error('[price-oracle] Failed to get V4 pool price for', tokenAddress, ':', error.message);
    return { price: 0, liquidity: '0' };
  }
}

export interface AgentTokenPrice {
  tokenAddress: string;
  tokenSymbol: string;
  priceInSelfclaw: number;
  priceInCelo: number;
  priceInUsd: number;
  marketCapUsd: number;
  marketCapCelo: number;
  totalSupply: string;
  liquidity: string;
  poolId: string;
}

export async function getAgentTokenPrice(
  tokenAddress: string,
  poolId: string,
  tokenSymbol: string,
): Promise<AgentTokenPrice | null> {
  try {
    const [poolData, refPrices, totalSupplyRaw, decimals] = await Promise.all([
      getV4PoolPrice(poolId as `0x${string}`, tokenAddress, SELFCLAW_TOKEN),
      getReferencePrices(),
      publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
      }),
      publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ]);

    const totalSupply = Number(formatUnits(totalSupplyRaw, decimals));
    const priceInSelfclaw = poolData.price;
    const priceInCelo = priceInSelfclaw * refPrices.selfclawCelo;
    const priceInUsd = priceInSelfclaw * refPrices.selfclawUsd;
    const marketCapUsd = priceInUsd * totalSupply;
    const marketCapCelo = priceInCelo * totalSupply;

    return {
      tokenAddress,
      tokenSymbol,
      priceInSelfclaw,
      priceInCelo,
      priceInUsd,
      marketCapUsd,
      marketCapCelo,
      totalSupply: totalSupply.toString(),
      liquidity: poolData.liquidity,
      poolId,
    };
  } catch (error: any) {
    console.error('[price-oracle] Failed to get agent token price:', error.message);
    return null;
  }
}

export async function getAllAgentTokenPrices(
  pools: Array<{ tokenAddress: string; v4PoolId: string | null; poolAddress: string; tokenSymbol: string; poolVersion: string | null }>
): Promise<AgentTokenPrice[]> {
  const results: AgentTokenPrice[] = [];

  for (const pool of pools) {
    const poolId = pool.v4PoolId || pool.poolAddress;
    if (!poolId || poolId.length < 42) continue;

    try {
      const price = await getAgentTokenPrice(pool.tokenAddress, poolId, pool.tokenSymbol);
      if (price) {
        results.push(price);
      }
    } catch (err: any) {
      console.error('[price-oracle] Skipping pool for', pool.tokenSymbol, ':', err.message);
    }
  }

  return results;
}

export function formatPrice(price: number, maxDecimals: number = 6): string {
  if (price === 0) return '0';
  if (price < 0.000001) return price.toExponential(2);
  if (price < 0.01) return price.toFixed(maxDecimals);
  if (price < 1) return price.toFixed(4);
  if (price < 1000) return price.toFixed(2);
  return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatMarketCap(value: number): string {
  if (value === 0) return '$0';
  if (value < 1000) return '$' + value.toFixed(2);
  if (value < 1_000_000) return '$' + (value / 1000).toFixed(1) + 'K';
  if (value < 1_000_000_000) return '$' + (value / 1_000_000).toFixed(2) + 'M';
  return '$' + (value / 1_000_000_000).toFixed(2) + 'B';
}
