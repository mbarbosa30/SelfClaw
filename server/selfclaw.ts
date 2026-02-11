import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { verifiedBots, verificationSessions, sponsoredAgents, trackedPools, agentWallets, agentActivity, tokenPlans, revenueEvents, agentServices, costEvents, type InsertVerifiedBot, type InsertVerificationSession } from "../shared/schema.js";
import { eq, and, gt, lt, sql, desc, count, isNotNull } from "drizzle-orm";
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from "@selfxyz/core";
import { SelfAppBuilder } from "@selfxyz/qrcode";
import crypto from "crypto";
import * as ed from "@noble/ed25519";
import { createAgentWallet, getAgentWallet, getAgentWalletByHumanId, sendGasSubsidy, getGasWalletInfo, switchWallet } from "../lib/secure-wallet.js";
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
function getCanonicalDomain(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (!domains) return "localhost:5000";
  const parts = domains.split(",").map(d => d.trim()).filter(Boolean);
  const custom = parts.find(d => d.endsWith(".ai") || d.endsWith(".com") || d.endsWith(".app"));
  return custom || parts[parts.length - 1] || domains;
}
const CANONICAL_DOMAIN = getCanonicalDomain();
const SELFCLAW_ENDPOINT = process.env.SELFCLAW_CALLBACK_URL 
  || `https://${CANONICAL_DOMAIN}/api/selfclaw/v1/callback`;

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
let lastV3FeeCollectionTime = 0;
const V3_FEE_COLLECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const deployEconomySessions = new Map<string, {
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

function extractRawEd25519Key(publicKeyInput: string): Uint8Array {
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

function decodeSignature(signature: string): Uint8Array {
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

    if (agentName) {
      const existingAgents = await db.select()
        .from(verifiedBots)
        .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${agentName})`)
        .limit(1);
      if (existingAgents.length > 0 && existingAgents[0].publicKey !== agentPublicKey) {
        return res.status(400).json({
          error: "Agent name already taken",
          suggestion: "Try a different name like '" + agentName + "-" + Date.now().toString(36) + "'"
        });
      }
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

router.get("/v1/verification-status/:sessionId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const sessions = await db.select()
      .from(verificationSessions)
      .where(sql`${verificationSessions.id} = ${sessionId}`)
      .limit(1);

    if (sessions.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessions[0];

    if (session.challengeExpiry && new Date(session.challengeExpiry) < new Date()) {
      return res.json({
        status: "expired",
        sessionId,
        agentPublicKey: session.agentPublicKey,
        signatureVerified: session.signatureVerified,
        agentName: session.agentName
      });
    }

    res.json({
      status: session.status,
      sessionId,
      agentPublicKey: session.agentPublicKey,
      signatureVerified: session.signatureVerified,
      agentName: session.agentName
    });
  } catch (error: any) {
    console.error("[selfclaw] verification-status error:", error);
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
              "Create Uniswap liquidity pools",
              "Trade and swap tokens across EVM chains",
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

    const [tokensResult] = await db.select({ count: count() })
      .from(sponsoredAgents)
      .where(isNotNull(sponsoredAgents.tokenAddress));

    res.json({
      totalAgents: totalResult?.count || 0,
      uniqueHumans: humanResult?.count || 0,
      last24h: last24hResult?.count || 0,
      tokensDeployed: tokensResult?.count || 0,
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

router.post("/v1/create-sponsored-lp", verificationLimiter, async (_req: Request, res: Response) => {
  res.status(410).json({
    error: "This endpoint has been deprecated. Use POST /api/selfclaw/v1/request-selfclaw-sponsorship instead.",
    newEndpoint: "/api/selfclaw/v1/request-selfclaw-sponsorship",
    requiredFields: { tokenAddress: "Your deployed token address", tokenAmount: "Amount of your token to add as liquidity" }
  });
});

router.get("/v1/selfclaw-sponsorship", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const { getSelfclawBalance, getSponsorAddress, getV3PoolState, SELFCLAW_CELO_V3_POOL } = await import("../lib/uniswap-v3.js");
    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;
    const balance = await getSelfclawBalance(sponsorKey);
    const sponsorAddress = getSponsorAddress(sponsorKey);

    let selfclawPriceInCelo: string | null = null;
    let celoUsd: number | null = null;
    let selfclawPriceUsd: number | null = null;
    let sponsorValueUsd: number | null = null;
    let halfValueUsd: number | null = null;

    try {
      const [poolState, celoRes] = await Promise.all([
        getV3PoolState(SELFCLAW_CELO_V3_POOL),
        fetch('https://api.coingecko.com/api/v3/simple/price?ids=celo&vs_currencies=usd').then((r: any) => r.json()).catch(() => null),
      ]);
      selfclawPriceInCelo = poolState.price;
      if (celoRes?.celo?.usd) {
        celoUsd = celoRes.celo.usd;
        selfclawPriceUsd = parseFloat(selfclawPriceInCelo!) * celoUsd!;
        sponsorValueUsd = parseFloat(balance) * selfclawPriceUsd;
        halfValueUsd = sponsorValueUsd / 2;
      }
    } catch (priceErr: any) {
      console.warn("[selfclaw] sponsorship price fetch warning:", priceErr.message);
    }

    res.json({
      available: balance,
      sponsorableAmount: (parseFloat(balance) / 2).toFixed(2),
      token: "SELFCLAW (Wrapped on Celo)",
      tokenAddress: "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb",
      sponsorWallet: sponsorAddress,
      selfclawPriceInCelo,
      celoUsd,
      selfclawPriceUsd,
      sponsorValueUsd,
      halfValueUsd,
      description: "SELFCLAW available for agent token liquidity sponsorship. On request, fees are collected from the SELFCLAW/CELO pool, then 50% of sponsor balance is used to create an AgentToken/SELFCLAW pool. The sponsorable amount (50% of available) defines the initial liquidity pairing for your agent token.",
      poolFeeTier: "1% (10000)",
      poolVersion: "Uniswap V4",
      requirements: [
        "Agent must be verified via Self.xyz passport",
        "Agent must have deployed a token on Celo",
        "Agent sends chosen amount of its token to sponsor wallet",
        "System auto-collects fees, then creates AgentToken/SELFCLAW pool with 1% fee tier"
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
    const { tokenAddress, tokenSymbol, tokenAmount } = req.body;

    if (!tokenAddress || !tokenAmount) {
      return res.status(400).json({
        error: "Missing required fields: tokenAddress, tokenAmount"
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

    const {
      getSelfclawBalance, getTokenBalance, getSponsorAddress,
      createPoolAndAddLiquidity, getNextPositionTokenId, computePoolId, getPoolState,
      extractPositionTokenIdFromReceipt,
    } = await import("../lib/uniswap-v4.js");

    const { collectAllV3Fees } = await import("../lib/uniswap-v3.js");

    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;
    const sponsorAddress = getSponsorAddress(sponsorKey);

    const agentTokenBalance = await getTokenBalance(tokenAddress, 18, sponsorKey);
    const requiredAmount = parseFloat(tokenAmount);
    const heldAmount = parseFloat(agentTokenBalance);

    if (heldAmount < requiredAmount) {
      return res.status(400).json({
        error: `Sponsor wallet does not hold enough of your agent token. Has ${agentTokenBalance}, needs ${tokenAmount}`,
        sponsorWallet: sponsorAddress,
        instructions: `Send ${tokenAmount} of your token (${tokenAddress}) to ${sponsorAddress} before requesting sponsorship`
      });
    }

    const selfclawAddress = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";

    const now = Date.now();
    if (now - lastV3FeeCollectionTime >= V3_FEE_COLLECTION_COOLDOWN_MS) {
      console.log(`[selfclaw] Sponsorship requested by ${humanId.substring(0, 16)}... — collecting V3 fees`);
      try {
        const feeCollectionResult = await collectAllV3Fees(sponsorKey);
        lastV3FeeCollectionTime = Date.now();
        if (feeCollectionResult.success && parseFloat(feeCollectionResult.totalSelfclaw) > 0) {
          console.log(`[selfclaw] Collected ${feeCollectionResult.totalSelfclaw} SELFCLAW from V3 fee positions`);
        }
      } catch (feeErr: any) {
        console.log(`[selfclaw] V3 fee collection skipped: ${feeErr.message}`);
      }
    } else {
      console.log(`[selfclaw] V3 fee collection on cooldown (next in ${Math.round((V3_FEE_COLLECTION_COOLDOWN_MS - (now - lastV3FeeCollectionTime)) / 3600000)}h)`);
    }

    const availableBalance = await getSelfclawBalance(sponsorKey);
    const available = parseFloat(availableBalance);

    if (available <= 0) {
      return res.status(400).json({
        error: "No SELFCLAW available in sponsorship wallet. Fees not yet accrued.",
        available: availableBalance
      });
    }

    const selfclawAmount = (available * 0.5).toFixed(0);
    const selfclawForPool = selfclawAmount;

    console.log(`[selfclaw] Sponsoring with ${selfclawForPool} SELFCLAW via Uniswap V4 (50% of ${availableBalance} available)`);

    const tokenLower = tokenAddress.toLowerCase();
    const selfclawLower = selfclawAddress.toLowerCase();
    const token0 = tokenLower < selfclawLower ? tokenAddress : selfclawAddress;
    const token1 = tokenLower < selfclawLower ? selfclawAddress : tokenAddress;
    const feeTier = 10000;
    const tickSpacing = 200;
    const v4PoolId = computePoolId(token0, token1, feeTier, tickSpacing);

    try {
      const poolState = await getPoolState(v4PoolId as `0x${string}`);
      if (poolState.liquidity !== '0') {
        return res.status(409).json({
          error: "A V4 pool already exists for this token pair with active liquidity",
          v4PoolId,
        });
      }
    } catch (_poolCheckErr: any) {
    }

    const nextTokenIdBefore = await getNextPositionTokenId();

    const result = await createPoolAndAddLiquidity({
      tokenA: tokenAddress,
      tokenB: selfclawAddress,
      amountA: tokenAmount,
      amountB: selfclawForPool,
      feeTier,
      privateKey: sponsorKey,
    });

    if (!result.success) {
      return res.status(400).json({
        error: result.error
      });
    }

    let positionTokenId: string | null = null;
    if (result.receipt) {
      positionTokenId = extractPositionTokenIdFromReceipt(result.receipt);
    }
    if (!positionTokenId) {
      const nextTokenIdAfter = await getNextPositionTokenId();
      if (nextTokenIdAfter > nextTokenIdBefore) {
        positionTokenId = nextTokenIdBefore.toString();
      } else {
        console.warn(`[selfclaw] V4 position token ID could not be reliably determined (before=${nextTokenIdBefore}, after=${nextTokenIdAfter})`);
      }
    }

    await db.insert(sponsoredAgents).values({
      humanId,
      publicKey: auth.publicKey,
      tokenAddress,
      tokenSymbol: tokenSymbol || 'TOKEN',
      poolAddress: v4PoolId,
      v4PositionTokenId: positionTokenId,
      poolVersion: 'v4',
      sponsoredAmountCelo: selfclawForPool,
      sponsorTxHash: result.txHash || '',
      status: 'completed',
      completedAt: new Date(),
    });

    try {
      await db.insert(trackedPools).values({
        poolAddress: v4PoolId,
        tokenAddress,
        tokenSymbol: tokenSymbol || 'TOKEN',
        tokenName: req.body.tokenName || tokenSymbol || 'TOKEN',
        pairedWith: 'SELFCLAW',
        humanId,
        agentPublicKey: auth.publicKey,
        feeTier,
        v4PositionTokenId: positionTokenId,
        poolVersion: 'v4',
        v4PoolId,
        initialCeloLiquidity: selfclawForPool,
        initialTokenLiquidity: tokenAmount,
      }).onConflictDoNothing();
      console.log(`[selfclaw] V4 pool tracked: ${v4PoolId} for ${tokenSymbol || 'TOKEN'}/SELFCLAW (position ${positionTokenId || 'unknown'})`);
    } catch (poolTrackErr: any) {
      console.error(`[selfclaw] Failed to track pool: ${poolTrackErr.message}`);
    }

    logActivity("selfclaw_sponsorship", humanId, auth.publicKey, undefined, {
      tokenAddress,
      tokenSymbol: tokenSymbol || 'TOKEN',
      tokenAmount,
      selfclawAmount: selfclawForPool,
      v4PoolId,
      positionTokenId,
      poolVersion: 'v4',
      feesCollected: '0',
    });

    res.json({
      success: true,
      message: "AgentToken/SELFCLAW liquidity pool created on Uniswap V4",
      pool: {
        v4PoolId,
        positionTokenId,
        tokenAddress,
        tokenAmount,
        selfclawAmount: selfclawForPool,
        feeTier,
        txHash: result.txHash,
        poolVersion: 'v4',
      },
      sponsorship: {
        selfclawSponsored: selfclawForPool,
        feesCollected: '0',
        sponsorWallet: sponsorAddress,
      },
      nextSteps: [
        "Your token is now tradeable against SELFCLAW on Uniswap V4",
        "Trading fees (1%) accrue to the SelfClaw treasury for future sponsorships",
        "View on Celoscan: https://celoscan.io/tx/" + (result.txHash || '')
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

router.get("/v1/agents", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const limitParam = Math.min(Number(req.query.limit) || 50, 100);
    
    const agents = await db.select({
      publicKey: verifiedBots.publicKey,
      agentName: verifiedBots.deviceId,
      humanId: verifiedBots.humanId,
      verificationLevel: verifiedBots.verificationLevel,
      verifiedAt: verifiedBots.verifiedAt,
      metadata: verifiedBots.metadata,
      walletAddress: agentWallets.address,
      tokenAddress: trackedPools.tokenAddress,
      tokenSymbol: trackedPools.tokenSymbol,
      tokenName: trackedPools.tokenName,
      poolAddress: trackedPools.poolAddress,
      currentPriceCelo: trackedPools.currentPriceCelo,
      volume24h: trackedPools.volume24h,
      marketCapCelo: trackedPools.marketCapCelo,
      tokenPlanPurpose: tokenPlans.purpose,
      tokenPlanStatus: tokenPlans.status,
    })
    .from(verifiedBots)
    .leftJoin(agentWallets, sql`${verifiedBots.humanId} = ${agentWallets.humanId}`)
    .leftJoin(trackedPools, sql`${verifiedBots.humanId} = ${trackedPools.humanId}`)
    .leftJoin(tokenPlans, sql`${verifiedBots.humanId} = ${tokenPlans.humanId}`)
    .orderBy(desc(verifiedBots.verifiedAt))
    .limit(limitParam);
    
    const seen = new Set<string>();
    const formattedAgents = agents
      .filter(a => {
        if (seen.has(a.publicKey)) return false;
        seen.add(a.publicKey);
        return true;
      })
      .map(a => ({
        agentName: a.agentName || null,
        publicKey: a.publicKey,
        humanId: a.humanId,
        verificationLevel: a.verificationLevel || 'passport',
        verifiedAt: a.verifiedAt,
        hasErc8004: !!(a.metadata as any)?.erc8004TokenId,
        wallet: a.walletAddress ? { address: a.walletAddress } : null,
        token: a.tokenAddress ? {
          address: a.tokenAddress,
          symbol: a.tokenSymbol,
          name: a.tokenName,
        } : null,
        pool: a.poolAddress ? {
          address: a.poolAddress,
          priceCelo: a.currentPriceCelo,
          volume24h: a.volume24h,
          marketCapCelo: a.marketCapCelo,
        } : null,
        tokenPlan: a.tokenPlanPurpose ? {
          purpose: a.tokenPlanPurpose,
          status: a.tokenPlanStatus,
        } : null,
        profileUrl: a.agentName ? `/agent/${encodeURIComponent(a.agentName)}` : null,
      }));
    
    res.json({ agents: formattedAgents, total: formattedAgents.length });
  } catch (error: any) {
    console.error("[selfclaw] agents listing error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent-profile/:name", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    
    const agents = await db.select()
      .from(verifiedBots)
      .where(sql`lower(${verifiedBots.deviceId}) = ${(name || '').toLowerCase()}`)
      .limit(1);
    
    if (agents.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }
    
    const agent = agents[0];
    const humanId = agent.humanId;
    
    const [walletResults, poolResults, planResults, activityResults, revenueResults, serviceResults] = await Promise.all([
      humanId ? db.select().from(agentWallets).where(sql`${agentWallets.humanId} = ${humanId}`).limit(1) : Promise.resolve([]),
      humanId ? db.select().from(trackedPools).where(sql`${trackedPools.humanId} = ${humanId}`) : Promise.resolve([]),
      humanId ? db.select().from(tokenPlans).where(sql`${tokenPlans.humanId} = ${humanId}`).limit(1) : Promise.resolve([]),
      humanId ? db.select({
        id: agentActivity.id,
        eventType: agentActivity.eventType,
        agentName: agentActivity.agentName,
        metadata: agentActivity.metadata,
        createdAt: agentActivity.createdAt
      }).from(agentActivity).where(sql`${agentActivity.humanId} = ${humanId}`).orderBy(desc(agentActivity.createdAt)).limit(20) : Promise.resolve([]),
      humanId ? db.select().from(revenueEvents).where(sql`${revenueEvents.humanId} = ${humanId}`).orderBy(desc(revenueEvents.createdAt)).limit(20) : Promise.resolve([]),
      humanId ? db.select().from(agentServices).where(sql`${agentServices.humanId} = ${humanId} AND ${agentServices.active} = true`).orderBy(desc(agentServices.createdAt)) : Promise.resolve([])
    ]);
    
    const wallet = walletResults[0] || null;
    const pool = poolResults[0] || null;
    const plan = planResults[0] || null;
    const metadata = agent.metadata as any;

    const revenueTotals: Record<string, number> = {};
    for (const e of revenueResults) {
      revenueTotals[e.token] = (revenueTotals[e.token] || 0) + parseFloat(e.amount);
    }
    
    res.json({
      agent: {
        agentName: agent.deviceId,
        publicKey: agent.publicKey,
        humanId: agent.humanId,
        verificationLevel: agent.verificationLevel || 'passport',
        verifiedAt: agent.verifiedAt,
        erc8004: metadata?.erc8004TokenId ? {
          tokenId: metadata.erc8004TokenId,
          scanUrl: `https://www.8004scan.io/agents/${metadata.erc8004TokenId}`
        } : null,
      },
      wallet: wallet ? {
        address: wallet.address,
        gasReceived: wallet.gasReceived,
      } : null,
      token: pool ? {
        address: pool.tokenAddress,
        symbol: pool.tokenSymbol,
        name: pool.tokenName,
      } : null,
      pool: pool ? {
        address: pool.poolAddress,
        priceCelo: pool.currentPriceCelo,
        volume24h: pool.volume24h,
        marketCapCelo: pool.marketCapCelo,
        feeTier: pool.feeTier,
        pairedWith: pool.pairedWith,
      } : null,
      tokenPlan: plan ? {
        purpose: plan.purpose,
        supplyReasoning: plan.supplyReasoning,
        allocation: plan.allocation,
        utility: plan.utility,
        economicModel: plan.economicModel,
        status: plan.status,
      } : null,
      revenue: {
        totalEvents: revenueResults.length,
        totals: revenueTotals,
        recent: revenueResults.slice(0, 5).map(e => ({
          amount: e.amount,
          token: e.token,
          source: e.source,
          createdAt: e.createdAt,
        })),
      },
      services: serviceResults.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price: s.price,
        currency: s.currency,
        endpoint: s.endpoint,
      })),
      activity: activityResults,
    });
  } catch (error: any) {
    console.error("[selfclaw] agent-profile error:", error);
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
    const { walletAddress } = req.body;
    
    if (!walletAddress) {
      return res.status(400).json({ 
        error: "walletAddress is required. SelfClaw never stores private keys — provide your own EVM wallet address."
      });
    }

    const result = await createAgentWallet(humanId, agentPublicKey, walletAddress);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    if (!result.alreadyExists) {
      logActivity("wallet_creation", humanId, auth.publicKey, undefined, { 
        address: result.address 
      });
    }
    res.json({
      success: true,
      address: result.address,
      alreadyExists: result.alreadyExists || false,
      message: result.alreadyExists 
        ? "Wallet already registered for this humanId" 
        : "Wallet registered successfully. You keep your own keys."
    });
  } catch (error: any) {
    console.error("[selfclaw] create-wallet error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/switch-wallet", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const humanId = auth.humanId;
    const agentPublicKey = auth.publicKey;
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ 
        error: "walletAddress is required. Provide the new EVM wallet address you want to use."
      });
    }

    const result = await switchWallet(humanId, agentPublicKey, walletAddress);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    logActivity("wallet_switch", humanId, auth.publicKey, undefined, {
      previousAddress: result.previousAddress,
      newAddress: result.address,
    });

    res.json({
      success: true,
      address: result.address,
      previousAddress: result.previousAddress,
      message: "Wallet updated. You keep your own keys.",
    });
  } catch (error: any) {
    console.error("[selfclaw] switch-wallet error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/wallet/:identifier", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier as string;
    
    if (!identifier) {
      return res.status(400).json({ error: "humanId or agentPublicKey is required" });
    }
    
    const wallet = await getAgentWallet(identifier);
    if (wallet) {
      return res.json({
        address: wallet.address,
        gasReceived: wallet.gasReceived,
        balance: wallet.balance
      });
    }
    
    const allWallets = await db.select()
      .from(agentWallets)
      .where(eq(agentWallets.humanId, identifier));
    
    if (allWallets.length === 0) {
      return res.status(404).json({ error: "No wallet found" });
    }
    
    if (allWallets.length === 1) {
      const w = allWallets[0];
      return res.json({
        address: w.address,
        gasReceived: w.gasReceived,
      });
    }
    
    res.json({
      wallets: allWallets.map(w => ({
        address: w.address,
        agentPublicKey: w.publicKey,
        gasReceived: w.gasReceived,
      })),
      message: "Multiple wallets found for this humanId. Use agentPublicKey for precise lookup."
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
      walletType: "self-custody",
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
    
    const result = await sendGasSubsidy(humanId, auth.publicKey);
    
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

    const tokenPlanId = req.body.tokenPlanId;
    if (tokenPlanId) {
      const plans = await db.select()
        .from(tokenPlans)
        .where(sql`${tokenPlans.id} = ${tokenPlanId} AND ${tokenPlans.humanId} = ${humanId}`)
        .limit(1);
      if (plans.length === 0) {
        return res.status(400).json({ error: "Token plan not found or does not belong to this agent" });
      }
    }
    
    const decimals = 18;
    const supplyWithDecimals = parseUnits(initialSupply.toString(), decimals);

    const { AbiCoder } = await import('ethers');
    const abiCoder = new AbiCoder();
    const encodedArgs = abiCoder.encode(
      ['string', 'string', 'uint256'],
      [name, symbol, supplyWithDecimals.toString()]
    ).slice(2);

    const deployData = (TOKEN_FACTORY_BYTECODE + encodedArgs) as `0x${string}`;

    const walletInfo = await getAgentWallet(auth.publicKey);
    if (!walletInfo?.address) {
      return res.status(400).json({ error: "No wallet found. Register a wallet first." });
    }

    const fromAddr = walletInfo.address as `0x${string}`;
    const nonce = await viemPublicClient.getTransactionCount({ address: fromAddr });
    const gasPrice = await viemPublicClient.getGasPrice();
    const predictedAddress = getContractAddress({ from: fromAddr, nonce: BigInt(nonce) });

    let estimatedGas = BigInt(2000000);
    try {
      estimatedGas = await viemPublicClient.estimateGas({
        account: fromAddr,
        data: deployData,
        value: BigInt(0),
      });
      estimatedGas = estimatedGas * BigInt(120) / BigInt(100);
    } catch (estimateErr: any) {
      console.warn(`[selfclaw] Gas estimation failed, using default 2M: ${estimateErr.message}`);
    }

    const balance = await viemPublicClient.getBalance({ address: fromAddr });
    const txCost = estimatedGas * gasPrice;
    const hasSufficientGas = balance >= txCost;

    if (tokenPlanId) {
      await db.update(tokenPlans)
        .set({ status: "deploying", tokenAddress: predictedAddress, updatedAt: new Date() })
        .where(sql`${tokenPlans.id} = ${tokenPlanId}`);
    }

    logActivity("token_deployment", humanId, auth.publicKey, undefined, {
      predictedTokenAddress: predictedAddress, symbol, name, supply: initialSupply,
      bytecodeSize: Math.floor(deployData.length / 2),
      estimatedGas: estimatedGas.toString(),
      tokenPlanId: tokenPlanId || null,
    });

    res.json({
      success: true,
      mode: "unsigned",
      message: "Sign and submit this transaction with your own wallet to deploy the token.",
      unsignedTx: {
        from: walletInfo.address,
        data: deployData,
        gas: estimatedGas.toString(),
        gasPrice: gasPrice.toString(),
        chainId: 42220,
        value: "0",
        nonce,
      },
      predictedTokenAddress: predictedAddress,
      tokenPlanId: tokenPlanId || undefined,
      note: "predictedTokenAddress assumes no pending transactions. If you have pending txs, the actual deployed address will differ.",
      name,
      symbol,
      supply: initialSupply,
      deployment: {
        bytecodeSize: Math.floor(deployData.length / 2),
        estimatedGas: estimatedGas.toString(),
        estimatedCost: formatUnits(txCost, 18) + " CELO",
        walletBalance: formatUnits(balance, 18) + " CELO",
        hasSufficientGas,
      },
      nextSteps: [
        "1. Sign the unsignedTx with your wallet private key",
        "2. Submit the signed transaction to Celo mainnet (chainId 42220)",
        "3. Wait for confirmation (typically 5 seconds on Celo)",
        "4. Call POST /api/selfclaw/v1/register-token with {tokenAddress: predictedTokenAddress, txHash: <your_tx_hash>}",
        "5. After registering, call POST /api/selfclaw/v1/request-selfclaw-sponsorship to create your liquidity pool",
      ],
      troubleshooting: {
        gasErrors: "If you get 'out of gas', request more CELO via POST /api/selfclaw/v1/request-gas (retries allowed if no token deployed yet)",
        revertErrors: "If the transaction reverts, check that you have enough CELO for gas and that the contract data is not corrupted",
        nonceMismatch: "If nonce is wrong, wait for any pending transactions to confirm first",
      },
    });
  } catch (error: any) {
    console.error("[selfclaw] deploy-token error:", error);
    res.status(500).json({
      error: error.message,
      hint: "Token deployment preparation failed. Common causes: wallet not registered, insufficient gas balance, or RPC connectivity issues. If gas was burned on a previous failed attempt, you can request gas again via POST /api/selfclaw/v1/request-gas."
    });
  }
});

router.post("/v1/register-token", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { tokenAddress, txHash, name, symbol, initialSupply } = req.body;
    const humanId = auth.humanId;

    if (!tokenAddress || !txHash) {
      return res.status(400).json({
        error: "tokenAddress and txHash are required",
        hint: "After signing and submitting your deploy-token transaction, call this endpoint with the deployed contract address and transaction hash."
      });
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
      return res.status(400).json({ error: "Invalid tokenAddress format" });
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ error: "Invalid txHash format" });
    }

    let onChainName = name || '';
    let onChainSymbol = symbol || '';
    let onChainDecimals = 18;
    let onChainSupply = initialSupply || '';

    try {
      const ERC20_NAME_ABI = [
        { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
        { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
        { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
        { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
      ] as const;
      const tokenAddr = tokenAddress as `0x${string}`;
      const [chainName, chainSymbol, chainDecimals, chainSupply] = await Promise.all([
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_NAME_ABI, functionName: 'name' }).catch(() => null),
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_NAME_ABI, functionName: 'symbol' }).catch(() => null),
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_NAME_ABI, functionName: 'decimals' }).catch(() => null),
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_NAME_ABI, functionName: 'totalSupply' }).catch(() => null),
      ]);
      if (chainName) onChainName = chainName as string;
      if (chainSymbol) onChainSymbol = chainSymbol as string;
      if (chainDecimals !== null) onChainDecimals = Number(chainDecimals);
      if (chainSupply !== null) onChainSupply = formatUnits(chainSupply as bigint, onChainDecimals);
    } catch (e: any) {
      console.log(`[selfclaw] Could not read on-chain token data: ${e.message}`);
    }

    if (!onChainName && !onChainSymbol) {
      return res.status(400).json({
        error: "Could not verify token at the provided address. Make sure the transaction has been confirmed on Celo."
      });
    }

    logActivity("token_registered", humanId, auth.publicKey, undefined, {
      tokenAddress, txHash, name: onChainName, symbol: onChainSymbol, supply: onChainSupply
    });

    res.json({
      success: true,
      token: {
        address: tokenAddress,
        name: onChainName,
        symbol: onChainSymbol,
        decimals: onChainDecimals,
        totalSupply: onChainSupply,
        deployTxHash: txHash,
      },
      celoscanUrl: `https://celoscan.io/token/${tokenAddress}`,
      nextSteps: [
        "Check sponsorship availability: GET /api/selfclaw/v1/selfclaw-sponsorship",
        `Transfer your tokens to the sponsor wallet, then request sponsorship`,
        "Request sponsorship: POST /api/selfclaw/v1/request-selfclaw-sponsorship"
      ]
    });
  } catch (error: any) {
    console.error("[selfclaw] register-token error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/token-plan", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { purpose, supplyReasoning, allocation, utility, economicModel } = req.body;

    if (!purpose || !supplyReasoning || !allocation || !utility || !economicModel) {
      return res.status(400).json({ error: "purpose, supplyReasoning, allocation, utility, and economicModel are required" });
    }

    if (typeof allocation !== "object" || Array.isArray(allocation)) {
      return res.status(400).json({ error: "allocation must be an object" });
    }

    if (!Array.isArray(utility)) {
      return res.status(400).json({ error: "utility must be an array" });
    }

    const agentName = (auth.agent.metadata as any)?.agentName || auth.agent.deviceId || null;

    const [plan] = await db.insert(tokenPlans).values({
      humanId: auth.humanId,
      agentPublicKey: auth.publicKey,
      agentName,
      purpose,
      supplyReasoning,
      allocation,
      utility,
      economicModel,
    }).returning();

    logActivity("token_plan_created", auth.humanId, auth.publicKey, agentName || undefined, {
      planId: plan.id, purpose,
    });

    res.json({
      success: true,
      plan: {
        id: plan.id,
        humanId: auth.humanId,
        purpose: plan.purpose,
        supplyReasoning: plan.supplyReasoning,
        allocation: plan.allocation,
        utility: plan.utility,
        economicModel: plan.economicModel,
        status: plan.status,
        createdAt: plan.createdAt,
      },
      publicUrl: `/api/selfclaw/v1/token-plan/${auth.humanId}`,
    });
  } catch (error: any) {
    console.error("[selfclaw] token-plan create error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/token-plan/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { humanId } = req.params;

    const plans = await db.select()
      .from(tokenPlans)
      .where(sql`${tokenPlans.humanId} = ${humanId}`)
      .limit(1);

    if (plans.length === 0) {
      return res.status(404).json({ error: "Token plan not found" });
    }

    const plan = plans[0];

    const agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.humanId} = ${humanId}`)
      .limit(1);

    const agentName = agents.length > 0 ? agents[0].deviceId : plan.agentName;

    res.json({
      plan: {
        id: plan.id,
        humanId: plan.humanId,
        agentName,
        purpose: plan.purpose,
        supplyReasoning: plan.supplyReasoning,
        allocation: plan.allocation,
        utility: plan.utility,
        economicModel: plan.economicModel,
        tokenAddress: plan.tokenAddress,
        status: plan.status,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      },
    });
  } catch (error: any) {
    console.error("[selfclaw] token-plan get error:", error);
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
    
    const decimals = await viemPublicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: SIMPLE_ERC20_ABI,
      functionName: 'decimals'
    });

    const amountParsed = parseUnits(amount.toString(), decimals);

    const data = encodeFunctionData({
      abi: SIMPLE_ERC20_ABI,
      functionName: 'transfer',
      args: [toAddress as `0x${string}`, amountParsed]
    });

    const walletInfo = await getAgentWallet(auth.publicKey);
    if (!walletInfo?.address) {
      return res.status(400).json({ error: "No wallet found. Register a wallet first." });
    }

    const fromAddr = walletInfo.address as `0x${string}`;
    const nonce = await viemPublicClient.getTransactionCount({ address: fromAddr });
    const gasPrice = await viemPublicClient.getGasPrice();

    res.json({
      success: true,
      mode: "unsigned",
      message: "Sign and submit this transaction with your own wallet.",
      unsignedTx: {
        from: walletInfo.address,
        to: tokenAddress,
        data,
        gas: "100000",
        gasPrice: gasPrice.toString(),
        chainId: 42220,
        value: "0",
        nonce,
      },
      amount,
      toAddress,
      tokenAddress,
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
    
    const walletInfo = await getAgentWallet(auth.publicKey);
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

    const domain = "selfclaw.ai";
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

router.get("/v1/token-balance/:identifier/:tokenAddress", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier as string;
    const tokenAddress = req.params.tokenAddress as string;
    
    if (!identifier || !tokenAddress) {
      return res.status(400).json({ error: "identifier (agentPublicKey or humanId) and tokenAddress are required" });
    }
    
    let walletInfo = await getAgentWallet(identifier);
    if (!walletInfo) {
      walletInfo = await getAgentWalletByHumanId(identifier);
    }
    if (!walletInfo || !walletInfo.address) {
      return res.status(404).json({ error: "No wallet found" });
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
      , // unused (was external wallets count, now all self-custody)
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
      db.select({ value: count() }).from(agentWallets),
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
        selfCustody: Number(totalWallets),
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

async function updatePoolPrices() {
  try {
    const pools = await db.select().from(trackedPools).limit(100);
    if (pools.length === 0) return;

    for (const pool of pools) {
      try {
        const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pool.tokenAddress}`);
        if (!resp.ok) continue;
        const data = await resp.json() as any;
        const pairs = data.pairs || [];
        const celoPair = pairs.find((p: any) =>
          p.chainId === 'celo' &&
          (p.quoteToken?.symbol === 'SELFCLAW' || p.baseToken?.address?.toLowerCase() === pool.tokenAddress.toLowerCase())
        );

        if (celoPair) {
          await db.update(trackedPools)
            .set({
              currentPriceCelo: celoPair.priceNative || celoPair.priceUsd || null,
              priceChange24h: celoPair.priceChange?.h24 ? String(celoPair.priceChange.h24) : null,
              volume24h: celoPair.volume?.h24 ? String(celoPair.volume.h24) : null,
              marketCapCelo: celoPair.marketCap ? String(celoPair.marketCap) : celoPair.fdv ? String(celoPair.fdv) : null,
              lastUpdated: new Date(),
            })
            .where(eq(trackedPools.id, pool.id));
        }
      } catch (e: any) {
        // skip individual pool errors
      }
    }
    console.log(`[selfclaw] Pool prices updated for ${pools.length} pool(s)`);
  } catch (error: any) {
    console.error("[selfclaw] pool price update error:", error.message);
  }
}

