import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { db } from "./db.js";
import { agentActivity, verifiedBots, agentWallets } from "../shared/schema.js";
import { sql, desc } from "drizzle-orm";
import {
  attestToken,
  completeAttestation,
  bridgeTokens,
  completeTransfer,
  getWrappedTokenAddress,
  getBridgeStatus,
  getWalletBalances,
} from "../lib/wormhole-bridge.js";

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

router.post("/bridge/attest", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { tokenAddress } = req.body;
    if (!tokenAddress) {
      return res.status(400).json({ error: "tokenAddress required" });
    }
    const result = await attestToken(tokenAddress);
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

router.post("/bridge/transfer", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { tokenAddress, amount } = req.body;
    if (!tokenAddress || !amount) {
      return res.status(400).json({ error: "tokenAddress and amount required" });
    }
    const result = await bridgeTokens(tokenAddress, amount);
    res.json(result);
  } catch (error: any) {
    console.error("[admin] bridge/transfer error:", error);
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

router.get("/bridge/wrapped/:tokenAddress", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await getWrappedTokenAddress(req.params.tokenAddress as string);
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
    
    res.json({
      verifiedAgents: Number(verified.count),
      walletsCreated: Number(wallets.count),
      gasSent: Number(gasReceived.count),
    });
  } catch (error: any) {
    console.error("[admin] registry-stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
