import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { verifiedBots, agentWallets, trackedPools } from "../shared/schema.js";
import { eq, sql } from "drizzle-orm";
import { createPublicClient, http, fallback, parseUnits, formatUnits, encodePacked, encodeAbiParameters, parseAbiParameters, keccak256, encodeFunctionData, type Address } from "viem";
import { celo } from "viem/chains";

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, token0Decimals: number, token1Decimals: number): { token0Per1: number; token1Per0: number } {
  const Q96 = 2n ** 96n;
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const denominator = Q96 * Q96;
  const PRECISION = 10n ** 18n;
  const rawPrice = (numerator * PRECISION) / denominator;
  const decimalAdjust = 10 ** (token0Decimals - token1Decimals);
  const token1Per0 = Number(rawPrice) / 1e18 * decimalAdjust;
  const token0Per1 = token1Per0 > 0 ? 1 / token1Per0 : 0;
  return { token0Per1, token1Per0 };
}

function estimateSwapOutput(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  feeBps: number,
  _decimalsIn: number,
  _decimalsOut: number,
): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const Q96 = 2n ** 96n;
  const feeMultiplier = 10000n - BigInt(feeBps);
  const amountInAfterFee = (amountIn * feeMultiplier) / 10000n;

  if (zeroForOne) {
    return (amountInAfterFee * sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
  } else {
    return (amountInAfterFee * Q96 * Q96) / (sqrtPriceX96 * sqrtPriceX96);
  }
}

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const d = await publicClient.readContract({
      address: tokenAddress as Address,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    return Number(d);
  } catch {
    return 18;
  }
}

async function getPoolSlot0(poolId: string): Promise<{ sqrtPriceX96: bigint; tick: number; lpFee: number }> {
  try {
    const slot0 = await publicClient.readContract({
      address: V4_CONTRACTS.STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId as `0x${string}`],
    });
    return {
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
      lpFee: Number(slot0[3]),
    };
  } catch {
    return { sqrtPriceX96: 0n, tick: 0, lpFee: 0 };
  }
}

const router = Router();

const WRAPPED_SELFCLAW_CELO = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb' as `0x${string}`;
const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;
const CELO_RPC_PRIMARY = 'https://forno.celo.org';
const CELO_RPC_FALLBACK = 'https://rpc.ankr.com/celo';

