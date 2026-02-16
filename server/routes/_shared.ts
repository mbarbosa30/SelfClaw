import { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import * as ed from "@noble/ed25519";
import { db } from "../db.js";
import { verifiedBots, verificationSessions, agentWallets, agentServices, tokenPlans, trackedPools, revenueEvents, agentActivity } from "../../shared/schema.js";
import { eq, and, gt, lt, sql, desc } from "drizzle-orm";

export const SELFCLAW_SCOPE = "selfclaw-verify";
export const SELFCLAW_STAGING = process.env.SELFCLAW_STAGING === "true";

export function getCanonicalDomain(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (!domains) return "localhost:5000";
  const parts = domains.split(",").map(d => d.trim()).filter(Boolean);
  const priorities = [".ai", ".com", ".app"];
  for (const suffix of priorities) {
    const match = parts.find(d => d.endsWith(suffix));
    if (match) return match;
  }
  return parts[parts.length - 1] || domains;
}

export const CANONICAL_DOMAIN = getCanonicalDomain();
export const SELFCLAW_ENDPOINT = process.env.SELFCLAW_CALLBACK_URL
  || `https://${CANONICAL_DOMAIN}/api/selfclaw/v1/callback`;

export const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const verificationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many verification attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many feedback submissions. Max 10 per hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

export const feedbackCooldowns = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, ts] of feedbackCooldowns) {
    if (ts < cutoff) feedbackCooldowns.delete(key);
  }
}, 10 * 60 * 1000);

export const usedNonces = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(key);
  }
}, 60 * 1000);

export const deployEconomySessions = new Map<string, {
  publicKey: string;
  humanId: string;
  status: 'running' | 'completed' | 'failed';
  currentStep: string;
  steps: Array<{
    name: string;
    status: 'pending' | 'running' | 'success' | 'failed';
    result?: any;
    error?: string;
    durationMs?: number;
  }>;
  result?: any;
  error?: string;
  startedAt: number;
}>();

export const deployWalletKeys = new Map<string, { privateKey: string; claimed: boolean; humanId: string; createdAt: number }>();

export function generateChallenge(sessionId: string, agentKeyHash: string): string {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  return JSON.stringify({
    domain: "selfclaw.ai",
    action: "verify-agent",
    sessionId,
    agentKeyHash,
    timestamp,
    nonce,
    expiresAt: timestamp + 10 * 60 * 1000
  });
}

export function extractRawEd25519Key(publicKeyInput: string): Uint8Array {
  let input = publicKeyInput.trim();
  if (input.startsWith('0x') || input.startsWith('0X')) {
    const hexStr = input.slice(2);
    if (/^[0-9a-fA-F]+$/.test(hexStr) && hexStr.length === 64) {
      return Buffer.from(hexStr, "hex");
    }
  }
  const bytes = Buffer.from(input, "base64");
  if (bytes.length === 32) {
    return bytes;
  }
  if (bytes.length === 44 && bytes[0] === 0x30 && bytes[1] === 0x2a) {
    return bytes.subarray(12);
  }
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Buffer.from(input, "hex");
  }
  return bytes;
}

export function decodeSignature(signature: string): Uint8Array {
  let sig = signature.trim();
  if (sig.startsWith('0x') || sig.startsWith('0X')) {
    sig = sig.slice(2);
  }
  if (/^[0-9a-fA-F]+$/.test(sig)) {
    const padded = sig.length % 2 === 1 ? '0' + sig : sig;
    const buf = Buffer.from(padded, "hex");
    if (buf.length === 64) return buf;
  }
  const b64 = Buffer.from(sig, "base64");
  if (b64.length === 64) {
    return b64;
  }
  return Buffer.from(sig, "hex");
}

