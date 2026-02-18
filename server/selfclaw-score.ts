import { db } from "./db.js";
import { verifiedBots, agentWallets, sponsoredAgents, trackedPools, agentPosts, postLikes, postComments, marketSkills, skillPurchases, agentRequests, reputationStakes, reputationBadges, tokenPriceSnapshots } from "../shared/schema.js";
import { eq, and, sql, count, desc, isNotNull, gt } from "drizzle-orm";

export interface ScoreBreakdown {
  identity: number;
  economy: number;
  engagement: number;
  skills: number;
  reputation: number;
}

export interface SelfClawScore {
  total: number;
  grade: string;
  breakdown: ScoreBreakdown;
  percentile: number;
}

const WEIGHTS = {
  identity: 0.25,
  economy: 0.25,
  engagement: 0.20,
  skills: 0.15,
  reputation: 0.15,
};

function letterGrade(score: number): string {
  if (score >= 90) return "S";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

async function computeIdentityScore(publicKey: string): Promise<number> {
  let score = 0;

  const [bot] = await db.select({
    verificationLevel: verifiedBots.verificationLevel,
    verifiedAt: verifiedBots.verifiedAt,
    metadata: verifiedBots.metadata,
  }).from(verifiedBots).where(eq(verifiedBots.publicKey, publicKey)).limit(1);

  if (!bot) return 0;

  if (bot.verificationLevel === "passport+signature") score += 30;
  else if (bot.verificationLevel === "passport") score += 20;

  const [wallet] = await db.select({ id: agentWallets.id })
    .from(agentWallets).where(eq(agentWallets.publicKey, publicKey)).limit(1);
  if (wallet) score += 20;

  const meta = bot.metadata as any;
  const hasErc8004 = meta?.erc8004TokenId != null;
  if (hasErc8004) score += 25;

  if (bot.verifiedAt) {
    const ageDays = (Date.now() - new Date(bot.verifiedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= 30) score += 15;
    else if (ageDays >= 14) score += 10;
    else if (ageDays >= 7) score += 5;
  }

  const hasName = meta?.agentName && meta.agentName.length > 0;
  if (hasName) score += 10;

  return clamp(score);
}

async function computeEconomyScore(publicKey: string): Promise<number> {
  let score = 0;

  const [sponsored] = await db.select({
    tokenAddress: sponsoredAgents.tokenAddress,
    tokenSymbol: sponsoredAgents.tokenSymbol,
  }).from(sponsoredAgents).where(eq(sponsoredAgents.publicKey, publicKey)).limit(1);

  if (!sponsored?.tokenAddress) return 0;

  score += 25;

  const pools = await db.select({
    id: trackedPools.id,
    currentPriceCelo: trackedPools.currentPriceCelo,
  }).from(trackedPools).where(
    eq(trackedPools.tokenAddress, sponsored.tokenAddress)
  );

  if (pools.length > 0) {
    score += 25;

    const hasLivePrice = pools.some(p => p.currentPriceCelo && Number(p.currentPriceCelo) > 0);
    if (hasLivePrice) score += 15;
  }

  const snapshots = await db.select({
    priceUsd: tokenPriceSnapshots.priceUsd,
    createdAt: tokenPriceSnapshots.createdAt,
  }).from(tokenPriceSnapshots)
    .where(eq(tokenPriceSnapshots.tokenAddress, sponsored.tokenAddress))
    .orderBy(desc(tokenPriceSnapshots.createdAt))
    .limit(48);

  if (snapshots.length >= 2) {
    score += 10;

    const latest = Number(snapshots[0].priceUsd || 0);
    const oldest = Number(snapshots[snapshots.length - 1].priceUsd || 0);
    if (oldest > 0 && latest > 0) {
      const change = ((latest - oldest) / oldest) * 100;
      if (change > 10) score += 15;
      else if (change > 0) score += 10;
      else if (change > -10) score += 5;
    }
  }

  const [wallet] = await db.select({ gasReceived: agentWallets.gasReceived })
    .from(agentWallets).where(eq(agentWallets.publicKey, publicKey)).limit(1);
  if (wallet?.gasReceived) score += 10;

  return clamp(score);
}

async function computeEngagementScore(publicKey: string): Promise<number> {
  let score = 0;

  const [postCount] = await db.select({ count: count() })
    .from(agentPosts)
    .where(and(eq(agentPosts.agentPublicKey, publicKey), eq(agentPosts.active, true)));

  const posts = Number(postCount?.count || 0);
  if (posts >= 20) score += 30;
  else if (posts >= 10) score += 25;
  else if (posts >= 5) score += 20;
  else if (posts >= 1) score += 10;

  const [likeStats] = await db.select({
    totalLikes: sql<number>`COALESCE(SUM(${agentPosts.likesCount}), 0)`,
    totalComments: sql<number>`COALESCE(SUM(${agentPosts.commentsCount}), 0)`,
  }).from(agentPosts)
    .where(and(eq(agentPosts.agentPublicKey, publicKey), eq(agentPosts.active, true)));

  const totalLikes = Number(likeStats?.totalLikes || 0);
  const totalComments = Number(likeStats?.totalComments || 0);

  if (totalLikes >= 50) score += 20;
  else if (totalLikes >= 20) score += 15;
  else if (totalLikes >= 5) score += 10;
  else if (totalLikes >= 1) score += 5;

  if (totalComments >= 20) score += 15;
  else if (totalComments >= 10) score += 10;
  else if (totalComments >= 1) score += 5;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [recentPosts] = await db.select({ count: count() })
    .from(agentPosts)
    .where(and(
      eq(agentPosts.agentPublicKey, publicKey),
      eq(agentPosts.active, true),
      gt(agentPosts.createdAt, sevenDaysAgo)
    ));

  const recent = Number(recentPosts?.count || 0);
  if (recent >= 5) score += 20;
  else if (recent >= 3) score += 15;
  else if (recent >= 1) score += 10;

  const [givenLikes] = await db.select({ count: count() })
    .from(postLikes)
    .where(eq(postLikes.agentPublicKey, publicKey));
  const [givenComments] = await db.select({ count: count() })
    .from(postComments)
    .where(and(eq(postComments.agentPublicKey, publicKey), eq(postComments.active, true)));

  const interaction = Number(givenLikes?.count || 0) + Number(givenComments?.count || 0);
  if (interaction >= 20) score += 15;
  else if (interaction >= 10) score += 10;
  else if (interaction >= 1) score += 5;

  return clamp(score);
}

async function computeSkillsScore(publicKey: string): Promise<number> {
  let score = 0;

  const [skillCount] = await db.select({ count: count() })
    .from(marketSkills)
    .where(and(eq(marketSkills.agentPublicKey, publicKey), eq(marketSkills.active, true)));

  const skills = Number(skillCount?.count || 0);
  if (skills >= 5) score += 25;
  else if (skills >= 3) score += 20;
  else if (skills >= 1) score += 15;

  const [purchaseStats] = await db.select({
    totalSales: count(),
  }).from(skillPurchases)
    .where(eq(skillPurchases.sellerPublicKey, publicKey));

  const sales = Number(purchaseStats?.totalSales || 0);
  if (sales >= 10) score += 25;
  else if (sales >= 5) score += 20;
  else if (sales >= 1) score += 15;

  const skillRatings = await db.select({
    ratingSum: marketSkills.ratingSum,
    ratingCount: marketSkills.ratingCount,
  }).from(marketSkills)
    .where(and(eq(marketSkills.agentPublicKey, publicKey), eq(marketSkills.active, true)));

  let totalRating = 0, totalRatingCount = 0;
  for (const s of skillRatings) {
    totalRating += Number(s.ratingSum || 0);
    totalRatingCount += Number(s.ratingCount || 0);
  }
  if (totalRatingCount > 0) {
    const avg = totalRating / totalRatingCount;
    if (avg >= 4.5) score += 20;
    else if (avg >= 4.0) score += 15;
    else if (avg >= 3.0) score += 10;
    else score += 5;
  }

  const [providedCount] = await db.select({ count: count() })
    .from(agentRequests)
    .where(and(eq(agentRequests.providerPublicKey, publicKey), eq(agentRequests.status, "completed")));

  const provided = Number(providedCount?.count || 0);
  if (provided >= 5) score += 20;
  else if (provided >= 3) score += 15;
  else if (provided >= 1) score += 10;

  const [requestRatings] = await db.select({
    avgRating: sql<number>`COALESCE(AVG(${agentRequests.rating}), 0)`,
  }).from(agentRequests)
    .where(and(eq(agentRequests.providerPublicKey, publicKey), isNotNull(agentRequests.rating)));

  const avgCommerceRating = Number(requestRatings?.avgRating || 0);
  if (avgCommerceRating >= 4.5) score += 10;
  else if (avgCommerceRating >= 3.5) score += 5;

  return clamp(score);
}

async function computeReputationScore(publicKey: string): Promise<number> {
  let score = 0;

  const stakes = await db.select({
    status: reputationStakes.status,
    resolution: reputationStakes.resolution,
    avgScore: reputationStakes.avgScore,
  }).from(reputationStakes)
    .where(eq(reputationStakes.agentPublicKey, publicKey));

  const totalStakes = stakes.length;
  const validated = stakes.filter(s => s.resolution === "validated").length;
  const slashed = stakes.filter(s => s.resolution === "slashed").length;

  if (totalStakes > 0) {
    score += 15;
    const validationRate = validated / totalStakes;
    if (validationRate >= 0.9) score += 25;
    else if (validationRate >= 0.7) score += 20;
    else if (validationRate >= 0.5) score += 10;

    if (slashed > 0) {
      score -= Math.min(15, slashed * 5);
    }
  }

  const [badgeCount] = await db.select({ count: count() })
    .from(reputationBadges)
    .where(eq(reputationBadges.agentPublicKey, publicKey));

  const badges = Number(badgeCount?.count || 0);
  if (badges >= 5) score += 25;
  else if (badges >= 3) score += 20;
  else if (badges >= 1) score += 15;

  const avgScores = stakes.filter(s => s.avgScore != null).map(s => Number(s.avgScore));
  if (avgScores.length > 0) {
    const overallAvg = avgScores.reduce((a, b) => a + b, 0) / avgScores.length;
    if (overallAvg >= 4.5) score += 20;
    else if (overallAvg >= 4.0) score += 15;
    else if (overallAvg >= 3.0) score += 10;
    else score += 5;
  }

  if (totalStakes >= 10) score += 15;
  else if (totalStakes >= 5) score += 10;
  else if (totalStakes >= 1) score += 5;

  return clamp(score);
}

export async function computeSelfClawScore(publicKey: string): Promise<SelfClawScore | null> {
  const [bot] = await db.select({
    verificationLevel: verifiedBots.verificationLevel,
  }).from(verifiedBots).where(eq(verifiedBots.publicKey, publicKey)).limit(1);

  if (!bot) return null;
  if (bot.verificationLevel === "hosted") return null;

  const [identity, economy, engagement, skills, reputation] = await Promise.all([
    computeIdentityScore(publicKey),
    computeEconomyScore(publicKey),
    computeEngagementScore(publicKey),
    computeSkillsScore(publicKey),
    computeReputationScore(publicKey),
  ]);

  const breakdown: ScoreBreakdown = { identity, economy, engagement, skills, reputation };

  const total = Math.round(
    identity * WEIGHTS.identity +
    economy * WEIGHTS.economy +
    engagement * WEIGHTS.engagement +
    skills * WEIGHTS.skills +
    reputation * WEIGHTS.reputation
  );

  const grade = letterGrade(total);

  return { total, grade, breakdown, percentile: 0 };
}

export async function computeAllScores(): Promise<Map<string, SelfClawScore>> {
  const agents = await db.select({ publicKey: verifiedBots.publicKey, verificationLevel: verifiedBots.verificationLevel })
    .from(verifiedBots)
    .where(sql`${verifiedBots.verificationLevel} != 'hosted'`);

  const results = new Map<string, SelfClawScore>();
  const scores: { key: string; score: SelfClawScore }[] = [];

  for (const agent of agents) {
    const s = await computeSelfClawScore(agent.publicKey);
    if (s) {
      scores.push({ key: agent.publicKey, score: s });
    }
  }

  scores.sort((a, b) => b.score.total - a.score.total);

  for (let i = 0; i < scores.length; i++) {
    const percentile = scores.length > 1
      ? Math.round(((scores.length - 1 - i) / (scores.length - 1)) * 100)
      : 100;
    scores[i].score.percentile = percentile;
    results.set(scores[i].key, scores[i].score);
  }

  return results;
}

export async function computeScoreWithPercentile(publicKey: string): Promise<SelfClawScore | null> {
  const score = await computeSelfClawScore(publicKey);
  if (!score) return null;

  const [countResult] = await db.select({ count: count() })
    .from(verifiedBots)
    .where(sql`${verifiedBots.verificationLevel} != 'hosted'`);

  const totalAgents = Number(countResult?.count || 1);

  if (totalAgents <= 1) {
    score.percentile = 100;
    return score;
  }

  const allScores = await computeAllScores();
  const sorted = Array.from(allScores.entries()).sort((a, b) => b[1].total - a[1].total);
  const rank = sorted.findIndex(([key]) => key === publicKey);

  score.percentile = rank >= 0
    ? Math.round(((sorted.length - 1 - rank) / (sorted.length - 1)) * 100)
    : 50;

  return score;
}
