import { Router } from "express";
import { db } from "./db.js";
import { sql, desc, eq, count, and, sum } from "drizzle-orm";
import {
  reputationStakes,
  stakeReviews,
  reputationBadges,
  verifiedBots,
} from "../shared/schema.js";

const router = Router();

router.post("/v1/reputation/stake", async (req, res) => {
  try {
    const humanId = req.session?.humanId;
    const publicKey = req.session?.publicKey;
    if (!humanId || !publicKey) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { outputHash, outputType, description, stakeAmount, stakeToken, txHash } = req.body;

    if (!outputHash || !outputType || !stakeAmount || !stakeToken) {
      return res.status(400).json({ error: "Missing required fields: outputHash, outputType, stakeAmount, stakeToken" });
    }

    const validTypes = ["research", "prediction", "content", "analysis", "service"];
    if (!validTypes.includes(outputType)) {
      return res.status(400).json({ error: `Invalid outputType. Must be one of: ${validTypes.join(", ")}` });
    }

    const [stake] = await db.insert(reputationStakes).values({
      humanId,
      agentPublicKey: publicKey,
      outputHash,
      outputType,
      description: description || null,
      stakeAmount,
      stakeToken,
      status: "active",
    }).returning();

    return res.json({ stake });
  } catch (err: any) {
    console.error("[reputation] Error creating stake:", err.message);
    return res.status(500).json({ error: "Failed to create stake" });
  }
});

router.post("/v1/reputation/stakes/:id/review", async (req, res) => {
  try {
    const humanId = req.session?.humanId;
    const publicKey = req.session?.publicKey;
    if (!humanId || !publicKey) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { id } = req.params;
    const { score, comment } = req.body;

    if (!score || score < 1 || score > 5) {
      return res.status(400).json({ error: "Score must be between 1 and 5" });
    }

    const [stake] = await db.select().from(reputationStakes).where(eq(reputationStakes.id, id));
    if (!stake) {
      return res.status(404).json({ error: "Stake not found" });
    }

    if (stake.agentPublicKey === publicKey) {
      return res.status(403).json({ error: "Cannot review your own stake" });
    }

    if (stake.status !== "active") {
      return res.status(400).json({ error: "Stake is no longer active" });
    }

    await db.insert(stakeReviews).values({
      stakeId: id,
      reviewerHumanId: humanId,
      reviewerPublicKey: publicKey,
      score,
      comment: comment || null,
    });

    const reviews = await db.select().from(stakeReviews).where(eq(stakeReviews.stakeId, id));
    const reviewCount = reviews.length;
    const avgScore = reviews.reduce((sum, r) => sum + r.score, 0) / reviewCount;

    const updateData: any = {
      reviewCount,
      avgScore: avgScore.toFixed(2),
    };

    if (reviewCount >= 3) {
      updateData.resolvedAt = new Date();
      if (avgScore >= 3.5) {
        updateData.status = "validated";
        updateData.resolution = "validated";
        updateData.rewardAmount = (parseFloat(stake.stakeAmount) * 0.1).toString();
      } else if (avgScore < 2.0) {
        updateData.status = "slashed";
        updateData.resolution = "slashed";
        updateData.slashedAmount = (parseFloat(stake.stakeAmount) * 0.5).toString();
      } else {
        updateData.status = "neutral";
        updateData.resolution = "neutral";
      }
    }

    const [updatedStake] = await db.update(reputationStakes)
      .set(updateData)
      .where(eq(reputationStakes.id, id))
      .returning();

    if (updateData.resolution) {
      await checkAndAwardBadges(stake.agentPublicKey, stake.humanId);
    }

    return res.json({ stake: updatedStake });
  } catch (err: any) {
    console.error("[reputation] Error creating review:", err.message);
    return res.status(500).json({ error: "Failed to create review" });
  }
});

async function checkAndAwardBadges(agentPublicKey: string, humanId: string) {
  const validatedStakes = await db.select()
    .from(reputationStakes)
    .where(and(
      eq(reputationStakes.agentPublicKey, agentPublicKey),
      eq(reputationStakes.resolution, "validated")
    ));

  const validatedCount = validatedStakes.length;

  const existingBadges = await db.select()
    .from(reputationBadges)
    .where(eq(reputationBadges.agentPublicKey, agentPublicKey));

  const hasBadge = (type: string) => existingBadges.some(b => b.badgeType === type);

  if (validatedCount >= 5 && !hasBadge("reliable_output")) {
    await db.insert(reputationBadges).values({
      humanId,
      agentPublicKey,
      badgeType: "reliable_output",
      badgeName: "Reliable Output",
      description: "Achieved 5+ validated reputation stakes",
    });
  }

  if (validatedCount >= 10 && !hasBadge("trusted_expert")) {
    await db.insert(reputationBadges).values({
      humanId,
      agentPublicKey,
      badgeType: "trusted_expert",
      badgeName: "Trusted Expert",
      description: "Achieved 10+ validated reputation stakes",
    });
  }

  const allStakes = await db.select()
    .from(reputationStakes)
    .where(eq(reputationStakes.agentPublicKey, agentPublicKey))
    .orderBy(desc(reputationStakes.createdAt));

  let streak = 0;
  for (const s of allStakes) {
    if (s.resolution === "validated") {
      streak++;
    } else if (s.status !== "active") {
      break;
    }
  }

  if (streak >= 3 && !hasBadge("streak_3")) {
    await db.insert(reputationBadges).values({
      humanId,
      agentPublicKey,
      badgeType: "streak_3",
      badgeName: "Hot Streak",
      description: "Achieved 3+ consecutive validated stakes",
    });
  }
}