export async function verifyEd25519Signature(
  publicKeyBase64: string,
  signature: string,
  message: string
): Promise<boolean> {
  try {
    const publicKeyBytes = extractRawEd25519Key(publicKeyBase64);
    const signatureBytes = decodeSignature(signature);
    const messageBytes = new TextEncoder().encode(message);

    if (publicKeyBytes.length !== 32) {
      console.error("[selfclaw] Public key must be 32 bytes, got", publicKeyBytes.length);
      return false;
    }
    if (signatureBytes.length !== 64) {
      console.error("[selfclaw] Signature must be 64 bytes, got", signatureBytes.length);
      return false;
    }

    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch (error) {
    console.error("[selfclaw] Signature verification error:", error);
    return false;
  }
}

export async function authenticateAgentRequest(req: Request, res: Response): Promise<{ publicKey: string; humanId: string; agent: any } | null> {
  const { agentPublicKey, signature, timestamp, nonce } = req.body;

  if (!agentPublicKey || !signature || !timestamp || !nonce) {
    res.status(401).json({
      error: "Authentication required: agentPublicKey, signature, timestamp, and nonce are required",
      hint: "Sign the exact JSON string: JSON.stringify({agentPublicKey, timestamp, nonce}) with your Ed25519 private key. Signature can be hex or base64 encoded. Public key can be raw 32-byte base64 or SPKI DER base64 (MCowBQYDK2VwAyEA...). nonce must be a unique random string (8-64 chars) per request. timestamp must be Date.now() within 5 minutes.",
      example: {
        agentPublicKey: "MCowBQYDK2VwAyEA...",
        signature: "<hex or base64 encoded Ed25519 signature>",
        timestamp: Date.now(),
        nonce: "random-unique-string"
      }
    });
    return null;
  }

  const ts = Number(timestamp);
  const now = Date.now();
  if (isNaN(ts) || Math.abs(now - ts) > 5 * 60 * 1000) {
    res.status(401).json({ error: "Request expired or invalid timestamp. Must be within 5 minutes." });
    return null;
  }

  const nonceStr = String(nonce);
  if (nonceStr.length < 8 || nonceStr.length > 64) {
    res.status(401).json({ error: "Nonce must be 8-64 characters" });
    return null;
  }

  const nonceKey = `${agentPublicKey}:${nonceStr}`;
  if (usedNonces.has(nonceKey)) {
    res.status(401).json({ error: "Nonce already used. Each request must have a unique nonce." });
    return null;
  }

  const messageToSign = JSON.stringify({ agentPublicKey, timestamp: ts, nonce: nonceStr });
  const isValid = await verifyEd25519Signature(agentPublicKey, signature, messageToSign);

  if (!isValid) {
    res.status(401).json({
      error: "Invalid signature",
      signedMessage: messageToSign,
      hint: "Sign the exact JSON string above with your Ed25519 private key. Accepted formats: signature as hex (128 chars, with or without 0x prefix) or base64 (88 chars). Public key as base64 (raw 32-byte or SPKI DER MCowBQYDK2VwAyEA...) or hex (64 chars, with or without 0x prefix).",
    });
    return null;
  }

  usedNonces.set(nonceKey, ts);

  const agentRecords = await db.select()
    .from(verifiedBots)
    .where(sql`${verifiedBots.publicKey} = ${agentPublicKey}`)
    .limit(1);

  if (agentRecords.length === 0) {
    res.status(403).json({ error: "Agent not found in SelfClaw registry. Verify first." });
    return null;
  }

  const agent = agentRecords[0];
  if (!agent.humanId) {
    res.status(403).json({ error: "Agent has no humanId. Complete verification first." });
    return null;
  }

  return { publicKey: agentPublicKey, humanId: agent.humanId, agent };
}

export async function logActivity(eventType: string, humanId?: string, agentPublicKey?: string, agentName?: string, metadata?: any) {
  try {
    await db.insert(agentActivity).values({ eventType, humanId, agentPublicKey, agentName, metadata });
  } catch (e: any) {
    console.error("[selfclaw] activity log error:", e.message);
  }
}

export async function buildAgentContext(publicKey: string, humanId: string, depth: 'minimal' | 'standard' | 'full' = 'standard'): Promise<Record<string, any>> {
  const context: Record<string, any> = {};

  try {
    const agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey}`)
      .limit(1);

    if (agents.length > 0) {
      const agent = agents[0];
      context.identity = {
        agentName: agent.deviceId || null,
        publicKey: agent.publicKey,
        humanId: agent.humanId,
        verifiedAt: agent.verifiedAt,
        verificationLevel: agent.verificationLevel || 'passport',
        profileUrl: agent.deviceId ? `/agent/${agent.deviceId}` : `/agent/${agent.publicKey}`,
      };

      const metadata = (agent.metadata as Record<string, any>) || {};
      if (metadata.erc8004TokenId) {
        context.erc8004 = {
          tokenId: metadata.erc8004TokenId,
          minted: true,
          scanUrl: `https://www.8004scan.io/agents/celo/${metadata.erc8004TokenId}`,
        };
      }
    }

    if (depth === 'minimal') return context;

    const [walletResults, planResults] = await Promise.all([
      db.select().from(agentWallets).where(sql`${agentWallets.humanId} = ${humanId}`).limit(1),
      db.select().from(tokenPlans).where(sql`${tokenPlans.humanId} = ${humanId}`).limit(1),
    ]);

    if (walletResults.length > 0) {
      context.wallet = {
        address: walletResults[0].address,
        gasReceived: walletResults[0].gasReceived,
        explorerUrl: `https://celoscan.io/address/${walletResults[0].address}`,
      };
    }

    if (planResults.length > 0) {
      const plan = planResults[0];
      context.tokenPlan = {
        purpose: plan.purpose,
        supplyReasoning: plan.supplyReasoning,
        allocation: plan.allocation,
        utility: plan.utility,
        economicModel: plan.economicModel,
        status: plan.status,
        tokenAddress: plan.tokenAddress || null,
      };
    }

    if (depth === 'standard') return context;

    const [serviceResults, revenueResults, poolResults] = await Promise.all([
      db.select().from(agentServices).where(sql`${agentServices.humanId} = ${humanId} AND ${agentServices.active} = true`),
      db.select().from(revenueEvents).where(sql`${revenueEvents.humanId} = ${humanId}`).orderBy(desc(revenueEvents.createdAt)).limit(20),
      db.select().from(trackedPools).where(sql`${trackedPools.humanId} = ${humanId}`),
    ]);

    if (serviceResults.length > 0) {
      context.services = serviceResults.map(s => ({
        name: s.name,
        description: s.description,
        price: s.price,
        currency: s.currency,
      }));
    }

    if (revenueResults.length > 0) {
      const totals: Record<string, number> = {};
      for (const e of revenueResults) {
        totals[e.token] = (totals[e.token] || 0) + parseFloat(e.amount);
      }
      context.revenue = { totalEvents: revenueResults.length, totals };
    }

    if (poolResults.length > 0) {
      const pool = poolResults[0];
      context.pool = {
        tokenAddress: pool.tokenAddress,
        tokenSymbol: pool.tokenSymbol,
        tokenName: pool.tokenName,
        poolVersion: pool.poolVersion || 'v3',
        v4PoolId: pool.v4PoolId,
        pairedWith: pool.pairedWith,
      };
    }
  } catch (e: any) {
    console.error('[selfclaw] buildAgentContext error:', e.message);
  }

  return context;
}

