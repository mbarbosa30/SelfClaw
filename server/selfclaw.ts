import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { verifiedBots, verificationSessions, sponsoredAgents, trackedPools, agentWallets, agentActivity, type InsertVerifiedBot, type InsertVerificationSession } from "../shared/schema.js";
import { eq, and, gt, lt, sql, desc, count } from "drizzle-orm";
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from "@selfxyz/core";
import { SelfAppBuilder } from "@selfxyz/qrcode";
import crypto from "crypto";
import * as ed from "@noble/ed25519";
import { createAgentWallet, getAgentWalletByHumanId, sendGasSubsidy, getGasWalletInfo, recoverWalletClient, isExternalWallet } from "../lib/secure-wallet.js";
import { erc8004Service } from "../lib/erc8004.js";
import { generateRegistrationFile } from "../lib/erc8004-config.js";
import { createPublicClient, http, parseUnits, formatUnits, encodeFunctionData, getContractAddress } from 'viem';
import { celo } from 'viem/chains';
import { TOKEN_FACTORY_BYTECODE } from '../lib/constants.js';

const router = Router();

async function cleanupExpiredSessions() {
  try {
    const result = await db.update(verificationSessions)
      .set({ status: "expired" })
      .where(and(
        eq(verificationSessions.status, "pending"),
        lt(verificationSessions.challengeExpiry, new Date())
      ));
  } catch (error) {
    console.error("[selfclaw] Session cleanup error:", error);
  }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
cleanupExpiredSessions();

async function logActivity(eventType: string, humanId?: string, agentPublicKey?: string, agentName?: string, metadata?: any) {
  try {
    await db.insert(agentActivity).values({ eventType, humanId, agentPublicKey, agentName, metadata });
  } catch (e: any) {
    console.error("[selfclaw] activity log error:", e.message);
  }
}

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
    domain: "selfclaw.ai",
    action: "verify-agent",
    sessionId,
    agentKeyHash,
    timestamp,
    nonce,
    expiresAt: timestamp + 10 * 60 * 1000
  });
}

function extractRawEd25519Key(publicKeyBase64: string): Uint8Array {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  if (bytes.length === 32) {
    return bytes;
  }
  if (bytes.length === 44 && bytes[0] === 0x30 && bytes[1] === 0x2a) {
    return bytes.subarray(12);
  }
  return bytes;
}

function decodeSignature(signature: string): Uint8Array {
  if (/^[0-9a-fA-F]{128}$/.test(signature)) {
    return Buffer.from(signature, "hex");
  }
  const b64 = Buffer.from(signature, "base64");
  if (b64.length === 64) {
    return b64;
  }
  return Buffer.from(signature, "hex");
}

async function verifyEd25519Signature(
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

const usedNonces = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(key);
  }
}, 60 * 1000);

async function authenticateAgent(req: Request, res: Response): Promise<{ publicKey: string; humanId: string; agent: any } | null> {
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
    res.status(401).json({ error: "Invalid signature. Sign the exact JSON: " + messageToSign });
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
      logoBase64: "https://selfclaw.ai/favicon.png",
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
  
  // Initialize debug tracking
  lastVerificationAttempt = {
    timestamp: rawTimestamp,
    hasProof: false,
    hasPublicSignals: false,
    finalStatus: "in_progress"
  };
  
  try {
    const body = req.body || {};
    const { attestationId, proof, publicSignals, userContextData } = body;
    
    // Update debug info
    lastVerificationAttempt.attestationId = attestationId;
    lastVerificationAttempt.hasProof = !!proof;
    lastVerificationAttempt.hasPublicSignals = !!publicSignals;
    lastVerificationAttempt.publicSignalsLength = publicSignals?.length;
    lastVerificationAttempt.userId = userContextData?.userIdentifier;
    lastVerificationAttempt.sessionId = userContextData?.userIdentifier;
    
    if (!proof || !publicSignals || !attestationId || !userContextData) {
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Missing required verification data";
      return res.status(200).json({ status: "error", result: false, reason: "Missing required verification data" });
    }
    
    let result;
    try {
      result = await selfBackendVerifier.verify(
        attestationId,
        proof,
        publicSignals,
        userContextData
      );
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
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Proof invalid: " + JSON.stringify(result.isValidDetails);
      return res.status(200).json({ 
        status: "error",
        result: false,
        reason: "Proof verification failed"
      });
    }
    
    const sessionId = result.userData?.userIdentifier;
    if (!sessionId) {
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Missing session ID in proof userData";
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
      await db.update(verificationSessions)
        .set({ status: "expired" })
        .where(and(
          eq(verificationSessions.id, sessionId),
          eq(verificationSessions.status, "pending")
        ));
      return res.status(200).json({ status: "error", result: false, reason: "Invalid or expired verification session" });
    }
    
    // Self.xyz SDK hex-encodes the userDefinedData, so we need to decode it
    const rawUserDefinedData = result.userData?.userDefinedData || "";
    
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
    }
    
    if (!proofAgentKeyHash) {
      lastVerificationAttempt.finalStatus = "error";
      lastVerificationAttempt.finalReason = "Missing agentKeyHash in userDefinedData";
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding required" });
    }
    if (proofAgentKeyHash !== session.agentKeyHash) {
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

    const proofHash = crypto.createHash("sha256")
      .update(attestationId + ":" + JSON.stringify(proof) + ":" + JSON.stringify(publicSignals))
      .digest("hex");

    const metadata = { 
      nationality, 
      verifiedVia: "selfxyz", 
      signatureVerified: session.signatureVerified || false,
      lastUpdated: new Date().toISOString(),
      zkProof: {
        attestationId,
        proof,
        publicSignals,
        proofHash,
        verifiedAt: new Date().toISOString()
      }
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
    logActivity("verification", humanId, session.agentPublicKey, session.agentName || undefined);
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
          },
          nextSteps: {
            message: "Your agent is verified! Unlock the token economy.",
            command: "Read https://selfclaw.ai/agent-economy.md to deploy tokens, create liquidity pools, and trade with other agents.",
            features: [
              "Deploy your own ERC20 token",
              "Create Uniswap V4 liquidity pools",
              "Trade and swap tokens on Celo",
              "Earn yield on Aave",
              "Sell skills in the marketplace"
            ]
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

    const qMeta = foundAgent.metadata as any || {};
    const { zkProof: qZkProof, ...qPublicMetadata } = qMeta;

    const qRepData: any = {
      hasErc8004: !!qPublicMetadata.erc8004TokenId,
      endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/reputation`,
      registryAddress: erc8004Service.getReputationRegistryAddress()
    };
    if (qPublicMetadata.erc8004TokenId) {
      qRepData.erc8004TokenId = qPublicMetadata.erc8004TokenId;
      qRepData.attestation = qPublicMetadata.erc8004Attestation || null;
    }

    const { erc8004TokenId: _qt, erc8004Attestation: _qa, ...qCleanMetadata } = qPublicMetadata;

    res.json({
      verified: true,
      publicKey: foundAgent.publicKey,
      agentName: foundAgent.deviceId,
      humanId: foundAgent.humanId,
      selfxyz: {
        verified: true,
        registeredAt: foundAgent.verifiedAt
      },
      proof: {
        available: !!qZkProof,
        hash: qZkProof?.proofHash || null,
        endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/proof`
      },
      reputation: qRepData,
      swarm: foundAgent.humanId ? `https://selfclaw.ai/human/${foundAgent.humanId}` : null,
      metadata: qCleanMetadata,
      economy: {
        enabled: true,
        playbook: "https://selfclaw.ai/agent-economy.md",
        capabilities: ["deploy_token", "create_liquidity_pool", "swap_tokens", "aave_supply", "invoke_skill"]
      }
    });
  } catch (error) {
    console.error("Query param agent lookup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/agent/:identifier/proof", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;

    if (!identifier || identifier.length < 2) {
      return res.status(400).json({ error: "Invalid identifier" });
    }

    let agents: any[] = [];
    try {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${identifier}`)
        .limit(1);
    } catch (dbError) {
      console.error("[selfclaw] DB error on proof lookup:", dbError);
    }

    if (agents.length === 0) {
      try {
        agents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.deviceId} = ${identifier}`)
          .limit(1);
      } catch (dbError) {
        console.error("[selfclaw] DB error on proof deviceId lookup:", dbError);
      }
    }

    const foundAgent = agents[0];
    if (!foundAgent) {
      return res.status(404).json({ error: "Agent not found in registry" });
    }

    const agentMeta = foundAgent.metadata as any || {};
    const zkProof = agentMeta.zkProof;

    if (!zkProof) {
      return res.json({
        publicKey: foundAgent.publicKey,
        proofAvailable: false,
        message: "This agent was verified before proof storage was enabled. The verification is valid but the raw proof is not available for independent re-verification."
      });
    }

    res.json({
      publicKey: foundAgent.publicKey,
      humanId: foundAgent.humanId,
      proofAvailable: true,
      verifiedAt: zkProof.verifiedAt,
      proofHash: zkProof.proofHash,
      attestationId: zkProof.attestationId,
      proof: zkProof.proof,
      publicSignals: zkProof.publicSignals,
      verification: {
        method: "selfxyz",
        description: "Zero-knowledge passport proof via Self.xyz. Verify independently using the Self.xyz SDK.",
        howToVerify: [
          "Install @selfxyz/core: npm install @selfxyz/core",
          "Import SelfBackendVerifier from @selfxyz/core",
          "Create verifier with scope 'selfclaw-verify' and attestationId 'selfclaw-passport'",
          "Call verifier.verify(attestationId, proof, publicSignals) with the data above",
          "If isValid is true, the agent's human backing is cryptographically confirmed"
        ],
        sdkDocs: "https://docs.self.xyz"
      }
    });
  } catch (error: any) {
    console.error("[selfclaw] proof lookup error:", error);
    return res.status(500).json({ error: "Proof lookup failed" });
  }
});

