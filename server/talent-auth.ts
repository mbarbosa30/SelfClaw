import { Router, Request, Response } from "express";
import crypto from "crypto";
import { verifyMessage } from "viem";
import { db } from "./db.js";
import { verifiedBots, verificationSessions, users, type InsertVerifiedBot, type InsertVerificationSession } from "../shared/schema.js";
import { eq, and } from "drizzle-orm";
import { getHumanCheckmark, getBuilderScore, getProfile, checkWalletStatus } from "../lib/talent-protocol.js";
import {
  verificationLimiter,
  generateChallenge,
  extractRawEd25519Key,
  decodeSignature,
  verifyEd25519Signature,
  logActivity,
} from "./routes/_shared.js";

const router = Router();

const talentNonces = new Map<string, { nonce: string; expires: number }>();

function deriveTalentHumanId(talentId: string): string {
  return crypto.createHash("sha256")
    .update("talent:" + talentId)
    .digest("hex")
    .substring(0, 16);
}

router.get("/v1/talent/nonce", (_req: Request, res: Response) => {
  const nonce = crypto.randomBytes(32).toString("hex");
  const sessionKey = crypto.randomBytes(16).toString("hex");
  talentNonces.set(sessionKey, { nonce, expires: Date.now() + 5 * 60 * 1000 });
  res.json({ nonce, sessionKey, message: `Sign in with SelfClaw\nnonce: ${nonce}` });
});

router.post("/v1/talent/check-wallet", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: "Valid EVM wallet address required (0x...)" });
    }

    console.log(`[talent-auth] Checking wallet status: ${walletAddress}`);

    const result = await checkWalletStatus(walletAddress);

    console.log(`[talent-auth] Wallet check result: found=${result.found}, isHuman=${result.isHuman}, score=${result.builderScore}, source=${result.source}`);

    if (!result.found) {
      return res.status(404).json({
        error: "No Talent Protocol Passport found for this wallet",
        details: `Wallet ${walletAddress} is not registered on Talent Protocol. Create a passport at talentprotocol.com`,
        walletAddress,
      });
    }

    res.json({
      walletAddress,
      humanCheckmark: result.isHuman,
      builderScore: result.builderScore,
      displayName: result.displayName,
      source: result.source,
    });
  } catch (err: any) {
    console.error("[talent-auth] check-wallet failed:", err.message);
    res.status(400).json({
      error: "Could not verify wallet with Talent Protocol",
      details: err.message,
    });
  }
});