const V4_CONTRACTS = {
  POOL_MANAGER: '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC' as `0x${string}`,
  POSITION_MANAGER: '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9' as `0x${string}`,
  UNIVERSAL_ROUTER: '0xcb695bc5d3aa22cad1e6df07801b061a05a0233a' as `0x${string}`,
  STATE_VIEW: '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb' as `0x${string}`,
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`,
};

const SELFCLAW_CELO_POOL_ID = '0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b' as `0x${string}`;

const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
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
  transport: fallback([
    http(CELO_RPC_PRIMARY, { timeout: 15_000, retryCount: 1 }),
    http(CELO_RPC_FALLBACK, { timeout: 15_000, retryCount: 1 }),
  ]),
});

const STATE_VIEW_ABI = [
  {
    name: 'getSlot0',
    type: 'function',
    stateMutability: 'view' as const,
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
    stateMutability: 'view' as const,
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const;

const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable' as const, inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view' as const, inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view' as const, inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const PERMIT2_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable' as const, inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  { name: 'execute', type: 'function', stateMutability: 'payable' as const, inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
] as const;

const swapLimiter = rateLimit({
  windowMs: 60000,
  max: 30,
  message: { error: "Too many swap requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

async function authenticateAgent(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <api_key>" });
    }
    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) {
      return res.status(401).json({ error: "API key is empty" });
    }
    const [agent] = await db.select().from(verifiedBots).where(eq(verifiedBots.apiKey, apiKey)).limit(1);
    if (!agent) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    (req as any).agent = agent;
    next();
  } catch (error: any) {
    console.error("[swap-api] Auth error:", error.message);
    res.status(500).json({ error: "Authentication failed" });
  }
}

function sortTokens(tokenA: string, tokenB: string): { token0: `0x${string}`; token1: `0x${string}` } {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a < b) {
    return { token0: tokenA as `0x${string}`, token1: tokenB as `0x${string}` };
  }
  return { token0: tokenB as `0x${string}`, token1: tokenA as `0x${string}` };
}

function computePoolId(tokenA: string, tokenB: string, fee: number, tickSpacing: number): `0x${string}` {
  const { token0, token1 } = sortTokens(tokenA, tokenB);
  const hooks = '0x0000000000000000000000000000000000000000' as `0x${string}`;
  const encoded = encodeAbiParameters(
    parseAbiParameters('address, address, uint24, int24, address'),
    [token0, token1, fee, tickSpacing, hooks]
  );
  return keccak256(encoded);
}

router.get("/v1/agent-api/swap/pools", swapLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const allPools = await db.select().from(trackedPools);

    const pools = await Promise.all(allPools.map(async (p) => {
      let liquidity = '0';
      let sqrtPriceX96Str = '0';
      let price: { tokenPerSelfclaw: number; selfclawPerToken: number } | null = null;
      try {
        const [slot0, liq] = await Promise.all([
          publicClient.readContract({ address: V4_CONTRACTS.STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [p.poolAddress as `0x${string}`] }),
          publicClient.readContract({ address: V4_CONTRACTS.STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [p.poolAddress as `0x${string}`] }),
        ]);
        sqrtPriceX96Str = slot0[0].toString();
        liquidity = liq.toString();

        if (slot0[0] > 0n) {
          const { token0 } = sortTokens(p.tokenAddress, WRAPPED_SELFCLAW_CELO);
          const tokenIsToken0 = token0.toLowerCase() === p.tokenAddress.toLowerCase();
          const tokenDecimals = await getTokenDecimals(p.tokenAddress);
          const selfclawDecimals = 18;
          const t0Dec = tokenIsToken0 ? tokenDecimals : selfclawDecimals;
          const t1Dec = tokenIsToken0 ? selfclawDecimals : tokenDecimals;
          const { token0Per1, token1Per0 } = sqrtPriceX96ToPrice(slot0[0], t0Dec, t1Dec);
          price = {
            tokenPerSelfclaw: tokenIsToken0 ? token0Per1 : token1Per0,
            selfclawPerToken: tokenIsToken0 ? token1Per0 : token0Per1,
          };
        }
      } catch {}

      return {
        poolId: p.poolAddress,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        pairedWith: "SELFCLAW",
        pairedTokenAddress: WRAPPED_SELFCLAW_CELO,
        feeTier: p.feeTier || 10000,
        tickSpacing: TICK_SPACINGS[p.feeTier || 10000] || 200,
        liquidity,
        sqrtPriceX96: sqrtPriceX96Str,
        price,
        hasLiquidity: liquidity !== '0',
      };
    }));

    res.json({
      v4Contracts: {
        chainId: 42220,
        chain: "Celo Mainnet",
        poolManager: V4_CONTRACTS.POOL_MANAGER,
        universalRouter: V4_CONTRACTS.UNIVERSAL_ROUTER,
        stateView: V4_CONTRACTS.STATE_VIEW,
        positionManager: V4_CONTRACTS.POSITION_MANAGER,
        permit2: V4_CONTRACTS.PERMIT2,
      },
      coreTokens: {
        SELFCLAW: WRAPPED_SELFCLAW_CELO,
        CELO: CELO_NATIVE,
      },
      corePools: await (async () => {
        let corePrice: { celoPerSelfclaw: number; selfclawPerCelo: number } | null = null;
        let coreSqrtPriceX96 = '0';
        try {
          const coreSlot0 = await getPoolSlot0(SELFCLAW_CELO_POOL_ID);
          if (coreSlot0.sqrtPriceX96 > 0n) {
            coreSqrtPriceX96 = coreSlot0.sqrtPriceX96.toString();
            const { token0 } = sortTokens(CELO_NATIVE, WRAPPED_SELFCLAW_CELO);
            const celoIsToken0 = token0.toLowerCase() === CELO_NATIVE.toLowerCase();
            const { token0Per1, token1Per0 } = sqrtPriceX96ToPrice(coreSlot0.sqrtPriceX96, 18, 18);
            corePrice = {
              celoPerSelfclaw: celoIsToken0 ? token0Per1 : token1Per0,
              selfclawPerCelo: celoIsToken0 ? token1Per0 : token0Per1,
            };
          }
        } catch {}
        return {
          SELFCLAW_CELO: {
            poolId: SELFCLAW_CELO_POOL_ID,
            token0: CELO_NATIVE,
            token1: WRAPPED_SELFCLAW_CELO,
            feeTier: 3000,
            tickSpacing: 60,
            sqrtPriceX96: coreSqrtPriceX96,
            price: corePrice,
          },
        };
      })(),
      agentPools: pools.filter(p => p.poolId !== SELFCLAW_CELO_POOL_ID),
      totalPools: pools.length,
      note: "All SelfClaw pools are Uniswap V4 on Celo. Agent tokens are paired with SELFCLAW. SELFCLAW is paired with CELO. To swap AgentToken ↔ CELO, route through SELFCLAW (multi-hop). Use POST /v1/agent-api/swap/quote to get unsigned transaction data.",
    });
  } catch (error: any) {
    console.error("[swap-api] Error fetching pools:", error.message);
    res.status(500).json({ error: "Failed to fetch pool data" });
  }
});

router.post("/v1/agent-api/swap/quote", swapLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { tokenIn, tokenOut, amountIn, slippageBps } = req.body;

    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ error: "Required: tokenIn, tokenOut, amountIn (human-readable amount, e.g. '100')" });
    }

    const slippage = slippageBps ? Number(slippageBps) : 500;
    if (slippage < 10 || slippage > 5000) {
      return res.status(400).json({ error: "slippageBps must be between 10 (0.1%) and 5000 (50%). Default is 500 (5%)." });
    }

    const tokenInAddr = tokenIn.toLowerCase() as `0x${string}`;
    const tokenOutAddr = tokenOut.toLowerCase() as `0x${string}`;

    if (tokenInAddr === tokenOutAddr) {
      return res.status(400).json({ error: "tokenIn and tokenOut must be different" });
    }

    const [wallet] = await db.select().from(agentWallets).where(eq(agentWallets.publicKey, agent.publicKey)).limit(1);
    if (!wallet) {
      return res.status(400).json({ error: "You need a registered wallet to swap. POST /v1/create-wallet first." });
    }

    const walletAddress = wallet.address as `0x${string}`;
    const selfclawAddr = WRAPPED_SELFCLAW_CELO.toLowerCase();
    const celoAddr = CELO_NATIVE.toLowerCase();

    const allPools = await db.select().from(trackedPools);

    const findPool = (tA: string, tB: string): { poolId: string; feeTier: number; tickSpacing: number } | null => {
      const aLow = tA.toLowerCase();
      const bLow = tB.toLowerCase();

      if ((aLow === celoAddr && bLow === selfclawAddr) || (aLow === selfclawAddr && bLow === celoAddr)) {
        return { poolId: SELFCLAW_CELO_POOL_ID, feeTier: 3000, tickSpacing: 60 };
      }

      for (const p of allPools) {
        const tokenLow = p.tokenAddress.toLowerCase();
        const pairedLow = selfclawAddr;
        if ((aLow === tokenLow && bLow === pairedLow) || (aLow === pairedLow && bLow === tokenLow)) {
          return { poolId: p.poolAddress, feeTier: p.feeTier || 10000, tickSpacing: TICK_SPACINGS[p.feeTier || 10000] || 200 };
        }
      }
      return null;
    };

    const directPool = findPool(tokenInAddr, tokenOutAddr);

    let route: { type: 'direct' | 'multi-hop'; legs: Array<{ tokenIn: string; tokenOut: string; poolId: string; feeTier: number; tickSpacing: number }> };

    if (directPool) {
      route = {
        type: 'direct',
        legs: [{ tokenIn: tokenIn, tokenOut: tokenOut, poolId: directPool.poolId, feeTier: directPool.feeTier, tickSpacing: directPool.tickSpacing }],
      };
    } else {
      const leg1 = findPool(tokenInAddr, selfclawAddr);
      const leg2 = findPool(selfclawAddr, tokenOutAddr);

      if (!leg1 || !leg2) {
        const knownTokens = allPools.map(p => `${p.tokenSymbol} (${p.tokenAddress})`);
        return res.status(400).json({
          error: "No swap route found",
          detail: `No direct pool or multi-hop route via SELFCLAW found for ${tokenIn} → ${tokenOut}`,
          availablePools: knownTokens,
          coreTokens: { SELFCLAW: WRAPPED_SELFCLAW_CELO, CELO: CELO_NATIVE },
          hint: "All agent tokens are paired with SELFCLAW. SELFCLAW is paired with CELO. Check the token addresses and try again.",
        });
      }

      route = {
        type: 'multi-hop',
        legs: [
          { tokenIn: tokenIn, tokenOut: WRAPPED_SELFCLAW_CELO, poolId: leg1.poolId, feeTier: leg1.feeTier, tickSpacing: leg1.tickSpacing },
          { tokenIn: WRAPPED_SELFCLAW_CELO, tokenOut: tokenOut, poolId: leg2.poolId, feeTier: leg2.feeTier, tickSpacing: leg2.tickSpacing },
        ],
      };
    }

    const decimalsIn = await getTokenDecimals(tokenInAddr);
    const decimalsOut = await getTokenDecimals(tokenOutAddr);

    const amountInWei = parseUnits(amountIn.toString(), decimalsIn);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const slippageMultiplier = BigInt(10000 - slippage);
    const isCeloIn = tokenInAddr === celoAddr;

    const poolPrices: Array<{ poolId: string; sqrtPriceX96: string; feeBps: number; priceToken0Per1: number; priceToken1Per0: number }> = [];
    for (const leg of route.legs) {
      const slot0 = await getPoolSlot0(leg.poolId);
      const { token0 } = sortTokens(leg.tokenIn, leg.tokenOut);
      const decIn = await getTokenDecimals(leg.tokenIn);
      const decOut = await getTokenDecimals(leg.tokenOut);
      const t0Dec = leg.tokenIn.toLowerCase() === token0.toLowerCase() ? decIn : decOut;
      const t1Dec = leg.tokenIn.toLowerCase() === token0.toLowerCase() ? decOut : decIn;
      const { token0Per1, token1Per0 } = sqrtPriceX96ToPrice(slot0.sqrtPriceX96, t0Dec, t1Dec);
      poolPrices.push({
        poolId: leg.poolId,
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        feeBps: leg.feeTier / 100,
        priceToken0Per1: token0Per1,
        priceToken1Per0: token1Per0,
      });
    }

    let estimatedOutWei: bigint;
    let priceEstimate: { estimatedAmountOut: string; estimatedAmountOutWei: string; pricePerTokenIn: number; legs: Array<{ poolId: string; feePct: string; estimatedOutput: string; estimatedOutputWei: string }> };

    if (route.type === 'direct') {
      const leg = route.legs[0];
      const { token0 } = sortTokens(leg.tokenIn, leg.tokenOut);
      const zeroForOne = leg.tokenIn.toLowerCase() === token0.toLowerCase();
      const slot0 = await getPoolSlot0(leg.poolId);

      estimatedOutWei = estimateSwapOutput(amountInWei, slot0.sqrtPriceX96, zeroForOne, leg.feeTier / 100, decimalsIn, decimalsOut);
      const estimatedOutFormatted = formatUnits(estimatedOutWei, decimalsOut);
      const pricePerIn = estimatedOutWei > 0n ? Number(estimatedOutFormatted) / Number(amountIn) : 0;
      priceEstimate = {
        estimatedAmountOut: estimatedOutFormatted,
        estimatedAmountOutWei: estimatedOutWei.toString(),
        pricePerTokenIn: pricePerIn,
        legs: [{
          poolId: leg.poolId,
          feePct: `${leg.feeTier / 10000}%`,
          estimatedOutput: estimatedOutFormatted,
          estimatedOutputWei: estimatedOutWei.toString(),
        }],
      };
    } else {
      const leg1 = route.legs[0];
      const leg2 = route.legs[1];

      const { token0: t0a } = sortTokens(leg1.tokenIn, leg1.tokenOut);
      const zeroForOne1 = leg1.tokenIn.toLowerCase() === t0a.toLowerCase();
      const slot0_1 = await getPoolSlot0(leg1.poolId);
      const decSelfclaw = 18;
      const intermediateOutWei = estimateSwapOutput(amountInWei, slot0_1.sqrtPriceX96, zeroForOne1, leg1.feeTier / 100, decimalsIn, decSelfclaw);

      const { token0: t0b } = sortTokens(leg2.tokenIn, leg2.tokenOut);
      const zeroForOne2 = leg2.tokenIn.toLowerCase() === t0b.toLowerCase();
      const slot0_2 = await getPoolSlot0(leg2.poolId);
      estimatedOutWei = estimateSwapOutput(intermediateOutWei, slot0_2.sqrtPriceX96, zeroForOne2, leg2.feeTier / 100, decSelfclaw, decimalsOut);

      const intermediateFormatted = formatUnits(intermediateOutWei, decSelfclaw);
      const finalFormatted = formatUnits(estimatedOutWei, decimalsOut);
      const pricePerIn = estimatedOutWei > 0n ? Number(finalFormatted) / Number(amountIn) : 0;
      priceEstimate = {
        estimatedAmountOut: finalFormatted,
        estimatedAmountOutWei: estimatedOutWei.toString(),
        pricePerTokenIn: pricePerIn,
        legs: [
          { poolId: leg1.poolId, feePct: `${leg1.feeTier / 10000}%`, estimatedOutput: intermediateFormatted, estimatedOutputWei: intermediateOutWei.toString() },
          { poolId: leg2.poolId, feePct: `${leg2.feeTier / 10000}%`, estimatedOutput: finalFormatted, estimatedOutputWei: estimatedOutWei.toString() },
        ],
      };
    }

    const minAmountOutFinal = estimatedOutWei * slippageMultiplier / 10000n;

    const transactions: Array<{ step: number; description: string; to: string; data: string; value: string }> = [];
    let stepNum = 0;

    if (!isCeloIn) {
      stepNum++;
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [V4_CONTRACTS.PERMIT2, amountInWei],
      });
      transactions.push({
        step: stepNum,
        description: `Approve Permit2 to spend your ${tokenIn} tokens`,
        to: tokenIn,
        data: approveData,
        value: '0',
      });

      stepNum++;
      const maxUint160 = (2n ** 160n) - 1n;
      const expiration = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const permit2ApproveData = encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [tokenIn as `0x${string}`, V4_CONTRACTS.UNIVERSAL_ROUTER, maxUint160, Number(expiration)],
      });
      transactions.push({
        step: stepNum,
        description: `Approve UniversalRouter on Permit2 to use your ${tokenIn} tokens`,
        to: V4_CONTRACTS.PERMIT2,
        data: permit2ApproveData,
        value: '0',
      });
    }

    stepNum++;

    if (route.type === 'direct') {
      const leg = route.legs[0];
      const { token0, token1 } = sortTokens(leg.tokenIn, leg.tokenOut);
      const zeroForOne = leg.tokenIn.toLowerCase() === token0.toLowerCase();

      const swapActions = encodePacked(
        ['uint8', 'uint8', 'uint8'],
        [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
      );

      const swapParams = encodeAbiParameters(
        parseAbiParameters('(address, address, uint24, int24, address), bool, uint128, uint128, bytes'),
        [
          [token0, token1, leg.feeTier, leg.tickSpacing, '0x0000000000000000000000000000000000000000' as `0x${string}`],
          zeroForOne,
          amountInWei,
          minAmountOutFinal,
          '0x' as `0x${string}`,
        ]
      );

      const settleParams = encodeAbiParameters(
        parseAbiParameters('address, uint256'),
        [leg.tokenIn as `0x${string}`, amountInWei]
      );

      const takeParams = encodeAbiParameters(
        parseAbiParameters('address, uint256'),
        [leg.tokenOut as `0x${string}`, minAmountOutFinal]
      );

      const v4SwapInput = encodeAbiParameters(
        parseAbiParameters('bytes, bytes[]'),
        [swapActions, [swapParams, settleParams, takeParams]]
      );

      const commands = encodePacked(['uint8'], [COMMANDS.V4_SWAP]);

      const executeData = encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: [commands, [v4SwapInput], deadline],
      });

      transactions.push({
        step: stepNum,
        description: `Swap ${amountIn} ${tokenIn} → ~${priceEstimate.estimatedAmountOut} ${tokenOut} (direct, ${leg.feeTier / 10000}% fee)`,
        to: V4_CONTRACTS.UNIVERSAL_ROUTER,
        data: executeData,
        value: isCeloIn ? amountInWei.toString() : '0',
      });
    } else {
      const leg1 = route.legs[0];
      const leg2 = route.legs[1];

      const intermediateMinWei = estimatedOutWei > 0n
        ? (BigInt(priceEstimate.legs[0].estimatedOutputWei) * slippageMultiplier / 10000n)
        : 0n;

      const { token0: t0a, token1: t1a } = sortTokens(leg1.tokenIn, leg1.tokenOut);
      const zeroForOne1 = leg1.tokenIn.toLowerCase() === t0a.toLowerCase();

      const swapActions1 = encodePacked(
        ['uint8', 'uint8', 'uint8'],
        [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
      );

      const swapParams1 = encodeAbiParameters(
        parseAbiParameters('(address, address, uint24, int24, address), bool, uint128, uint128, bytes'),
        [
          [t0a, t1a, leg1.feeTier, leg1.tickSpacing, '0x0000000000000000000000000000000000000000' as `0x${string}`],
          zeroForOne1,
          amountInWei,
          intermediateMinWei,
          '0x' as `0x${string}`,
        ]
      );

      const settleParams1 = encodeAbiParameters(
        parseAbiParameters('address, uint256'),
        [leg1.tokenIn as `0x${string}`, amountInWei]
      );

      const takeParams1 = encodeAbiParameters(
        parseAbiParameters('address, uint256'),
        [leg1.tokenOut as `0x${string}`, intermediateMinWei]
      );

      const v4Input1 = encodeAbiParameters(
        parseAbiParameters('bytes, bytes[]'),
        [swapActions1, [swapParams1, settleParams1, takeParams1]]
      );

      const { token0: t0b, token1: t1b } = sortTokens(leg2.tokenIn, leg2.tokenOut);
      const zeroForOne2 = leg2.tokenIn.toLowerCase() === t0b.toLowerCase();

      const swapActions2 = encodePacked(
        ['uint8', 'uint8', 'uint8'],
        [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
      );

      const swapParams2 = encodeAbiParameters(
        parseAbiParameters('(address, address, uint24, int24, address), bool, uint128, uint128, bytes'),
        [
          [t0b, t1b, leg2.feeTier, leg2.tickSpacing, '0x0000000000000000000000000000000000000000' as `0x${string}`],
          zeroForOne2,
          intermediateMinWei,
          minAmountOutFinal,
          '0x' as `0x${string}`,
        ]
      );

      const settleParams2 = encodeAbiParameters(
        parseAbiParameters('address, uint256'),
        [leg2.tokenIn as `0x${string}`, intermediateMinWei]
      );

      const takeParams2 = encodeAbiParameters(
        parseAbiParameters('address, uint256'),
        [leg2.tokenOut as `0x${string}`, minAmountOutFinal]
      );

      const v4Input2 = encodeAbiParameters(
        parseAbiParameters('bytes, bytes[]'),
        [swapActions2, [swapParams2, settleParams2, takeParams2]]
      );

      const commands = encodePacked(['uint8', 'uint8'], [COMMANDS.V4_SWAP, COMMANDS.V4_SWAP]);

      const executeData = encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: [commands, [v4Input1, v4Input2], deadline],
      });

      transactions.push({
        step: stepNum,
        description: `Multi-hop swap: ${amountIn} ${leg1.tokenIn} → ~${priceEstimate.legs[0].estimatedOutput} SELFCLAW → ~${priceEstimate.estimatedAmountOut} ${leg2.tokenOut} (via UniversalRouter)`,
        to: V4_CONTRACTS.UNIVERSAL_ROUTER,
        data: executeData,
        value: isCeloIn ? amountInWei.toString() : '0',
      });
    }

    res.json({
      route: {
        type: route.type,
        path: route.legs.map(l => l.tokenIn).concat([route.legs[route.legs.length - 1].tokenOut]),
        legs: route.legs,
      },
      amountIn: amountIn.toString(),
      amountInWei: amountInWei.toString(),
      estimate: priceEstimate,
      minAmountOut: formatUnits(minAmountOutFinal, decimalsOut),
      minAmountOutWei: minAmountOutFinal.toString(),
      slippageBps: slippage,
      fees: {
        totalFeePct: route.legs.reduce((sum, l) => sum + l.feeTier / 10000, 0) + '%',
        perLeg: route.legs.map(l => ({ poolId: l.poolId, feePct: `${l.feeTier / 10000}%`, feeBps: l.feeTier / 100 })),
        note: "Fees are deducted from the input amount by the V4 PoolManager during execution. The estimated output already accounts for fees.",
      },
      poolPrices,
      deadlineUnix: Number(deadline),
      signerAddress: walletAddress,
      transactions,
      instructions: [
        "Sign and send each transaction in order using your wallet private key.",
        "Wait for each transaction to be confirmed before sending the next.",
        "The final transaction executes the swap on Uniswap V4's UniversalRouter.",
        isCeloIn ? "The swap transaction includes a CELO value — send it as msg.value." : "All transactions are standard contract calls (value: 0).",
        `Slippage tolerance: ${slippage / 100}%. Min output: ${formatUnits(minAmountOutFinal, decimalsOut)}.`,
        `Estimated output: ~${priceEstimate.estimatedAmountOut}. Actual output may vary with liquidity depth and price impact.`,
      ],
      v4Contracts: {
        universalRouter: V4_CONTRACTS.UNIVERSAL_ROUTER,
        permit2: V4_CONTRACTS.PERMIT2,
        stateView: V4_CONTRACTS.STATE_VIEW,
        chainId: 42220,
      },
    });
  } catch (error: any) {
    console.error("[swap-api] Quote error:", error.message);
    res.status(500).json({ error: "Failed to build swap quote", detail: error.message });
  }
});

router.get("/v1/agent-api/swap/balances", swapLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const [wallet] = await db.select().from(agentWallets).where(eq(agentWallets.publicKey, agent.publicKey)).limit(1);

    if (!wallet) {
      return res.status(400).json({ error: "No wallet registered. POST /v1/create-wallet first." });
    }

    const walletAddress = wallet.address as `0x${string}`;

    const [celoBalance, selfclawBalance] = await Promise.all([
      publicClient.getBalance({ address: walletAddress }),
      publicClient.readContract({ address: WRAPPED_SELFCLAW_CELO, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress] }).catch(() => 0n),
    ]);

    const agentPools = await db.select().from(trackedPools).where(eq(trackedPools.agentPublicKey, agent.publicKey));

    const tokenBalances: Array<{ symbol: string; address: string; balance: string; balanceWei: string }> = [];

    for (const pool of agentPools) {
      try {
        const bal = await publicClient.readContract({ address: pool.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress] });
        tokenBalances.push({
          symbol: pool.tokenSymbol,
          address: pool.tokenAddress,
          balance: formatUnits(bal as bigint, 18),
          balanceWei: (bal as bigint).toString(),
        });
      } catch {}
    }

    res.json({
      wallet: walletAddress,
      balances: {
        CELO: { address: CELO_NATIVE, balance: formatUnits(celoBalance, 18), balanceWei: celoBalance.toString() },
        SELFCLAW: { address: WRAPPED_SELFCLAW_CELO, balance: formatUnits(selfclawBalance as bigint, 18), balanceWei: (selfclawBalance as bigint).toString() },
        agentTokens: tokenBalances,
      },
      hint: tokenBalances.length === 0
        ? "No agent tokens tracked. Deploy a token and request sponsorship to create a pool."
        : `You have ${tokenBalances.length} agent token(s). Use POST /v1/agent-api/swap/quote to swap between them.`,
    });
  } catch (error: any) {
    console.error("[swap-api] Balances error:", error.message);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

export default router;