router.get("/v1/agent/:identifier/reputation", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;

    if (!identifier || identifier.length < 2) {
      return res.status(400).json({ error: "Invalid identifier" });
    }

    let agentRecords: any[] = [];
    agentRecords = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${identifier}`)
      .limit(1);

    if (agentRecords.length === 0) {
      agentRecords = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.deviceId} = ${identifier}`)
        .limit(1);
    }

    const agent = agentRecords[0];
    if (!agent) {
      return res.status(404).json({ error: "Agent not found in registry" });
    }

    const meta = agent.metadata as any || {};
    const tokenId = meta.erc8004TokenId;

    if (!tokenId) {
      return res.json({
        publicKey: agent.publicKey,
        humanId: agent.humanId,
        hasErc8004: false,
        message: "This agent does not have an ERC-8004 identity NFT. Mint one first to build on-chain reputation.",
        reputationRegistry: erc8004Service.getReputationRegistryAddress()
      });
    }

    const [summary, feedback] = await Promise.all([
      erc8004Service.getReputationSummary(tokenId),
      erc8004Service.readAllFeedback(tokenId)
    ]);

    res.json({
      publicKey: agent.publicKey,
      humanId: agent.humanId,
      erc8004TokenId: tokenId,
      hasErc8004: true,
      reputationRegistry: erc8004Service.getReputationRegistryAddress(),
      attestation: meta.erc8004Attestation || null,
      summary: summary || { totalFeedback: 0, averageScore: 0, lastUpdated: 0 },
      feedback: feedback || [],
      explorerUrl: erc8004Service.getExplorerUrl(tokenId)
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Serve ERC-8004 registration.json for any agent (public, used as agentURI on-chain)
router.get("/v1/agent/:identifier/registration.json", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier as string;
    const regAgents = await db.select()
      .from(verifiedBots)
      .where(
        sql`${verifiedBots.publicKey} = ${identifier} OR ${verifiedBots.deviceId} = ${identifier}`
      )
      .limit(1);
    
    if (!regAgents.length) {
      return res.status(404).json({ error: "Agent not found" });
    }
    
    const regAgent = regAgents[0];
    const regMetadata = (regAgent.metadata as Record<string, any>) || {};
    
    if (!regMetadata.erc8004RegistrationJson) {
      return res.status(404).json({ error: "No ERC-8004 registration file generated yet" });
    }
    
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(regMetadata.erc8004RegistrationJson);
  } catch (error: any) {
    console.error("[selfclaw] registration.json error:", error);
    res.status(500).json({ error: error.message });
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

    const meta = foundAgent.metadata as any || {};
    const { zkProof, ...publicMetadata } = meta;

    const reputationData: any = {
      hasErc8004: !!publicMetadata.erc8004TokenId,
      endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/reputation`,
      registryAddress: erc8004Service.getReputationRegistryAddress()
    };
    if (publicMetadata.erc8004TokenId) {
      reputationData.erc8004TokenId = publicMetadata.erc8004TokenId;
      reputationData.attestation = publicMetadata.erc8004Attestation || null;
    }

    const { erc8004TokenId: _t, erc8004Attestation: _a, ...cleanMetadata } = publicMetadata;

    res.json({
      verified: true,
      publicKey: foundAgent.publicKey,
      agentName: foundAgent.deviceId,
      humanId: foundAgent.humanId,
      selfxyz: {
        verified: true,
        registeredAt: foundAgent.verifiedAt
      },
      proof: {
        available: !!zkProof,
        hash: zkProof?.proofHash || null,
        endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/proof`
      },
      reputation: reputationData,
      swarm: foundAgent.humanId ? `https://selfclaw.ai/human/${foundAgent.humanId}` : null,
      metadata: cleanMetadata,
      economy: {
        enabled: true,
        playbook: "https://selfclaw.ai/agent-economy.md",
        capabilities: ["deploy_token", "create_liquidity_pool", "swap_tokens", "aave_supply", "invoke_skill"]
      }
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
    docs: "https://selfclaw.ai/developers"
  });
});