router.post("/v1/talent/start-verification", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { walletAddress, agentPublicKey, agentName, referralCode } = req.body;

    if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: "Valid EVM wallet address required" });
    }
    if (!agentPublicKey || typeof agentPublicKey !== "string") {
      return res.status(400).json({ error: "agentPublicKey is required" });
    }

    const rawKey = extractRawEd25519Key(agentPublicKey);
    if (!rawKey || rawKey.length < 32) {
      return res.status(400).json({ error: "Invalid Ed25519 public key format" });
    }

    const sessionId = crypto.randomUUID();
    const agentKeyHash = crypto.createHash("sha256")
      .update(rawKey)
      .digest("hex")
      .substring(0, 16);
    const challenge = `selfclaw-talent:${sessionId}:${agentKeyHash}`;
    const challengeExpiry = new Date(Date.now() + 10 * 60 * 1000);

    let humanCheckmark = false;
    let builderScore = 0;
    let talentId: string | null = null;

    try {
      const [checkmark, profile] = await Promise.all([
        getHumanCheckmark(walletAddress),
        getProfile(walletAddress),
      ]);
      humanCheckmark = checkmark.isHuman;
      talentId = profile.id;

      try {
        const scoreResult = await getBuilderScore(walletAddress);
        builderScore = scoreResult.score;
      } catch (e) {
        console.log("[talent-auth] Builder score lookup failed (non-critical):", (e as Error).message);
      }
    } catch (err: any) {
      console.error("[talent-auth] Talent API lookup failed:", err.message);
      return res.status(400).json({
        error: "Could not verify wallet with Talent Protocol. Make sure this wallet has a Talent Protocol profile.",
        details: err.message,
      });
    }

    if (!humanCheckmark) {
      return res.status(403).json({
        error: "Wallet does not have the Talent Protocol Human Checkmark. Visit talentprotocol.com to complete verification.",
        walletAddress,
      });
    }

    const session: InsertVerificationSession = {
      id: sessionId,
      agentPublicKey,
      agentName: agentName || null,
      agentKeyHash,
      challenge,
      challengeExpiry,
      status: "pending",
      verificationProvider: "talent",
      walletAddress,
    };
    await db.insert(verificationSessions).values(session);

    console.log(`[talent-auth] Verification session created: ${sessionId} for wallet ${walletAddress}, humanCheckmark: true, builderScore: ${builderScore}`);

    res.json({
      sessionId,
      challenge,
      humanCheckmark: true,
      builderScore,
      talentId,
      message: "Human Checkmark verified. Sign the challenge with your agent's Ed25519 key to complete verification.",
    });
  } catch (error: any) {
    console.error("[talent-auth] start-verification error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/v1/talent/sign-challenge", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId, signature } = req.body;

    if (!sessionId || !signature) {
      return res.status(400).json({ error: "sessionId and signature required" });
    }

    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, sessionId),
        eq(verificationSessions.verificationProvider, "talent"),
      ))
      .limit(1);

    if (sessions.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessions[0];

    if (session.status !== "pending") {
      return res.status(400).json({ error: "Session already completed or expired" });
    }

    if (new Date() > session.challengeExpiry) {
      await db.update(verificationSessions)
        .set({ status: "expired" })
        .where(eq(verificationSessions.id, sessionId));
      return res.status(410).json({ error: "Session expired" });
    }

    const rawKey = extractRawEd25519Key(session.agentPublicKey);
    const sigBytes = decodeSignature(signature);

    const isValid = await verifyEd25519Signature(rawKey, sigBytes, session.challenge);

    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    await db.update(verificationSessions)
      .set({ signatureVerified: true })
      .where(eq(verificationSessions.id, sessionId));

    console.log(`[talent-auth] Challenge signed for session ${sessionId}`);

    res.json({ success: true, message: "Signature verified. Call /v1/talent/complete to finalize." });
  } catch (error: any) {
    console.error("[talent-auth] sign-challenge error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/v1/talent/complete", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, sessionId),
        eq(verificationSessions.verificationProvider, "talent"),
      ))
      .limit(1);

    if (sessions.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessions[0];

    if (session.status === "verified") {
      return res.status(400).json({ error: "Session already completed" });
    }

    if (new Date() > session.challengeExpiry) {
      await db.update(verificationSessions)
        .set({ status: "expired" })
        .where(eq(verificationSessions.id, sessionId));
      return res.status(410).json({ error: "Session expired" });
    }

    if (!session.walletAddress) {
      return res.status(400).json({ error: "No wallet address in session" });
    }

    let humanCheckmark = false;
    let builderScore = 0;
    let talentId: string | null = null;
    let profileData: any = null;

    try {
      const [checkmark, profile] = await Promise.all([
        getHumanCheckmark(session.walletAddress),
        getProfile(session.walletAddress),
      ]);
      humanCheckmark = checkmark.isHuman;
      talentId = profile.id;
      profileData = profile;

      try {
        const scoreResult = await getBuilderScore(session.walletAddress);
        builderScore = scoreResult.score;
      } catch (e) {
        console.log("[talent-auth] Builder score lookup failed (non-critical):", (e as Error).message);
      }
    } catch (err: any) {
      return res.status(400).json({ error: "Talent Protocol verification failed", details: err.message });
    }

    if (!humanCheckmark) {
      return res.status(403).json({ error: "Human Checkmark not verified for this wallet" });
    }

    const humanId = deriveTalentHumanId(talentId || session.walletAddress);
    const verificationLevel = session.signatureVerified ? "talent-human+signature" : "talent-human";
    const apiKey = "sclaw_" + crypto.randomBytes(32).toString("hex");

    const existingBot = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, session.agentPublicKey))
      .limit(1);

    const metadata = {
      provider: "talent",
      walletAddress: session.walletAddress,
      talentId,
      builderScore,
      displayName: profileData?.displayName || null,
      verifiedAt: new Date().toISOString(),
    };

    if (existingBot.length > 0) {
      await db.update(verifiedBots)
        .set({
          humanId,
          verificationLevel,
          verificationProvider: "talent",
          talentScore: builderScore,
          talentId,
          metadata,
          verifiedAt: new Date(),
        })
        .where(eq(verifiedBots.publicKey, session.agentPublicKey));
    } else {
      const newBot: InsertVerifiedBot = {
        publicKey: session.agentPublicKey,
        deviceId: session.agentName || null,
        humanId,
        verificationLevel,
        verificationProvider: "talent",
        talentScore: builderScore,
        talentId,
        metadata,
        apiKey,
      };
      await db.insert(verifiedBots).values(newBot);
    }

    await db.update(verificationSessions)
      .set({ status: "verified", humanId })
      .where(eq(verificationSessions.id, sessionId));

    logActivity(session.agentPublicKey, "verified", { provider: "talent", level: verificationLevel });

    const finalApiKey = existingBot.length > 0 ? existingBot[0].apiKey : apiKey;

    console.log(`[talent-auth] Agent verified via Talent Protocol: ${session.agentPublicKey.substring(0, 16)}... level=${verificationLevel} builderScore=${builderScore}`);

    res.json({
      success: true,
      publicKey: session.agentPublicKey,
      humanId,
      verificationLevel,
      builderScore,
      talentId,
      apiKey: finalApiKey,
      provider: "talent",
    });
  } catch (error: any) {
    console.error("[talent-auth] complete error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/talent/status/:sessionId", async (req: Request, res: Response) => {
  try {
    const sessions = await db.select()
      .from(verificationSessions)
      .where(and(
        eq(verificationSessions.id, req.params.sessionId),
        eq(verificationSessions.verificationProvider, "talent"),
      ))
      .limit(1);

    if (sessions.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = sessions[0];
    res.json({
      sessionId: session.id,
      status: session.status,
      signatureVerified: session.signatureVerified,
      provider: "talent",
    });
  } catch (error: any) {
    console.error("[talent-auth] status error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/v1/talent/nonce", (_req: Request, res: Response) => {
  const nonce = crypto.randomBytes(32).toString("hex");
  const sessionKey = crypto.randomBytes(16).toString("hex");
  talentNonces.set(sessionKey, { nonce, expires: Date.now() + 5 * 60 * 1000 });

  if (talentNonces.size > 1000) {
    const now = Date.now();
    for (const [k, v] of talentNonces) {
      if (v.expires < now) talentNonces.delete(k);
    }
  }

  res.json({ nonce, sessionKey, message: `Sign in with SelfClaw\nnonce: ${nonce}` });
});

router.post("/v1/talent/connect", async (req: Request, res: Response) => {
  try {
    const { walletAddress, signature, sessionKey } = req.body;

    if (!walletAddress || !signature || !sessionKey) {
      return res.status(400).json({ error: "walletAddress, signature, and sessionKey required" });
    }

    const storedNonce = talentNonces.get(sessionKey);
    if (!storedNonce || storedNonce.expires < Date.now()) {
      talentNonces.delete(sessionKey);
      return res.status(400).json({ error: "Nonce expired or invalid. Request a new one." });
    }
    talentNonces.delete(sessionKey);

    const expectedMessage = `Sign in with SelfClaw\nnonce: ${storedNonce.nonce}`;
    try {
      const isValidSig = await verifyMessage({
        address: walletAddress as `0x${string}`,
        message: expectedMessage,
        signature: signature as `0x${string}`,
      });
      if (!isValidSig) {
        return res.status(401).json({ error: "Invalid wallet signature" });
      }
    } catch (sigErr: any) {
      console.error("[talent-auth] Signature verification failed:", sigErr.message);
      return res.status(401).json({ error: "Signature verification failed" });
    }

    let humanCheckmark = false;
    let talentId: string | null = null;
    let builderScore = 0;
    let profileData: any = null;

    try {
      const [checkmark, profile] = await Promise.all([
        getHumanCheckmark(walletAddress),
        getProfile(walletAddress),
      ]);
      humanCheckmark = checkmark.isHuman;
      talentId = profile.id;
      profileData = profile;

      try {
        const scoreResult = await getBuilderScore(walletAddress);
        builderScore = scoreResult.score;
      } catch (e) {}
    } catch (err: any) {
      return res.status(400).json({
        error: "Could not verify wallet with Talent Protocol",
        details: err.message,
      });
    }

    if (!humanCheckmark) {
      return res.status(403).json({
        error: "Wallet does not have the Talent Protocol Human Checkmark",
      });
    }

    const humanId = deriveTalentHumanId(talentId || walletAddress);

    const existingUsers = await db.select()
      .from(users)
      .where(eq(users.humanId, humanId))
      .limit(1);

    if (existingUsers.length === 0) {
      await db.insert(users).values({
        humanId,
        walletAddress: walletAddress.toLowerCase(),
        authMethod: "talent",
        firstName: profileData?.displayName || null,
      });
    }

    (req.session as any).humanId = humanId;
    (req.session as any).walletAddress = walletAddress.toLowerCase();
    (req.session as any).authMethod = "talent";
    (req.session as any).talentId = talentId;
    (req.session as any).builderScore = builderScore;

    console.log(`[talent-auth] User logged in via Talent Protocol: humanId=${humanId}, wallet=${walletAddress}, builderScore=${builderScore}`);

    res.json({
      success: true,
      humanId,
      walletAddress,
      builderScore,
      displayName: profileData?.displayName || null,
      provider: "talent",
    });
  } catch (error: any) {
    console.error("[talent-auth] connect error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
