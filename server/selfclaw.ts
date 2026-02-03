import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { verifiedBots, verificationSessions, type InsertVerifiedBot, type InsertVerificationSession } from "../shared/schema.js";
import { eq, and, gt, lt, sql } from "drizzle-orm";
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from "@selfxyz/core";
import { SelfAppBuilder } from "@selfxyz/qrcode";
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
const SELFCLAW_STAGING = process.env.SELFCLAW_STAGING === "true";
const SELFCLAW_ENDPOINT = process.env.SELFCLAW_CALLBACK_URL 
  || (process.env.REPLIT_DOMAINS 
    ? `https://${process.env.REPLIT_DOMAINS}/api/selfclaw/v1/callback`
    : "http://localhost:5000/api/selfclaw/v1/callback");

console.log(`[selfclaw] Callback endpoint: ${SELFCLAW_ENDPOINT}`);
console.log(`[selfclaw] Staging mode: ${SELFCLAW_STAGING}`);

const selfBackendVerifier = new SelfBackendVerifier(
  SELFCLAW_SCOPE,
  SELFCLAW_ENDPOINT,
  SELFCLAW_STAGING,
  AllIds,
  new DefaultConfigStore({
    minimumAge: 18,
    excludedCountries: [],
    ofac: false,
  }),
  "uuid"
);

// Debug: Store last verification attempt for debugging production issues
interface DebugVerificationAttempt {
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

let lastVerificationAttempt: DebugVerificationAttempt | null = null;

// Store history of raw callback requests for debugging
interface RawCallbackRequest {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyPreview: string;
  contentType?: string;
  contentLength?: string;
  ip?: string;
}
const recentCallbackRequests: RawCallbackRequest[] = [];

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
    
    // Build properly formatted Self app config using the official SDK
    const userDefinedData = agentKeyHash.padEnd(128, '0');
    const selfApp = new SelfAppBuilder({
      version: 2,
      appName: "SelfClaw",
      logoBase64: "https://selfclaw.app/favicon.png",
      scope: SELFCLAW_SCOPE,
      endpoint: SELFCLAW_ENDPOINT,
      endpointType: SELFCLAW_STAGING ? "staging_https" : "https",
      userId: sessionId,
      userIdType: "uuid",
      userDefinedData: userDefinedData,
      disclosures: {
        minimumAge: 18,
        excludedCountries: [],
        ofac: false
      }
    }).build();
    
