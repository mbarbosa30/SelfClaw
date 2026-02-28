import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  verificationBounties,
  reputationStakes,
  stakeReviews,
  verifiedBots,
  reputationEvents,
  reputationBadges,
} from "../shared/schema.js";

const router = Router();

router.get("/v1/verification/bounties", async (_req: Request, res: Response) => {
  try {
    const bounties = await db
      .select({
        id: verificationBounties.id,
        stakeId: verificationBounties.stakeId,
        rewardAmount: verificationBounties.rewardAmount,
        status: verificationBounties.status,
        createdAt: verificationBounties.createdAt,
        outputHash: reputationStakes.outputHash,
        outputType: reputationStakes.outputType,
        description: reputationStakes.description,
        stakeAmount: reputationStakes.stakeAmount,
        stakeToken: reputationStakes.stakeToken,
        agentPublicKey: reputationStakes.agentPublicKey,
        agentName: reputationStakes.agentName,
      })
      .from(verificationBounties)
      .innerJoin(reputationStakes, eq(verificationBounties.stakeId, reputationStakes.id))
      .where(eq(verificationBounties.status, "open"))
      .orderBy(desc(sql`CAST(${verificationBounties.rewardAmount} AS NUMERIC)`))
      .limit(50);

    const enriched = await Promise.all(
      bounties.map(async (b) => {
        const [agent] = await db
          .select({ deviceId: verifiedBots.deviceId })
          .from(verifiedBots)
          .where(eq(verifiedBots.publicKey, b.agentPublicKey))
          .limit(1);
        return {
          ...b,
          agentName: b.agentName || agent?.deviceId || b.agentPublicKey.slice(0, 16),
        };
      })
    );

    res.json({ bounties: enriched, count: enriched.length });
  } catch (err: any) {
    console.error("[verification] Error listing bounties:", err.message);
    res.status(500).json({ error: "Failed to list bounties" });
  }
});

