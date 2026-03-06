import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { verifiedBots, verificationSessions, sponsoredAgents, agentWallets, users, referralCodes, referralCompletions, type InsertVerifiedBot, type InsertVerificationSession, type UpsertUser } from "../shared/schema.js";
import { eq, and, gt, desc, count, isNotNull, sql } from "drizzle-orm";
import crypto from "crypto";
import { publicApiLimiter, verificationLimiter, generateChallenge, verifyEd25519Signature, logActivity, buildAgentContext, generateFriendlySuggestions, SELFCLAW_SCOPE, SELFCLAW_STAGING, SELFCLAW_ENDPOINT, debugState, type DebugVerificationAttempt, type RawCallbackRequest } from "./routes/_shared.js";

const router = Router();

console.log(`[selfclaw] Callback endpoint: ${SELFCLAW_ENDPOINT}`);
console.log(`[selfclaw] Staging mode: ${SELFCLAW_STAGING}`);

const pendingReferrals = new Map<string, string>();

let _selfBackendVerifier: any = null;
async function getSelfBackendVerifier() {
  if (!_selfBackendVerifier) {
    const { SelfBackendVerifier, AllIds, DefaultConfigStore } = await import("@selfxyz/core");
    _selfBackendVerifier = new SelfBackendVerifier(
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
  }
  return _selfBackendVerifier;
}

router.get("/v1/check-name/:name", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const name = (String(req.params.name) || "").trim().toLowerCase();
    if (!name || name.length < 2 || name.length > 40) {
      return res.status(400).json({ error: "Name must be 2-40 characters" });
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      return res.status(400).json({ error: "Name must start with a letter or number and contain only letters, numbers, hyphens, and underscores" });
    }

    const existing = await db.select({ id: verifiedBots.id })
      .from(verifiedBots)
      .where(sql`LOWER(${verifiedBots.deviceId}) = ${name}`)
      .limit(1);

    if (existing.length > 0) {
      return res.json({
        available: false,
        suggestions: generateFriendlySuggestions(name),
      });
    }

    return res.json({ available: true });
  } catch (error: any) {
    console.error("[selfclaw] check-name error:", error.message);
    return res.status(500).json({ error: "Failed to check name availability" });
  }
});

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
    const { agentPublicKey, agentName, signature, referralCode } = req.body;
    
    if (!agentPublicKey) {
      logActivity("verification_failed", undefined, undefined, undefined, { error: "agentPublicKey is required", endpoint: "/v1/start-verification", statusCode: 400 });
      return res.status(400).json({ error: "agentPublicKey is required" });
    }

    let referralInfo: { code: string; ownerAgentName?: string | null } | null = null;
    if (referralCode) {
      const [refCode] = await db.select().from(referralCodes).where(and(eq(referralCodes.code, referralCode), eq(referralCodes.active, true))).limit(1);
      if (refCode) {
        referralInfo = { code: refCode.code, ownerAgentName: refCode.ownerAgentName };
      }
    }

    if (agentName) {
      const existingAgents = await db.select()
        .from(verifiedBots)
        .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${agentName})`)
        .limit(1);
      if (existingAgents.length > 0 && existingAgents[0].publicKey !== agentPublicKey) {
        logActivity("verification_failed", undefined, agentPublicKey, agentName, { error: "Agent name already taken", endpoint: "/v1/start-verification", statusCode: 400 });
        return res.status(400).json({
          error: "Agent name already taken",
          suggestions: generateFriendlySuggestions(agentName),
        });
      }
    }
    
    const sessionId = crypto.randomUUID();
    const agentKeyHash = crypto.createHash("sha256").update(agentPublicKey).digest("hex").substring(0, 16);
    const challenge = generateChallenge(sessionId, agentKeyHash);
    const challengeExpiry = new Date(Date.now() + 30 * 60 * 1000);
    
    let signatureVerified = false;
    
    if (signature) {
      signatureVerified = await verifyEd25519Signature(agentPublicKey, signature, challenge);
      if (!signatureVerified) {
        logActivity("verification_failed", undefined, agentPublicKey, agentName, { error: "Invalid signature", endpoint: "/v1/start-verification", statusCode: 400 });
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
    
    const reqAny = req as any;
    if (reqAny.session?.isAuthenticated && reqAny.session?.humanId) {
      (newSession as any).humanId = reqAny.session.humanId;
    }

    await db.insert(verificationSessions).values(newSession);

    if (referralInfo) {
      pendingReferrals.set(sessionId, referralInfo.code);
    }
    
    const { SelfAppBuilder } = await import("@selfxyz/qrcode");
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
      referral: referralInfo ? { code: referralInfo.code, referredBy: referralInfo.ownerAgentName || 'A SelfClaw agent' } : null,
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
    await logActivity("verification_failed", undefined, req.body?.agentPublicKey, req.body?.agentName, { error: error.message, endpoint: "/v1/start-verification", statusCode: 500 });
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/sign-challenge", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId, signature } = req.body;
    
    if (!sessionId || !signature) {
      logActivity("sign_challenge_failed", undefined, undefined, undefined, { error: "sessionId and signature are required", endpoint: "/v1/sign-challenge", statusCode: 400 });
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
      logActivity("sign_challenge_failed", undefined, undefined, undefined, { error: "Invalid or expired session", endpoint: "/v1/sign-challenge", statusCode: 400, sessionId });
      return res.status(400).json({ error: "Invalid or expired session" });
    }
    
    if (new Date() > session.challengeExpiry) {
      await db.update(verificationSessions)
        .set({ status: "expired" })
        .where(eq(verificationSessions.id, sessionId));
      logActivity("sign_challenge_failed", undefined, session.agentPublicKey, session.agentName || undefined, { error: "Challenge has expired", endpoint: "/v1/sign-challenge", statusCode: 400, sessionId });
      return res.status(400).json({ error: "Challenge has expired" });
    }
    
    const isValid = await verifyEd25519Signature(session.agentPublicKey, signature, session.challenge);
    if (!isValid) {
      logActivity("sign_challenge_failed", undefined, session.agentPublicKey, session.agentName || undefined, { error: "Invalid signature", endpoint: "/v1/sign-challenge", statusCode: 400, sessionId });
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
    await logActivity("sign_challenge_failed", undefined, undefined, undefined, { error: error.message, endpoint: "/v1/sign-challenge", statusCode: 500 });
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

router.all("/v1/ping", (req: Request, res: Response) => {
  res.status(200).json({ pong: true, method: req.method, time: Date.now() });
});

router.get("/v1/stats", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const [[agents], [wallets], [tokens], [humans]] = await Promise.all([
      db.select({ count: count() }).from(verifiedBots),
      db.select({ count: count() }).from(agentWallets),
      db.select({ count: count() }).from(sponsoredAgents).where(isNotNull(sponsoredAgents.tokenAddress)),
      db.select({ count: sql<number>`COUNT(DISTINCT ${verifiedBots.humanId})` }).from(verifiedBots).where(isNotNull(verifiedBots.humanId)),
    ]);
    res.json({
      verifiedAgents: Number(agents.count),
      walletsRegistered: Number(wallets.count),
      tokensDeployed: Number(tokens.count),
      uniqueHumans: Number(humans.count),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

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

router.get("/v1/callback/", (req: Request, res: Response) => {
  res.status(200).json({ 
    status: "ok", 
    message: "SelfClaw callback endpoint. Use POST to submit verification proofs.",
    method: "GET not supported for verification"
  });
});

async function handleCallback(req: Request, res: Response) {
  const rawTimestamp = new Date().toISOString();
  
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
  
  debugState.recentCallbackRequests.unshift(rawRequest);
  if (debugState.recentCallbackRequests.length > 10) {
    debugState.recentCallbackRequests.pop();
  }
  
  debugState.lastVerificationAttempt = {
    timestamp: rawTimestamp,
    hasProof: false,
    hasPublicSignals: false,
    finalStatus: "in_progress"
  };
  
  try {
    const body = req.body || {};
    const { attestationId, proof, publicSignals, userContextData } = body;
    
    debugState.lastVerificationAttempt.attestationId = attestationId;
    debugState.lastVerificationAttempt.hasProof = !!proof;
    debugState.lastVerificationAttempt.hasPublicSignals = !!publicSignals;
    debugState.lastVerificationAttempt.publicSignalsLength = publicSignals?.length;
    debugState.lastVerificationAttempt.userId = userContextData?.userIdentifier;
    debugState.lastVerificationAttempt.sessionId = userContextData?.userIdentifier;
    
    if (!proof || !publicSignals || !attestationId || !userContextData) {
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = "Missing required verification data";
      logActivity("verification_callback_failed", undefined, undefined, undefined, { error: "Missing required verification data", endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ status: "error", result: false, reason: "Missing required verification data" });
    }
    
    let result;
    try {
      const verifier = await getSelfBackendVerifier();
      result = await verifier.verify(
        attestationId,
        proof,
        publicSignals,
        userContextData
      );
      debugState.lastVerificationAttempt.verifyResult = result.isValidDetails;
    } catch (verifyError: any) {
      console.error("[selfclaw] SDK verify() threw error:", verifyError.message);
      console.error("[selfclaw] Error stack:", verifyError.stack);
      debugState.lastVerificationAttempt.sdkError = verifyError.message;
      debugState.lastVerificationAttempt.sdkErrorStack = verifyError.stack?.substring(0, 500);
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = "SDK verify() threw: " + verifyError.message;
      logActivity("verification_callback_failed", undefined, undefined, undefined, { error: "SDK verify error: " + verifyError.message, endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ 
        status: "error", 
        result: false, 
        reason: "Proof verification error: " + verifyError.message 
      });
    }
    
    if (!result.isValidDetails.isValid) {
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = "Proof invalid: " + JSON.stringify(result.isValidDetails);
      logActivity("verification_callback_failed", undefined, undefined, undefined, { error: "Proof verification failed", endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ 
        status: "error",
        result: false,
        reason: "Proof verification failed"
      });
    }
    
    const sessionId = result.userData?.userIdentifier;
    if (!sessionId) {
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = "Missing session ID in proof userData";
      logActivity("verification_callback_failed", undefined, undefined, undefined, { error: "Missing session ID in proof userData", endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ status: "error", result: false, reason: "Missing session ID in proof" });
    }
    
    const maxCallbackAge = new Date(Date.now() - 60 * 60 * 1000);
    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, sessionId),
        sql`${verificationSessions.status} IN ('pending', 'expired')`,
        gt(verificationSessions.createdAt, maxCallbackAge)
      ))
      .limit(1);
    
    const session = sessions[0];
    if (!session) {
      logActivity("verification_callback_failed", undefined, undefined, undefined, { error: "Invalid or expired verification session", endpoint: "/v1/callback", statusCode: 200, sessionId });
      return res.status(200).json({ status: "error", result: false, reason: "Invalid or expired verification session" });
    }
    
    const rawUserDefinedData = result.userData?.userDefinedData || "";
    
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
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = "Missing agentKeyHash in userDefinedData";
      logActivity("verification_callback_failed", undefined, session.agentPublicKey, session.agentName || undefined, { error: "Missing agentKeyHash in userDefinedData", endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding required" });
    }
    if (proofAgentKeyHash !== session.agentKeyHash) {
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = `Agent key mismatch: proof='${proofAgentKeyHash}' vs session='${session.agentKeyHash}'`;
      logActivity("verification_callback_failed", undefined, session.agentPublicKey, session.agentName || undefined, { error: "Agent key binding mismatch", endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ status: "error", result: false, reason: "Agent key binding mismatch" });
    }
    
    const storedHumanId = session.humanId;
    let humanId: string;
    if (storedHumanId) {
      humanId = storedHumanId;
      console.log("[selfclaw] Using persisted humanId from session for agent:", humanId.substring(0, 8) + "...");
    } else {
      const nullifier = result.discloseOutput?.nullifier;
      if (nullifier) {
        humanId = crypto.createHash("sha256")
          .update(nullifier)
          .digest("hex")
          .substring(0, 16);
        console.log("[selfclaw] Generated humanId from nullifier:", humanId.substring(0, 8) + "...");
      } else {
        console.error("[selfclaw] WARNING: No nullifier in verify result, falling back to full publicSignals hash");
        humanId = crypto.createHash("sha256")
          .update(JSON.stringify(publicSignals))
          .digest("hex")
          .substring(0, 16);
      }
    }
    
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
        const updateData: any = {
            humanId,
            metadata,
            verificationLevel: session.signatureVerified ? "passport+signature" : "passport",
            verifiedAt: new Date()
        };
        if (session.agentName) {
          updateData.deviceId = session.agentName;
        }
        if (!existing[0].apiKey) {
          updateData.apiKey = "sclaw_" + crypto.randomBytes(32).toString("hex");
        }
        await db.update(verifiedBots)
          .set(updateData)
          .where(sql`${verifiedBots.publicKey} = ${session.agentPublicKey}`);
      } else {
        const newBot: InsertVerifiedBot = {
          publicKey: session.agentPublicKey,
          deviceId: session.agentName || null,
          selfId: null,
          humanId,
          verificationLevel: session.signatureVerified ? "passport+signature" : "passport",
          metadata,
          apiKey: "sclaw_" + crypto.randomBytes(32).toString("hex"),
        };
        await db.insert(verifiedBots).values(newBot);
      }
    } catch (dbError: any) {
      console.error("[selfclaw] Database insert/update error:", dbError.message);
      debugState.lastVerificationAttempt.finalStatus = "error";
      debugState.lastVerificationAttempt.finalReason = "Database error: " + dbError.message;
      logActivity("verification_callback_failed", humanId, session.agentPublicKey, session.agentName || undefined, { error: "Database error: " + dbError.message, endpoint: "/v1/callback", statusCode: 200 });
      return res.status(200).json({ status: "error", result: false, reason: "Failed to save verification" });
    }

    await db.update(verificationSessions)
      .set({ status: "verified" })
      .where(eq(verificationSessions.id, sessionId));

    console.log("[selfclaw] === CALLBACK SUCCESS === Agent registered:", session.agentPublicKey || session.agentName);
    debugState.lastVerificationAttempt.finalStatus = "success";
    debugState.lastVerificationAttempt.finalReason = "Agent verified and registered";
    logActivity("verification", humanId, session.agentPublicKey, session.agentName || undefined);

    const pendingRefCode = pendingReferrals.get(sessionId);
    if (pendingRefCode) {
      pendingReferrals.delete(sessionId);
      try {
        const [refCode] = await db.select().from(referralCodes).where(and(eq(referralCodes.code, pendingRefCode), eq(referralCodes.active, true))).limit(1);
        if (refCode && refCode.ownerHumanId !== humanId) {
          const [existingCompletion] = await db.select({ id: referralCompletions.id }).from(referralCompletions).where(and(eq(referralCompletions.referralCodeId, refCode.id), eq(referralCompletions.referredPublicKey, session.agentPublicKey))).limit(1);
          if (!existingCompletion) {
            const rewardAmount = refCode.rewardPerReferral || "100";
            let rewardStatus = "pending";
            let transferTxHash: string | undefined;

            if (refCode.ownerPublicKey) {
              const [referrerWallet] = await db.select().from(agentWallets).where(eq(agentWallets.publicKey, refCode.ownerPublicKey)).limit(1);
              if (referrerWallet) {
                try {
                  const referralId = `ref_${refCode.id}_${session.agentPublicKey.substring(0, 12)}`;
                  const { isRewardsContractDeployed, distributeReferralReward } = await import("../lib/rewards-contract.js");
                  if (isRewardsContractDeployed()) {
                    const result = await distributeReferralReward(referrerWallet.address, rewardAmount, referralId);
                    if (result.success && result.txHash) {
                      rewardStatus = result.queued ? "queued" : "credited";
                      transferTxHash = result.txHash;
                      console.log(`[selfclaw] Referral reward ${result.queued ? "queued" : "distributed"} via contract: ${rewardAmount} SELFCLAW to ${referrerWallet.address} — tx: ${result.txHash}`);
                    } else {
                      console.warn(`[selfclaw] Referral reward contract distribution failed for ${referrerWallet.address}: ${result.error}`);
                    }
                  } else {
                    const { parseUnits } = await import('viem');
                    const { releaseEscrow, SELFCLAW_TOKEN } = await import("../lib/selfclaw-commerce.js");
                    const amountWei = parseUnits(rewardAmount, 18);
                    const result = await releaseEscrow(referrerWallet.address, amountWei, SELFCLAW_TOKEN);
                    if (result.success && result.txHash) {
                      rewardStatus = "credited";
                      transferTxHash = result.txHash;
                      console.log(`[selfclaw] Referral reward transferred (legacy): ${rewardAmount} SELFCLAW to ${referrerWallet.address} — tx: ${result.txHash}`);
                    } else {
                      console.warn(`[selfclaw] Referral reward transfer failed for ${referrerWallet.address}: ${result.error}`);
                    }
                  }
                } catch (txErr: any) {
                  console.warn(`[selfclaw] Referral reward transfer error for ${referrerWallet.address}:`, txErr.message);
                }
              } else {
                console.warn(`[selfclaw] Referral reward pending: no wallet registered for referrer ${refCode.ownerPublicKey.substring(0, 12)}...`);
              }
            }

            await db.insert(referralCompletions).values({
              referralCodeId: refCode.id,
              referrerHumanId: refCode.ownerHumanId,
              referrerPublicKey: refCode.ownerPublicKey,
              referredHumanId: humanId,
              referredPublicKey: session.agentPublicKey,
              referredAgentName: session.agentName || null,
              rewardAmount,
              rewardStatus,
            });
            if (rewardStatus === "credited") {
              await db.update(referralCodes).set({
                totalReferrals: sql`${referralCodes.totalReferrals} + 1`,
                totalRewardsPaid: sql`(COALESCE(${referralCodes.totalRewardsPaid}::numeric, 0) + ${rewardAmount})::text`,
              }).where(eq(referralCodes.id, refCode.id));
            } else {
              await db.update(referralCodes).set({
                totalReferrals: sql`${referralCodes.totalReferrals} + 1`,
              }).where(eq(referralCodes.id, refCode.id));
            }
            logActivity("referral_completed", humanId, session.agentPublicKey, session.agentName || undefined, { referralCode: pendingRefCode, referrerHumanId: refCode.ownerHumanId, reward: rewardAmount, rewardStatus, transferTxHash });
            console.log(`[selfclaw] Referral completed: ${pendingRefCode} → ${session.agentName || session.agentPublicKey.substring(0, 12)} (status: ${rewardStatus})`);
          }
        }
      } catch (refError: any) {
        console.error("[selfclaw] Referral crediting error (non-blocking):", refError.message);
      }
    }

    res.status(200).json({
      status: "success",
      result: true
    });
  } catch (error: any) {
    console.error("[selfclaw] === CALLBACK ERROR ===", error);
    debugState.lastVerificationAttempt.finalStatus = "error";
    debugState.lastVerificationAttempt.finalReason = "Callback handler error: " + (error.message || "Unknown error");
    await logActivity("verification_callback_failed", undefined, undefined, undefined, { error: error.message || "Unknown error", endpoint: "/v1/callback", statusCode: 200 });
    res.status(200).json({ status: "error", result: false, reason: error.message || "Unknown error" });
  }
}

router.post("/v1/callback", handleCallback);
router.post("/v1/callback/", handleCallback);
router.post("/v1/self-callback", handleCallback);
router.post("/v1/self-callback/", handleCallback);
router.get("/v1/self-callback", (req: Request, res: Response) => {
  res.status(200).json({ 
    status: "ok", 
    message: "SelfClaw callback endpoint. Use POST to submit verification proofs.",
    method: "GET not supported for verification"
  });
});
router.get("/v1/self-callback/", (req: Request, res: Response) => {
  res.status(200).json({ 
    status: "ok", 
    message: "SelfClaw callback endpoint. Use POST to submit verification proofs.",
    method: "GET not supported for verification"
  });
});

async function authenticateAgentFlexible(req: Request): Promise<{ publicKey: string; humanId: string; agentName: string | null } | null> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const apiKey = authHeader.slice(7).trim();
    if (apiKey) {
      const [agent] = await db.select().from(verifiedBots).where(eq(verifiedBots.apiKey, apiKey)).limit(1);
      if (agent) return { publicKey: agent.publicKey, humanId: agent.humanId || '', agentName: agent.deviceId || null };
    }
  }
  if (req.body?.agentPublicKey && req.body?.signature) {
    const { agentPublicKey, signature, timestamp, nonce } = req.body;
    const ts = Number(timestamp);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return null;
    const messageToSign = JSON.stringify({ agentPublicKey, timestamp: ts, nonce: String(nonce) });
    const isValid = await verifyEd25519Signature(agentPublicKey, signature, messageToSign);
    if (!isValid) return null;
    const [agent] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, agentPublicKey)).limit(1);
    if (agent) return { publicKey: agent.publicKey, humanId: agent.humanId || '', agentName: agent.deviceId || null };
  }
  return null;
}

router.post("/v1/referral/generate", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgentFlexible(req);
    if (!auth) return res.status(401).json({ error: "Authentication required. Provide agentPublicKey + signature or Bearer API key." });
    const { humanId, publicKey, agentName } = auth;

    const [existing] = await db.select().from(referralCodes).where(eq(referralCodes.ownerPublicKey, publicKey)).limit(1);
    if (existing) {
      return res.json({
        success: true,
        referralCode: existing.code,
        referralLink: `https://selfclaw.ai/?ref=${existing.code}`,
        stats: { totalReferrals: existing.totalReferrals, totalRewardsPaid: existing.totalRewardsPaid, rewardPerReferral: existing.rewardPerReferral },
        message: "Your existing referral code"
      });
    }

    const code = (agentName || "agent").toLowerCase().replace(/[^a-z0-9]/g, '') + "-" + crypto.randomBytes(4).toString("hex");
    await db.insert(referralCodes).values({
      code,
      ownerHumanId: humanId,
      ownerPublicKey: publicKey,
      ownerAgentName: agentName || null,
      rewardPerReferral: "100",
    });

    logActivity("referral_code_created", humanId, publicKey, agentName || undefined, { code });
    res.json({
      success: true,
      referralCode: code,
      referralLink: `https://selfclaw.ai/?ref=${code}`,
      stats: { totalReferrals: 0, totalRewardsPaid: "0", rewardPerReferral: "100" },
      message: "Share this link with other agents. You earn 100 SELFCLAW for each new agent that verifies through your referral."
    });
  } catch (error: any) {
    console.error("[selfclaw] referral generate error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/referral/stats", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgentFlexible(req);
    if (!auth) return res.status(401).json({ error: "Authentication required" });
    const { publicKey } = auth;

    const [refCode] = await db.select().from(referralCodes).where(eq(referralCodes.ownerPublicKey, publicKey)).limit(1);
    if (!refCode) {
      return res.json({ success: true, hasReferralCode: false, message: "No referral code yet. POST /v1/referral/generate to create one." });
    }

    const completions = await db.select().from(referralCompletions).where(eq(referralCompletions.referralCodeId, refCode.id)).orderBy(desc(referralCompletions.completedAt));

    res.json({
      success: true,
      hasReferralCode: true,
      referralCode: refCode.code,
      referralLink: `https://selfclaw.ai/?ref=${refCode.code}`,
      stats: {
        totalReferrals: refCode.totalReferrals,
        totalRewardsPaid: refCode.totalRewardsPaid,
        rewardPerReferral: refCode.rewardPerReferral,
        active: refCode.active,
      },
      completions: completions.map(c => ({
        referredAgentName: c.referredAgentName,
        referredPublicKey: c.referredPublicKey?.substring(0, 20) + '...',
        rewardAmount: c.rewardAmount,
        rewardStatus: c.rewardStatus,
        completedAt: c.completedAt,
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] referral stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/referral/validate/:code", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code || '');
    if (!code) return res.status(400).json({ error: "Referral code is required" });

    const [refCode] = await db.select().from(referralCodes).where(and(eq(referralCodes.code, code), eq(referralCodes.active, true))).limit(1);
    if (!refCode) {
      return res.json({ valid: false, message: "Invalid or inactive referral code" });
    }

    res.json({
      valid: true,
      referredBy: refCode.ownerAgentName || "A verified SelfClaw agent",
      rewardForReferrer: refCode.rewardPerReferral + " SELFCLAW",
      message: `You were referred by ${refCode.ownerAgentName || 'a verified agent'}. Complete verification to activate the referral.`
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/referral/claim", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgentFlexible(req);
    if (!auth) return res.status(401).json({ error: "Authentication required" });
    const { publicKey } = auth;

    const [wallet] = await db.select().from(agentWallets).where(eq(agentWallets.publicKey, publicKey)).limit(1);
    if (!wallet) {
      return res.status(400).json({ error: "No wallet registered. Register a wallet first before claiming referral rewards." });
    }

    const [refCode] = await db.select().from(referralCodes).where(eq(referralCodes.ownerPublicKey, publicKey)).limit(1);
    if (!refCode) {
      return res.status(404).json({ error: "No referral code found for this agent." });
    }

    const pendingCompletions = await db.select().from(referralCompletions).where(and(eq(referralCompletions.referralCodeId, refCode.id), eq(referralCompletions.rewardStatus, "pending")));

    if (pendingCompletions.length === 0) {
      return res.json({ success: true, claimed: 0, message: "No pending referral rewards to claim." });
    }

    let claimed = 0;
    let totalClaimed = "0";
    const results: Array<{ completionId: string; status: string; txHash?: string; error?: string }> = [];

    const { isRewardsContractDeployed, distributeReferralReward } = await import("../lib/rewards-contract.js");

    for (const completion of pendingCompletions) {
      const rewardAmount = completion.rewardAmount || "100";
      try {
        const referralId = `ref_${completion.referralCodeId}_${completion.referredPublicKey?.substring(0, 12) || completion.id}`;
        let transferResult: { success: boolean; txHash?: string; queued?: boolean; error?: string };

        if (isRewardsContractDeployed()) {
          transferResult = await distributeReferralReward(wallet.address, rewardAmount, referralId);
        } else {
          const { parseUnits } = await import('viem');
          const { releaseEscrow, SELFCLAW_TOKEN } = await import("../lib/selfclaw-commerce.js");
          const amountWei = parseUnits(rewardAmount, 18);
          transferResult = await releaseEscrow(wallet.address, amountWei, SELFCLAW_TOKEN);
        }

        if (transferResult.success && transferResult.txHash) {
          const status = transferResult.queued ? "queued" : "credited";
          await db.update(referralCompletions).set({ rewardStatus: status }).where(eq(referralCompletions.id, completion.id));
          await db.update(referralCodes).set({
            totalRewardsPaid: sql`(COALESCE(${referralCodes.totalRewardsPaid}::numeric, 0) + ${rewardAmount})::text`,
          }).where(eq(referralCodes.id, refCode.id));
          claimed++;
          totalClaimed = String(Number(totalClaimed) + Number(rewardAmount));
          results.push({ completionId: completion.id, status: "credited", txHash: transferResult.txHash });
        } else {
          results.push({ completionId: completion.id, status: "failed", error: transferResult.error });
        }
      } catch (claimErr: any) {
        results.push({ completionId: completion.id, status: "failed", error: claimErr.message });
      }
    }

    logActivity("referral_rewards_claimed", undefined, publicKey, auth.agentName || undefined, { claimed, totalClaimed, pending: pendingCompletions.length });
    res.json({
      success: true,
      claimed,
      totalClaimed: totalClaimed + " SELFCLAW",
      pending: pendingCompletions.length - claimed,
      results,
    });
  } catch (error: any) {
    console.error("[selfclaw] referral claim error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/status/:sessionId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    
    const sessions = await db.select()
      .from(verificationSessions)
      .where(sql`${verificationSessions.id} = ${sessionId}`)
      .limit(1);
    
    if (sessions.length === 0) {
      return res.json({ status: "not_found" });
    }
    
    const session = sessions[0];
    
    if (session.status === "verified" && session.agentPublicKey) {
      const agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${session.agentPublicKey}`)
        .limit(1);
      
      if (agents.length > 0) {
        const reqAny = req as any;
        const agentHumanId = agents[0].humanId;
        if (agentHumanId && reqAny.session && (!reqAny.session.isAuthenticated || reqAny.session.humanId !== agentHumanId)) {
          try {
            let [user] = await db.select().from(users).where(eq(users.humanId, agentHumanId)).limit(1);
            if (!user) {
              const newUser: UpsertUser = { humanId: agentHumanId, profileComplete: false };
              [user] = await db.insert(users).values(newUser).returning();
              console.log("[selfclaw] Auto-created user for verified agent owner:", user.id);
            }
            reqAny.session.userId = user.id;
            reqAny.session.humanId = agentHumanId;
            reqAny.session.isAuthenticated = true;
            console.log("[selfclaw] Auto-logged in user after verification:", agentHumanId.substring(0, 8) + "...");
          } catch (authErr: any) {
            console.error("[selfclaw] Auto-login after verification failed:", authErr.message);
          }
        }
        return res.json({
          status: "verified",
          loggedIn: true,
          agent: {
            publicKey: agents[0].publicKey,
            deviceId: agents[0].deviceId,
            humanId: agents[0].humanId,
            verifiedAt: agents[0].verifiedAt
          },
          agentContext: await buildAgentContext(agents[0].publicKey, agents[0].humanId!, 'minimal'),
          nextSteps: {
            message: "Your agent is verified! The playbook covers two paths: Platform-Executed (recommended, no crypto libraries needed) and Self-Custody (advanced). Start with the platform path for the fastest launch.",
            playbook: "https://selfclaw.ai/agent-economy.md",
            recommendedPath: "platform-executed",
            quickStart: [
              "1. Read the playbook: https://selfclaw.ai/agent-economy.md (covers both platform-executed and self-custody paths)",
              "2. RECOMMENDED: Use platform-executed tools — POST /v1/platform-deploy-token or tool-call deploy_token (Bearer API key, no viem/ethers needed)",
              "3. Register onchain identity: tool-call register_erc8004",
              "4. Get sponsored liquidity: tool-call request_sponsorship",
              "5. Check SELFCLAW price & sponsorship: GET /api/selfclaw/v1/selfclaw-sponsorship",
              "6. Simulate your token launch: GET /api/selfclaw/v1/sponsorship-simulator?totalSupply=1000000&liquidityTokens=100000",
            ],
            features: [
              "Deploy your own ERC20 token",
              "Get SELFCLAW-sponsored liquidity (Uniswap V4)",
              "Live price tracking and market cap",
              "Track revenue, costs, and P/L",
              "Onchain identity via ERC-8004",
              "List services in the marketplace"
            ]
          }
        });
      }
    }
    
    if (session.status === "expired" || (session.challengeExpiry && new Date(session.challengeExpiry) < new Date())) {
      return res.json({ status: "expired" });
    }
    
    return res.json({ status: "pending" });
  } catch (error: any) {
    console.error("[selfclaw] status check error:", error);
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

async function retryQueuedRewards(): Promise<void> {
  try {
    const { isRewardsContractDeployed, claimPendingReward } = await import("../lib/rewards-contract.js");
    if (!isRewardsContractDeployed()) {
      return;
    }

    const queued = await db.select()
      .from(referralCompletions)
      .where(eq(referralCompletions.rewardStatus, 'queued'));

    if (queued.length === 0) return;

    console.log(`[reward-worker] Found ${queued.length} queued reward(s) to retry`);

    for (const completion of queued) {
      try {
        const referralId = `ref_${completion.referralCodeId}_${completion.referredPublicKey?.substring(0, 12) || completion.id}`;
        const result = await claimPendingReward(referralId);

        if (result.success) {
          await db.update(referralCompletions)
            .set({ rewardStatus: 'credited' })
            .where(eq(referralCompletions.id, completion.id));
          console.log(`[reward-worker] Claimed reward for referral ${completion.id}, tx=${result.txHash}`);
        } else {
          console.log(`[reward-worker] Reward ${completion.id} still queued: ${result.error}`);
        }
      } catch (err: any) {
        console.error(`[reward-worker] Error retrying reward ${completion.id}:`, err.message);
      }
    }
  } catch (error: any) {
    console.error("[reward-worker] Tick error:", error.message);
  }
}

let rewardWorkerInterval: ReturnType<typeof setInterval> | null = null;

function startRewardWorker() {
  if (rewardWorkerInterval) return;
  console.log("[reward-worker] Starting queued reward retry worker (30min interval)");
  rewardWorkerInterval = setInterval(() => {
    retryQueuedRewards().catch(err => console.error("[reward-worker] Unhandled:", err.message));
  }, 30 * 60 * 1000);
  setTimeout(() => retryQueuedRewards().catch(() => {}), 10000);
}

startRewardWorker();

export default router;