    res.json({
      success: true,
      sessionId,
      agentKeyHash,
      challenge,
      signatureRequired: !signatureVerified,
      signatureVerified,
      selfApp,
      config: {
        scope: SELFCLAW_SCOPE,
        endpoint: SELFCLAW_ENDPOINT,
        appName: "SelfClaw",
        version: 2,
        staging: SELFCLAW_STAGING
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

// Ping endpoint - ultra-minimal for connectivity testing
router.all("/v1/ping", (req: Request, res: Response) => {
  res.status(200).json({ pong: true, method: req.method, time: Date.now() });
});

// Health check for the API
router.get("/v1/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "healthy", endpoint: SELFCLAW_ENDPOINT });
});

router.get("/v1/callback", (req: Request, res: Response) => {
  res.status(200).json({ 
    status: "ok", 
    message: "SelfClaw callback endpoint. Use POST to submit verification proofs.",
    method: "GET not supported for verification"
  });
});

// Handle trailing slash variant to prevent redirects
router.get("/v1/callback/", (req: Request, res: Response) => {
  res.status(200).json({ 
    status: "ok", 
    message: "SelfClaw callback endpoint. Use POST to submit verification proofs.",
    method: "GET not supported for verification"
  });
});

// Test endpoint - minimal callback that just returns success to diagnose connectivity
router.post("/v1/callback-test", (req: Request, res: Response) => {
  console.log("[selfclaw] === TEST CALLBACK HIT ===");
  console.log("[selfclaw] Test body:", JSON.stringify(req.body || {}).substring(0, 500));
  res.status(200).json({ status: "success", result: true });
});

// Debug endpoint - echoes back everything for diagnostics
router.post("/v1/debug-callback", (req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  console.log("[selfclaw] === DEBUG CALLBACK ===", timestamp);
  console.log("[selfclaw] Method:", req.method);
  console.log("[selfclaw] Headers:", JSON.stringify(req.headers));
  console.log("[selfclaw] Body keys:", Object.keys(req.body || {}));
  console.log("[selfclaw] Full body:", JSON.stringify(req.body || {}).substring(0, 2000));
  
  res.status(200).json({ 
    status: "success", 
    result: true,
    debug: {
      timestamp,
      method: req.method,
      bodyKeys: Object.keys(req.body || {}),
      hasProof: !!req.body?.proof,
      hasPublicSignals: !!req.body?.publicSignals,
      hasAttestationId: !!req.body?.attestationId,
      hasUserContextData: !!req.body?.userContextData
    }
  });
});

// Shared callback handler function
async function handleCallback(req: Request, res: Response) {
  const rawTimestamp = new Date().toISOString();
  
  // Capture raw request immediately before any processing
  const rawRequest: RawCallbackRequest = {
    timestamp: rawTimestamp,
    method: req.method,
    url: req.originalUrl || req.url,
    headers: Object.fromEntries(
      Object.entries(req.headers)
        .filter(([_, v]) => typeof v === 'string')
        .map(([k, v]) => [k, String(v).substring(0, 200)])
    ),
    bodyPreview: JSON.stringify(req.body || {}).substring(0, 1000),
    contentType: req.get('content-type'),
    contentLength: req.get('content-length'),
    ip: req.ip || req.get('x-forwarded-for') || 'unknown'
  };
  
  // Store in recent requests (keep last 10)
  recentCallbackRequests.unshift(rawRequest);
  if (recentCallbackRequests.length > 10) {
    recentCallbackRequests.pop();
  }
  
  console.log("[selfclaw] === CALLBACK REQUEST RECEIVED ===");
  console.log("[selfclaw] Time:", rawTimestamp);
  console.log("[selfclaw] IP:", rawRequest.ip);
  console.log("[selfclaw] Content-Type:", rawRequest.contentType);
  console.log("[selfclaw] Content-Length:", rawRequest.contentLength);
  console.log("[selfclaw] Headers:", JSON.stringify(rawRequest.headers).substring(0, 500));
  console.log("[selfclaw] Body preview:", rawRequest.bodyPreview);
  
  // Initialize debug tracking
  lastVerificationAttempt = {
    timestamp: rawTimestamp,
    hasProof: false,
    hasPublicSignals: false,
    finalStatus: "in_progress"
  };
  
  try {
    const body = req.body || {};
    console.log("[selfclaw] Body keys:", Object.keys(body));
    console.log("[selfclaw] Body preview:", JSON.stringify(body).substring(0, 800));
    
    const { attestationId, proof, publicSignals, userContextData } = body;
    
    // Update debug info
    lastVerificationAttempt.attestationId = attestationId;
    lastVerificationAttempt.hasProof = !!proof;
    lastVerificationAttempt.hasPublicSignals = !!publicSignals;
    lastVerificationAttempt.publicSignalsLength = publicSignals?.length;
    lastVerificationAttempt.userId = userContextData?.userIdentifier;
    lastVerificationAttempt.sessionId = userContextData?.userIdentifier;
    
    if (!proof || !publicSignals || !attestationId || !userContextData) {
      console.log("[selfclaw] Missing fields - attestationId:", !!attestationId, "proof:", !!proof, "publicSignals:", !!publicSignals, "userContextData:", !!userContextData);
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Missing required verification data";
      return res.status(200).json({ status: "error", result: false, reason: "Missing required verification data" });
    }
    
    console.log("[selfclaw] All required fields present, verifying proof...");
    console.log("[selfclaw] attestationId:", attestationId);
    console.log("[selfclaw] publicSignals length:", publicSignals?.length || 0);
    console.log("[selfclaw] userContextData:", JSON.stringify(userContextData || {}).substring(0, 200));
    
    let result;
    try {
      result = await selfBackendVerifier.verify(
        attestationId,
        proof,
        publicSignals,
        userContextData
      );
      console.log("[selfclaw] Verification result:", JSON.stringify(result.isValidDetails));
      lastVerificationAttempt.verifyResult = result.isValidDetails;
    } catch (verifyError: any) {
      console.error("[selfclaw] SDK verify() threw error:", verifyError.message);
      console.error("[selfclaw] Error stack:", verifyError.stack);
      lastVerificationAttempt.sdkError = verifyError.message;
      lastVerificationAttempt.sdkErrorStack = verifyError.stack?.substring(0, 500);
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "SDK verify() threw: " + verifyError.message;
      return res.status(200).json({ 
        status: "error", 
        result: false, 
        reason: "Proof verification error: " + verifyError.message 
      });
    }
    
    if (!result.isValidDetails.isValid) {
      console.log("[selfclaw] Proof invalid:", result.isValidDetails);
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Proof invalid: " + JSON.stringify(result.isValidDetails);
      return res.status(200).json({ 
        status: "error",
        result: false,
        reason: "Proof verification failed"
      });
    }
    console.log("[selfclaw] Proof verified successfully!");
    
    // Debug: log full userData to understand sessionId/userId mapping
    console.log("[selfclaw] Full userData:", JSON.stringify(result.userData || {}, null, 2));
    console.log("[selfclaw] userIdentifier:", result.userData?.userIdentifier);
    console.log("[selfclaw] userDefinedData:", result.userData?.userDefinedData);
    console.log("[selfclaw] userDefinedData type:", typeof result.userData?.userDefinedData);
    
    const sessionId = result.userData?.userIdentifier;
    console.log("[selfclaw] Session ID from proof:", sessionId);
    if (!sessionId) {
      console.log("[selfclaw] No session ID in proof userData");
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Missing session ID in proof userData";
      return res.status(200).json({ status: "error", result: false, reason: "Missing session ID in proof" });
    }
    
    console.log("[selfclaw] Looking up session:", sessionId);
    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, sessionId),
        eq(verificationSessions.status, "pending"),
        gt(verificationSessions.challengeExpiry, new Date())
      ))
      .limit(1);
    
    const session = sessions[0];
    console.log("[selfclaw] Session found:", !!session, session ? `status=${session.status}` : "");
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
    
    // Debug: extract and compare agent key hash
    // Self.xyz SDK hex-encodes the userDefinedData, so we need to decode it
    const rawUserDefinedData = result.userData?.userDefinedData || "";
    console.log("[selfclaw] Raw userDefinedData length:", rawUserDefinedData.length);
    console.log("[selfclaw] Raw userDefinedData first 64 chars:", rawUserDefinedData.substring(0, 64));
    console.log("[selfclaw] Session agentKeyHash:", session.agentKeyHash);
    
    // Decode hex-encoded ASCII: each 2 hex chars = 1 ASCII char
    // We need 16 chars of agentKeyHash, so take first 32 hex chars
    let proofAgentKeyHash = "";
    const hexPortion = rawUserDefinedData.substring(0, 32);
    try {
      for (let i = 0; i < hexPortion.length; i += 2) {
        const hexByte = hexPortion.substring(i, i + 2);
        const charCode = parseInt(hexByte, 16);
        if (!isNaN(charCode) && charCode > 0) {
          proofAgentKeyHash += String.fromCharCode(charCode);
        }
      }
    } catch (e) {
      console.log("[selfclaw] Failed to decode hex userDefinedData:", e);
    }
    
    console.log("[selfclaw] Decoded proofAgentKeyHash:", proofAgentKeyHash);
    console.log("[selfclaw] Comparison: '", proofAgentKeyHash, "' === '", session.agentKeyHash, "':", proofAgentKeyHash === session.agentKeyHash);
    
    if (!proofAgentKeyHash) {
      console.log("[selfclaw] Missing agentKeyHash in proof userDefinedData");
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Missing agentKeyHash in userDefinedData";
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding required" });
    }
    if (proofAgentKeyHash !== session.agentKeyHash) {
      console.log("[selfclaw] Agent key hash mismatch:", proofAgentKeyHash, "vs", session.agentKeyHash);
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = `Agent key mismatch: proof='${proofAgentKeyHash}' vs session='${session.agentKeyHash}'`;
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding mismatch" });
    }
    
    const humanId = crypto.createHash("sha256")
      .update(JSON.stringify(publicSignals))
      .digest("hex")
      .substring(0, 16);
    
    // Sanitize nationality - remove null characters that can break JSONB
    let nationality = result.discloseOutput?.nationality || null;
    if (nationality && typeof nationality === 'string') {
      nationality = nationality.replace(/\u0000/g, '').trim() || null;
    }
    
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

    try {
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
    } catch (dbError: any) {
      console.error("[selfclaw] Database insert/update error:", dbError.message);
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Database error: " + dbError.message;
      return res.status(200).json({ status: "error", result: false, reason: "Failed to save verification" });
    }

    await db.update(verificationSessions)
      .set({ status: "verified" })
      .where(eq(verificationSessions.id, sessionId));

    console.log("[selfclaw] === CALLBACK SUCCESS === Agent registered:", session.agentPublicKey || session.agentName);
    lastVerificationAttempt.finalStatus = "success";
    lastVerificationAttempt.finalReason = "Agent verified and registered";
    res.status(200).json({
      status: "success",
      result: true
    });
  } catch (error: any) {
    console.error("[selfclaw] === CALLBACK ERROR ===", error);
    lastVerificationAttempt.finalStatus = "error";
    lastVerificationAttempt.finalReason = "Callback handler error: " + (error.message || "Unknown error");
    res.status(200).json({ status: "error", result: false, reason: error.message || "Unknown error" });
  }
}

