import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { db } from "./db.js";
import { agentActivity, verifiedBots, agentWallets, bridgeTransactions, sponsoredAgents, trackedPools, sponsorshipRequests, tokenPlans, agentServices, revenueEvents, costEvents, hostedAgents, conversations, messages, agentMemories, conversationSummaries } from "../shared/schema.js";
import { sql, desc, eq, inArray, count } from "drizzle-orm";
import {
  attestToken,
  completeAttestation,
  bridgeTokens,
  completeTransfer,
  getWrappedTokenAddress,
  getBridgeStatus,
  getWalletBalances,
  fetchVaaForTx,
} from "../lib/wormhole-bridge.js";
import {
  collectFees,
  collectAllFees,
  swapExactInput,
  createPoolAndAddLiquidity,
  getPosition,
  getUncollectedFees,
  getSelfclawBalance,
  getPoolState,
  SELFCLAW_CELO_POOL_ID,
} from "../lib/uniswap-v4.js";

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminTokens = new Map<string, number>();
const TOKEN_TTL = 4 * 60 * 60 * 1000;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts, try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function isValidToken(token: string): boolean {
  const expiry = adminTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req: Request, res: Response): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const token = authHeader.slice(7);
  if (!isValidToken(token)) {
    res.status(401).json({ error: "Invalid or expired token" });
    return false;
  }
  return true;
}

router.post("/login", loginLimiter, (req: Request, res: Response) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Admin access not configured" });
  }
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = generateToken();
  adminTokens.set(token, Date.now() + TOKEN_TTL);
  res.json({ success: true, token });
});

router.post("/logout", (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    adminTokens.delete(authHeader.slice(7));
  }
  res.json({ success: true });
});

router.get("/wallet-balances", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const balances = await getWalletBalances();
    res.json(balances);
  } catch (error: any) {
    console.error("[admin] wallet-balances error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/bridge-status", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const status = await getBridgeStatus();
    res.json(status);
  } catch (error: any) {
    console.error("[admin] bridge-status error:", error);
    res.status(500).json({ error: error.message });
  }
});

const SELFCLAW_TOKEN = "0x9ae5f51d81ff510bf961218f833f79d57bfbab07";