setInterval(updatePoolPrices, 5 * 60 * 1000);
setTimeout(updatePoolPrices, 30 * 1000);

// ===================== REVENUE TRACKING =====================

router.post("/v1/log-revenue", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { amount, token, tokenAddress, source, description, txHash, chain } = req.body;
    const humanId = auth.humanId;

    if (!amount || !token || !source) {
      return res.status(400).json({
        error: "amount, token, and source are required",
        hint: "amount: string (e.g. '100'), token: symbol (e.g. 'CELO'), source: what generated this revenue (e.g. 'skill-payment', 'service-fee')"
      });
    }

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const agentName = auth.agent.deviceId || null;

    const [event] = await db.insert(revenueEvents).values({
      humanId,
      agentPublicKey: auth.publicKey,
      agentName,
      amount: String(amount),
      token: String(token),
      tokenAddress: tokenAddress || null,
      source: String(source),
      description: description || null,
      txHash: txHash || null,
      chain: chain || "celo",
    }).returning();

    await db.insert(agentActivity).values({
      eventType: "revenue_logged",
      humanId,
      agentPublicKey: auth.publicKey,
      agentName,
      metadata: { amount, token, source, txHash: txHash || null },
    });

    res.json({
      success: true,
      event: {
        id: event.id,
        amount: event.amount,
        token: event.token,
        source: event.source,
        chain: event.chain,
        createdAt: event.createdAt,
      },
      message: "Revenue event logged successfully."
    });
  } catch (error: any) {
    console.error("[selfclaw] log-revenue error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/revenue/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const humanId = req.params.humanId as string;

    const events = await db.select()
      .from(revenueEvents)
      .where(sql`${revenueEvents.humanId} = ${humanId}`)
      .orderBy(desc(revenueEvents.createdAt))
      .limit(100);

    const totals: Record<string, number> = {};
    for (const e of events) {
      const key = e.token;
      totals[key] = (totals[key] || 0) + parseFloat(e.amount);
    }

    res.json({
      humanId,
      totalEvents: events.length,
      totals,
      events: events.map(e => ({
        id: e.id,
        amount: e.amount,
        token: e.token,
        tokenAddress: e.tokenAddress,
        source: e.source,
        description: e.description,
        txHash: e.txHash,
        chain: e.chain,
        createdAt: e.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] get-revenue error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== AGENT SERVICES =====================

router.post("/v1/services", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { name, description, price, currency, endpoint } = req.body;
    const humanId = auth.humanId;

    if (!name || !description) {
      return res.status(400).json({
        error: "name and description are required",
        hint: "name: short service name, description: what the service does, price: optional (e.g. '10'), currency: optional (default 'CELO'), endpoint: optional URL"
      });
    }

    if (String(name).length > 100) {
      return res.status(400).json({ error: "Service name must be 100 characters or less" });
    }
    if (String(description).length > 1000) {
      return res.status(400).json({ error: "Description must be 1000 characters or less" });
    }

    const existingServices = await db.select()
      .from(agentServices)
      .where(sql`${agentServices.humanId} = ${humanId}`);

    if (existingServices.length >= 10) {
      return res.status(400).json({ error: "Maximum 10 services per agent" });
    }

    const agentName = auth.agent.deviceId || null;

    const [service] = await db.insert(agentServices).values({
      humanId,
      agentPublicKey: auth.publicKey,
      agentName,
      name: String(name),
      description: String(description),
      price: price ? String(price) : null,
      currency: currency ? String(currency) : "CELO",
      endpoint: endpoint || null,
    }).returning();

    await db.insert(agentActivity).values({
      eventType: "service_listed",
      humanId,
      agentPublicKey: auth.publicKey,
      agentName,
      metadata: { serviceName: name, price: price || null, currency: currency || "CELO" },
    });

    res.json({
      success: true,
      service: {
        id: service.id,
        name: service.name,
        description: service.description,
        price: service.price,
        currency: service.currency,
        endpoint: service.endpoint,
        active: service.active,
        createdAt: service.createdAt,
      },
      message: "Service listed successfully."
    });
  } catch (error: any) {
    console.error("[selfclaw] create-service error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/v1/services/:serviceId", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const serviceId = req.params.serviceId as string;
    const { name, description, price, currency, endpoint, active } = req.body;
    const humanId = auth.humanId;

    const existing = await db.select()
      .from(agentServices)
      .where(sql`${agentServices.id} = ${serviceId} AND ${agentServices.humanId} = ${humanId}`)
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ error: "Service not found or does not belong to your agent" });
    }

    const updates: any = { updatedAt: new Date() };
    if (name !== undefined) updates.name = String(name);
    if (description !== undefined) updates.description = String(description);
    if (price !== undefined) updates.price = price ? String(price) : null;
    if (currency !== undefined) updates.currency = String(currency);
    if (endpoint !== undefined) updates.endpoint = endpoint || null;
    if (active !== undefined) updates.active = Boolean(active);

    const [updated] = await db.update(agentServices)
      .set(updates)
      .where(sql`${agentServices.id} = ${serviceId}`)
      .returning();

    res.json({
      success: true,
      service: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        price: updated.price,
        currency: updated.currency,
        endpoint: updated.endpoint,
        active: updated.active,
        updatedAt: updated.updatedAt,
      },
      message: "Service updated successfully."
    });
  } catch (error: any) {
    console.error("[selfclaw] update-service error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/services/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const humanId = req.params.humanId as string;

    const services = await db.select()
      .from(agentServices)
      .where(sql`${agentServices.humanId} = ${humanId} AND ${agentServices.active} = true`)
      .orderBy(desc(agentServices.createdAt));

    res.json({
      humanId,
      totalServices: services.length,
      services: services.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price: s.price,
        currency: s.currency,
        endpoint: s.endpoint,
        agentName: s.agentName,
        createdAt: s.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] get-services error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/log-cost", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const authResult = await authenticateAgent(req, res);
    if (!authResult) return;

    const { costType, amount, currency, description, metadata: costMeta } = req.body;

    if (!costType || !amount) {
      return res.status(400).json({ error: "costType and amount are required" });
    }

    const validTypes = ["infra", "compute", "ai_credits", "bandwidth", "storage", "other"];
    if (!validTypes.includes(costType)) {
      return res.status(400).json({ error: "Invalid costType. Must be one of: " + validTypes.join(", ") });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const [costEvent] = await db.insert(costEvents).values({
      humanId: authResult.humanId,
      agentPublicKey: authResult.publicKey,
      agentName: authResult.agent.deviceId || null,
      costType,
      amount: String(numAmount),
      currency: currency || "USD",
      description: description || null,
      metadata: costMeta || null,
    }).returning();

    await logActivity("cost_logged", authResult.humanId, authResult.publicKey, authResult.agent.deviceId, {
      costType, amount: numAmount, currency: currency || "USD"
    });

    res.json({
      success: true,
      costEventId: costEvent.id,
      costType,
      amount: numAmount,
      currency: currency || "USD",
    });
  } catch (error: any) {
    console.error("[selfclaw] log-cost error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent/:identifier/economics", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;

    let agent;
    const byName = await db.select().from(verifiedBots)
      .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${identifier})`)
      .limit(1);
    if (byName.length > 0) {
      agent = byName[0];
    } else {
      const byKey = await db.select().from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${identifier}`)
        .limit(1);
      if (byKey.length > 0) agent = byKey[0];
    }

    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const revenue = await db.select().from(revenueEvents)
      .where(eq(revenueEvents.agentPublicKey, agent.publicKey));

    const costs = await db.select().from(costEvents)
      .where(eq(costEvents.agentPublicKey, agent.publicKey));

    const revenueTotals: Record<string, number> = {};
    for (const r of revenue) {
      const token = r.token || "CELO";
      revenueTotals[token] = (revenueTotals[token] || 0) + parseFloat(r.amount || "0");
    }

    const costTotals: Record<string, number> = {};
    let totalCostUsd = 0;
    for (const c of costs) {
      const type = c.costType || "other";
      const amt = parseFloat(c.amount || "0");
      costTotals[type] = (costTotals[type] || 0) + amt;
      totalCostUsd += amt;
    }

    const totalRevenueUsd = revenueTotals["cUSD"] || revenueTotals["CUSD"] || 0;

    const monthlyCosts = costs.filter(c => {
      const d = new Date(c.createdAt || 0);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const monthlySpend = monthlyCosts.reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);

    const runway = monthlySpend > 0
      ? Math.max(0, Math.round((totalRevenueUsd - totalCostUsd) / monthlySpend))
      : null;

    res.json({
      agentName: agent.deviceId,
      humanId: agent.humanId,
      revenue: {
        totalEvents: revenue.length,
        totals: revenueTotals,
        recent: revenue.slice(-5).reverse().map(r => ({
          amount: r.amount,
          token: r.token,
          source: r.source,
          date: r.createdAt,
        })),
      },
      costs: {
        totalEvents: costs.length,
        totalUsd: totalCostUsd,
        byType: costTotals,
        monthlySpend,
        recent: costs.slice(-5).reverse().map(c => ({
          type: c.costType,
          amount: c.amount,
          currency: c.currency,
          description: c.description,
          date: c.createdAt,
        })),
      },
      profitLoss: {
        totalRevenueUsd,
        totalCostUsd,
        netUsd: totalRevenueUsd - totalCostUsd,
        status: totalRevenueUsd >= totalCostUsd ? "profitable" : "deficit",
      },
      runwayMonths: runway,
    });
  } catch (error: any) {
    console.error("[selfclaw] economics error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/agent/:identifier/fund-alert", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const authResult = await authenticateAgent(req, res);
    if (!authResult) return;

    const { message, currentBalance, estimatedRunway } = req.body;

    await logActivity("fund_alert", authResult.humanId, authResult.publicKey, authResult.agent.deviceId, {
      message: message || "Agent requesting funds",
      currentBalance,
      estimatedRunway,
    });

    res.json({
      success: true,
      message: "Fund alert logged. Human owner will be notified.",
    });
  } catch (error: any) {
    console.error("[selfclaw] fund-alert error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/human/:humanId/economics", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { humanId } = req.params;

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.humanId} = ${humanId}`);

    if (agents.length === 0) {
      return res.status(404).json({ error: "No agents found for this human" });
    }

    const revenue = await db.select().from(revenueEvents)
      .where(sql`${revenueEvents.humanId} = ${humanId}`);

    const costs = await db.select().from(costEvents)
      .where(sql`${costEvents.humanId} = ${humanId}`);

    const wallets = await db.select().from(agentWallets)
      .where(sql`${agentWallets.humanId} = ${humanId}`);

    const services = await db.select().from(agentServices)
      .where(sql`${agentServices.humanId} = ${humanId}`);

    const pools = await db.select().from(trackedPools)
      .where(sql`${trackedPools.humanId} = ${humanId}`);

    const tokenPlansList = await db.select().from(tokenPlans)
      .where(sql`${tokenPlans.humanId} = ${humanId}`);

    const sponsorships = await db.select().from(sponsoredAgents)
      .where(sql`${sponsoredAgents.humanId} = ${humanId}`);

    const alerts = await db.select().from(agentActivity)
      .where(sql`${agentActivity.humanId} = ${humanId} AND ${agentActivity.eventType} = 'fund_alert'`)
      .orderBy(desc(agentActivity.createdAt))
      .limit(10);

    let totalRevenue = 0;
    let totalCosts = 0;
    const revByToken: Record<string, number> = {};
    for (const r of revenue) {
      const amt = parseFloat(r.amount || "0");
      if (r.token === "cUSD" || r.token === "CUSD") totalRevenue += amt;
      revByToken[r.token] = (revByToken[r.token] || 0) + amt;
    }
    for (const c of costs) {
      totalCosts += parseFloat(c.amount || "0");
    }

    const agentSummaries = agents.map(a => {
      const agentRevenue = revenue.filter(r => r.agentPublicKey === a.publicKey);
      const agentCosts = costs.filter(c => c.agentPublicKey === a.publicKey);
      const agentWallet = wallets.find(w => w.publicKey === a.publicKey);
      const agentPool = pools.find(p => p.agentPublicKey === a.publicKey) || pools.find(p => p.humanId === a.humanId);
      const agentPlan = tokenPlansList.find(t => t.agentPublicKey === a.publicKey);
      const agentServicesList = services.filter(s => s.agentPublicKey === a.publicKey);
      const agentSponsorship = sponsorships.find(s => s.publicKey === a.publicKey) || sponsorships.find(s => s.humanId === a.humanId);

      const rev = agentRevenue.reduce((sum, r) => sum + parseFloat(r.amount || "0"), 0);
      const cost = agentCosts.reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);

      return {
        name: a.deviceId,
        publicKey: a.publicKey,
        verifiedAt: a.verifiedAt,
        wallet: agentWallet ? { address: agentWallet.address, gasReceived: agentWallet.gasReceived } : null,
        token: agentPool ? {
          symbol: agentPool.tokenSymbol,
          name: agentPool.tokenName,
          address: agentPool.tokenAddress,
          poolAddress: agentPool.poolAddress,
          price: agentPool.currentPriceCelo,
        } : null,
        tokenPlan: agentPlan ? { status: agentPlan.status, purpose: agentPlan.purpose } : null,
        sponsorship: agentSponsorship ? {
          status: agentSponsorship.status,
          tokenAddress: agentSponsorship.tokenAddress,
          poolAddress: agentSponsorship.poolAddress,
          amount: agentSponsorship.sponsoredAmountCelo,
        } : null,
        services: agentServicesList.length,
        economics: {
          totalRevenue: rev,
          totalCosts: cost,
          net: rev - cost,
          revenueEvents: agentRevenue.length,
          costEvents: agentCosts.length,
        },
      };
    });

    res.json({
      humanId,
      agentCount: agents.length,
      agents: agentSummaries,
      totals: {
        revenue: totalRevenue,
        costs: totalCosts,
        net: totalRevenue - totalCosts,
        revenueByToken: revByToken,
      },
      alerts: alerts.map(a => ({
        message: (a.metadata as any)?.message,
        agentName: a.agentName,
        date: a.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] human-economics error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/create-agent", verificationLimiter, async (req: any, res: Response) => {
  try {
    if (!req.session?.isAuthenticated || !req.session?.humanId) {
      return res.status(401).json({
        error: "Login required",
        hint: "You must be logged in with Self.xyz passport to create an agent. Visit selfclaw.ai and click LOGIN."
      });
    }

    const humanId = req.session.humanId;
    const { agentName, description, deployToHostinger, hostingerVmId } = req.body;

    if (!agentName || typeof agentName !== "string" || agentName.trim().length < 2) {
      return res.status(400).json({ error: "agentName is required (minimum 2 characters)" });
    }
    if (agentName.trim().length > 32) {
      return res.status(400).json({ error: "agentName must be 32 characters or fewer" });
    }

    let cleanName = agentName.trim().toLowerCase().replace(/[^a-z0-9\-]/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    if (!cleanName || cleanName.length < 2) {
      return res.status(400).json({ error: "Agent name must contain at least 2 alphanumeric characters" });
    }
    if (cleanName.length > 63) {
      cleanName = cleanName.substring(0, 63).replace(/-+$/, "");
    }

    const existingAgents = await db.select()
      .from(verifiedBots)
      .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${cleanName})`)
      .limit(1);
    if (existingAgents.length > 0) {
      return res.status(400).json({
        error: "Agent name already taken",
        suggestion: cleanName + "-" + Date.now().toString(36)
      });
    }

    const { generateKeyPairSync } = await import("crypto");
    const keyPair = generateKeyPairSync("ed25519");

    const publicKeySpki = keyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const privateKeyPkcs8 = keyPair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

    const agentKeyHash = crypto.createHash("sha256").update(publicKeySpki).digest("hex").substring(0, 16);

    const metadata: any = {
      verifiedVia: "create-agent",
      createdByHuman: true,
      description: description || null,
      lastUpdated: new Date().toISOString(),
    };

    const newBot: InsertVerifiedBot = {
      publicKey: publicKeySpki,
      deviceId: cleanName,
      selfId: null,
      humanId,
      verificationLevel: "human-created",
      metadata,
    };

    await db.insert(verifiedBots).values(newBot);
    logActivity("create_agent", humanId, publicKeySpki, cleanName, { method: "one-click" });

    let deployment: any = null;

    if (deployToHostinger && hostingerVmId) {
      const vmIdNum = parseInt(String(hostingerVmId), 10);
      if (isNaN(vmIdNum) || vmIdNum <= 0) {
        return res.status(400).json({ error: "Invalid hostingerVmId — must be a positive number" });
      }

      try {
        const { callTool } = await import("./hostinger-mcp.js");

        const agentDockerCompose = `
version: '3.8'
services:
  ${cleanName}:
    image: node:22-slim
    container_name: ${cleanName}
    restart: unless-stopped
    working_dir: /app
    environment:
      - AGENT_NAME=${cleanName}
      - AGENT_PUBLIC_KEY=${publicKeySpki}
      - SELFCLAW_API=https://selfclaw.ai/api/selfclaw/v1
    volumes:
      - ./${cleanName}-data:/app/data
    command: >
      bash -c "
        mkdir -p /app &&
        cat > /app/agent.mjs << 'AGENTEOF'
        import { readFileSync, writeFileSync, existsSync } from 'fs';
        import { createPrivateKey, sign } from 'crypto';

        const AGENT_NAME = process.env.AGENT_NAME || '${cleanName}';
        const PUBLIC_KEY = process.env.AGENT_PUBLIC_KEY || '${publicKeySpki}';
        const SELFCLAW_API = process.env.SELFCLAW_API || 'https://selfclaw.ai/api/selfclaw/v1';

        console.log('[' + AGENT_NAME + '] Agent started');
        console.log('[' + AGENT_NAME + '] Public Key: ' + PUBLIC_KEY);
        console.log('[' + AGENT_NAME + '] SelfClaw API: ' + SELFCLAW_API);
        console.log('[' + AGENT_NAME + '] Ready for commands. Set AGENT_PRIVATE_KEY env var to enable signing.');

        setInterval(() => {
          console.log('[' + AGENT_NAME + '] heartbeat ' + new Date().toISOString());
        }, 60000);
        AGENTEOF
        node /app/agent.mjs
      "
`.trim();

        const dockerProjectName = `sc-${cleanName}`;
        const result = await callTool("vps_docker_compose_create_project", {
          virtual_machine_id: vmIdNum,
          project_name: dockerProjectName,
          docker_compose_content: agentDockerCompose,
        });

        deployment = {
          success: true,
          vmId: hostingerVmId,
          projectName: dockerProjectName,
          result,
        };
      } catch (deployErr: any) {
        deployment = {
          success: false,
          error: deployErr.message,
          hint: "Agent was created successfully but VPS deployment failed. You can deploy manually later."
        };
      }
    }

    // SECURITY: privateKeyPkcs8 is returned to the user exactly once and never stored, logged, or persisted anywhere
    console.log(`[selfclaw] === AGENT CREATED === name: ${cleanName}, humanId: ${humanId}`);

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    res.json({
      success: true,
      agent: {
        name: cleanName,
        publicKey: publicKeySpki,
        humanId,
        agentKeyHash,
        verificationLevel: "human-created",
        registeredAt: new Date().toISOString(),
        profileUrl: `https://selfclaw.ai/agent/${encodeURIComponent(cleanName)}`,
      },
      keys: {
        publicKey: publicKeySpki,
        privateKey: privateKeyPkcs8,
        format: "SPKI DER (base64) / PKCS8 DER (base64)",
        warning: "SAVE YOUR PRIVATE KEY NOW. It will never be shown again. SelfClaw does not store private keys.",
      },
      deployment,
      nextSteps: [
        "1. SAVE your private key securely — it cannot be recovered",
        "2. Create a wallet: POST /api/selfclaw/v1/create-wallet",
        "3. Plan your tokenomics: POST /api/selfclaw/v1/token-plan",
        "4. Deploy your token: POST /api/selfclaw/v1/deploy-token",
        "5. Request liquidity sponsorship: POST /api/selfclaw/v1/request-selfclaw-sponsorship",
        deployToHostinger ? "6. Your agent is deploying to Hostinger VPS" : "6. (Optional) Deploy to Hostinger VPS from /create-agent",
      ],
    });
  } catch (error: any) {
    console.error("[selfclaw] create-agent error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/create-agent/deploy-economy", async (req: any, res: Response) => {
  try {
    if (!req.session?.isAuthenticated || !req.session?.humanId) {
      return res.status(401).json({ error: "Login required. Scan the QR code with your Self app." });
    }

    const humanId = req.session.humanId;
    const { publicKey, tokenName, tokenSymbol, totalSupply, selfclawForPool } = req.body;

    if (!publicKey || !tokenName || !tokenSymbol || !totalSupply) {
      return res.status(400).json({ error: "publicKey, tokenName, tokenSymbol, and totalSupply are required" });
    }

    const agents = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey} AND ${verifiedBots.humanId} = ${humanId}`)
      .limit(1);

    if (agents.length === 0) {
      return res.status(403).json({ error: "Agent not found or does not belong to your identity." });
    }

    const agent = agents[0];
    const sessionId = crypto.randomUUID();

    type DeployStep = { name: string; status: 'pending' | 'running' | 'success' | 'failed'; result?: any; error?: string; durationMs?: number };
    type DeploySession = { publicKey: string; humanId: string; status: 'running' | 'completed' | 'failed'; currentStep: string; steps: DeployStep[]; result?: any; error?: string; startedAt: number };

    const session: DeploySession = {
      publicKey,
      humanId,
      status: 'running',
      currentStep: 'setup_wallet',
      steps: [
        { name: 'setup_wallet', status: 'pending' },
        { name: 'request_gas', status: 'pending' },
        { name: 'deploy_token', status: 'pending' },
        { name: 'register_token', status: 'pending' },
        ...(selfclawForPool && Number(selfclawForPool) > 0 ? [{ name: 'request_sponsorship', status: 'pending' as const }] : []),
      ],
      startedAt: Date.now(),
    };

    deployEconomySessions.set(sessionId, session);

    res.json({ success: true, sessionId });

    (async () => {
      let evmPrivateKey = '';
      let evmAddress = '';
      let deployedTokenAddress = '';

      const runPipelineStep = async (stepName: string, fn: () => Promise<any>) => {
        const step = session.steps.find(s => s.name === stepName);
        if (!step) throw new Error(`Step ${stepName} not found`);
        step.status = 'running';
        session.currentStep = stepName;
        const start = Date.now();
        try {
          const result = await fn();
          step.status = 'success';
          step.result = result;
          step.durationMs = Date.now() - start;
          return result;
        } catch (err: any) {
          step.status = 'failed';
          step.error = err.message;
          step.durationMs = Date.now() - start;
          throw err;
        }
      };

      try {
        await runPipelineStep('setup_wallet', async () => {
          const { Wallet } = await import('ethers');
          const wallet = Wallet.createRandom();
          evmPrivateKey = wallet.privateKey;
          evmAddress = wallet.address;

          const result = await createAgentWallet(humanId, publicKey, wallet.address);
          if (!result.success) throw new Error(result.error || "Failed to register wallet");

          logActivity("wallet_creation", humanId, publicKey, agent.deviceId || undefined, {
            address: wallet.address,
            method: "deploy-economy"
          });

          return { walletAddress: wallet.address, privateKey: wallet.privateKey };
        });

        await runPipelineStep('request_gas', async () => {
          const result = await sendGasSubsidy(humanId, publicKey);
          if (!result.success) throw new Error(result.error || "Gas subsidy failed");
          return { txHash: result.txHash, amountCelo: result.amountCelo };
        });

        await runPipelineStep('deploy_token', async () => {
          const { privateKeyToAccount } = await import("viem/accounts");
          const { createWalletClient } = await import("viem");
          const { AbiCoder } = await import("ethers");

          const account = privateKeyToAccount(evmPrivateKey as `0x${string}`);
          const deployPublicClient = createPublicClient({ chain: celo, transport: http() });
          const walletClient = createWalletClient({ account, chain: celo, transport: http() });

          const decimals = 18;
          const supplyWithDecimals = parseUnits(totalSupply.toString(), decimals);
          const abiCoder = new AbiCoder();
          const encodedArgs = abiCoder.encode(
            ["string", "string", "uint256"],
            [tokenName, tokenSymbol, supplyWithDecimals.toString()]
          ).slice(2);

          const deployData = (TOKEN_FACTORY_BYTECODE + encodedArgs) as `0x${string}`;
          const nonce = await deployPublicClient.getTransactionCount({ address: account.address });
          const predictedAddress = getContractAddress({ from: account.address, nonce: BigInt(nonce) });

          const txHash = await walletClient.sendTransaction({
            data: deployData,
            value: BigInt(0),
          });

          const receipt = await deployPublicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

          if (receipt.status !== "success") {
            throw new Error(`Token deploy transaction reverted (tx: ${txHash})`);
          }

          deployedTokenAddress = receipt.contractAddress || predictedAddress;

          logActivity("token_deployed", humanId, publicKey, agent.deviceId || '', {
            tokenAddress: deployedTokenAddress,
            tokenSymbol,
            txHash,
            method: "deploy-economy"
          });

          return {
            tokenAddress: deployedTokenAddress,
            txHash,
            celoscanUrl: `https://celoscan.io/token/${deployedTokenAddress}`,
          };
        });

        await runPipelineStep('register_token', async () => {
          await db.execute(sql`
            INSERT INTO agent_tokens (id, agent_id, contract_address, name, symbol, decimals, initial_supply, deploy_tx_hash, created_at)
            VALUES (gen_random_uuid(), ${publicKey}, ${deployedTokenAddress}, ${tokenName}, ${tokenSymbol}, 18, ${totalSupply.toString()}, ${session.steps.find(s => s.name === 'deploy_token')?.result?.txHash || ''}, NOW())
          `);

          logActivity("token_registered", humanId, publicKey, agent.deviceId || '', {
            tokenAddress: deployedTokenAddress,
            tokenName,
            tokenSymbol,
            method: "deploy-economy"
          });

          return { verified: true, tokenAddress: deployedTokenAddress };
        });

        if (selfclawForPool && Number(selfclawForPool) > 0) {
          await runPipelineStep('request_sponsorship', async () => {
            const {
              getSelfclawBalance, getNextPositionTokenId, computePoolId,
              extractPositionTokenIdFromReceipt, createPoolAndAddLiquidity,
              getSponsorAddress,
            } = await import("../lib/uniswap-v4.js");

            const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
            const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith("0x") ? `0x${rawSponsorKey}` : rawSponsorKey;

            const selfclawAddress = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";

            const availableBalance = await getSelfclawBalance(sponsorKey);
            const available = parseFloat(availableBalance);
            if (available <= 0) {
              throw new Error("No SELFCLAW available in sponsorship wallet");
            }

            const PRODUCTION_SELFCLAW_CAP_PERCENT = 50;
            const SELFCLAW_TOTAL_SUPPLY = 1_000_000_000;
            const MAX_SELFCLAW = (SELFCLAW_TOTAL_SUPPLY * PRODUCTION_SELFCLAW_CAP_PERCENT) / 100;

            const cappedAmount = Math.min(Number(selfclawForPool), available * (PRODUCTION_SELFCLAW_CAP_PERCENT / 100), MAX_SELFCLAW);
            const finalSelfclaw = Math.floor(cappedAmount).toString();

            if (Number(finalSelfclaw) <= 0) {
              throw new Error(`SELFCLAW budget too small after cap (available: ${availableBalance})`);
            }

            const { privateKeyToAccount } = await import("viem/accounts");
            const { createWalletClient } = await import("viem");

            const agentAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`);
            const agentWalletClient = createWalletClient({ account: agentAccount, chain: celo, transport: http() });

            const tokenAmount = Math.floor(Number(totalSupply) * 0.3).toString();

            const ERC20_ABI_TRANSFER = [
              { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
            ] as const;

            const sponsorAddress = getSponsorAddress(sponsorKey);

            const transferHash = await agentWalletClient.writeContract({
              address: deployedTokenAddress as `0x${string}`,
              abi: ERC20_ABI_TRANSFER,
              functionName: "transfer",
              args: [sponsorAddress as `0x${string}`, parseUnits(tokenAmount, 18)],
            });

            const transferPublicClient = createPublicClient({ chain: celo, transport: http() });
            await transferPublicClient.waitForTransactionReceipt({ hash: transferHash, timeout: 60_000 });

            const tokenLower = deployedTokenAddress.toLowerCase();
            const selfclawLower = selfclawAddress.toLowerCase();
            const token0 = tokenLower < selfclawLower ? deployedTokenAddress : selfclawAddress;
            const token1 = tokenLower < selfclawLower ? selfclawAddress : deployedTokenAddress;
            const feeTier = 10000;
            const tickSpacing = 200;
            const v4PoolId = computePoolId(token0, token1, feeTier, tickSpacing);

            const nextTokenIdBefore = await getNextPositionTokenId();

            const poolResult = await createPoolAndAddLiquidity({
              tokenA: deployedTokenAddress,
              tokenB: selfclawAddress,
              amountA: tokenAmount,
              amountB: finalSelfclaw,
              feeTier,
              privateKey: sponsorKey,
            });

            if (!poolResult.success) {
              throw new Error(poolResult.error || "Pool creation failed");
            }

            let positionTokenId: string | null = null;
            if (poolResult.receipt) {
              positionTokenId = extractPositionTokenIdFromReceipt(poolResult.receipt);
            }
            if (!positionTokenId) {
              const nextTokenIdAfter = await getNextPositionTokenId();
              if (nextTokenIdAfter > nextTokenIdBefore) {
                positionTokenId = nextTokenIdBefore.toString();
              }
            }

            await db.insert(sponsoredAgents).values({
              humanId,
              publicKey,
              tokenAddress: deployedTokenAddress,
              tokenSymbol,
              poolAddress: v4PoolId,
              v4PositionTokenId: positionTokenId,
              poolVersion: "v4",
              sponsoredAmountCelo: finalSelfclaw,
              sponsorTxHash: poolResult.txHash || "",
              status: "completed",
              completedAt: new Date(),
            });

            try {
              await db.insert(trackedPools).values({
                poolAddress: v4PoolId,
                tokenAddress: deployedTokenAddress,
                tokenSymbol,
                tokenName,
                pairedWith: "SELFCLAW",
                humanId,
                agentPublicKey: publicKey,
                feeTier,
                v4PositionTokenId: positionTokenId,
                poolVersion: "v4",
                v4PoolId,
                initialCeloLiquidity: finalSelfclaw,
                initialTokenLiquidity: tokenAmount,
              }).onConflictDoNothing();
            } catch (e: any) {
              console.error(`[selfclaw] Failed to track pool: ${e.message}`);
            }

            logActivity("sponsorship_completed", humanId, publicKey, agent.deviceId || '', {
              v4PoolId,
              positionTokenId,
              selfclawAmount: finalSelfclaw,
              method: "deploy-economy"
            });

            return {
              v4PoolId,
              positionTokenId,
              selfclawAmount: finalSelfclaw,
              agentTokenAmount: tokenAmount,
              txHash: poolResult.txHash,
              poolVersion: "v4",
            };
          });
        }

        session.status = 'completed';
        session.result = {
          walletAddress: evmAddress,
          tokenAddress: deployedTokenAddress,
          steps: session.steps,
        };
      } catch (err: any) {
        session.status = 'failed';
        session.error = err.message;
      }
    })();
  } catch (error: any) {
    console.error("[selfclaw] deploy-economy error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/create-agent/deploy-status/:sessionId", async (req: any, res: Response) => {
  try {
    if (!req.session?.isAuthenticated || !req.session?.humanId) {
      return res.status(401).json({ error: "Login required." });
    }

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [key, val] of deployEconomySessions) {
      if (now - val.startedAt > ONE_HOUR) {
        deployEconomySessions.delete(key);
      }
    }

    const { sessionId } = req.params;
    const session = deployEconomySessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found or expired" });
    }

    res.json(session);
  } catch (error: any) {
    console.error("[selfclaw] deploy-status error:", error);
    res.status(500).json({ error: error.message });
  }
});

async function authenticateHumanForAgent(req: any, res: Response, agentPublicKey: string): Promise<{ humanId: string; agent: any } | null> {
  if (!req.session?.isAuthenticated || !req.session?.humanId) {
    res.status(401).json({ error: "Login required. Scan the QR code with your Self app." });
    return null;
  }
  const humanId = req.session.humanId;
  const agents = await db.select().from(verifiedBots)
    .where(sql`${verifiedBots.publicKey} = ${agentPublicKey} AND ${verifiedBots.humanId} = ${humanId}`)
    .limit(1);
  if (agents.length === 0) {
    res.status(403).json({ error: "Agent not found or does not belong to your identity." });
    return null;
  }
  return { humanId, agent: agents[0] };
}

router.post("/v1/my-agents/:publicKey/setup-wallet", verificationLimiter, async (req: any, res: Response) => {
  try {
    const auth = await authenticateHumanForAgent(req, res, req.params.publicKey);
    if (!auth) return;

    const existingWallet = await getAgentWallet(req.params.publicKey);
    if (existingWallet) {
      return res.json({
        success: true,
        alreadyExists: true,
        address: existingWallet.address,
        gasReceived: existingWallet.gasReceived,
      });
    }

    const { Wallet } = await import('ethers');
    const wallet = Wallet.createRandom();

    const result = await createAgentWallet(auth.humanId, req.params.publicKey, wallet.address);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    logActivity("wallet_creation", auth.humanId, req.params.publicKey, auth.agent.deviceId, {
      address: wallet.address,
      method: "dashboard"
    });

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    res.json({
      success: true,
      address: wallet.address,
      privateKey: wallet.privateKey,
      warning: "SAVE THIS PRIVATE KEY NOW. It will NOT be shown again. SelfClaw never stores private keys.",
    });
  } catch (error: any) {
    console.error("[selfclaw] my-agents setup-wallet error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/my-agents/:publicKey/request-gas", verificationLimiter, async (req: any, res: Response) => {
  try {
    const auth = await authenticateHumanForAgent(req, res, req.params.publicKey);
    if (!auth) return;

    const result = await sendGasSubsidy(auth.humanId, req.params.publicKey);
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        alreadyReceived: result.alreadyReceived || false
      });
    }

    logActivity("gas_request", auth.humanId, req.params.publicKey, auth.agent.deviceId, {
      txHash: result.txHash, amountCelo: result.amountCelo, method: "dashboard"
    });

    res.json({
      success: true,
      txHash: result.txHash,
      amountCelo: result.amountCelo,
    });
  } catch (error: any) {
    console.error("[selfclaw] my-agents request-gas error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/my-agents/:publicKey/deploy-token", verificationLimiter, async (req: any, res: Response) => {
  try {
    const auth = await authenticateHumanForAgent(req, res, req.params.publicKey);
    if (!auth) return;

    const { name, symbol, initialSupply } = req.body;
    if (!name || !symbol || !initialSupply) {
      return res.status(400).json({ error: "name, symbol, and initialSupply are required" });
    }

    const walletInfo = await getAgentWallet(req.params.publicKey);
    if (!walletInfo?.address) {
      return res.status(400).json({ error: "No wallet found. Create a wallet first." });
    }

    const decimals = 18;
    const supplyWithDecimals = parseUnits(initialSupply.toString(), decimals);
    const { AbiCoder } = await import('ethers');
    const abiCoder = new AbiCoder();
    const encodedArgs = abiCoder.encode(
      ['string', 'string', 'uint256'],
      [name, symbol, supplyWithDecimals.toString()]
    ).slice(2);

    const deployData = (TOKEN_FACTORY_BYTECODE + encodedArgs) as `0x${string}`;
    const fromAddr = walletInfo.address as `0x${string}`;
    const nonce = await viemPublicClient.getTransactionCount({ address: fromAddr });
    const gasPrice = await viemPublicClient.getGasPrice();
    const predictedAddress = getContractAddress({ from: fromAddr, nonce: BigInt(nonce) });

    let estimatedGas = BigInt(2000000);
    try {
      estimatedGas = await viemPublicClient.estimateGas({
        account: fromAddr, data: deployData, value: BigInt(0),
      });
      estimatedGas = estimatedGas * BigInt(120) / BigInt(100);
    } catch (e: any) {
      console.warn(`[selfclaw] Gas estimation failed, using default: ${e.message}`);
    }

    const balance = await viemPublicClient.getBalance({ address: fromAddr });
    const txCost = estimatedGas * gasPrice;

    logActivity("token_deployment", auth.humanId, req.params.publicKey, auth.agent.deviceId, {
      predictedTokenAddress: predictedAddress, symbol, name, supply: initialSupply, method: "dashboard"
    });

    res.json({
      success: true,
      unsignedTx: {
        from: walletInfo.address,
        data: deployData,
        gas: estimatedGas.toString(),
        gasPrice: gasPrice.toString(),
        chainId: 42220,
        value: "0",
        nonce,
      },
      predictedTokenAddress: predictedAddress,
      name, symbol, supply: initialSupply,
      walletBalance: formatUnits(balance, 18) + " CELO",
      hasSufficientGas: balance >= txCost,
      estimatedCost: formatUnits(txCost, 18) + " CELO",
    });
  } catch (error: any) {
    console.error("[selfclaw] my-agents deploy-token error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/my-agents/:publicKey/register-token", verificationLimiter, async (req: any, res: Response) => {
  try {
    const auth = await authenticateHumanForAgent(req, res, req.params.publicKey);
    if (!auth) return;

    const { tokenAddress, txHash } = req.body;
    if (!tokenAddress || !txHash) {
      return res.status(400).json({ error: "tokenAddress and txHash are required" });
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
      return res.status(400).json({ error: "Invalid tokenAddress format" });
    }

    let onChainName = '', onChainSymbol = '', onChainDecimals = 18, onChainSupply = '';
    try {
      const ERC20_ABI = [
        { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
        { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
        { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
        { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
      ] as const;
      const tokenAddr = tokenAddress as `0x${string}`;
      const [n, s, d, ts] = await Promise.all([
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'name' }).catch(() => null),
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
        viemPublicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
      ]);
      if (n) onChainName = n as string;
      if (s) onChainSymbol = s as string;
      if (d !== null) onChainDecimals = Number(d);
      if (ts !== null) onChainSupply = formatUnits(ts as bigint, onChainDecimals);
    } catch (e: any) {
      console.log(`[selfclaw] Could not read token data: ${e.message}`);
    }

    if (!onChainName && !onChainSymbol) {
      return res.status(400).json({ error: "Could not verify token at the provided address." });
    }

    logActivity("token_registered", auth.humanId, req.params.publicKey, auth.agent.deviceId, {
      tokenAddress, txHash, name: onChainName, symbol: onChainSymbol, method: "dashboard"
    });

    res.json({
      success: true,
      token: {
        address: tokenAddress,
        name: onChainName,
        symbol: onChainSymbol,
        decimals: onChainDecimals,
        totalSupply: onChainSupply,
      },
      celoscanUrl: `https://celoscan.io/token/${tokenAddress}`,
    });
  } catch (error: any) {
    console.error("[selfclaw] my-agents register-token error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/my-agents/:publicKey/request-sponsorship", verificationLimiter, async (req: any, res: Response) => {
  try {
    const auth = await authenticateHumanForAgent(req, res, req.params.publicKey);
    if (!auth) return;

    const { tokenAddress, tokenSymbol, tokenAmount } = req.body;
    if (!tokenAddress || !tokenAmount) {
      return res.status(400).json({ error: "tokenAddress and tokenAmount are required" });
    }

    const existing = await db.select().from(sponsoredAgents)
      .where(eq(sponsoredAgents.humanId, auth.humanId)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({
        error: "This identity has already received a sponsorship",
        alreadySponsored: true,
        existingPool: existing[0].poolAddress,
      });
    }

    const {
      getSelfclawBalance, getTokenBalance, getSponsorAddress,
      createPoolAndAddLiquidity, getNextPositionTokenId, computePoolId, getPoolState,
      extractPositionTokenIdFromReceipt,
    } = await import("../lib/uniswap-v4.js");

    const { collectAllV3Fees } = await import("../lib/uniswap-v3.js");

    const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
    const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;
    const sponsorAddress = getSponsorAddress(sponsorKey);

    const agentTokenBalance = await getTokenBalance(tokenAddress, 18, sponsorKey);
    const requiredAmount = parseFloat(tokenAmount);
    const heldAmount = parseFloat(agentTokenBalance);

    if (heldAmount < requiredAmount) {
      return res.status(400).json({
        error: `Sponsor wallet does not hold enough of your agent token.`,
        sponsorWallet: sponsorAddress,
        has: agentTokenBalance,
        needs: tokenAmount,
        instructions: `Send ${tokenAmount} of your token (${tokenAddress}) to ${sponsorAddress} before requesting sponsorship`,
      });
    }

    const selfclawAddress = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";

    const now = Date.now();
    if (now - lastV3FeeCollectionTime >= V3_FEE_COLLECTION_COOLDOWN_MS) {
      try {
        await collectAllV3Fees(sponsorKey);
        lastV3FeeCollectionTime = Date.now();
      } catch (e: any) {
        console.log(`[selfclaw] V3 fee collection skipped: ${e.message}`);
      }
    } else {
      console.log(`[selfclaw] V3 fee collection on cooldown (next in ${Math.round((V3_FEE_COLLECTION_COOLDOWN_MS - (now - lastV3FeeCollectionTime)) / 3600000)}h)`);
    }

    const availableBalance = await getSelfclawBalance(sponsorKey);
    const available = parseFloat(availableBalance);
    if (available <= 0) {
      return res.status(400).json({ error: "No SELFCLAW available in sponsorship wallet." });
    }

    const selfclawForPool = (available * 0.5).toFixed(0);

    const tokenLower = tokenAddress.toLowerCase();
    const selfclawLower = selfclawAddress.toLowerCase();
    const token0 = tokenLower < selfclawLower ? tokenAddress : selfclawAddress;
    const token1 = tokenLower < selfclawLower ? selfclawAddress : tokenAddress;
    const feeTier = 10000;
    const tickSpacing = 200;
    const v4PoolId = computePoolId(token0, token1, feeTier, tickSpacing);

    try {
      const poolState = await getPoolState(v4PoolId as `0x${string}`);
      if (poolState.liquidity !== '0') {
        return res.status(409).json({ error: "A V4 pool already exists for this token pair", v4PoolId });
      }
    } catch (_e: any) {}

    const nextTokenIdBefore = await getNextPositionTokenId();

    const result = await createPoolAndAddLiquidity({
      tokenA: tokenAddress, tokenB: selfclawAddress,
      amountA: tokenAmount, amountB: selfclawForPool,
      feeTier, privateKey: sponsorKey,
    });

    if (!result.success) {
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
      } else {
        console.warn(`[selfclaw] V4 position token ID could not be reliably determined (before=${nextTokenIdBefore}, after=${nextTokenIdAfter})`);
      }
    }

    await db.insert(sponsoredAgents).values({
      humanId: auth.humanId, publicKey: req.params.publicKey,
      tokenAddress, tokenSymbol: tokenSymbol || 'TOKEN',
      poolAddress: v4PoolId,
      v4PositionTokenId: positionTokenId,
      poolVersion: 'v4',
      sponsoredAmountCelo: selfclawForPool,
      sponsorTxHash: result.txHash || '',
      status: 'completed', completedAt: new Date(),
    });

    try {
      await db.insert(trackedPools).values({
        poolAddress: v4PoolId, tokenAddress,
        tokenSymbol: tokenSymbol || 'TOKEN',
        tokenName: req.body.tokenName || tokenSymbol || 'TOKEN',
        pairedWith: 'SELFCLAW', humanId: auth.humanId,
        agentPublicKey: req.params.publicKey, feeTier,
        v4PositionTokenId: positionTokenId,
        poolVersion: 'v4',
        v4PoolId,
        initialCeloLiquidity: selfclawForPool,
        initialTokenLiquidity: tokenAmount,
      }).onConflictDoNothing();
    } catch (e: any) {
      console.error(`[selfclaw] Failed to track pool: ${e.message}`);
    }

    logActivity("selfclaw_sponsorship", auth.humanId, req.params.publicKey, auth.agent.deviceId, {
      tokenAddress, selfclawAmount: selfclawForPool, v4PoolId, positionTokenId, poolVersion: 'v4', method: "dashboard"
    });

    res.json({
      success: true,
      pool: {
        v4PoolId,
        positionTokenId,
        tokenAddress, selfclawAmount: selfclawForPool,
        txHash: result.txHash,
        poolVersion: 'v4',
      },
    });
  } catch (error: any) {
    console.error("[selfclaw] my-agents request-sponsorship error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
