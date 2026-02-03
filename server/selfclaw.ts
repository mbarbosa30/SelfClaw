import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { verifiedBots, verificationSessions, type InsertVerifiedBot, type InsertVerificationSession } from "../shared/schema.js";
import { eq, and, gt, lt, sql } from "drizzle-orm";
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from "@selfxyz/core";
import crypto from "crypto";
import * as ed from "@noble/ed25519";

const router = Router();

async function cleanupExpiredSessions() {
  try {
    const result = await db.update(verificationSessions)
      .set({ status: "expired" })
      .where(and(
        eq(verificationSessions.status, "pending"),
        lt(verificationSessions.challengeExpiry, new Date())
      ));
    console.log("[selfclaw] Cleaned up expired sessions");
  } catch (error) {
    console.error("[selfclaw] Session cleanup error:", error);
  }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
cleanupExpiredSessions();

const SELFCLAW_SCOPE = "selfclaw-verify";
const SELFCLAW_ENDPOINT = process.env.SELFCLAW_CALLBACK_URL 
  || (process.env.REPLIT_DOMAINS 
    ? `https://${process.env.REPLIT_DOMAINS}/api/selfclaw/v1/callback`
    : "http://localhost:5000/api/selfclaw/v1/callback");

console.log(`[selfclaw] Callback endpoint: ${SELFCLAW_ENDPOINT}`);

const selfBackendVerifier = new SelfBackendVerifier(
  SELFCLAW_SCOPE,
  SELFCLAW_ENDPOINT,
  false,
  AllIds,
  new DefaultConfigStore({
    minimumAge: 0,
    excludedCountries: [],
    ofac: false,
  }),
  "uuid"
);

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const verificationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many verification attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

function generateChallenge(sessionId: string, agentKeyHash: string): string {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  return JSON.stringify({
    domain: "selfclaw.app",
    action: "verify-agent",
    sessionId,
    agentKeyHash,
    timestamp,
    nonce,
    expiresAt: timestamp + 10 * 60 * 1000
  });
}

async function verifyEd25519Signature(
  publicKeyBase64: string,
  signature: string,
  message: string
): Promise<boolean> {
  try {
    const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const signatureBytes = Buffer.from(signature, "hex");
    const messageBytes = new TextEncoder().encode(message);
    
    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch (error) {
    console.error("[selfclaw] Signature verification error:", error);
    return false;
  }
}

router.get("/v1/config", (_req: Request, res: Response) => {
  res.json({
    scope: SELFCLAW_SCOPE,
    endpoint: SELFCLAW_ENDPOINT,
    appName: "SelfClaw",
    version: 2
  });
});

router.post("/v1/start-verification", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { agentPublicKey, agentName, signature } = req.body;
    
    if (!agentPublicKey) {
      return res.status(400).json({ error: "agentPublicKey is required" });
    }
    
    const sessionId = crypto.randomUUID();
    const agentKeyHash = crypto.createHash("sha256").update(agentPublicKey).digest("hex").substring(0, 16);
    const challenge = generateChallenge(sessionId, agentKeyHash);
    const challengeExpiry = new Date(Date.now() + 10 * 60 * 1000);
    
    let signatureVerified = false;
    
    if (signature) {
      signatureVerified = await verifyEd25519Signature(agentPublicKey, signature, challenge);
      if (!signatureVerified) {
        return res.status(400).json({ 
          error: "Invalid signature",
          message: "The provided signature does not match the agent's public key"
        });
      }
    }
    
    const newSession: InsertVerificationSession = {
      id: sessionId,
      agentPublicKey,
      agentName: agentName || null,
      agentKeyHash,
      challenge,
      challengeExpiry,
      signatureVerified,
      status: "pending"
    };
    
    await db.insert(verificationSessions).values(newSession);
    
    res.json({
      success: true,
      sessionId,
      agentKeyHash,
      challenge,
      signatureRequired: !signatureVerified,
      signatureVerified,
      config: {
        scope: SELFCLAW_SCOPE,
        endpoint: SELFCLAW_ENDPOINT,
        appName: "SelfClaw",
        version: 2
      }
    });
  } catch (error: any) {
    console.error("[selfclaw] start-verification error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/sign-challenge", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId, signature } = req.body;
    
    if (!sessionId || !signature) {
      return res.status(400).json({ 
        error: "sessionId and signature are required",
        hint: "Signature must be hex-encoded Ed25519 signature of the challenge string"
      });
    }
    
    if (!/^[0-9a-fA-F]+$/.test(signature)) {
      return res.status(400).json({ 
        error: "Invalid signature format",
        hint: "Signature must be hex-encoded (128 hex characters for Ed25519)"
      });
    }
    
    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, sessionId),
        eq(verificationSessions.status, "pending")
      ))
      .limit(1);
    
    const session = sessions[0];
    if (!session) {
      return res.status(400).json({ error: "Invalid or expired session" });
    }
    
    if (new Date() > session.challengeExpiry) {
      await db.update(verificationSessions)
        .set({ status: "expired" })
        .where(eq(verificationSessions.id, sessionId));
      return res.status(400).json({ error: "Challenge has expired" });
    }
    
    const isValid = await verifyEd25519Signature(session.agentPublicKey, signature, session.challenge);
    if (!isValid) {
      return res.status(400).json({ 
        error: "Invalid signature",
        hint: "Public key must be base64-encoded Ed25519 public key"
      });
    }
    
    await db.update(verificationSessions)
      .set({ signatureVerified: true })
      .where(eq(verificationSessions.id, sessionId));
    
    res.json({
      success: true,
      message: "Signature verified. You can now proceed with passport verification."
    });
  } catch (error: any) {
    console.error("[selfclaw] sign-challenge error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/callback", async (req: Request, res: Response) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body;
    
    if (!proof || !publicSignals || !attestationId || !userContextData) {
      return res.status(200).json({ status: "error", result: false, reason: "Missing required verification data" });
    }
    
    const result = await selfBackendVerifier.verify(
      attestationId,
      proof,
      publicSignals,
      userContextData
    );
    
    if (!result.isValidDetails.isValid) {
      return res.status(200).json({ 
        status: "error",
        result: false,
        reason: "Proof verification failed"
      });
    }
    
    const sessionId = result.userData?.userIdentifier;
    if (!sessionId) {
      return res.status(200).json({ status: "error", result: false, reason: "Missing session ID in proof" });
    }
    
    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, sessionId),
        eq(verificationSessions.status, "pending"),
        gt(verificationSessions.challengeExpiry, new Date())
      ))
      .limit(1);
    
    const session = sessions[0];
    if (!session) {
      console.log("[selfclaw] Session not found or expired:", sessionId);
      await db.update(verificationSessions)
        .set({ status: "expired" })
        .where(and(
          eq(verificationSessions.id, sessionId),
          eq(verificationSessions.status, "pending")
        ));
      return res.status(200).json({ status: "error", result: false, reason: "Invalid or expired verification session" });
    }
    
    const proofAgentKeyHash = result.userData?.userDefinedData?.substring(0, 16) || "";
    if (!proofAgentKeyHash) {
      console.log("[selfclaw] Missing agentKeyHash in proof userDefinedData");
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding required" });
    }
    if (proofAgentKeyHash !== session.agentKeyHash) {
      console.log("[selfclaw] Agent key hash mismatch:", proofAgentKeyHash, "vs", session.agentKeyHash);
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding mismatch" });
    }
    
    const humanId = crypto.createHash("sha256")
      .update(JSON.stringify(publicSignals))
      .digest("hex")
      .substring(0, 16);
    
    const nationality = result.discloseOutput?.nationality;
    
    const existing = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${session.agentPublicKey}`)
      .limit(1);

    const metadata = { 
      nationality, 
      verifiedVia: "selfxyz", 
      signatureVerified: session.signatureVerified || false,
      lastUpdated: new Date().toISOString() 
    };

    if (existing.length > 0) {
      await db.update(verifiedBots)
        .set({
          humanId,
          metadata,
          verificationLevel: session.signatureVerified ? "passport+signature" : "passport",
          verifiedAt: new Date()
        })
        .where(sql`${verifiedBots.publicKey} = ${session.agentPublicKey}`);
    } else {
      const newBot: InsertVerifiedBot = {
        publicKey: session.agentPublicKey,
        deviceId: session.agentName || null,
        selfId: null,
        humanId,
        verificationLevel: session.signatureVerified ? "passport+signature" : "passport",
        metadata
      };
      await db.insert(verifiedBots).values(newBot);
    }

    await db.update(verificationSessions)
      .set({ status: "completed" })
      .where(eq(verificationSessions.id, sessionId));

    res.status(200).json({
      status: "success",
      result: true
    });
  } catch (error: any) {
    console.error("[selfclaw] callback error:", error);
    res.status(200).json({ status: "error", result: false, reason: error.message || "Unknown error" });
  }
});

router.get("/v1/agent", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const publicKey = req.query.publicKey as string;
    const name = req.query.name as string;
    
    if (!publicKey && !name) {
      return res.status(400).json({ error: "Missing publicKey or name query parameter" });
    }
    
    const identifier = publicKey || name;
    
    let agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${identifier}`)
      .limit(1);
    
    if (agents.length === 0) {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.deviceId} = ${identifier}`)
        .limit(1);
    }
    
    const foundAgent = agents[0];

    if (!foundAgent) {
      return res.json({
        verified: false,
        publicKey: identifier,
        message: "Agent not found in registry"
      });
    }

    res.json({
      verified: true,
      publicKey: foundAgent.publicKey,
      agentName: foundAgent.deviceId,
      humanId: foundAgent.humanId,
      selfxyz: {
        verified: true,
        registeredAt: foundAgent.verifiedAt
      },
      swarm: foundAgent.humanId ? `https://selfclaw.app/human/${foundAgent.humanId}` : null,
      metadata: foundAgent.metadata
    });
  } catch (error) {
    console.error("Query param agent lookup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/agent/:identifier", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    
    let agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${identifier}`)
      .limit(1);
    
    if (agents.length === 0) {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.deviceId} = ${identifier}`)
        .limit(1);
    }
    
    const foundAgent = agents[0];

    if (!foundAgent) {
      return res.json({
        verified: false,
        publicKey: identifier,
        message: "Agent not found in registry"
      });
    }

    res.json({
      verified: true,
      publicKey: foundAgent.publicKey,
      agentName: foundAgent.deviceId,
      humanId: foundAgent.humanId,
      selfxyz: {
        verified: true,
        registeredAt: foundAgent.verifiedAt
      },
      swarm: foundAgent.humanId ? `https://selfclaw.app/human/${foundAgent.humanId}` : null,
      metadata: foundAgent.metadata
    });
  } catch (error: any) {
    console.error("[selfclaw] agent lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/bot/:identifier", async (req: Request, res: Response) => {
  res.redirect(301, `/api/selfclaw/v1/agent/${req.params.identifier}`);
});

router.get("/v1/human/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { humanId } = req.params;
    
    const agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.humanId} = ${humanId}`);

    res.json({
      humanId,
      agentCount: agents.length,
      agents: agents.map(agent => ({
        publicKey: agent.publicKey,
        agentName: agent.deviceId,
        verifiedAt: agent.verifiedAt
      }))
    });
  } catch (error: any) {
    console.error("[selfclaw] human lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/verify", async (_req: Request, res: Response) => {
  res.status(410).json({
    error: "This endpoint is deprecated",
    message: "Use the Self.xyz verification flow instead: POST /api/selfclaw/v1/start-verification",
    docs: "https://selfclaw.app/developers"
  });
});

router.get("/v1/stats", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const allAgents = await db.select().from(verifiedBots);
    const uniqueHumans = new Set(allAgents.map(a => a.humanId).filter(Boolean));
    
    res.json({
      totalVerifiedAgents: allAgents.length,
      uniqueHumans: uniqueHumans.size,
      latestVerification: allAgents.length > 0 
        ? allAgents.sort((a, b) => new Date(b.verifiedAt!).getTime() - new Date(a.verifiedAt!).getTime())[0].verifiedAt
        : null
    });
  } catch (error: any) {
    console.error("[selfclaw] stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
