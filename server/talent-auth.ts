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
      found: true,
      walletAddress,
      humanCheckmark: result.isHuman,
      builderScore: result.builderScore,
      builderRank: result.builderRank,
      displayName: result.displayName,
      builderContext: result.builderContext,
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
      const status = await checkWalletStatus(walletAddress);
      humanCheckmark = status.isHuman;
      talentId = status.talentId;
      builderScore = status.builderScore;
    } catch (err: any) {
      console.log("[talent-auth] Talent API lookup failed (non-critical), proceeding with wallet-only:", err.message);
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

    console.log(`[talent-auth] Verification session created: ${sessionId} for wallet ${walletAddress}, humanCheckmark: ${humanCheckmark}, builderScore: ${builderScore}`);

    res.json({
      sessionId,
      challenge,
      humanCheckmark,
      builderScore,
      talentId,
      message: humanCheckmark
        ? "Human Checkmark verified. Sign the challenge with your agent's Ed25519 key to complete verification."
        : "Talent Protocol passport found. Sign the challenge with your agent's Ed25519 key to complete verification.",
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
    let builderRank = 0;
    let talentId: string | null = null;
    let builderContext: any = null;

    try {
      const status = await checkWalletStatus(session.walletAddress);
      humanCheckmark = status.isHuman;
      talentId = status.talentId;
      builderScore = status.builderScore;
      builderRank = status.builderRank;
      builderContext = status.builderContext;
    } catch (err: any) {
      console.log("[talent-auth] Talent API lookup failed (non-critical), proceeding with wallet-only:", err.message);
    }

    const humanId = deriveTalentHumanId(talentId || session.walletAddress);
    let verificationLevel: string;
    if (humanCheckmark) {
      verificationLevel = session.signatureVerified ? "talent-human+signature" : "talent-human";
    } else {
      verificationLevel = session.signatureVerified ? "talent-passport+signature" : "talent-passport";
    }
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
      builderRank,
      displayName: builderContext?.displayName || null,
      bio: builderContext?.bio || null,
      imageUrl: builderContext?.imageUrl || null,
      github: builderContext?.github || null,
      twitter: builderContext?.twitter || null,
      linkedin: builderContext?.linkedin || null,
      location: builderContext?.location || null,
      tags: builderContext?.tags || [],
      credentials: builderContext?.credentials || [],
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

router.get("/v1/talent/link-nonce", (req: Request, res: Response) => {
  if (!(req.session as any)?.isAuthenticated || !(req.session as any)?.humanId) {
    return res.status(401).json({ error: "Must be logged in via Self.xyz to link a Talent profile" });
  }
  const nonce = crypto.randomBytes(32).toString("hex");
  const sessionKey = crypto.randomBytes(16).toString("hex");
  talentNonces.set(sessionKey, { nonce, expires: Date.now() + 5 * 60 * 1000 });
  res.json({ nonce, sessionKey, message: `Link Talent Profile to SelfClaw\nnonce: ${nonce}` });
});

router.post("/v1/talent/link-profile", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.isAuthenticated || !session?.humanId) {
      return res.status(401).json({ error: "Must be logged in via Self.xyz to link a Talent profile" });
    }

    const { walletAddress, signature, sessionKey } = req.body;

    if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: "Valid EVM wallet address required (0x...)" });
    }
    if (!signature || !sessionKey) {
      return res.status(400).json({ error: "signature and sessionKey required" });
    }

    const storedNonce = talentNonces.get(sessionKey);
    if (!storedNonce || storedNonce.expires < Date.now()) {
      talentNonces.delete(sessionKey);
      return res.status(400).json({ error: "Nonce expired or invalid. Request a new one." });
    }
    talentNonces.delete(sessionKey);

    const expectedMessage = `Link Talent Profile to SelfClaw\nnonce: ${storedNonce.nonce}`;
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
      console.error("[talent-auth] Link profile signature verification failed:", sigErr.message);
      return res.status(401).json({ error: "Signature verification failed" });
    }

    let builderContext: any = null;
    let builderScore = 0;
    let builderRank = 0;
    let talentId: string | null = null;
    let displayName: string | null = null;

    try {
      const status = await checkWalletStatus(walletAddress);
      if (!status.found || status.source === 'wallet') {
        return res.status(404).json({
          error: "No Talent Protocol profile found for this wallet",
          details: `Wallet ${walletAddress} is not registered on Talent Protocol. Create a passport at talentprotocol.com`,
        });
      }
      builderContext = status.builderContext;
      builderScore = status.builderScore;
      builderRank = status.builderRank;
      talentId = status.talentId;
      displayName = status.displayName;
    } catch (err: any) {
      console.error("[talent-auth] Talent API lookup failed during link:", err.message);
      return res.status(503).json({
        error: "Talent Protocol API is temporarily unavailable. Please try again later.",
      });
    }

    const humanId = session.humanId;

    const agents = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId));

    for (const agent of agents) {
      const existingMeta = (agent.metadata as Record<string, any>) || {};
      const updatedMeta = {
        ...existingMeta,
        talentLinked: true,
        talentWalletAddress: walletAddress.toLowerCase(),
        talentId,
        builderScore,
        builderRank,
        displayName: builderContext?.displayName || displayName || existingMeta.displayName || null,
        bio: builderContext?.bio || existingMeta.bio || null,
        imageUrl: builderContext?.imageUrl || existingMeta.imageUrl || null,
        github: builderContext?.github || existingMeta.github || null,
        twitter: builderContext?.twitter || existingMeta.twitter || null,
        linkedin: builderContext?.linkedin || existingMeta.linkedin || null,
        location: builderContext?.location || existingMeta.location || null,
        tags: builderContext?.tags?.length ? builderContext.tags : (existingMeta.tags || []),
        credentials: builderContext?.credentials?.length ? builderContext.credentials : (existingMeta.credentials || []),
        talentLinkedAt: new Date().toISOString(),
      };

      await db.update(verifiedBots)
        .set({
          metadata: updatedMeta,
          talentScore: builderScore || agent.talentScore,
          talentId: talentId || agent.talentId,
        })
        .where(eq(verifiedBots.publicKey, agent.publicKey));
    }

    const existingUser = await db.select()
      .from(users)
      .where(eq(users.humanId, humanId))
      .limit(1);

    if (existingUser.length > 0 && !existingUser[0].walletAddress) {
      await db.update(users)
        .set({ walletAddress: walletAddress.toLowerCase() })
        .where(eq(users.humanId, humanId));
    }

    session.walletAddress = walletAddress.toLowerCase();
    session.talentLinked = true;

    logActivity("talent_profile_linked", humanId, undefined, undefined, {
      walletAddress,
      builderScore,
      builderRank,
      agentsUpdated: agents.length,
    });

    console.log(`[talent-auth] Talent profile linked for humanId=${humanId}, wallet=${walletAddress}, ${agents.length} agents updated, builderScore=${builderScore}`);

    res.json({
      success: true,
      walletAddress,
      builderScore,
      builderRank,
      displayName: builderContext?.displayName || displayName || null,
      builderContext: builderContext || null,
      agentsUpdated: agents.length,
    });
  } catch (error: any) {
    console.error("[talent-auth] link-profile error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
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
    let builderRank = 0;
    let builderContext: any = null;

    try {
      const status = await checkWalletStatus(walletAddress);
      humanCheckmark = status.isHuman;
      talentId = status.talentId;
      builderScore = status.builderScore;
      builderRank = status.builderRank;
      builderContext = status.builderContext;
    } catch (err: any) {
      console.log("[talent-auth] Talent API lookup failed (non-critical), proceeding with wallet-only:", err.message);
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
        firstName: builderContext?.displayName || null,
      });
    }

    (req.session as any).humanId = humanId;
    (req.session as any).walletAddress = walletAddress.toLowerCase();
    (req.session as any).authMethod = "talent";
    (req.session as any).talentId = talentId;
    (req.session as any).builderScore = builderScore;
    (req.session as any).builderRank = builderRank;

    console.log(`[talent-auth] User logged in via Talent Protocol: humanId=${humanId}, wallet=${walletAddress}, builderScore=${builderScore}, rank=${builderRank}`);

    res.json({
      success: true,
      humanId,
      walletAddress,
      builderScore,
      builderRank,
      displayName: builderContext?.displayName || null,
      provider: "talent",
    });
  } catch (error: any) {
    console.error("[talent-auth] connect error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