router.post("/bridge/attest", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await attestToken(SELFCLAW_TOKEN);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/attest error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/complete-attestation", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { vaaBytes } = req.body;
    if (!vaaBytes) {
      return res.status(400).json({ error: "vaaBytes required" });
    }
    const result = await completeAttestation(vaaBytes);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/complete-attestation error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/complete-attestation-by-tx", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { txHash } = req.body;
    if (!txHash) {
      return res.status(400).json({ error: "txHash required" });
    }

    console.log(`[admin] Fetching VAA for attestation tx: ${txHash}`);
    const vaaResult = await fetchVaaForTx(txHash);

    if (!vaaResult.vaaBytes) {
      const msg = vaaResult.status === 'pending'
        ? 'VAA not yet available — guardians may still be signing. Try again shortly.'
        : vaaResult.error || 'Could not retrieve VAA from Wormholescan';
      return res.status(422).json({ error: msg, status: vaaResult.status });
    }

    console.log(`[admin] VAA fetched, completing attestation on Celo...`);
    const result = await completeAttestation(vaaResult.vaaBytes);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/complete-attestation-by-tx error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/transfer", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ error: "amount required" });
    }
    const result = await bridgeTokens(SELFCLAW_TOKEN, amount);

    if (result.success && result.sourceTxHash) {
      await db.insert(bridgeTransactions).values({
        type: 'transfer',
        sourceTxHash: result.sourceTxHash,
        tokenAddress: SELFCLAW_TOKEN,
        amount,
        status: 'submitted',
      });
    }

    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/transfer error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/auto-bridge", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ error: "amount required" });
    }

    console.log(`[admin] Auto-bridge: starting full bridge flow for ${amount} SELFCLAW`);

    const transferResult = await bridgeTokens(SELFCLAW_TOKEN, amount);
    if (!transferResult.success || !transferResult.sourceTxHash) {
      return res.status(400).json({
        error: transferResult.error || "Transfer failed on Base",
        phase: "transfer",
      });
    }

    const [record] = await db.insert(bridgeTransactions).values({
      type: 'transfer',
      sourceTxHash: transferResult.sourceTxHash,
      tokenAddress: SELFCLAW_TOKEN,
      amount,
      status: 'polling',
    }).returning();

    console.log(`[admin] Auto-bridge: transfer confirmed on Base (${transferResult.sourceTxHash}), starting VAA polling...`);

    pollAndComplete(record.id, transferResult.sourceTxHash);

    res.json({
      success: true,
      phase: "polling",
      bridgeId: record.id,
      sourceTxHash: transferResult.sourceTxHash,
      message: "Transfer confirmed on Base. Now polling for VAA and will auto-complete on Celo.",
    });
  } catch (error: any) {
    console.error("[admin] bridge/auto-bridge error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/bridge/status/:bridgeId", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const records = await db.select()
      .from(bridgeTransactions)
      .where(eq(bridgeTransactions.id, req.params.bridgeId as string))
      .limit(1);

    if (records.length === 0) {
      return res.status(404).json({ error: "Bridge transaction not found" });
    }

    const record = records[0];
    res.json({
      id: record.id,
      status: record.status,
      sourceTxHash: record.sourceTxHash,
      destTxHash: record.destTxHash,
      amount: record.amount,
      error: record.error,
      hasVaa: !!record.vaaBytes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  } catch (error: any) {
    console.error("[admin] bridge/status error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/complete-transfer", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { vaaBytes } = req.body;
    if (!vaaBytes) {
      return res.status(400).json({ error: "vaaBytes required" });
    }
    const result = await completeTransfer(vaaBytes);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/complete-transfer error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/bridge/pending", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pending = await db.select()
      .from(bridgeTransactions)
      .where(inArray(bridgeTransactions.status, ['submitted', 'polling', 'vaa_ready']))
      .orderBy(desc(bridgeTransactions.createdAt));

    for (const tx of pending) {
      if (tx.status === 'submitted') {
        try {
          const vaaResult = await fetchVaaForTx(tx.sourceTxHash);
          if (vaaResult.vaaBytes) {
            await db.update(bridgeTransactions)
              .set({ status: 'vaa_ready', vaaBytes: vaaResult.vaaBytes, updatedAt: new Date() })
              .where(eq(bridgeTransactions.id, tx.id));
            tx.status = 'vaa_ready';
            tx.vaaBytes = vaaResult.vaaBytes;
          }
        } catch (e) {
        }
      }
    }

    res.json({ pending: pending.map(tx => ({
      id: tx.id,
      type: tx.type,
      sourceTxHash: tx.sourceTxHash,
      destTxHash: tx.destTxHash,
      tokenAddress: tx.tokenAddress,
      amount: tx.amount,
      status: tx.status,
      hasVaa: !!tx.vaaBytes,
      createdAt: tx.createdAt,
    }))});
  } catch (error: any) {
    console.error("[admin] bridge/pending error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/claim", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { bridgeId } = req.body;
    if (!bridgeId) {
      return res.status(400).json({ error: "bridgeId required" });
    }

    const records = await db.select()
      .from(bridgeTransactions)
      .where(eq(bridgeTransactions.id, bridgeId))
      .limit(1);

    if (records.length === 0) {
      return res.status(404).json({ error: "Bridge transaction not found" });
    }

    const record = records[0];

    if (record.status === 'claimed') {
      return res.status(400).json({ error: "Already claimed", destTxHash: record.destTxHash });
    }

    let vaaBytes = record.vaaBytes;

    if (!vaaBytes) {
      const vaaResult = await fetchVaaForTx(record.sourceTxHash);
      if (!vaaResult.vaaBytes) {
        return res.status(422).json({
          error: "VAA not ready yet — guardians may still be signing. Try again shortly.",
          status: vaaResult.status,
        });
      }
      vaaBytes = vaaResult.vaaBytes;
      await db.update(bridgeTransactions)
        .set({ status: 'vaa_ready', vaaBytes, updatedAt: new Date() })
        .where(eq(bridgeTransactions.id, bridgeId));
    }

    const result = await completeTransfer(vaaBytes);

    if (result.success) {
      await db.update(bridgeTransactions)
        .set({
          status: 'claimed',
          destTxHash: result.destTxHash || result.txHash || '',
          updatedAt: new Date(),
        })
        .where(eq(bridgeTransactions.id, bridgeId));
    } else {
      await db.update(bridgeTransactions)
        .set({ error: result.error || 'Claim failed', updatedAt: new Date() })
        .where(eq(bridgeTransactions.id, bridgeId));
    }

    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/claim error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bridge/add-pending", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { sourceTxHash, amount, type } = req.body;
    if (!sourceTxHash) {
      return res.status(400).json({ error: "sourceTxHash required" });
    }

    const existing = await db.select()
      .from(bridgeTransactions)
      .where(eq(bridgeTransactions.sourceTxHash, sourceTxHash))
      .limit(1);

    if (existing.length > 0) {
      return res.json({ id: existing[0].id, existing: true });
    }

    const [record] = await db.insert(bridgeTransactions).values({
      type: type || 'transfer',
      sourceTxHash,
      tokenAddress: SELFCLAW_TOKEN,
      amount: amount || 'unknown',
      status: 'submitted',
    }).returning();

    res.json({ id: record.id, existing: false });
  } catch (error: any) {
    console.error("[admin] bridge/add-pending error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/bridge/fetch-vaa", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const txHash = req.query.txHash as string;
    if (!txHash) {
      return res.status(400).json({ error: "txHash query parameter required" });
    }
    const result = await fetchVaaForTx(txHash);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/fetch-vaa error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/bridge/wrapped", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await getWrappedTokenAddress(SELFCLAW_TOKEN);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/wrapped error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/activity-log", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const activities = await db.select()
      .from(agentActivity)
      .orderBy(desc(agentActivity.createdAt))
      .limit(50);
    res.json(activities);
  } catch (error: any) {
    console.error("[admin] activity-log error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/registry-stats", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [verified] = await db.select({ count: sql<number>`count(*)` }).from(verifiedBots);
    const [wallets] = await db.select({ count: sql<number>`count(*)` }).from(agentWallets);
    const [gasReceived] = await db.select({ count: sql<number>`count(*)` }).from(agentWallets).where(sql`gas_received = true`);
    const [tokens] = await db.select({ count: sql<number>`count(DISTINCT token_address)` }).from(trackedPools).where(sql`human_id NOT IN ('platform') AND hidden_from_registry IS NOT TRUE`);
    
    res.json({
      verifiedAgents: Number(verified.count),
      walletsCreated: Number(wallets.count),
      gasSent: Number(gasReceived.count),
      tokensDeployed: Number(tokens.count),
    });
  } catch (error: any) {
    console.error("[admin] registry-stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

const WRAPPED_SELFCLAW_CELO = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";
const CELO_NATIVE = "0x471EcE3750Da237f93B8E339c536989b8978a438";

router.post("/uniswap/collect-fees", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { positionTokenId } = req.body;
    if (!positionTokenId) {
      return res.status(400).json({ error: "positionTokenId required" });
    }
    const result = await collectFees(BigInt(positionTokenId));
    res.json(result);
  } catch (error: any) {
    console.error("[admin] uniswap/collect-fees error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/collect-all-fees", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { collectAllV3Fees } = await import("../lib/uniswap-v3.js");
    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;

    let v3Result: any = { success: true, totalSelfclaw: '0' };
    try {
      v3Result = await collectAllV3Fees(sponsorKey);
    } catch (e: any) {
      v3Result = { success: false, error: e.message };
    }

    const v4Positions = await db.select({ v4PositionTokenId: sponsoredAgents.v4PositionTokenId })
      .from(sponsoredAgents)
      .where(sql`pool_version = 'v4' AND v4_position_token_id IS NOT NULL AND status = 'completed'`);

    const v4PoolPositions = await db.select({ v4PositionTokenId: trackedPools.v4PositionTokenId })
      .from(trackedPools)
      .where(sql`pool_version = 'v4' AND v4_position_token_id IS NOT NULL`);

    const allPositionIds = new Set<string>();
    for (const p of v4Positions) {
      if (p.v4PositionTokenId) allPositionIds.add(p.v4PositionTokenId);
    }
    for (const p of v4PoolPositions) {
      if (p.v4PositionTokenId) allPositionIds.add(p.v4PositionTokenId);
    }

    let v4Result: any = { success: true, collected: [], totalCollected: 0 };
    if (allPositionIds.size > 0) {
      const tokenIds = Array.from(allPositionIds).map(id => BigInt(id));
      v4Result = await collectAllFees(tokenIds);
    }

    res.json({
      v3: v3Result,
      v4: v4Result,
    });
  } catch (error: any) {
    console.error("[admin] collect-all-fees error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v3/positions", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { getOwnedV3PositionIds, getV3PositionInfo } = await import("../lib/uniswap-v3.js");
    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;
    const positionIds = await getOwnedV3PositionIds(sponsorKey);
    const positions = await Promise.all(positionIds.map((id: bigint) => getV3PositionInfo(id)));
    res.json({ count: positions.length, positions });
  } catch (error: any) {
    console.error("[admin] v3/positions error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v4/positions", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const v4Positions = await db.select({
      v4PositionTokenId: sponsoredAgents.v4PositionTokenId,
      tokenAddress: sponsoredAgents.tokenAddress,
      tokenSymbol: sponsoredAgents.tokenSymbol,
      humanId: sponsoredAgents.humanId,
    }).from(sponsoredAgents)
      .where(sql`pool_version = 'v4' AND v4_position_token_id IS NOT NULL AND status = 'completed'`);

    const positionsWithInfo = await Promise.all(
      v4Positions.filter(p => p.v4PositionTokenId).map(async (p) => {
        try {
          const [position, fees] = await Promise.all([
            getPosition(BigInt(p.v4PositionTokenId!)),
            getUncollectedFees(BigInt(p.v4PositionTokenId!)),
          ]);
          return { ...p, position, uncollectedFees: fees };
        } catch (e: any) {
          return { ...p, error: e.message };
        }
      })
    );

    res.json({ count: positionsWithInfo.length, positions: positionsWithInfo });
  } catch (error: any) {
    console.error("[admin] v4/positions error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/uniswap/swap-celo-to-selfclaw", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { amount, fee } = req.body;
    if (!amount) {
      return res.status(400).json({ error: "amount required (in CELO)" });
    }
    const result = await swapExactInput(CELO_NATIVE, WRAPPED_SELFCLAW_CELO, amount, fee || 3000);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] uniswap/swap error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/uniswap/position/:tokenId", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const tokenId = BigInt(req.params.tokenId as string);
    const [position, fees] = await Promise.all([
      getPosition(tokenId),
      getUncollectedFees(tokenId),
    ]);
    res.json({ position, uncollectedFees: fees });
  } catch (error: any) {
    console.error("[admin] uniswap/position error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/uniswap/selfclaw-balance", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const balance = await getSelfclawBalance();
    res.json({ balance, token: WRAPPED_SELFCLAW_CELO });
  } catch (error: any) {
    console.error("[admin] uniswap/selfclaw-balance error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/uniswap/create-pool", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { tokenA, tokenB, amountA, amountB, feeTier } = req.body;
    if (!tokenA || !tokenB || !amountA || !amountB) {
      return res.status(400).json({ error: "tokenA, tokenB, amountA, amountB required" });
    }
    const result = await createPoolAndAddLiquidity({
      tokenA,
      tokenB,
      amountA,
      amountB,
      feeTier: feeTier || 10000,
    });
    res.json(result);
  } catch (error: any) {
    console.error("[admin] uniswap/create-pool error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/pool-info", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const poolState = await getPoolState(SELFCLAW_CELO_POOL_ID);
    res.json({
      poolId: SELFCLAW_CELO_POOL_ID,
      token0: CELO_NATIVE,
      token1: WRAPPED_SELFCLAW_CELO,
      ...poolState,
    });
  } catch (error: any) {
    console.error("[admin] pool-info error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/token-prices", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const SELFCLAW_BASE_ADDR = SELFCLAW_TOKEN;

    const [dexScreenerBase, dexScreenerCelo, poolState, celoUsdData] = await Promise.all([
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${SELFCLAW_BASE_ADDR}`)
        .then(r => r.json())
        .catch(() => null),
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${WRAPPED_SELFCLAW_CELO}`)
        .then(r => r.json())
        .catch(() => null),
      getPoolState(SELFCLAW_CELO_POOL_ID).catch(() => null),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=celo&vs_currencies=usd')
        .then(r => r.json())
        .catch(() => null),
    ]);

    let basePriceUsd: string | null = null;
    let basePriceNative: string | null = null;
    let baseLiquidity: string | null = null;
    let baseVolume24h: string | null = null;
    let basePriceChange24h: string | null = null;
    let baseDex: string | null = null;
    let basePairAddress: string | null = null;
    let basePairUrl: string | null = null;

    if (dexScreenerBase?.pairs?.length) {
      const basePairs = dexScreenerBase.pairs.filter((p: any) => p.chainId === 'base');
      if (basePairs.length > 0) {
        const topPair = basePairs.sort((a: any, b: any) =>
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        basePriceUsd = topPair.priceUsd || null;
        basePriceNative = topPair.priceNative || null;
        baseLiquidity = topPair.liquidity?.usd?.toString() || null;
        baseVolume24h = topPair.volume?.h24?.toString() || null;
        basePriceChange24h = topPair.priceChange?.h24?.toString() || null;
        baseDex = topPair.dexId || null;
        basePairAddress = topPair.pairAddress || null;
        basePairUrl = topPair.url || null;
      }
    }

    let celoPriceUsd: string | null = null;
    let celoPriceNative: string | null = null;
    let celoLiquidity: string | null = null;
    let celoVolume24h: string | null = null;
    let celoPriceChange24h: string | null = null;
    let celoDex: string | null = null;
    let celoPairUrl: string | null = null;

    if (dexScreenerCelo?.pairs?.length) {
      const celoPairs = dexScreenerCelo.pairs.filter((p: any) => p.chainId === 'celo');
      if (celoPairs.length > 0) {
        const topPair = celoPairs.sort((a: any, b: any) =>
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        celoPriceUsd = topPair.priceUsd || null;
        celoPriceNative = topPair.priceNative || null;
        celoLiquidity = topPair.liquidity?.usd?.toString() || null;
        celoVolume24h = topPair.volume?.h24?.toString() || null;
        celoPriceChange24h = topPair.priceChange?.h24?.toString() || null;
        celoDex = topPair.dexId || null;
        celoPairUrl = topPair.url || null;
      }
    }

    let onChainCeloPrice: string | null = null;
    if (poolState) {
      onChainCeloPrice = poolState.price;
    }

    const celoUsdPrice: number | null = celoUsdData?.celo?.usd ?? null;

    let selfclawCeloUsd: string | null = null;
    if (celoUsdPrice && poolState) {
      const selfclawPerCelo = parseFloat(poolState.price);
      if (selfclawPerCelo > 0) {
        selfclawCeloUsd = (celoUsdPrice / selfclawPerCelo).toFixed(12);
      }
    }

    let priceGapPercent: string | null = null;
    if (selfclawCeloUsd && basePriceUsd) {
      const baseP = parseFloat(basePriceUsd);
      const celoP = parseFloat(selfclawCeloUsd);
      if (baseP > 0) {
        priceGapPercent = (((celoP - baseP) / baseP) * 100).toFixed(2);
      }
    }

    res.json({
      base: {
        token: SELFCLAW_BASE_ADDR,
        chain: 'base',
        priceUsd: basePriceUsd,
        priceNative: basePriceNative,
        liquidity: baseLiquidity,
        volume24h: baseVolume24h,
        priceChange24h: basePriceChange24h,
        dex: baseDex,
        pairAddress: basePairAddress,
        pairUrl: basePairUrl,
      },
      celo: {
        token: WRAPPED_SELFCLAW_CELO,
        chain: 'celo',
        priceUsd: celoPriceUsd || selfclawCeloUsd,
        priceNative: celoPriceNative,
        liquidity: celoLiquidity,
        volume24h: celoVolume24h,
        priceChange24h: celoPriceChange24h,
        dex: celoDex,
        pairUrl: celoPairUrl,
        onChainPrice: onChainCeloPrice,
        computedFromCelo: celoPriceUsd ? false : !!selfclawCeloUsd,
      },
      celoUsdPrice: celoUsdPrice,
      priceGapPercent: priceGapPercent,
      poolState: poolState ? {
        tick: poolState.tick,
        liquidity: poolState.liquidity,
        lpFee: poolState.lpFee,
      } : null,
    });
  } catch (error: any) {
    console.error("[admin] token-prices error:", error);
    res.status(500).json({ error: error.message });
  }
});

const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_ATTEMPTS = 80;

async function pollAndComplete(bridgeId: string, sourceTxHash: string) {
  let attempts = 0;
  const poll = async () => {
    attempts++;
    try {
      console.log(`[auto-bridge] Polling VAA for ${sourceTxHash} (attempt ${attempts}/${MAX_POLL_ATTEMPTS})...`);
      const vaaResult = await fetchVaaForTx(sourceTxHash);

      if (vaaResult.vaaBytes) {
        console.log(`[auto-bridge] VAA received for ${sourceTxHash}, completing transfer on Celo...`);
        try {
          await db.update(bridgeTransactions)
            .set({ status: 'vaa_ready', vaaBytes: vaaResult.vaaBytes, updatedAt: new Date() })
            .where(eq(bridgeTransactions.id, bridgeId));
        } catch (dbErr: any) {
          console.error(`[auto-bridge] DB update failed for ${sourceTxHash}:`, dbErr?.message);
        }

        const claimResult = await completeTransfer(vaaResult.vaaBytes);
        if (claimResult.success) {
          console.log(`[auto-bridge] Transfer completed on Celo for ${sourceTxHash}`);
          try {
            await db.update(bridgeTransactions)
              .set({
                status: 'claimed',
                destTxHash: claimResult.destTxHash || claimResult.txHash || '',
                updatedAt: new Date(),
              })
              .where(eq(bridgeTransactions.id, bridgeId));
          } catch (dbErr: any) {
            console.error(`[auto-bridge] DB update failed for ${sourceTxHash}:`, dbErr?.message);
          }
        } else {
          console.error(`[auto-bridge] completeTransfer failed for ${sourceTxHash}: ${claimResult.error}`);
          try {
            await db.update(bridgeTransactions)
              .set({ status: 'vaa_ready', error: claimResult.error || 'completeTransfer failed', updatedAt: new Date() })
              .where(eq(bridgeTransactions.id, bridgeId));
          } catch (dbErr: any) {
            console.error(`[auto-bridge] DB update failed for ${sourceTxHash}:`, dbErr?.message);
          }
        }
        return;
      }

      if (attempts >= MAX_POLL_ATTEMPTS) {
        console.warn(`[auto-bridge] Max polling attempts reached for ${sourceTxHash}`);
        try {
          await db.update(bridgeTransactions)
            .set({ status: 'submitted', error: 'VAA polling timed out after 20 minutes. Use manual claim.', updatedAt: new Date() })
            .where(eq(bridgeTransactions.id, bridgeId));
        } catch (dbErr: any) {
          console.error(`[auto-bridge] DB update failed for ${sourceTxHash}:`, dbErr?.message);
        }
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    } catch (error: any) {
      console.error(`[auto-bridge] Poll error for ${sourceTxHash}:`, error?.shortMessage || error?.message);
      if (attempts >= MAX_POLL_ATTEMPTS) {
        try {
          await db.update(bridgeTransactions)
            .set({ error: `Polling error: ${error?.message}`, updatedAt: new Date() })
            .where(eq(bridgeTransactions.id, bridgeId));
        } catch (dbErr: any) {
          console.error(`[auto-bridge] DB update failed for ${sourceTxHash}:`, dbErr?.message);
        }
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  setTimeout(poll, POLL_INTERVAL_MS);
}

export async function runAutoClaimPendingBridges() {
  try {
    const pending = await db.select()
      .from(bridgeTransactions)
      .where(inArray(bridgeTransactions.status, ['submitted', 'polling', 'vaa_ready']));

    if (pending.length === 0) {
      console.log('[auto-bridge] No pending bridge transactions to process.');
      return;
    }

    console.log(`[auto-bridge] Found ${pending.length} pending bridge transaction(s), processing...`);

    for (const tx of pending) {
      try {
        if (tx.status === 'vaa_ready' && tx.vaaBytes) {
          console.log(`[auto-bridge] Completing previously ready transfer: ${tx.sourceTxHash}`);
          try {
            const result = await completeTransfer(tx.vaaBytes);
            if (result.success) {
              await db.update(bridgeTransactions)
                .set({
                  status: 'claimed',
                  destTxHash: result.destTxHash || result.txHash || '',
                  error: null,
                  updatedAt: new Date(),
                })
                .where(eq(bridgeTransactions.id, tx.id));
              console.log(`[auto-bridge] Claimed ${tx.sourceTxHash}`);
            } else {
              await db.update(bridgeTransactions)
                .set({ error: result.error || 'Claim failed', updatedAt: new Date() })
                .where(eq(bridgeTransactions.id, tx.id));
            }
          } catch (err: any) {
            console.error(`[auto-bridge] Claim error for ${tx.sourceTxHash}:`, err?.shortMessage || err?.message);
          }
          continue;
        }

        console.log(`[auto-bridge] Resuming VAA polling for: ${tx.sourceTxHash}`);
        await db.update(bridgeTransactions)
          .set({ status: 'polling', updatedAt: new Date() })
          .where(eq(bridgeTransactions.id, tx.id));
        pollAndComplete(tx.id, tx.sourceTxHash);
      } catch (txErr: any) {
        console.error(`[auto-bridge] Error processing tx ${tx.sourceTxHash}:`, txErr?.shortMessage || txErr?.message);
      }
    }
  } catch (error: any) {
    console.error('[auto-bridge] runAutoClaimPendingBridges error:', error?.shortMessage || error?.message);
  }
}

router.get("/sponsorship-requests", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const requests = await db.select().from(sponsorshipRequests).orderBy(desc(sponsorshipRequests.createdAt));

    const pools = await db.select().from(trackedPools);
    const poolByToken: Record<string, any> = {};
    for (const p of pools) {
      poolByToken[p.tokenAddress.toLowerCase()] = p;
    }

    const enriched = requests.map(r => {
      const pool = r.tokenAddress ? poolByToken[r.tokenAddress.toLowerCase()] : null;
      return {
        ...r,
        tokenSymbol: (r.tokenSymbol && r.tokenSymbol !== 'TOKEN') ? r.tokenSymbol : (pool?.tokenSymbol || r.tokenSymbol || 'TOKEN'),
        agentName: pool?.tokenName || null,
      };
    });

    res.json(enriched);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/sponsorship-requests/:id/retry", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const [request] = await db.select().from(sponsorshipRequests).where(sql`${sponsorshipRequests.id} = ${id}`).limit(1);
    if (!request) return res.status(404).json({ error: "Sponsorship request not found" });
    if (request.status !== 'failed') return res.status(400).json({ error: `Cannot retry request with status '${request.status}'` });
    if ((request.retryCount || 0) >= (request.maxRetries || 3)) {
      return res.status(400).json({ error: "Max retries exceeded", retryCount: request.retryCount, maxRetries: request.maxRetries });
    }

    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    if (!rawSponsorKey) {
      return res.status(503).json({ error: "Sponsor private key not configured. Set SELFCLAW_SPONSOR_PRIVATE_KEY or CELO_PRIVATE_KEY." });
    }
    const sponsorKey = !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;

    const { getTokenBalance, getNextPositionTokenId, computePoolId, extractPositionTokenIdFromReceipt } = await import("../lib/uniswap-v4.js");

    const tokenAddress = request.tokenAddress;
    const tokenAmount = request.tokenAmount;
    const selfclawAddress = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";

    let tokenDecimals = 18;
    try {
      const { createPublicClient, http } = await import('viem');
      const { celo } = await import('viem/chains');
      const publicClient = createPublicClient({ chain: celo, transport: http('https://forno.celo.org') });
      const dec = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: [{ name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }],
        functionName: 'decimals',
      });
      tokenDecimals = Number(dec);
    } catch (decErr: any) {
      console.warn(`[admin-retry] Could not fetch decimals for ${tokenAddress}, defaulting to 18:`, decErr?.message);
    }

    const agentTokenBalance = await getTokenBalance(tokenAddress, tokenDecimals, sponsorKey);
    const heldAmount = parseFloat(agentTokenBalance);
    const requiredAmount = parseFloat(tokenAmount);

    if (heldAmount < requiredAmount) {
      await db.update(sponsorshipRequests).set({
        errorMessage: `Pre-check: insufficient agent tokens (has ${agentTokenBalance}, needs ${tokenAmount})`,
        updatedAt: new Date(),
      }).where(sql`${sponsorshipRequests.id} = ${id}`);
      return res.status(400).json({
        error: `Sponsor wallet does not hold enough agent tokens. Has ${agentTokenBalance}, needs ${tokenAmount}`,
      });
    }

    const availableBalance = await getSelfclawBalance(sponsorKey);
    const available = parseFloat(availableBalance);
    if (available <= 0) {
      await db.update(sponsorshipRequests).set({
        errorMessage: 'Pre-check: no SELFCLAW available in sponsorship wallet',
        updatedAt: new Date(),
      }).where(sql`${sponsorshipRequests.id} = ${id}`);
      return res.status(400).json({ error: "No SELFCLAW available in sponsorship wallet." });
    }

    const selfclawForPool = Math.floor(available * 0.5 / 1.06).toString();
    const feeTier = 10000;
    const tickSpacing = 200;
    const tokenLower = tokenAddress.toLowerCase();
    const selfclawLower = selfclawAddress.toLowerCase();
    const token0 = tokenLower < selfclawLower ? tokenAddress : selfclawAddress;
    const token1 = tokenLower < selfclawLower ? selfclawAddress : tokenAddress;
    const v4PoolId = computePoolId(token0, token1, feeTier, tickSpacing);

    await db.update(sponsorshipRequests).set({
      status: 'processing',
      retryCount: (request.retryCount || 0) + 1,
      selfclawAmount: selfclawForPool,
      v4PoolId,
      updatedAt: new Date(),
    }).where(sql`${sponsorshipRequests.id} = ${id}`);

    const nextTokenIdBefore = await getNextPositionTokenId();

    const result = await createPoolAndAddLiquidity({
      tokenA: tokenAddress, tokenB: selfclawAddress,
      amountA: tokenAmount, amountB: selfclawForPool,
      feeTier, privateKey: sponsorKey,
    });

    if (!result.success) {
      await db.update(sponsorshipRequests).set({
        status: 'failed',
        errorMessage: result.error,
        updatedAt: new Date(),
      }).where(sql`${sponsorshipRequests.id} = ${id}`);
      return res.status(400).json({ error: result.error });
    }

    let positionTokenId: string | null = null;
    if (result.receipt) {
      positionTokenId = extractPositionTokenIdFromReceipt(result.receipt);
    }
    if (!positionTokenId) {
      const nextTokenIdAfter = await getNextPositionTokenId();
      if (nextTokenIdAfter > nextTokenIdBefore) {
        positionTokenId = nextTokenIdBefore.toString();
      }
    }

    await db.update(sponsorshipRequests).set({
      status: 'completed',
      v4PoolId,
      positionTokenId,
      txHash: result.txHash || '',
      selfclawAmount: selfclawForPool,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(sql`${sponsorshipRequests.id} = ${id}`);

    const existingSponsor = await db.select().from(sponsoredAgents)
      .where(sql`${sponsoredAgents.humanId} = ${request.humanId}`).limit(1);
    if (existingSponsor.length > 0) {
      await db.update(sponsoredAgents).set({
        poolAddress: v4PoolId,
        v4PositionTokenId: positionTokenId,
        poolVersion: 'v4',
        sponsoredAmountCelo: selfclawForPool,
        sponsorTxHash: result.txHash || '',
        status: 'completed',
        completedAt: new Date(),
      }).where(sql`${sponsoredAgents.humanId} = ${request.humanId}`);
    } else {
      await db.insert(sponsoredAgents).values({
        humanId: request.humanId,
        publicKey: request.publicKey,
        tokenAddress,
        tokenSymbol: request.tokenSymbol || 'TOKEN',
        poolAddress: v4PoolId,
        v4PositionTokenId: positionTokenId,
        poolVersion: 'v4',
        sponsoredAmountCelo: selfclawForPool,
        sponsorTxHash: result.txHash || '',
        status: 'completed',
        completedAt: new Date(),
      });
    }

    try {
      await db.insert(trackedPools).values({
        poolAddress: v4PoolId, tokenAddress,
        tokenSymbol: request.tokenSymbol || 'TOKEN',
        tokenName: request.tokenSymbol || 'TOKEN',
        pairedWith: 'SELFCLAW', humanId: request.humanId,
        agentPublicKey: request.publicKey, feeTier,
        v4PositionTokenId: positionTokenId,
        poolVersion: 'v4',
        v4PoolId,
        initialCeloLiquidity: selfclawForPool,
        initialTokenLiquidity: tokenAmount,
      }).onConflictDoNothing();
    } catch (e: any) {
      console.error(`[admin] Failed to track pool: ${e.message}`);
    }

    res.json({
      success: true,
      v4PoolId,
      positionTokenId,
      txHash: result.txHash,
      selfclawAmount: selfclawForPool,
    });
  } catch (error: any) {
    console.error("[admin] sponsorship retry error:", error);
    try {
      await db.update(sponsorshipRequests).set({
        status: 'failed',
        errorMessage: error.message,
        updatedAt: new Date(),
      }).where(sql`${sponsorshipRequests.id} = ${req.params.id}`);
    } catch (_e) {}
    res.status(500).json({ error: error.message });
  }
});

router.post("/uniswap/tracked-pools/register", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { tokenAddress, v4PoolId, positionTokenId } = req.body;
    if (!tokenAddress || !v4PoolId) {
      return res.status(400).json({ error: "Token address and V4 pool ID are required" });
    }

    const addr = tokenAddress.trim().toLowerCase();

    const existing = await db.select().from(trackedPools).where(eq(trackedPools.tokenAddress, addr)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "This token is already tracked", pool: existing[0] });
    }

    const { createPublicClient, http } = await import("viem");
    const { celo } = await import("viem/chains");
    const client = createPublicClient({ chain: celo, transport: http() });
    const ERC20_META_ABI = [
      { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
      { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
    ] as const;

    let tokenSymbol = 'TOKEN';
    let tokenName = 'TOKEN';
    try {
      const [sym, nm] = await Promise.all([
        client.readContract({ address: addr as `0x${string}`, abi: ERC20_META_ABI, functionName: 'symbol' }),
        client.readContract({ address: addr as `0x${string}`, abi: ERC20_META_ABI, functionName: 'name' }),
      ]);
      tokenSymbol = sym as string;
      tokenName = nm as string;
    } catch (e: any) {
      console.warn(`[admin] Could not read token metadata from chain: ${e.message}`);
    }

    let humanId: string | null = null;
    let agentPublicKey: string | null = null;

    const sponsored = await db.select().from(sponsoredAgents).where(eq(sponsoredAgents.tokenAddress, addr)).limit(1);
    if (sponsored.length > 0) {
      humanId = sponsored[0].humanId;
      agentPublicKey = sponsored[0].publicKey;
    }

    if (!humanId) {
      const sponsorReq = await db.select().from(sponsorshipRequests).where(eq(sponsorshipRequests.tokenAddress, addr)).limit(1);
      if (sponsorReq.length > 0) {
        humanId = sponsorReq[0].humanId;
        agentPublicKey = sponsorReq[0].publicKey;
      }
    }

    const poolId = v4PoolId.trim();
    const posTokenId = positionTokenId ? String(positionTokenId).trim() : null;

    await db.insert(trackedPools).values({
      poolAddress: poolId,
      tokenAddress: addr,
      tokenSymbol,
      tokenName,
      pairedWith: 'SELFCLAW',
      humanId: humanId || 'unknown',
      agentPublicKey,
      feeTier: 10000,
      v4PositionTokenId: posTokenId,
      poolVersion: 'v4',
      v4PoolId: poolId,
    }).onConflictDoNothing();

    res.json({
      success: true,
      tokenSymbol,
      tokenName,
      humanId: humanId || '(not found — update manually)',
      agentPublicKey: agentPublicKey ? agentPublicKey.slice(0, 20) + '...' : '(not found)',
      v4PoolId: poolId,
      positionTokenId: posTokenId,
    });
  } catch (error: any) {
    console.error("[admin] register tracked pool error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/token-management", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pools = await db.select().from(trackedPools).orderBy(trackedPools.createdAt);
    
    const agentKeys = pools.filter(p => p.agentPublicKey).map(p => p.agentPublicKey!);
    const agentMap = new Map<string, string>();
    if (agentKeys.length > 0) {
      const agents = await db.select({ publicKey: verifiedBots.publicKey, deviceId: verifiedBots.deviceId })
        .from(verifiedBots)
        .where(inArray(verifiedBots.publicKey, agentKeys));
      for (const a of agents) {
        agentMap.set(a.publicKey, a.deviceId || '');
      }
    }

    const result = pools.map(pool => ({
      id: pool.id,
      tokenAddress: pool.tokenAddress,
      tokenSymbol: pool.tokenSymbol,
      tokenName: pool.tokenName,
      pairedWith: pool.pairedWith,
      humanId: pool.humanId,
      agentPublicKey: pool.agentPublicKey,
      agentName: pool.agentPublicKey ? agentMap.get(pool.agentPublicKey) || null : null,
      poolVersion: pool.poolVersion,
      v4PoolId: pool.v4PoolId,
      poolAddress: pool.poolAddress,
      hiddenFromRegistry: pool.hiddenFromRegistry || false,
      displayNameOverride: pool.displayNameOverride || null,
      displaySymbolOverride: pool.displaySymbolOverride || null,
      adminNotes: pool.adminNotes || null,
      createdAt: pool.createdAt,
    }));

    res.json({ pools: result });
  } catch (error: any) {
    console.error("[admin] token-management error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/token-management/:id", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const { hiddenFromRegistry, displayNameOverride, displaySymbolOverride, adminNotes, agentPublicKey, humanId } = req.body;

    const updates: Record<string, any> = {};
    if (typeof hiddenFromRegistry === 'boolean') updates.hiddenFromRegistry = hiddenFromRegistry;
    if (displayNameOverride !== undefined) updates.displayNameOverride = displayNameOverride || null;
    if (displaySymbolOverride !== undefined) updates.displaySymbolOverride = displaySymbolOverride || null;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes || null;
    if (agentPublicKey !== undefined) updates.agentPublicKey = agentPublicKey || null;
    if (humanId !== undefined) updates.humanId = humanId || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    await db.update(trackedPools).set(updates).where(sql`${trackedPools.id} = ${id}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error("[admin] token-management update error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/agents", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const agents = await db.select().from(verifiedBots).orderBy(desc(verifiedBots.verifiedAt));

    const publicKeys = agents.map(a => a.publicKey);

    const hostedRows = publicKeys.length > 0
      ? await db.select({ publicKey: hostedAgents.publicKey, name: hostedAgents.name, status: hostedAgents.status })
          .from(hostedAgents).where(inArray(hostedAgents.publicKey, publicKeys))
      : [];
    const hostedMap = new Map<string, typeof hostedRows[0]>();
    for (const h of hostedRows) hostedMap.set(h.publicKey, h);

    const [walletRows, poolRows, planRows] = await Promise.all([
      publicKeys.length > 0
        ? db.select({ publicKey: agentWallets.publicKey, address: agentWallets.address, gasReceived: agentWallets.gasReceived })
            .from(agentWallets).where(inArray(agentWallets.publicKey, publicKeys))
        : Promise.resolve([]),
      publicKeys.length > 0
        ? db.select({ agentPublicKey: trackedPools.agentPublicKey, tokenAddress: trackedPools.tokenAddress, tokenSymbol: trackedPools.tokenSymbol, poolVersion: trackedPools.poolVersion, v4PoolId: trackedPools.v4PoolId })
            .from(trackedPools).where(sql`${trackedPools.agentPublicKey} IN (${sql.join(publicKeys.map(pk => sql`${pk}`), sql`, `)})`)
        : Promise.resolve([]),
      publicKeys.length > 0
        ? db.select({ agentPublicKey: tokenPlans.agentPublicKey, status: tokenPlans.status, tokenAddress: tokenPlans.tokenAddress })
            .from(tokenPlans).where(inArray(tokenPlans.agentPublicKey, publicKeys))
        : Promise.resolve([]),
    ]);

    const walletMap = new Map<string, typeof walletRows[0]>();
    for (const w of walletRows) walletMap.set(w.publicKey, w);
    const poolMap = new Map<string, (typeof poolRows)[0]>();
    for (const p of poolRows) if (p.agentPublicKey) poolMap.set(p.agentPublicKey, p);
    const planMap = new Map<string, (typeof planRows)[0]>();
    for (const p of planRows) planMap.set(p.agentPublicKey, p);

    const result = agents.map(agent => {
      const pk = agent.publicKey;
      const wallet = walletMap.get(pk);
      const pool = poolMap.get(pk);
      const plan = planMap.get(pk);
      const hosted = hostedMap.get(pk);
      const metadata = (agent.metadata as Record<string, any>) || {};

      const pipelineStages: string[] = [];
      pipelineStages.push('verified');
      if (wallet) {
        pipelineStages.push('wallet');
        if (wallet.gasReceived) pipelineStages.push('gas');
      }
      if (metadata.erc8004Minted || metadata.erc8004TokenId) pipelineStages.push('erc8004');
      if (plan?.tokenAddress || pool?.tokenAddress) pipelineStages.push('token');
      if (pool?.v4PoolId || pool?.poolVersion === 'v4') pipelineStages.push('sponsored');

      const allStages = ['verified', 'wallet', 'gas', 'erc8004', 'token', 'sponsored'];
      const nextStage = allStages.find(s => !pipelineStages.includes(s)) || 'complete';

      let agentType = 'verified';
      if (hosted) agentType = 'miniclaw';
      else if ((agent.deviceId || '').startsWith('sandbox-')) agentType = 'sandbox';

      return {
        publicKey: agent.publicKey,
        agentName: agent.deviceId || null,
        hostedName: hosted?.name || null,
        hostedStatus: hosted?.status || null,
        agentType,
        humanId: agent.humanId,
        hidden: agent.hidden || false,
        verificationLevel: agent.verificationLevel || 'passport',
        verifiedAt: agent.verifiedAt,
        walletAddress: wallet?.address || null,
        tokenSymbol: pool?.tokenSymbol || null,
        tokenAddress: pool?.tokenAddress || plan?.tokenAddress || null,
        erc8004: !!(metadata.erc8004Minted || metadata.erc8004TokenId),
        pipelineStages,
        nextStage,
        pipelineProgress: Math.round((pipelineStages.length / allStages.length) * 100),
      };
    });

    res.json({ agents: result, total: result.length });
  } catch (error: any) {
    console.error("[admin] agents list error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/agents/:publicKey/visibility", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { publicKey } = req.params;
    const { hidden } = req.body;
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: "hidden (boolean) is required" });
    }

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`).limit(1);
    if (agents.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    await db.update(verifiedBots)
      .set({ hidden })
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`);

    const action = hidden ? 'hidden' : 'shown';
    console.log(`[admin] Agent ${agents[0].deviceId || publicKey.slice(0, 16)}... ${action}`);

    res.json({ success: true, hidden, agentName: agents[0].deviceId || null });
  } catch (error: any) {
    console.error("[admin] agent visibility error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/agents/:publicKey/rename", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { publicKey } = req.params;
    const { name } = req.body;
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) {
      return res.status(400).json({ error: "Name must be 2-40 characters" });
    }
    const cleanName = name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_\- ]*$/.test(cleanName)) {
      return res.status(400).json({ error: "Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and spaces" });
    }

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`).limit(1);
    if (agents.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const existing = await db.select({ id: verifiedBots.id })
      .from(verifiedBots)
      .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${cleanName}) AND ${verifiedBots.publicKey} != ${publicKey}`)
      .limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Name already taken by another agent" });
    }

    const oldName = agents[0].deviceId;
    await db.update(verifiedBots)
      .set({ deviceId: cleanName })
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`);

    console.log(`[admin] Agent renamed: "${oldName}" → "${cleanName}"`);
    res.json({ success: true, oldName, newName: cleanName });
  } catch (error: any) {
    console.error("[admin] agent rename error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/agents/:publicKey", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { publicKey } = req.params;
    if (!publicKey) {
      return res.status(400).json({ error: "publicKey is required" });
    }

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`).limit(1);
    if (agents.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const agent = agents[0];
    const deleted: string[] = [];

    await db.delete(agentWallets).where(sql`${agentWallets.publicKey} = ${publicKey}`);
    deleted.push('wallets');

    await db.delete(trackedPools).where(sql`${trackedPools.agentPublicKey} = ${publicKey}`);
    deleted.push('pools');

    await db.delete(tokenPlans).where(sql`${tokenPlans.agentPublicKey} = ${publicKey}`);
    deleted.push('tokenPlans');

    await db.delete(sponsoredAgents).where(sql`${sponsoredAgents.publicKey} = ${publicKey}`);
    deleted.push('sponsoredAgents');

    await db.delete(sponsorshipRequests).where(sql`${sponsorshipRequests.publicKey} = ${publicKey}`);
    deleted.push('sponsorshipRequests');

    await db.delete(agentServices).where(sql`${agentServices.agentPublicKey} = ${publicKey}`);
    deleted.push('services');

    await db.delete(revenueEvents).where(sql`${revenueEvents.agentPublicKey} = ${publicKey}`);
    deleted.push('revenueEvents');

    await db.delete(costEvents).where(sql`${costEvents.agentPublicKey} = ${publicKey}`);
    deleted.push('costEvents');

    await db.delete(agentActivity).where(sql`${agentActivity.agentPublicKey} = ${publicKey}`);
    deleted.push('activity');

    const hostedRows = await db.select({ id: hostedAgents.id }).from(hostedAgents)
      .where(sql`${hostedAgents.publicKey} = ${publicKey}`);
    if (hostedRows.length > 0) {
      const hostedIds = hostedRows.map(h => h.id);
      for (const hId of hostedIds) {
        await db.delete(messages).where(sql`${messages.conversationId} IN (SELECT id FROM conversations WHERE ${conversations.agentId} = ${hId})`);
        await db.delete(conversationSummaries).where(sql`${conversationSummaries.agentId} = ${hId}`);
        await db.delete(conversations).where(sql`${conversations.agentId} = ${hId}`);
        await db.delete(agentMemories).where(sql`${agentMemories.agentId} = ${hId}`);
      }
      await db.delete(hostedAgents).where(inArray(hostedAgents.id, hostedIds));
      deleted.push('hostedAgents');
    }

    await db.delete(verifiedBots).where(sql`${verifiedBots.publicKey} = ${publicKey}`);
    deleted.push('agent');

    console.log(`[admin] Deleted agent ${agent.deviceId || publicKey.slice(0, 16)}... and related data: ${deleted.join(', ')}`);

    res.json({
      success: true,
      deleted,
      agentName: agent.deviceId || null,
      message: `Agent and all related data removed (${deleted.join(', ')})`,
    });
  } catch (error: any) {
    console.error("[admin] agent delete error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/relink-agent", async (req: Request, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { publicKey, newHumanId } = req.body;
    if (!publicKey || !newHumanId) {
      return res.status(400).json({ error: "publicKey and newHumanId are required" });
    }

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`)
      .limit(1);

    if (!agents.length) {
      return res.status(404).json({ error: `No agent found with publicKey ${publicKey.slice(0, 16)}...` });
    }

    const agent = agents[0];
    const oldHumanId = agent.humanId || "(none)";

    await db.update(verifiedBots)
      .set({ humanId: newHumanId })
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`);

    const wallets = await db.select().from(agentWallets)
      .where(sql`${agentWallets.publicKey} = ${publicKey}`)
      .limit(1);

    if (wallets.length && wallets[0].humanId !== newHumanId) {
      await db.update(agentWallets)
        .set({ humanId: newHumanId })
        .where(sql`${agentWallets.publicKey} = ${publicKey}`);
    }

    console.log(`[admin] Relinked agent ${agent.deviceId || publicKey.slice(0, 16)}... from humanId=${oldHumanId} to humanId=${newHumanId}`);

    res.json({
      success: true,
      agentName: agent.deviceId || null,
      publicKey: publicKey.slice(0, 16) + "...",
      oldHumanId,
      newHumanId,
      walletUpdated: wallets.length > 0,
      message: `Agent relinked from ${oldHumanId} to ${newHumanId}`,
    });
  } catch (error: any) {
    console.error("[admin] relink-agent error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/update-erc8004", async (req: Request, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { publicKey, newTokenId } = req.body;
    if (!publicKey || newTokenId === undefined || newTokenId === null) {
      return res.status(400).json({ error: "publicKey and newTokenId are required" });
    }

    const tokenId = parseInt(newTokenId, 10);
    if (isNaN(tokenId) || tokenId < 0) {
      return res.status(400).json({ error: "newTokenId must be a valid non-negative integer" });
    }

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`)
      .limit(1);

    if (!agents.length) {
      return res.status(404).json({ error: `No agent found with publicKey ${publicKey.slice(0, 16)}...` });
    }

    const agent = agents[0];
    const metadata = (agent.metadata as Record<string, any>) || {};
    const oldTokenId = metadata.erc8004TokenId || "(none)";

    metadata.erc8004TokenId = tokenId;

    await db.update(verifiedBots)
      .set({ metadata })
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`);

    console.log(`[admin] Updated ERC-8004 tokenId for ${agent.deviceId || publicKey.slice(0, 16)}... from ${oldTokenId} to ${tokenId}`);

    res.json({
      success: true,
      agentName: agent.deviceId || null,
      publicKey: publicKey.slice(0, 16) + "...",
      oldTokenId,
      newTokenId: tokenId,
      scanUrl: `https://www.8004scan.io/agents/celo/${tokenId}`,
      message: `ERC-8004 token ID updated from #${oldTokenId} to #${tokenId}`,
    });
  } catch (error: any) {
    console.error("[admin] update-erc8004 error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/hide-agent", async (req: Request, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { publicKey, hidden } = req.body;
    if (!publicKey) {
      return res.status(400).json({ error: "publicKey is required" });
    }

    const hideFlag = hidden !== false;

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`)
      .limit(1);

    if (!agents.length) {
      return res.status(404).json({ error: `No agent found with publicKey ${publicKey.slice(0, 16)}...` });
    }

    const agent = agents[0];

    await db.update(verifiedBots)
      .set({ hidden: hideFlag })
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`);

    console.log(`[admin] ${hideFlag ? 'Hid' : 'Unhid'} agent ${agent.deviceId || publicKey.slice(0, 16)}...`);

    res.json({
      success: true,
      agentName: agent.deviceId || null,
      publicKey: publicKey.slice(0, 16) + "...",
      hidden: hideFlag,
      message: `Agent ${hideFlag ? 'hidden from' : 'restored to'} public listings`,
    });
  } catch (error: any) {
    console.error("[admin] hide-agent error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/refresh-all-agents", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { syncAllAgents } = await import("./onchain-sync.js");
    const result = await syncAllAgents();
    try {
      const { invalidateLeaderboardCache } = await import("./reputation.js");
      invalidateLeaderboardCache();
    } catch (_) {}
    console.log(`[admin] Manual agent refresh: synced=${result.synced}, updated=${result.updated}, errors=${result.errors}`);
    if (result.details?.length > 0) {
      for (const d of result.details) {
        console.log(`[admin]   ${d.agent} (#${d.tokenId}): ${d.status} feedback=${d.feedbackCount ?? '-'} avg=${d.avgScore ?? '-'}${d.error ? ' err=' + d.error : ''}`);
      }
    }
    res.json({
      success: true,
      ...result,
      message: `Refreshed ${result.synced} agents, updated ${result.updated}, ${result.errors} errors`,
    });
  } catch (error: any) {
    console.error("[admin] refresh-all-agents error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