router.get("/v1/stats", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const [totalResult] = await db.select({ count: count() }).from(verifiedBots);
    const [humanResult] = await db.select({ count: sql<number>`COUNT(DISTINCT ${verifiedBots.humanId})` }).from(verifiedBots);

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [last24hResult] = await db.select({ count: count() })
      .from(verifiedBots)
      .where(gt(verifiedBots.verifiedAt, oneDayAgo));

    const latestAgent = await db.select({ verifiedAt: verifiedBots.verifiedAt })
      .from(verifiedBots)
      .orderBy(desc(verifiedBots.verifiedAt))
      .limit(1);

    res.json({
      totalAgents: totalResult?.count || 0,
      uniqueHumans: humanResult?.count || 0,
      last24h: last24hResult?.count || 0,
      latestVerification: latestAgent[0]?.verifiedAt || null
    });
  } catch (error: any) {
    console.error("[selfclaw] stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/sponsorship/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const humanId = req.params.humanId as string;
    const { getSponsorshipStatus, checkSponsorshipEligibility, getSponsorWalletInfo } = await import("../lib/sponsored-liquidity.js");
    
    const status = await getSponsorshipStatus(humanId);
    const eligibility = await checkSponsorshipEligibility(humanId);
    const walletInfo = await getSponsorWalletInfo();
    
    res.json({
      humanId,
      ...status,
      eligible: eligibility.eligible,
      eligibilityReason: eligibility.reason,
      sponsorWallet: walletInfo.address,
      sponsorConfig: {
        amountPerAgent: walletInfo.sponsorAmountPerAgent,
        programActive: walletInfo.canSponsor
      }
    });
  } catch (error: any) {
    console.error("[selfclaw] sponsorship status error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/create-sponsored-lp", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const humanId = auth.humanId;
    const { agentId, tokenAddress, tokenSymbol, tokenAmount, initialPriceInCelo } = req.body;
    
    if (!tokenAddress || !tokenAmount || !initialPriceInCelo) {
      return res.status(400).json({
        error: "Missing required fields: tokenAddress, tokenAmount, initialPriceInCelo"
      });
    }
    
    const { createSponsoredLP, getSponsorWalletInfo } = await import("../lib/sponsored-liquidity.js");
    
    const result = await createSponsoredLP({
      humanId,
      agentId: agentId || '',
      tokenAddress,
      tokenSymbol: tokenSymbol || 'TOKEN',
      tokenAmount,
      initialPriceInCelo
    });
    
    if (!result.success) {
      const walletInfo = await getSponsorWalletInfo();
      return res.status(result.alreadySponsored ? 409 : 400).json({
        error: result.error,
        alreadySponsored: result.alreadySponsored,
        sponsorWallet: walletInfo.address,
        instructions: result.error?.includes('Insufficient tokens') ? 
          `Send ${tokenAmount} tokens to ${walletInfo.address} then retry` : undefined
      });
    }
    
    logActivity("sponsorship", humanId, auth.publicKey, undefined, { 
      tokenAddress, tokenSymbol, celoAmount: result.celoAmount 
    });
    res.json({
      success: true,
      message: "Sponsored liquidity pool created",
      pool: {
        tokenAddress,
        tokenSymbol,
        tokenAmount: result.tokenAmount,
        celoAmount: result.celoAmount,
        txHash: result.txHash
      },
      nextSteps: [
        "Your token is now tradeable on Uniswap",
        "View your pool at: https://app.uniswap.org",
        "Read the playbook: https://selfclaw.ai/agent-economy.md"
      ]
    });
  } catch (error: any) {
    console.error("[selfclaw] create-sponsored-lp error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/selfclaw-sponsorship", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const { getSelfclawBalance } = await import("../lib/uniswap-v4.js");
    const balance = await getSelfclawBalance();
    const available = parseFloat(balance);
    
    res.json({
      available: balance,
      token: "SELFCLAW (Wrapped on Celo)",
      tokenAddress: "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb",
      description: "SELFCLAW available for agent token liquidity sponsorship. Verified agents can request this to pair with their token in a Uniswap V4 pool.",
      poolFeeTier: "1% (10000)",
      requirements: [
        "Agent must be verified via Self.xyz passport",
        "Agent must have deployed a token on Celo",
        "Agent sends chosen amount of its token to sponsor wallet",
        "System creates AgentToken/SELFCLAW pool with 1% fee tier"
      ]
    });
  } catch (error: any) {
    console.error("[selfclaw] selfclaw-sponsorship error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/request-selfclaw-sponsorship", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const humanId = auth.humanId;
    const { tokenAddress, tokenSymbol, tokenAmount, selfclawAmount } = req.body;

    if (!tokenAddress || !tokenAmount || !selfclawAmount) {
      return res.status(400).json({
        error: "Missing required fields: tokenAddress, tokenAmount, selfclawAmount"
      });
    }

    const existingSponsorship = await db.select()
      .from(sponsoredAgents)
      .where(eq(sponsoredAgents.humanId, humanId))
      .limit(1);

    if (existingSponsorship.length > 0) {
      return res.status(409).json({
        error: "This identity has already received a sponsorship",
        alreadySponsored: true,
        existingPool: existingSponsorship[0].poolAddress,
        existingToken: existingSponsorship[0].tokenAddress
      });
    }

    const { getSelfclawBalance, getTokenBalance, createPoolAndAddLiquidity } = await import("../lib/uniswap-v4.js");

    const agentTokenBalance = await getTokenBalance(tokenAddress);
    const requiredAmount = parseFloat(tokenAmount);
    const heldAmount = parseFloat(agentTokenBalance);

    if (heldAmount < requiredAmount) {
      const { getSponsorWalletInfo } = await import("../lib/sponsored-liquidity.js");
      const walletInfo = await getSponsorWalletInfo();
      return res.status(400).json({
        error: `Sponsor wallet does not hold enough of your agent token. Has ${agentTokenBalance}, needs ${tokenAmount}`,
        sponsorWallet: walletInfo.address,
        instructions: `Send ${tokenAmount} of your token (${tokenAddress}) to ${walletInfo.address} before requesting sponsorship`
      });
    }

    const availableBalance = await getSelfclawBalance();
    const requested = parseFloat(selfclawAmount);
    const available = parseFloat(availableBalance);

    if (requested > available) {
      return res.status(400).json({
        error: `Insufficient SELFCLAW. Requested ${selfclawAmount}, available ${availableBalance}`,
        available: availableBalance
      });
    }

    const selfclawAddress = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";

    const result = await createPoolAndAddLiquidity({
      tokenA: tokenAddress,
      tokenB: selfclawAddress,
      amountA: tokenAmount,
      amountB: selfclawAmount,
      feeTier: 10000,
    });

    if (!result.success) {
      return res.status(400).json({
        error: result.error
      });
    }

    await db.insert(sponsoredAgents).values({
      humanId,
      publicKey: auth.publicKey,
      tokenAddress,
      tokenSymbol: tokenSymbol || 'TOKEN',
      poolAddress: result.poolAddress || '',
      sponsoredAmountCelo: selfclawAmount,
      sponsorTxHash: result.txHash || '',
      status: 'completed',
      completedAt: new Date(),
    });

    logActivity("selfclaw_sponsorship", humanId, auth.publicKey, undefined, {
      tokenAddress,
      tokenSymbol: tokenSymbol || 'TOKEN',
      tokenAmount,
      selfclawAmount,
      poolAddress: result.poolAddress,
      positionTokenId: result.positionTokenId,
    });

    res.json({
      success: true,
      message: "AgentToken/SELFCLAW liquidity pool created",
      pool: {
        poolAddress: result.poolAddress,
        positionTokenId: result.positionTokenId,
        tokenAddress,
        tokenAmount,
        selfclawAmount,
        feeTier: 10000,
        txHash: result.txHash
      },
      nextSteps: [
        "Your token is now tradeable against SELFCLAW on Uniswap V4",
        "Trading fees (1%) accrue to the SelfClaw treasury",
        "View on Celoscan: https://celoscan.io/address/" + (result.poolAddress || tokenAddress)
      ]
    });
  } catch (error: any) {
    console.error("[selfclaw] request-selfclaw-sponsorship error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/recent", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const recentAgents = await db.select({
      publicKey: verifiedBots.publicKey,
      deviceId: verifiedBots.deviceId,
      verificationLevel: verifiedBots.verificationLevel,
      verifiedAt: verifiedBots.verifiedAt
    })
    .from(verifiedBots)
    .orderBy(sql`${verifiedBots.verifiedAt} DESC`)
    .limit(50);
    
    res.json({ agents: recentAgents });
  } catch (error: any) {
    console.error("[selfclaw] recent error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/ecosystem-stats", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const [verifiedCount] = await db.select({ count: count() }).from(verifiedBots);
    const [sponsoredCount] = await db.select({ count: count() }).from(sponsoredAgents).where(eq(sponsoredAgents.status, 'completed'));
    const [poolsCount] = await db.select({ count: count() }).from(trackedPools);
    
    res.json({
      verifiedAgents: verifiedCount?.count || 0,
      sponsoredAgents: sponsoredCount?.count || 0,
      trackedPools: poolsCount?.count || 0,
      lastUpdated: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[selfclaw] ecosystem-stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Reputation leaderboard — ranks all agents with ERC-8004 tokens by on-chain reputation
router.get("/v1/reputation-leaderboard", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const limitParam = Math.min(Number(req.query.limit) || 50, 100);

    const allAgents = await db.select({
      id: verifiedBots.id,
      publicKey: verifiedBots.publicKey,
      deviceId: verifiedBots.deviceId,
      humanId: verifiedBots.humanId,
      verifiedAt: verifiedBots.verifiedAt,
      metadata: verifiedBots.metadata
    })
    .from(verifiedBots)
    .orderBy(desc(verifiedBots.verifiedAt));

    const agentsWithTokens = allAgents.filter(a => {
      const meta = a.metadata as any;
      return meta?.erc8004TokenId;
    });

    if (agentsWithTokens.length === 0) {
      return res.json({
        leaderboard: [],
        totalWithErc8004: 0,
        message: "No agents with ERC-8004 tokens yet"
      });
    }

    if (!erc8004Service.isReady()) {
      return res.status(503).json({
        error: "ERC-8004 contracts not available",
        totalWithErc8004: agentsWithTokens.length
      });
    }

    let failedQueries = 0;
    const reputationResults = await Promise.allSettled(
      agentsWithTokens.map(async (agent) => {
        const meta = agent.metadata as any;
        const tokenId = meta.erc8004TokenId;
        const summary = await erc8004Service.getReputationSummary(tokenId);
        return {
          publicKey: agent.publicKey,
          agentName: agent.deviceId,
          humanId: agent.humanId,
          erc8004TokenId: tokenId,
          verifiedAt: agent.verifiedAt,
          hasAttestation: !!meta.erc8004Attestation?.txHash,
          reputation: summary || { totalFeedback: 0, averageScore: 0, lastUpdated: 0 },
          explorerUrl: erc8004Service.getExplorerUrl(tokenId),
          reputationEndpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(agent.publicKey)}/reputation`
        };
      })
    );

    const succeeded: any[] = [];
    for (const r of reputationResults) {
      if (r.status === "fulfilled") {
        succeeded.push(r.value);
      } else {
        failedQueries++;
      }
    }

    const leaderboard = succeeded
      .sort((a, b) => {
        if (b.reputation.averageScore !== a.reputation.averageScore) {
          return b.reputation.averageScore - a.reputation.averageScore;
        }
        return b.reputation.totalFeedback - a.reputation.totalFeedback;
      })
      .slice(0, limitParam)
      .map((entry, index) => ({ rank: index + 1, ...entry }));

    res.json({
      leaderboard,
      totalWithErc8004: agentsWithTokens.length,
      queriedSuccessfully: succeeded.length,
      failedQueries,
      warning: failedQueries > 0 ? `${failedQueries} agent(s) could not be scored due to on-chain query failures` : undefined,
      reputationRegistry: erc8004Service.getReputationRegistryAddress(),
      lastUpdated: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation-leaderboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Feedback cooldown: one feedback per rater per target per 24 hours
const feedbackCooldowns = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, ts] of feedbackCooldowns) {
    if (ts < cutoff) feedbackCooldowns.delete(key);
  }
}, 10 * 60 * 1000);

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many feedback submissions. Max 10 per hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Judge/peer feedback — verified agents or judges can submit reputation feedback for other agents
router.post("/v1/reputation/feedback", feedbackLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { targetAgentPublicKey, score, tag1, tag2, feedbackURI } = req.body;

    if (!targetAgentPublicKey || score === undefined) {
      return res.status(400).json({
        error: "targetAgentPublicKey and score are required",
        hint: "score should be 0-100 (0=worst, 100=best). Optional: tag1, tag2, feedbackURI"
      });
    }

    const numericScore = Number(score);
    if (isNaN(numericScore) || numericScore < 0 || numericScore > 100) {
      return res.status(400).json({ error: "score must be between 0 and 100" });
    }

    if (targetAgentPublicKey === auth.publicKey) {
      return res.status(400).json({ error: "Cannot submit feedback for your own agent" });
    }

    const cooldownKey = `${auth.publicKey}:${targetAgentPublicKey}`;
    const lastFeedback = feedbackCooldowns.get(cooldownKey);
    if (lastFeedback && Date.now() - lastFeedback < 24 * 60 * 60 * 1000) {
      const hoursLeft = Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - lastFeedback)) / (60 * 60 * 1000));
      return res.status(429).json({
        error: `You already submitted feedback for this agent. Try again in ~${hoursLeft} hour(s).`
      });
    }

    const targetRecords = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${targetAgentPublicKey}`)
      .limit(1);

    if (targetRecords.length === 0) {
      return res.status(404).json({ error: "Target agent not found in registry" });
    }

    const targetMeta = targetRecords[0].metadata as any || {};
    const targetTokenId = targetMeta.erc8004TokenId;

    if (!targetTokenId) {
      return res.status(400).json({
        error: "Target agent does not have an ERC-8004 identity NFT",
        hint: "The target agent must mint an ERC-8004 token before receiving reputation feedback"
      });
    }

    if (!erc8004Service.isReady()) {
      return res.status(503).json({ error: "ERC-8004 contracts not available" });
    }

    const identity = await erc8004Service.getAgentIdentity(targetTokenId);
    if (!identity) {
      return res.status(400).json({ error: "Target agent's ERC-8004 token not found on-chain" });
    }

    const feedbackData = JSON.stringify({
      type: "peer-feedback",
      from: auth.publicKey,
      fromHumanId: auth.humanId,
      score: numericScore,
      tag1: tag1 || "general",
      tag2: tag2 || "",
      submittedAt: new Date().toISOString()
    });

    const { ethers } = await import("ethers");
    const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(feedbackData));

    const config = erc8004Service.getConfig();
    const wallet = process.env.CELO_PRIVATE_KEY
      ? new ethers.Wallet(process.env.CELO_PRIVATE_KEY, new ethers.JsonRpcProvider(config.rpcUrl))
      : null;

    if (!wallet) {
      return res.status(503).json({ error: "Platform wallet not configured for reputation transactions" });
    }

    const REPUTATION_REGISTRY_ABI = [
      "function giveFeedback(uint256 agentId, uint256 score, uint8 decimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external"
    ];

    const reputation = new ethers.Contract(config.resolver, REPUTATION_REGISTRY_ABI, wallet);

    const tx = await reputation.giveFeedback(
      targetTokenId,
      numericScore,
      0,
      tag1 || "peer-review",
      tag2 || "hackathon",
      `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(auth.publicKey)}`,
      feedbackURI || "",
      feedbackHash
    );

    const receipt = await tx.wait();

    feedbackCooldowns.set(cooldownKey, Date.now());

    console.log(`[selfclaw] Peer feedback: ${auth.publicKey.substring(0, 20)}... gave score ${numericScore} to ${targetAgentPublicKey.substring(0, 20)}... tx: ${receipt.hash}`);

    res.json({
      success: true,
      txHash: receipt.hash,
      explorerUrl: erc8004Service.getTxExplorerUrl(receipt.hash),
      feedback: {
        from: auth.publicKey,
        to: targetAgentPublicKey,
        score: numericScore,
        tag1: tag1 || "peer-review",
        tag2: tag2 || "hackathon"
      },
      reputationRegistry: erc8004Service.getReputationRegistryAddress()
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation feedback error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/reputation/attest", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { erc8004TokenId } = req.body;

    if (!erc8004TokenId) {
      return res.status(400).json({
        error: "erc8004TokenId is required",
        hint: "The agent must have an ERC-8004 identity NFT"
      });
    }

    const agentPublicKey = auth.publicKey;
    const agent = auth.agent;
    const meta = agent.metadata as any || {};

    if (meta.erc8004Attestation?.txHash) {
      return res.status(409).json({
        error: "Attestation already submitted for this agent",
        txHash: meta.erc8004Attestation.txHash,
        explorerUrl: erc8004Service.getTxExplorerUrl(meta.erc8004Attestation.txHash)
      });
    }

    if (!erc8004Service.isReady()) {
      return res.status(503).json({ error: "ERC-8004 contracts not available" });
    }

    const identity = await erc8004Service.getAgentIdentity(erc8004TokenId);
    if (!identity) {
      return res.status(400).json({
        error: "ERC-8004 token not found on-chain",
        hint: "Ensure the token has been minted on the Identity Registry before submitting attestation"
      });
    }

    const attestation = await erc8004Service.submitVerificationAttestation(erc8004TokenId);

    if (!attestation) {
      return res.status(500).json({ error: "Attestation submission failed" });
    }

    await db.update(verifiedBots)
      .set({
        metadata: {
          ...meta,
          erc8004TokenId,
          erc8004Attestation: {
            txHash: attestation.txHash,
            submittedAt: new Date().toISOString(),
            registryAddress: erc8004Service.getReputationRegistryAddress()
          }
        }
      })
      .where(sql`${verifiedBots.publicKey} = ${agentPublicKey}`);

    console.log("[selfclaw] Reputation attestation submitted for agent:", agentPublicKey, "tokenId:", erc8004TokenId, "tx:", attestation.txHash);

    res.json({
      success: true,
      txHash: attestation.txHash,
      explorerUrl: erc8004Service.getTxExplorerUrl(attestation.txHash),
      reputationRegistry: erc8004Service.getReputationRegistryAddress(),
      message: "SelfClaw verification attestation submitted to ERC-8004 Reputation Registry"
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation attest error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/create-wallet", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const humanId = auth.humanId;
    const agentPublicKey = auth.publicKey;
    const { existingWalletAddress } = req.body;
    
    const result = await createAgentWallet(humanId, agentPublicKey, existingWalletAddress);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    if (!result.alreadyExists) {
      logActivity("wallet_creation", humanId, auth.publicKey, undefined, { 
        isExternal: result.isExternalWallet || false, address: result.address 
      });
    }
    res.json({
      success: true,
      address: result.address,
      alreadyExists: result.alreadyExists || false,
      isExternalWallet: result.isExternalWallet || false,
      message: result.alreadyExists 
        ? "Wallet already exists for this humanId" 
        : result.isExternalWallet
          ? "External wallet linked successfully. You manage your own keys."
          : "Wallet created successfully. Request gas to activate it."
    });
  } catch (error: any) {
    console.error("[selfclaw] create-wallet error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/wallet/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const humanId = req.params.humanId as string;
    
    if (!humanId) {
      return res.status(400).json({ error: "humanId is required" });
    }
    
    const wallet = await getAgentWalletByHumanId(humanId);
    
    if (!wallet) {
      return res.status(404).json({ error: "No wallet found for this humanId" });
    }
    
    res.json({
      address: wallet.address,
      gasReceived: wallet.gasReceived,
      balance: wallet.balance
    });
  } catch (error: any) {
    console.error("[selfclaw] wallet lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/wallet-verify/:address", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string;
    
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.json({
        verified: false,
        address: address || "",
        message: "Invalid wallet address format"
      });
    }

    const wallets = await db.select()
      .from(agentWallets)
      .where(sql`LOWER(${agentWallets.address}) = LOWER(${address})`)
      .limit(1);

    if (wallets.length === 0) {
      return res.json({
        verified: false,
        address,
        message: "Wallet not found in SelfClaw registry"
      });
    }

    const wallet = wallets[0];
    const isExternal = wallet.encryptedPrivateKey === 'external';

    const agents = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, wallet.humanId))
      .limit(1);

    const agent = agents[0];
    if (!agent) {
      return res.json({
        verified: false,
        address,
        message: "Wallet exists but no verified agent found"
      });
    }

    const meta = (agent.metadata as any) || {};

    res.json({
      verified: true,
      address: wallet.address,
      walletType: isExternal ? "external" : "managed",
      agent: {
        publicKey: agent.publicKey,
        agentName: agent.deviceId,
        registeredAt: agent.verifiedAt,
        humanId: agent.humanId
      },
      identity: {
        hasErc8004: !!meta.erc8004TokenId,
        erc8004TokenId: meta.erc8004TokenId || null,
        scan8004Url: meta.erc8004TokenId ? `https://www.8004scan.io/agents/${meta.erc8004TokenId}` : null
      },
      swarm: {
        endpoint: `https://selfclaw.ai/api/selfclaw/v1/human/${agent.humanId}`,
      },
      lookup: {
        agentEndpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(agent.publicKey)}`,
        proofEndpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(agent.publicKey)}/proof`
      }
    });
  } catch (error: any) {
    console.error("[selfclaw] wallet-verify error:", error);
    return res.json({
      verified: false,
      address: req.params.address || "",
      message: "Lookup failed"
    });
  }
});

router.post("/v1/request-gas", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const humanId = auth.humanId;
    
    const result = await sendGasSubsidy(humanId);
    
    if (!result.success) {
      return res.status(400).json({ 
        error: result.error,
        alreadyReceived: result.alreadyReceived || false
      });
    }
    
    logActivity("gas_request", humanId, auth.publicKey, undefined, { 
      txHash: result.txHash, amountCelo: result.amountCelo 
    });
    res.json({
      success: true,
      txHash: result.txHash,
      amountCelo: result.amountCelo,
      message: `Sent ${result.amountCelo} CELO for gas. You can now register ERC-8004 and deploy tokens.`
    });
  } catch (error: any) {
    console.error("[selfclaw] request-gas error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/gas-info", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const info = await getGasWalletInfo();
    res.json(info);
  } catch (error: any) {
    console.error("[selfclaw] gas-info error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/pools", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const pools = await db.select()
      .from(trackedPools)
      .orderBy(desc(trackedPools.createdAt))
      .limit(100);
    
    res.json({
      pools,
      totalPools: pools.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[selfclaw] pools error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Simple ERC20 ABI for token operations
const SIMPLE_ERC20_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const viemPublicClient = createPublicClient({
  chain: celo,
  transport: http()
});

// ============================================================
// PUBLIC API: Token Economy Endpoints
// ============================================================
// These endpoints use humanId authorization for write operations.
// Read operations (GET) are public since blockchain data is public.
// Tokens deployed via public API are tracked on-chain (Celoscan).
// ============================================================

// Deploy token endpoint
router.post("/v1/deploy-token", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { name, symbol, initialSupply } = req.body;
    const humanId = auth.humanId;
    
    if (!name || !symbol || !initialSupply) {
      return res.status(400).json({ 
        error: "name, symbol, and initialSupply are required" 
      });
    }
    
    if (await isExternalWallet(humanId)) {
      return res.status(400).json({ 
        error: "This feature requires a SelfClaw-managed wallet. Your account uses an external wallet — use your own tooling to deploy tokens from your wallet directly." 
      });
    }

    const walletData = await recoverWalletClient(humanId);
    if (!walletData) {
      return res.status(400).json({ error: "No wallet found. Create a wallet first." });
    }
    
    const decimals = 18;
    const supplyWithDecimals = parseUnits(initialSupply.toString(), decimals);
    
    // Encode constructor args
    const { AbiCoder } = await import('ethers');
    const abiCoder = new AbiCoder();
    const encodedArgs = abiCoder.encode(
      ['string', 'string', 'uint256'],
      [name, symbol, supplyWithDecimals.toString()]
    ).slice(2);
    
    const deployData = (TOKEN_FACTORY_BYTECODE + encodedArgs) as `0x${string}`;
    
    // Deploy the token
    const hash = await walletData.walletClient.sendTransaction({
      account: walletData.account,
      chain: celo,
      data: deployData,
      gas: 2000000n,
    });
    
    const receipt = await viemPublicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      return res.status(500).json({ error: "Contract deployment failed" });
    }
    
    console.log(`[selfclaw] Deployed token ${symbol} at ${receipt.contractAddress} for humanId ${humanId.substring(0, 16)}...`);
    
    logActivity("token_deployment", humanId, auth.publicKey, undefined, { 
      tokenAddress: receipt.contractAddress, symbol, name, supply: initialSupply 
    });
    res.json({
      success: true,
      tokenAddress: receipt.contractAddress,
      txHash: hash,
      name,
      symbol,
      supply: initialSupply,
      creatorAddress: walletData.address,
      explorerUrl: `https://celoscan.io/token/${receipt.contractAddress}`
    });
  } catch (error: any) {
    console.error("[selfclaw] deploy-token error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Transfer token endpoint
router.post("/v1/transfer-token", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { tokenAddress, toAddress, amount } = req.body;
    const humanId = auth.humanId;
    
    if (!tokenAddress || !toAddress || !amount) {
      return res.status(400).json({ 
        error: "tokenAddress, toAddress, and amount are required" 
      });
    }
    
    if (await isExternalWallet(humanId)) {
      return res.status(400).json({ 
        error: "This feature requires a SelfClaw-managed wallet. Your account uses an external wallet — use your own tooling to transfer tokens directly." 
      });
    }

    const walletData = await recoverWalletClient(humanId);
    if (!walletData) {
      return res.status(400).json({ error: "No wallet found. Create a wallet first." });
    }
    
    // Get token decimals
    const decimals = await viemPublicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: SIMPLE_ERC20_ABI,
      functionName: 'decimals'
    });
    
    const amountParsed = parseUnits(amount.toString(), decimals);
    
    // Encode transfer call
    const data = encodeFunctionData({
      abi: SIMPLE_ERC20_ABI,
      functionName: 'transfer',
      args: [toAddress as `0x${string}`, amountParsed]
    });
    
    // Execute transfer
    const hash = await walletData.walletClient.sendTransaction({
      account: walletData.account,
      chain: celo,
      to: tokenAddress as `0x${string}`,
      data,
      gas: 100000n,
    });
    
    const receipt = await viemPublicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status !== 'success') {
      return res.status(500).json({ error: "Token transfer failed" });
    }
    
    console.log(`[selfclaw] Transferred ${amount} tokens to ${toAddress} for humanId ${humanId.substring(0, 16)}...`);
    
    res.json({
      success: true,
      txHash: hash,
      amount,
      toAddress,
      tokenAddress,
      explorerUrl: `https://celoscan.io/tx/${hash}`
    });
  } catch (error: any) {
    console.error("[selfclaw] transfer-token error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Register ERC-8004 on-chain identity
router.post("/v1/register-erc8004", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { agentName, description } = req.body;
    const humanId = auth.humanId;
    
    const walletInfo = await getAgentWalletByHumanId(humanId);
    if (!walletInfo || !walletInfo.address) {
      return res.status(400).json({ error: "No wallet found. Create a wallet first." });
    }
    
    if (!erc8004Service.isReady()) {
      return res.status(503).json({ error: "ERC-8004 contracts not available yet" });
    }
    
    const agent = auth.agent;
    const existingMetadata = (agent.metadata as Record<string, any>) || {};
    if (existingMetadata.erc8004Minted) {
      return res.status(400).json({
        error: "Already registered",
        tokenId: existingMetadata.erc8004TokenId,
        explorerUrl: erc8004Service.getExplorerUrl(existingMetadata.erc8004TokenId),
      });
    }

    const domain = process.env.REPLIT_DOMAINS || "selfclaw.ai";
    const agentIdentifier = agent.publicKey || agent.deviceId;

    const registrationJson = generateRegistrationFile(
      agentName || agent.deviceId || "Verified Agent",
      description || "A verified AI agent on SelfClaw — passport-verified, sybil-resistant",
      walletInfo.address,
      undefined,
      `https://${domain}`,
      undefined,
      true,
    );
    
    const registrationURL = `https://${domain}/api/selfclaw/v1/agent/${agentIdentifier}/registration.json`;
    
    await db.update(verifiedBots)
      .set({
        metadata: {
          ...existingMetadata,
          erc8004RegistrationJson: registrationJson,
        }
      })
      .where(eq(verifiedBots.id, agent.id));
    
    const result = await erc8004Service.registerAgent(registrationURL);
    
    if (!result) {
      return res.status(500).json({ error: "Failed to register on-chain identity" });
    }

    const updatedRegistrationJson = {
      ...registrationJson,
      registrations: [{
        agentRegistry: `eip155:${erc8004Service.getConfig().chainId}:${erc8004Service.getConfig().identityRegistry}`,
        agentId: result.tokenId,
        supportedTrust: registrationJson.supportedTrust,
      }],
    };
    
    await db.update(verifiedBots)
      .set({
        metadata: {
          ...existingMetadata,
          erc8004TokenId: result.tokenId,
          erc8004Minted: true,
          erc8004TxHash: result.txHash,
          erc8004RegistrationJson: updatedRegistrationJson,
        }
      })
      .where(eq(verifiedBots.id, agent.id));
    
    console.log(`[selfclaw] Registered ERC-8004 identity #${result.tokenId} for humanId ${humanId.substring(0, 16)}...`);
    
    res.json({
      success: true,
      tokenId: result.tokenId,
      txHash: result.txHash,
      agentURI: registrationURL,
      registrationJson: updatedRegistrationJson,
      explorerUrl: erc8004Service.getTxExplorerUrl(result.txHash),
      scan8004Url: `https://www.8004scan.io/agents/${result.tokenId}`,
    });
  } catch (error: any) {
    console.error("[selfclaw] register-erc8004 error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get token balance
router.get("/v1/token-balance/:humanId/:tokenAddress", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const humanId = req.params.humanId as string;
    const tokenAddress = req.params.tokenAddress as string;
    
    if (!humanId || !tokenAddress) {
      return res.status(400).json({ error: "humanId and tokenAddress are required" });
    }
    
    // Get wallet
    const walletInfo = await getAgentWalletByHumanId(humanId);
    if (!walletInfo || !walletInfo.address) {
      return res.status(404).json({ error: "No wallet found for this humanId" });
    }
    
    // Get token balance and decimals
    const [balance, decimals] = await Promise.all([
      viemPublicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: SIMPLE_ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletInfo.address as `0x${string}`]
      }),
      viemPublicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: SIMPLE_ERC20_ABI,
        functionName: 'decimals'
      })
    ]);
    
    res.json({
      tokenAddress,
      walletAddress: walletInfo.address,
      balance: balance.toString(),
      formattedBalance: formatUnits(balance, decimals),
      decimals
    });
  } catch (error: any) {
    console.error("[selfclaw] token-balance error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get ERC-8004 status for a humanId
router.get("/v1/erc8004/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const humanId = req.params.humanId as string;
    
    if (!humanId) {
      return res.status(400).json({ error: "humanId is required" });
    }
    
    // Get verified agent
    const verified = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId))
      .limit(1);
    
    if (verified.length === 0) {
      return res.status(404).json({ error: "No verified agent found for this humanId" });
    }
    
    const agent = verified[0];
    const metadata = (agent.metadata as Record<string, any>) || {};
    
    res.json({
      humanId,
      registered: !!metadata.erc8004Minted,
      tokenId: metadata.erc8004TokenId || null,
      txHash: metadata.erc8004TxHash || null,
      registrationJson: metadata.erc8004RegistrationJson || null,
      config: erc8004Service.getConfig()
    });
  } catch (error: any) {
    console.error("[selfclaw] erc8004 status error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/dashboard", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalVerifiedResult,
      uniqueHumansResult,
      verified24hResult,
      verified7dResult,
      totalWalletsResult,
      externalWalletsResult,
      gasSubsidiesResult,
      completedSponsorsResult,
      totalPoolsResult,
      celoLiquidityResult,
      timelineResult,
      recentActivityResult,
      funnelResult
    ] = await Promise.all([
      db.select({ value: count() }).from(verifiedBots),
      db.select({ value: sql<number>`count(distinct ${verifiedBots.humanId})` }).from(verifiedBots),
      db.select({ value: count() }).from(verifiedBots).where(gt(verifiedBots.verifiedAt, oneDayAgo)),
      db.select({ value: count() }).from(verifiedBots).where(gt(verifiedBots.verifiedAt, sevenDaysAgo)),
      db.select({ value: count() }).from(agentWallets),
      db.select({ value: count() }).from(agentWallets).where(eq(agentWallets.encryptedPrivateKey, 'external')),
      db.select({ value: count() }).from(agentWallets).where(eq(agentWallets.gasReceived, true)),
      db.select({ value: count() }).from(sponsoredAgents).where(eq(sponsoredAgents.status, 'completed')),
      db.select({ value: count() }).from(trackedPools),
      db.select({ value: sql<string>`coalesce(sum(cast(${trackedPools.initialCeloLiquidity} as numeric)), 0)` }).from(trackedPools),
      db.select({
        date: sql<string>`to_char(${agentActivity.createdAt}, 'YYYY-MM-DD')`,
        eventType: agentActivity.eventType,
        eventCount: count()
      }).from(agentActivity)
        .where(gt(agentActivity.createdAt, thirtyDaysAgo))
        .groupBy(sql`to_char(${agentActivity.createdAt}, 'YYYY-MM-DD')`, agentActivity.eventType)
        .orderBy(sql`to_char(${agentActivity.createdAt}, 'YYYY-MM-DD')`),
      db.select({
        id: agentActivity.id,
        eventType: agentActivity.eventType,
        agentName: agentActivity.agentName,
        createdAt: agentActivity.createdAt
      }).from(agentActivity).orderBy(desc(agentActivity.createdAt)).limit(20),
      db.select({
        status: verificationSessions.status,
        statusCount: count()
      }).from(verificationSessions).groupBy(verificationSessions.status)
    ]);

    const totalWallets = totalWalletsResult[0]?.value ?? 0;
    const externalWallets = externalWalletsResult[0]?.value ?? 0;
    const managedWallets = Number(totalWallets) - Number(externalWallets);

    const timelineMap: Record<string, Record<string, number>> = {};
    for (const row of timelineResult) {
      if (!timelineMap[row.date]) {
        timelineMap[row.date] = { verification: 0, wallet_creation: 0, token_deployment: 0, gas_request: 0, sponsorship: 0 };
      }
      timelineMap[row.date][row.eventType] = Number(row.eventCount);
    }
    const activityTimeline = Object.entries(timelineMap).map(([date, events]) => ({ date, events }));

    const funnelMap: Record<string, number> = { pending: 0, verified: 0, expired: 0, failed: 0 };
    for (const row of funnelResult) {
      if (row.status && row.status in funnelMap) {
        funnelMap[row.status] = Number(row.statusCount);
      }
    }

    res.json({
      registry: {
        totalVerifiedAgents: Number(totalVerifiedResult[0]?.value ?? 0),
        uniqueHumans: Number(uniqueHumansResult[0]?.value ?? 0),
        verifiedLast24h: Number(verified24hResult[0]?.value ?? 0),
        verifiedLast7d: Number(verified7dResult[0]?.value ?? 0)
      },
      wallets: {
        total: Number(totalWallets),
        external: Number(externalWallets),
        managed: managedWallets,
        gasSubsidies: Number(gasSubsidiesResult[0]?.value ?? 0)
      },
      tokenEconomy: {
        sponsoredAgents: Number(completedSponsorsResult[0]?.value ?? 0),
        trackedPools: Number(totalPoolsResult[0]?.value ?? 0),
        totalCeloLiquidity: String(celoLiquidityResult[0]?.value ?? "0")
      },
      activityTimeline,
      recentActivity: recentActivityResult,
      verificationFunnel: funnelMap,
      generatedAt: now.toISOString()
    });
  } catch (error: any) {
    console.error("[selfclaw] dashboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