export function generateFriendlySuggestions(baseName: string): string[] {
  const suffixes = [
    Math.floor(Math.random() * 99) + 1,
    "v2",
    "ai",
    Math.floor(Math.random() * 999) + 100,
    "agent",
    "x",
  ];
  const shuffled = suffixes.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).map(s => `${baseName}-${s}`);
}

export function cleanupExpiredSessions() {
  return db.update(verificationSessions)
    .set({ status: "expired" })
    .where(and(
      eq(verificationSessions.status, "pending"),
      lt(verificationSessions.challengeExpiry, new Date())
    ));
}

setInterval(() => cleanupExpiredSessions().catch(() => {}), 5 * 60 * 1000);
cleanupExpiredSessions().catch(() => {});

export interface DebugVerificationAttempt {
  timestamp: string;
  sessionId?: string;
  userId?: string;
  attestationId?: string;
  hasProof: boolean;
  hasPublicSignals: boolean;
  publicSignalsLength?: number;
  sdkError?: string;
  sdkErrorStack?: string;
  verifyResult?: any;
  finalStatus: string;
  finalReason?: string;
}

export interface RawCallbackRequest {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyPreview: string;
  contentType?: string;
  contentLength?: string;
  ip?: string;
}

export const debugState = {
  lastVerificationAttempt: null as DebugVerificationAttempt | null,
  recentCallbackRequests: [] as RawCallbackRequest[],
};

export function getSponsorKey(): string | undefined {
  const rawKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
  return rawKey && !rawKey.startsWith('0x') ? `0x${rawKey}` : rawKey;
}
