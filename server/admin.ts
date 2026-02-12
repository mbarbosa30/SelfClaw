import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { db } from "./db.js";
import { agentActivity, verifiedBots, agentWallets, bridgeTransactions, sponsoredAgents, trackedPools, sponsorshipRequests } from "../shared/schema.js";
import { sql, desc, eq, inArray } from "drizzle-orm";
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
    const tokensResult = await db.execute(sql`SELECT count(*)::int as count FROM agent_activity WHERE event_type = 'token_registered'`);
    const tokensCount = (tokensResult as any).rows?.[0]?.count ?? 0;
    
    res.json({
      verifiedAgents: Number(verified.count),
      walletsCreated: Number(wallets.count),
      gasSent: Number(gasReceived.count),
      tokensDeployed: Number(tokensCount),
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

router.post("/v3/collect-all-fees", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { collectAllV3Fees } = await import("../lib/uniswap-v3.js");
    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;
    const result = await collectAllV3Fees(sponsorKey);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] v3/collect-all-fees error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v4/collect-all-fees", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
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

    if (allPositionIds.size === 0) {
      return res.json({ success: true, message: "No V4 positions to collect fees from", collected: [], totalCollected: 0 });
    }

    const tokenIds = Array.from(allPositionIds).map(id => BigInt(id));
    const result = await collectAllFees(tokenIds);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] v4/collect-all-fees error:", error);
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
        await db.update(bridgeTransactions)
          .set({ status: 'vaa_ready', vaaBytes: vaaResult.vaaBytes, updatedAt: new Date() })
          .where(eq(bridgeTransactions.id, bridgeId));

        const claimResult = await completeTransfer(vaaResult.vaaBytes);
        if (claimResult.success) {
          console.log(`[auto-bridge] Transfer completed on Celo for ${sourceTxHash}`);
          await db.update(bridgeTransactions)
            .set({
              status: 'claimed',
              destTxHash: claimResult.destTxHash || claimResult.txHash || '',
              updatedAt: new Date(),
            })
            .where(eq(bridgeTransactions.id, bridgeId));
        } else {
          console.error(`[auto-bridge] completeTransfer failed for ${sourceTxHash}: ${claimResult.error}`);
          await db.update(bridgeTransactions)
            .set({ status: 'vaa_ready', error: claimResult.error || 'completeTransfer failed', updatedAt: new Date() })
            .where(eq(bridgeTransactions.id, bridgeId));
        }
        return;
      }

      if (attempts >= MAX_POLL_ATTEMPTS) {
        console.warn(`[auto-bridge] Max polling attempts reached for ${sourceTxHash}`);
        await db.update(bridgeTransactions)
          .set({ status: 'submitted', error: 'VAA polling timed out after 20 minutes. Use manual claim.', updatedAt: new Date() })
          .where(eq(bridgeTransactions.id, bridgeId));
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    } catch (error: any) {
      console.error(`[auto-bridge] Poll error for ${sourceTxHash}:`, error.message);
      if (attempts >= MAX_POLL_ATTEMPTS) {
        await db.update(bridgeTransactions)
          .set({ error: `Polling error: ${error.message}`, updatedAt: new Date() })
          .where(eq(bridgeTransactions.id, bridgeId));
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
          console.error(`[auto-bridge] Claim error for ${tx.sourceTxHash}:`, err.message);
        }
        continue;
      }

      console.log(`[auto-bridge] Resuming VAA polling for: ${tx.sourceTxHash}`);
      await db.update(bridgeTransactions)
        .set({ status: 'polling', updatedAt: new Date() })
        .where(eq(bridgeTransactions.id, tx.id));
      pollAndComplete(tx.id, tx.sourceTxHash);
    }
  } catch (error: any) {
    console.error('[auto-bridge] runAutoClaimPendingBridges error:', error.message);
  }
}

router.get("/sponsorship-requests", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const requests = await db.select().from(sponsorshipRequests).orderBy(desc(sponsorshipRequests.createdAt));
    res.json(requests);
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
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;

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

export default router;
