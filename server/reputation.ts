import { Router } from "express";
import { db } from "./db.js";
import { sql, desc, eq, count, and, sum } from "drizzle-orm";
import {
  reputationStakes,
  stakeReviews,
  reputationBadges,
  reputationEvents,
  verifiedBots,
  marketSkills,
  agentRequests,
} from "../shared/schema.js";

const router = Router();

router.post("/v1/reputation/stake", async (req, res) => {
  try {
    const humanId = (req.session as any)?.humanId;
    const publicKey = (req.session as any)?.publicKey;
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
    const humanId = (req.session as any)?.humanId;
    const publicKey = (req.session as any)?.publicKey;
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
      const eventType = updateData.resolution === "validated" ? "stake_validated" : updateData.resolution === "slashed" ? "stake_slashed" : "stake_neutral";
      try {
        const [bot] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, stake.agentPublicKey));
        const erc8004TokenId = (bot?.metadata as any)?.erc8004TokenId || null;
        await db.insert(reputationEvents).values({
          agentPublicKey: stake.agentPublicKey,
          humanId: stake.humanId,
          erc8004TokenId,
          eventType,
          eventData: { stakeId: id, resolution: updateData.resolution, avgScore, stakeAmount: stake.stakeAmount },
        });
      } catch (e: any) {
        console.error("[reputation] Error logging event:", e.message);
      }
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

  const logBadgeEvent = async (badgeType: string, badgeName: string) => {
    try {
      const [bot] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, agentPublicKey));
      const erc8004TokenId = (bot?.metadata as any)?.erc8004TokenId || null;
      await db.insert(reputationEvents).values({
        agentPublicKey,
        humanId,
        erc8004TokenId,
        eventType: "badge_earned",
        eventData: { badgeType, badgeName },
      });
    } catch (e: any) {
      console.error("[reputation] Error logging badge event:", e.message);
    }
  };

  if (validatedCount >= 5 && !hasBadge("reliable_output")) {
    await db.insert(reputationBadges).values({
      humanId,
      agentPublicKey,
      badgeType: "reliable_output",
      badgeName: "Reliable Output",
      description: "Achieved 5+ validated reputation stakes",
    });
    await logBadgeEvent("reliable_output", "Reliable Output");
  }

  if (validatedCount >= 10 && !hasBadge("trusted_expert")) {
    await db.insert(reputationBadges).values({
      humanId,
      agentPublicKey,
      badgeType: "trusted_expert",
      badgeName: "Trusted Expert",
      description: "Achieved 10+ validated reputation stakes",
    });
    await logBadgeEvent("trusted_expert", "Trusted Expert");
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
    await logBadgeEvent("streak_3", "Hot Streak");
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

let leaderboardCache: { data: any; timestamp: number } | null = null;
const LEADERBOARD_CACHE_TTL = 30_000;

router.get("/v1/reputation/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);

    if (leaderboardCache && Date.now() - leaderboardCache.timestamp < LEADERBOARD_CACHE_TTL) {
      return res.json({ leaderboard: leaderboardCache.data.slice(0, limit) });
    }

    const rows = await db.execute(sql`
      SELECT
        vb.public_key,
        COALESCE(NULLIF(vb.device_id, ''), tp.token_symbol, vb.metadata->>'agentName', 'Unknown') as agent_name,
        CASE WHEN vb.metadata->>'erc8004TokenId' IS NOT NULL THEN 20 ELSE 0 END as erc8004_score,
        COALESCE(stk.validated_count, 0) as validated_count,
        COALESCE(stk.slashed_count, 0) as slashed_count,
        COALESCE(stk.total_stakes, 0) as total_stakes,
        COALESCE(bdg.badge_count, 0) as badge_count,
        bdg.badge_names,
        COALESCE(skl.skills_published, 0) as skills_published,
        COALESCE(skl.total_purchases, 0) as total_purchases,
        COALESCE(skl.avg_skill_rating, 0) as avg_skill_rating,
        COALESCE(com.commerce_completed, 0) as commerce_completed,
        COALESCE(com.avg_commerce_rating, 0) as avg_commerce_rating
      FROM verified_bots vb
      LEFT JOIN (
        SELECT DISTINCT ON (agent_public_key)
          agent_public_key, token_symbol
        FROM tracked_pools
        WHERE agent_public_key IS NOT NULL
        ORDER BY agent_public_key, created_at DESC
      ) tp ON tp.agent_public_key = vb.public_key
      LEFT JOIN (
        SELECT agent_public_key,
          COUNT(*) FILTER (WHERE resolution = 'validated')::int as validated_count,
          COUNT(*) FILTER (WHERE resolution = 'slashed')::int as slashed_count,
          COUNT(*)::int as total_stakes
        FROM reputation_stakes GROUP BY agent_public_key
      ) stk ON stk.agent_public_key = vb.public_key
      LEFT JOIN (
        SELECT agent_public_key,
          COUNT(*)::int as badge_count,
          ARRAY_AGG(COALESCE(badge_name, badge_type)) as badge_names
        FROM reputation_badges GROUP BY agent_public_key
      ) bdg ON bdg.agent_public_key = vb.public_key
      LEFT JOIN (
        SELECT agent_public_key,
          COUNT(*)::int as skills_published,
          COALESCE(SUM(purchase_count), 0)::int as total_purchases,
          CASE WHEN COUNT(*) FILTER (WHERE rating_count > 0) > 0
            THEN AVG(CASE WHEN rating_count > 0 THEN rating_sum::float / rating_count END)
            ELSE 0 END as avg_skill_rating
        FROM market_skills WHERE active = true GROUP BY agent_public_key
      ) skl ON skl.agent_public_key = vb.public_key
      LEFT JOIN (
        SELECT provider_public_key,
          COUNT(*)::int as commerce_completed,
          CASE WHEN COUNT(*) FILTER (WHERE rating IS NOT NULL) > 0
            THEN AVG(rating) FILTER (WHERE rating IS NOT NULL)
            ELSE 0 END as avg_commerce_rating
        FROM agent_requests WHERE status = 'completed' GROUP BY provider_public_key
      ) com ON com.provider_public_key = vb.public_key
      WHERE vb.hidden IS NOT TRUE
      ORDER BY (
        CASE WHEN vb.metadata->>'erc8004TokenId' IS NOT NULL THEN 20 ELSE 0 END
        + CASE WHEN (COALESCE(stk.validated_count, 0) + COALESCE(stk.slashed_count, 0)) >= 3
            THEN ROUND(COALESCE(stk.validated_count, 0)::float / NULLIF(COALESCE(stk.validated_count, 0) + COALESCE(stk.slashed_count, 0), 0) * 30)
            ELSE 0 END
        + LEAST(COALESCE(bdg.badge_count, 0) * 5, 15)
      ) DESC
      LIMIT 100
    `);

    const leaderboard = (rows.rows || []).map((r: any) => {
      const erc8004Score = Number(r.erc8004_score) || 0;
      const validatedCount = Number(r.validated_count) || 0;
      const slashedCount = Number(r.slashed_count) || 0;
      const resolvedStakes = validatedCount + slashedCount;

      let stakingScore = 0;
      if (resolvedStakes >= 3) {
        stakingScore = Math.round(validatedCount / resolvedStakes * 30);
      }

      const commerceCompleted = Number(r.commerce_completed) || 0;
      const avgCommerceRating = Number(r.avg_commerce_rating) || 0;
      let commerceScore = 0;
      if (commerceCompleted > 0) {
        const rf = avgCommerceRating > 0 ? Math.min(avgCommerceRating / 5, 1) : 0.5;
        commerceScore = Math.min(Math.round(commerceCompleted * 4 * rf), 20);
      }

      const skillsPublished = Number(r.skills_published) || 0;
      const totalPurchases = Number(r.total_purchases) || 0;
      const avgSkillRating = Number(r.avg_skill_rating) || 0;
      let skillsScore = 0;
      if (skillsPublished > 0) {
        const pf = Math.min(totalPurchases / 10, 1);
        const rf = avgSkillRating > 0 ? Math.min(avgSkillRating / 5, 1) : 0.5;
        skillsScore = Math.min(Math.round(skillsPublished * 5 * pf * rf), 15);
      }

      const badgeCount = Number(r.badge_count) || 0;
      const badgesScore = Math.min(badgeCount * 5, 15);
      const reputationScore = erc8004Score + stakingScore + commerceScore + skillsScore + badgesScore;

      return {
        agentPublicKey: r.public_key,
        agentName: r.agent_name || "Unknown",
        reputationScore,
        scoreBreakdown: { erc8004: erc8004Score, staking: stakingScore, commerce: commerceScore, skills: skillsScore, badges: badgesScore },
        badges: (r.badge_names || []).filter(Boolean),
        totalStakes: Number(r.total_stakes) || 0,
        validatedCount,
      };
    });

    leaderboard.sort((a: any, b: any) => b.reputationScore - a.reputationScore);

    leaderboardCache = { data: leaderboard, timestamp: Date.now() };

    return res.json({ leaderboard: leaderboard.slice(0, limit) });
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

router.get("/v1/reputation/:identifier/full-profile", async (req, res) => {
  try {
    const { identifier } = req.params;
    const agentPublicKey = await resolveIdentifier(identifier);
    if (!agentPublicKey) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const [bot] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, agentPublicKey));
    const metadata = (bot?.metadata as any) || {};
    const erc8004TokenId = metadata.erc8004TokenId || null;
    const agentName = bot?.deviceId || null;
    const verifiedAt = bot?.verifiedAt || null;

    const allStakes = await db.select()
      .from(reputationStakes)
      .where(eq(reputationStakes.agentPublicKey, agentPublicKey))
      .orderBy(desc(reputationStakes.createdAt));

    const totalStakes = allStakes.length;
    const activeStakes = allStakes.filter(s => s.status === "active").length;
    const validatedCount = allStakes.filter(s => s.resolution === "validated").length;
    const slashedCount = allStakes.filter(s => s.resolution === "slashed").length;
    const neutralCount = allStakes.filter(s => s.resolution === "neutral").length;
    const totalStaked = allStakes.reduce((acc, s) => acc + parseFloat(s.stakeAmount), 0);
    const totalRewards = allStakes.reduce((acc, s) => acc + parseFloat(s.rewardAmount || "0"), 0);
    const totalSlashed = allStakes.reduce((acc, s) => acc + parseFloat(s.slashedAmount || "0"), 0);

    let currentStreak = 0;
    for (const s of allStakes) {
      if (s.resolution === "validated") currentStreak++;
      else if (s.status !== "active") break;
    }

    let bestStreak = 0;
    let tempStr = 0;
    for (const s of allStakes) {
      if (s.resolution === "validated") {
        tempStr++;
        bestStreak = Math.max(bestStreak, tempStr);
      } else if (s.status !== "active") {
        tempStr = 0;
      }
    }

    const badges = await db.select()
      .from(reputationBadges)
      .where(eq(reputationBadges.agentPublicKey, agentPublicKey));

    const skills = await db.select()
      .from(marketSkills)
      .where(and(eq(marketSkills.agentPublicKey, agentPublicKey), eq(marketSkills.active, true)));

    const skillsPublished = skills.length;
    const totalPurchases = skills.reduce((acc, s) => acc + (s.purchaseCount || 0), 0);
    const skillsWithRatings = skills.filter(s => (s.ratingCount || 0) > 0);
    const avgSkillRating = skillsWithRatings.length > 0
      ? skillsWithRatings.reduce((acc, s) => acc + ((s.ratingSum || 0) / (s.ratingCount || 1)), 0) / skillsWithRatings.length
      : 0;

    const commerceResults = await db.select()
      .from(agentRequests)
      .where(and(
        eq(agentRequests.providerPublicKey, agentPublicKey),
        eq(agentRequests.status, "completed")
      ));

    const commerceCompleted = commerceResults.length;
    const commerceWithRatings = commerceResults.filter(r => r.rating != null);
    const avgCommerceRating = commerceWithRatings.length > 0
      ? commerceWithRatings.reduce((acc, r) => acc + (r.rating || 0), 0) / commerceWithRatings.length
      : 0;

    let erc8004Score = erc8004TokenId ? 20 : 0;

    let stakingScore = 0;
    const resolvedStakes = validatedCount + slashedCount;
    if (resolvedStakes >= 3) {
      const ratio = validatedCount / resolvedStakes;
      stakingScore = Math.round(ratio * 30);
    }

    let commerceScore = 0;
    if (commerceCompleted > 0) {
      const ratingFactor = avgCommerceRating > 0 ? Math.min(avgCommerceRating / 5, 1) : 0.5;
      commerceScore = Math.min(Math.round(commerceCompleted * 4 * ratingFactor), 20);
    }

    let skillsScore = 0;
    if (skillsPublished > 0) {
      const purchaseFactor = Math.min(totalPurchases / 10, 1);
      const ratingFactor = avgSkillRating > 0 ? Math.min(avgSkillRating / 5, 1) : 0.5;
      skillsScore = Math.min(Math.round(skillsPublished * 5 * purchaseFactor * ratingFactor), 15);
    }

    const badgesScore = Math.min(badges.length * 5, 15);

    const reputationScore = erc8004Score + stakingScore + commerceScore + skillsScore + badgesScore;

    const allDates = [
      ...allStakes.map(s => s.createdAt),
      ...badges.map(b => b.earnedAt),
      verifiedAt,
    ].filter(Boolean);
    const lastActivity = allDates.length > 0
      ? new Date(Math.max(...allDates.map(d => new Date(d!).getTime()))).toISOString()
      : null;

    return res.json({
      agentPublicKey,
      agentName,
      erc8004: { tokenId: erc8004TokenId, registered: !!erc8004TokenId },
      reputationScore,
      scoreBreakdown: {
        erc8004: erc8004Score,
        staking: stakingScore,
        commerce: commerceScore,
        skills: skillsScore,
        badges: badgesScore,
      },
      staking: {
        total: totalStakes,
        validated: validatedCount,
        slashed: slashedCount,
        neutral: neutralCount,
        active: activeStakes,
        totalStaked: totalStaked.toString(),
        totalRewards: totalRewards.toString(),
        totalSlashed: totalSlashed.toString(),
        currentStreak,
        bestStreak,
      },
      badges: badges.map(b => ({
        badgeType: b.badgeType,
        badgeName: b.badgeName,
        description: b.description,
        earnedAt: b.earnedAt,
      })),
      skills: {
        published: skillsPublished,
        totalPurchases,
        avgRating: Number(avgSkillRating.toFixed(1)),
      },
      commerce: {
        completed: commerceCompleted,
        avgRating: Number(avgCommerceRating.toFixed(1)),
      },
      lastActivity,
    });
  } catch (err: any) {
    console.error("[reputation] Error fetching full profile:", err.message);
    return res.status(500).json({ error: "Failed to fetch full reputation profile" });
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
