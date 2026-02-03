import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { verifiedBots, type InsertVerifiedBot } from "../shared/schema.js";
import { eq } from "drizzle-orm";
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from "@selfxyz/core";
import crypto from "crypto";
import * as ed from "@noble/ed25519";

const router = Router();

const SELFMOLT_SCOPE = "selfmolt-verify";
const SELFMOLT_ENDPOINT = process.env.REPLIT_DOMAINS 
  ? `https://${process.env.REPLIT_DOMAINS}/api/selfmolt/v1/callback`
  : "http://localhost:5000/api/selfmolt/v1/callback";

const selfBackendVerifier = new SelfBackendVerifier(
  SELFMOLT_SCOPE,
  SELFMOLT_ENDPOINT,
  false,
  AllIds,
  new DefaultConfigStore({
    minimumAge: 0,
    excludedCountries: [],
    ofac: false,
  }),
  "uuid"
);

interface PendingVerification {
  agentPublicKey: string;
  agentName: string;
  agentKeyHash: string;
  challenge: string;
  challengeExpiry: Date;
  signatureVerified: boolean;
  createdAt: Date;
}

const pendingVerifications = new Map<string, PendingVerification>();

function generateChallenge(sessionId: string, agentKeyHash: string): string {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  return JSON.stringify({
    domain: "selfmolt.openclaw.ai",
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
    console.error("[selfmolt] Signature verification error:", error);
    return false;
  }
}

router.get("/v1/config", (_req: Request, res: Response) => {
  res.json({
    scope: SELFMOLT_SCOPE,
    endpoint: SELFMOLT_ENDPOINT,
    appName: "SelfMolt",
    version: 2
  });
});

router.post("/v1/start-verification", async (req: Request, res: Response) => {
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
    
    pendingVerifications.set(sessionId, {
      agentPublicKey,
      agentName: agentName || "",
      agentKeyHash,
      challenge,
      challengeExpiry,
      signatureVerified,
      createdAt: new Date()
    });
    
    setTimeout(() => pendingVerifications.delete(sessionId), 10 * 60 * 1000);
    
    res.json({
      success: true,
      sessionId,
      agentKeyHash,
      challenge,
      signatureRequired: !signatureVerified,
      signatureVerified,
      config: {
        scope: SELFMOLT_SCOPE,
        endpoint: SELFMOLT_ENDPOINT,
        appName: "SelfMolt",
        version: 2
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/sign-challenge", async (req: Request, res: Response) => {
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
    
    const pending = pendingVerifications.get(sessionId);
    if (!pending) {
      return res.status(400).json({ error: "Invalid or expired session" });
    }
    
    if (new Date() > pending.challengeExpiry) {
      pendingVerifications.delete(sessionId);
      return res.status(400).json({ error: "Challenge has expired" });
    }
    
    const isValid = await verifyEd25519Signature(pending.agentPublicKey, signature, pending.challenge);
    if (!isValid) {
      return res.status(400).json({ 
        error: "Invalid signature",
        hint: "Public key must be base64-encoded Ed25519 public key"
      });
    }
    
    pending.signatureVerified = true;
    pendingVerifications.set(sessionId, pending);
    
    res.json({
      success: true,
      message: "Signature verified. You can now proceed with passport verification."
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/callback", async (req: Request, res: Response) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body;
    
    if (!proof || !publicSignals || !attestationId || !userContextData) {
      return res.status(400).json({ error: "Missing required verification data" });
    }
    
    const result = await selfBackendVerifier.verify(
      attestationId,
      proof,
      publicSignals,
      userContextData
    );
    
    if (!result.isValidDetails.isValid) {
      return res.status(400).json({ 
        verified: false, 
        error: "Proof verification failed",
        details: result.isValidDetails
      });
    }
    
    const sessionId = result.userData?.userIdentifier;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing session ID in proof" });
    }
    
    const pending = pendingVerifications.get(sessionId);
    if (!pending) {
      console.log("[selfmolt] Session not found:", sessionId);
      return res.status(400).json({ error: "Invalid or expired verification session" });
    }
    
    const proofAgentKeyHash = result.userData?.userDefinedData?.substring(0, 16) || "";
    if (!proofAgentKeyHash) {
      console.log("[selfmolt] Missing agentKeyHash in proof userDefinedData");
      return res.status(400).json({ error: "Agent key binding required - proof must include agentKeyHash in userDefinedData" });
    }
    if (proofAgentKeyHash !== pending.agentKeyHash) {
      console.log("[selfmolt] Agent key hash mismatch:", proofAgentKeyHash, "vs", pending.agentKeyHash);
      return res.status(400).json({ error: "Agent key binding mismatch - proof does not match agent" });
    }
    
    const humanId = crypto.createHash("sha256")
      .update(JSON.stringify(publicSignals))
      .digest("hex")
      .substring(0, 16);
    
    const nationality = result.discloseOutput?.nationality;
    
    const existing = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, pending.agentPublicKey))
      .limit(1);

    const metadata = { 
      nationality, 
      verifiedVia: "selfxyz", 
      signatureVerified: pending.signatureVerified || false,
      lastUpdated: new Date().toISOString() 
    };

    if (existing.length > 0) {
      await db.update(verifiedBots)
        .set({
          humanId,
          metadata,
          verificationLevel: pending.signatureVerified ? "passport+signature" : "passport",
          verifiedAt: new Date()
        })
        .where(eq(verifiedBots.publicKey, pending.agentPublicKey));
    } else {
      const newBot: InsertVerifiedBot = {
        publicKey: pending.agentPublicKey,
        deviceId: pending.agentName || null,
        selfId: null,
        humanId,
        verificationLevel: pending.signatureVerified ? "passport+signature" : "passport",
        metadata
      };
      await db.insert(verifiedBots).values(newBot);
    }

    pendingVerifications.delete(sessionId);

    res.json({
      success: true,
      message: "Agent verified and registered",
      publicKey: pending.agentPublicKey,
      agentName: pending.agentName,
      humanId
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent/:identifier", async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    
    let agent = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, identifier))
      .limit(1);
    
    if (agent.length === 0) {
      agent = await db.select()
        .from(verifiedBots)
        .where(eq(verifiedBots.deviceId, identifier))
        .limit(1);
    }
    
    const foundAgent = agent[0];

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
      swarm: foundAgent.humanId ? `https://selfmolt.openclaw.ai/human/${foundAgent.humanId}` : null,
      metadata: foundAgent.metadata
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/bot/:identifier", async (req: Request, res: Response) => {
  res.redirect(301, `/api/selfmolt/v1/agent/${req.params.identifier}`);
});

router.get("/v1/human/:humanId", async (req: Request, res: Response) => {
  try {
    const { humanId } = req.params;
    
    const agents = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId));

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
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/verify", async (_req: Request, res: Response) => {
  res.status(410).json({
    error: "This endpoint is deprecated",
    message: "Use the Self.xyz verification flow instead: POST /api/selfmolt/v1/start-verification",
    docs: "https://selfmolt.openclaw.ai/developers"
  });
});

router.get("/v1/stats", async (_req: Request, res: Response) => {
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
    res.status(500).json({ error: error.message });
  }
});

export default router;
