import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { verifiedBots, type InsertVerifiedBot } from "../shared/schema.js";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/v1/bot/:identifier", async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    
    let bot = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, identifier))
      .limit(1);
    
    if (bot.length === 0) {
      bot = await db.select()
        .from(verifiedBots)
        .where(eq(verifiedBots.deviceId, identifier))
        .limit(1);
    }
    
    const foundBot = bot[0];

    if (!foundBot) {
      return res.json({
        verified: false,
        publicKey: identifier,
        message: "Bot not found in registry"
      });
    }

    res.json({
      verified: true,
      publicKey: foundBot.publicKey,
      deviceId: foundBot.deviceId,
      selfId: foundBot.selfId,
      humanId: foundBot.humanId,
      selfxyz: {
        verified: true,
        verificationLevel: foundBot.verificationLevel || "passport",
        registeredAt: foundBot.verifiedAt
      },
      swarm: foundBot.humanId ? `https://selfmolt.app/human/${foundBot.humanId}` : null,
      metadata: foundBot.metadata
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/human/:humanId", async (req: Request, res: Response) => {
  try {
    const { humanId } = req.params;
    
    const bots = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId));

    res.json({
      humanId,
      botCount: bots.length,
      bots: bots.map(bot => ({
        publicKey: bot.publicKey,
        deviceId: bot.deviceId,
        verifiedAt: bot.verifiedAt
      }))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/verify", async (req: Request, res: Response) => {
  try {
    const { publicKey, deviceId, selfId, humanId, verificationLevel, attestation, proof, publicSignals } = req.body;

    if (!publicKey) {
      return res.status(400).json({ error: "publicKey is required" });
    }

    const existing = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, publicKey))
      .limit(1);

    if (existing.length > 0) {
      await db.update(verifiedBots)
        .set({
          selfId,
          humanId,
          verificationLevel,
          metadata: { attestation, lastUpdated: new Date().toISOString() },
          verifiedAt: new Date()
        })
        .where(eq(verifiedBots.publicKey, publicKey));
      
      return res.json({
        success: true,
        message: "Verification updated",
        publicKey
      });
    }

    const newBot: InsertVerifiedBot = {
      publicKey,
      deviceId: deviceId || null,
      selfId: selfId || null,
      humanId: humanId || null,
      verificationLevel: verificationLevel || "passport",
      metadata: { attestation }
    };

    await db.insert(verifiedBots).values(newBot);

    res.json({
      success: true,
      message: "Bot verified and registered",
      publicKey,
      deviceId
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/stats", async (_req: Request, res: Response) => {
  try {
    const allBots = await db.select().from(verifiedBots);
    const uniqueHumans = new Set(allBots.map(b => b.humanId).filter(Boolean));
    
    res.json({
      totalVerifiedBots: allBots.length,
      uniqueHumans: uniqueHumans.size,
      latestVerification: allBots.length > 0 
        ? allBots.sort((a, b) => new Date(b.verifiedAt!).getTime() - new Date(a.verifiedAt!).getTime())[0].verifiedAt
        : null
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