// Register callback for both with and without trailing slash (avoid redirects which break Self.xyz app)
router.post("/v1/callback", handleCallback);
router.post("/v1/callback/", handleCallback);

// Polling endpoint for frontend to check verification status
router.get("/v1/status/:sessionId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    
    // Check verification sessions table
    const sessions = await db.select()
      .from(verificationSessions)
      .where(sql`${verificationSessions.id} = ${sessionId}`)
      .limit(1);
    
    if (sessions.length === 0) {
      return res.json({ status: "not_found" });
    }
    
    const session = sessions[0];
    
    // If session is verified, check if agent was registered
    if (session.status === "verified" && session.agentPublicKey) {
      const agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${session.agentPublicKey}`)
        .limit(1);
      
      if (agents.length > 0) {
        return res.json({
          status: "verified",
          agent: {
            publicKey: agents[0].publicKey,
            deviceId: agents[0].deviceId,
            humanId: agents[0].humanId,
            verifiedAt: agents[0].verifiedAt
          }
        });
      }
    }
    
    // Check for expired session
    if (session.status === "expired" || (session.challengeExpiry && new Date(session.challengeExpiry) < new Date())) {
      return res.json({ status: "expired" });
    }
    
    // Still pending
    return res.json({ status: "pending" });
  } catch (error: any) {
    console.error("[selfclaw] status check error:", error);
    res.status(500).json({ error: error.message });
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
    
    if (!identifier || identifier.length < 2) {
      return res.json({
        verified: false,
        publicKey: identifier || "",
        message: "Invalid identifier"
      });
    }
    
    let agents: any[] = [];
    
    try {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${identifier}`)
        .limit(1);
    } catch (dbError) {
      console.error("[selfclaw] DB error on publicKey lookup:", dbError);
    }
    
    if (agents.length === 0) {
      try {
        agents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.deviceId} = ${identifier}`)
          .limit(1);
      } catch (dbError) {
        console.error("[selfclaw] DB error on deviceId lookup:", dbError);
      }
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
    return res.json({
      verified: false,
      publicKey: req.params.identifier || "",
      message: "Lookup failed"
    });
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

// Debug endpoint to see last verification attempt (for debugging production issues)
router.get("/v1/debug-status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    config: {
      endpoint: SELFCLAW_ENDPOINT,
      scope: SELFCLAW_SCOPE,
      staging: SELFCLAW_STAGING
    },
    lastVerificationAttempt: lastVerificationAttempt || { message: "No verification attempts yet" },
    recentCallbackRequests: recentCallbackRequests.length > 0 
      ? recentCallbackRequests 
      : [{ message: "No callback requests received yet" }],
    callbackRequestCount: recentCallbackRequests.length
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