async function resolveIdentifier(identifier: string): Promise<string | null> {
  if (identifier.length > 50) {
    return identifier;
  }

  const [bot] = await db.select()
    .from(verifiedBots)
    .where(eq(verifiedBots.publicKey, identifier));

  if (bot) return identifier;

  const [botByName] = await db.select()
    .from(verifiedBots)
    .where(sql`${verifiedBots.metadata}->>'name' = ${identifier}`);

  if (botByName) return botByName.publicKey;

  return identifier;
}

router.get("/v1/reputation/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const results = await db.select({
      agentPublicKey: reputationStakes.agentPublicKey,
      agentName: reputationStakes.agentName,
      humanId: reputationStakes.humanId,
      totalStakes: sql<number>`count(*)::int`,
      validatedCount: sql<number>`count(*) filter (where ${reputationStakes.resolution} = 'validated')::int`,
      slashedCount: sql<number>`count(*) filter (where ${reputationStakes.resolution} = 'slashed')::int`,
      totalStaked: sql<string>`coalesce(sum(${reputationStakes.stakeAmount}::numeric), 0)::text`,
    })
      .from(reputationStakes)
      .groupBy(reputationStakes.agentPublicKey, reputationStakes.agentName, reputationStakes.humanId)
      .orderBy(sql`count(*) filter (where ${reputationStakes.resolution} = 'validated') desc`)
      .limit(limit);

    return res.json({ leaderboard: results });
  } catch (err: any) {
    console.error("[reputation] Error fetching leaderboard:", err.message);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

router.get("/v1/reputation/:identifier/stakes", async (req, res) => {
  try {
    const { identifier } = req.params;
    const agentPublicKey = await resolveIdentifier(identifier);
    if (!agentPublicKey) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const status = req.query.status as string;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;

    const conditions = [eq(reputationStakes.agentPublicKey, agentPublicKey)];
    if (status && ["active", "validated", "slashed", "neutral"].includes(status)) {
      conditions.push(eq(reputationStakes.status, status));
    }

    const stakes = await db.select()
      .from(reputationStakes)
      .where(and(...conditions))
      .orderBy(desc(reputationStakes.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
      .from(reputationStakes)
      .where(and(...conditions));

    return res.json({
      stakes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    console.error("[reputation] Error fetching stakes:", err.message);
    return res.status(500).json({ error: "Failed to fetch stakes" });
  }
});

router.get("/v1/reputation/:identifier", async (req, res) => {
  try {
    const { identifier } = req.params;

    if (identifier === "leaderboard") {
      return res.status(400).json({ error: "Use /v1/reputation/leaderboard endpoint" });
    }

    const agentPublicKey = await resolveIdentifier(identifier);
    if (!agentPublicKey) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const allStakes = await db.select()
      .from(reputationStakes)
      .where(eq(reputationStakes.agentPublicKey, agentPublicKey))
      .orderBy(desc(reputationStakes.createdAt));

    const totalStakes = allStakes.length;
    const activeStakes = allStakes.filter(s => s.status === "active").length;
    const validatedCount = allStakes.filter(s => s.resolution === "validated").length;
    const slashedCount = allStakes.filter(s => s.resolution === "slashed").length;
    const neutralCount = allStakes.filter(s => s.resolution === "neutral").length;
    const totalStaked = allStakes.reduce((sum, s) => sum + parseFloat(s.stakeAmount), 0);
    const totalRewards = allStakes.reduce((sum, s) => sum + parseFloat(s.rewardAmount || "0"), 0);
    const totalSlashed = allStakes.reduce((sum, s) => sum + parseFloat(s.slashedAmount || "0"), 0);

    let streakCurrent = 0;
    for (const s of allStakes) {
      if (s.resolution === "validated") {
        streakCurrent++;
      } else if (s.status !== "active") {
        break;
      }
    }

    let streakBest = 0;
    let tempStreak = 0;
    for (const s of allStakes) {
      if (s.resolution === "validated") {
        tempStreak++;
        streakBest = Math.max(streakBest, tempStreak);
      } else if (s.status !== "active") {
        tempStreak = 0;
      }
    }

    const badges = await db.select()
      .from(reputationBadges)
      .where(eq(reputationBadges.agentPublicKey, agentPublicKey));

    const recentStakes = allStakes.slice(0, 10);
    const recentStakeIds = recentStakes.map(s => s.id);

    let reviewsForRecent: any[] = [];
    if (recentStakeIds.length > 0) {
      reviewsForRecent = await db.select()
        .from(stakeReviews)
        .where(sql`${stakeReviews.stakeId} = ANY(${recentStakeIds})`);
    }

    const recentWithReviews = recentStakes.map(s => ({
      ...s,
      reviews: reviewsForRecent.filter(r => r.stakeId === s.id),
    }));

    return res.json({
      summary: {
        totalStakes,
        activeStakes,
        validatedCount,
        slashedCount,
        neutralCount,
        totalStaked: totalStaked.toString(),
        totalRewards: totalRewards.toString(),
        totalSlashed: totalSlashed.toString(),
        streakCurrent,
        streakBest,
      },
      badges,
      recentStakes: recentWithReviews,
    });
  } catch (err: any) {
    console.error("[reputation] Error fetching profile:", err.message);
    return res.status(500).json({ error: "Failed to fetch reputation profile" });
  }
});

export default router;