router.post("/v1/verification/bounties/:id/claim", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.humanId) {
      return res.status(401).json({
        error: "Human verification required. Log in with your Self.xyz passport to claim bounties.",
        hint: "Only passport-verified humans can claim verification bounties.",
      });
    }

    const { id } = req.params;
    const { score, comment } = req.body;

    if (!score || score < 1 || score > 5) {
      return res.status(400).json({ error: "Score must be between 1 and 5" });
    }

    const [bounty] = await db
      .select()
      .from(verificationBounties)
      .where(eq(verificationBounties.id, id));

    if (!bounty) {
      return res.status(404).json({ error: "Bounty not found" });
    }

    if (bounty.status !== "open") {
      return res.status(400).json({ error: "Bounty has already been claimed" });
    }

    const [stake] = await db
      .select()
      .from(reputationStakes)
      .where(eq(reputationStakes.id, bounty.stakeId));

    if (!stake) {
      return res.status(404).json({ error: "Associated stake not found" });
    }

    if (stake.humanId === session.humanId) {
      return res.status(403).json({ error: "Cannot verify your own agent's output" });
    }

    if (stake.status !== "active") {
      return res.status(400).json({ error: "Stake is no longer active for review" });
    }

    const existingReview = await db
      .select()
      .from(stakeReviews)
      .where(
        and(
          eq(stakeReviews.stakeId, bounty.stakeId),
          eq(stakeReviews.reviewerHumanId, session.humanId)
        )
      )
      .limit(1);

    if (existingReview.length > 0) {
      return res.status(409).json({ error: "You have already reviewed this stake" });
    }

    const sessionPublicKey = session.publicKey || `human:${session.humanId}`;

    await db.insert(stakeReviews).values({
      stakeId: bounty.stakeId,
      reviewerHumanId: session.humanId,
      reviewerPublicKey: sessionPublicKey,
      score,
      comment: comment || null,
    });

    const [updatedBounty] = await db
      .update(verificationBounties)
      .set({
        status: "claimed",
        claimedByHumanId: session.humanId,
        claimedByPublicKey: sessionPublicKey,
        verifierType: "human",
        score,
        comment: comment || null,
        claimedAt: new Date(),
      })
      .where(eq(verificationBounties.id, id))
      .returning();

    const reviews = await db
      .select()
      .from(stakeReviews)
      .where(eq(stakeReviews.stakeId, bounty.stakeId));

    const humanBounties = await db
      .select()
      .from(verificationBounties)
      .where(
        and(
          eq(verificationBounties.stakeId, bounty.stakeId),
          eq(verificationBounties.status, "claimed"),
          eq(verificationBounties.verifierType, "human")
        )
      );

    let weightedSum = 0;
    let weightedCount = 0;

    for (const review of reviews) {
      const isHumanReview = humanBounties.some(
        (hb) => hb.claimedByHumanId === review.reviewerHumanId
      );
      const weight = isHumanReview ? 2 : 1;
      weightedSum += review.score * weight;
      weightedCount += weight;
    }

    const weightedAvg = weightedCount > 0 ? weightedSum / weightedCount : 0;
    const reviewCount = reviews.length;

    const updateData: any = {
      reviewCount,
      avgScore: weightedAvg.toFixed(2),
    };

    if (reviewCount >= 3) {
      updateData.resolvedAt = new Date();
      if (weightedAvg >= 3.5) {
        updateData.status = "validated";
        updateData.resolution = "validated";
        updateData.rewardAmount = (parseFloat(stake.stakeAmount) * 0.1).toString();
      } else if (weightedAvg < 2.0) {
        updateData.status = "slashed";
        updateData.resolution = "slashed";
        updateData.slashedAmount = (parseFloat(stake.stakeAmount) * 0.5).toString();
      } else {
        updateData.status = "neutral";
        updateData.resolution = "neutral";
      }
    }

    await db
      .update(reputationStakes)
      .set(updateData)
      .where(eq(reputationStakes.id, bounty.stakeId));

    if (updateData.resolution) {
      try {
        const [bot] = await db
          .select()
          .from(verifiedBots)
          .where(eq(verifiedBots.publicKey, stake.agentPublicKey));
        const erc8004TokenId = (bot?.metadata as any)?.erc8004TokenId || null;
        await db.insert(reputationEvents).values({
          agentPublicKey: stake.agentPublicKey,
          humanId: stake.humanId,
          erc8004TokenId,
          eventType:
            updateData.resolution === "validated"
              ? "stake_validated"
              : updateData.resolution === "slashed"
              ? "stake_slashed"
              : "stake_neutral",
          eventData: {
            stakeId: bounty.stakeId,
            resolution: updateData.resolution,
            avgScore: weightedAvg,
            humanVerified: true,
            bountyId: id,
          },
        });
      } catch (e: any) {
        console.error("[verification] Error logging event:", e.message);
      }
    }

    res.json({
      bounty: updatedBounty,
      stakeResolution: updateData.resolution || null,
      weightedAvgScore: parseFloat(weightedAvg.toFixed(2)),
      reviewCount,
      message: `Bounty claimed. Reward: ${bounty.rewardAmount} SELFCLAW. ${
        updateData.resolution
          ? `Stake resolved as: ${updateData.resolution}`
          : `${3 - reviewCount} more reviews needed for resolution.`
      }`,
    });
  } catch (err: any) {
    console.error("[verification] Error claiming bounty:", err.message);
    res.status(500).json({ error: "Failed to claim bounty" });
  }
});

router.get("/v1/verification/my-claims", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.humanId) {
      return res
        .status(401)
        .json({ error: "Human verification required. Log in with your Self.xyz passport." });
    }

    const claims = await db
      .select({
        id: verificationBounties.id,
        stakeId: verificationBounties.stakeId,
        rewardAmount: verificationBounties.rewardAmount,
        score: verificationBounties.score,
        comment: verificationBounties.comment,
        claimedAt: verificationBounties.claimedAt,
        outputType: reputationStakes.outputType,
        description: reputationStakes.description,
        agentPublicKey: reputationStakes.agentPublicKey,
        stakeStatus: reputationStakes.status,
      })
      .from(verificationBounties)
      .innerJoin(reputationStakes, eq(verificationBounties.stakeId, reputationStakes.id))
      .where(eq(verificationBounties.claimedByHumanId, session.humanId))
      .orderBy(desc(verificationBounties.claimedAt))
      .limit(50);

    const totalEarned = claims.reduce((sum, c) => sum + parseFloat(c.rewardAmount || "0"), 0);

    res.json({ claims, totalEarned: totalEarned.toString(), count: claims.length });
  } catch (err: any) {
    console.error("[verification] Error fetching claims:", err.message);
    res.status(500).json({ error: "Failed to fetch claims" });
  }
});

export default router;
