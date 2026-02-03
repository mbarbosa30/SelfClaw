import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { verifiedBots, type InsertVerifiedBot } from "../shared/schema.js";
import { eq } from "drizzle-orm";

const router = Router();

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
      message: "Agent verified and registered",
      publicKey,
      agentName: deviceId
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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
