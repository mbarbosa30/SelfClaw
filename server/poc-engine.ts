import { db } from "./db.js";
import {
  verifiedBots, agentWallets, sponsoredAgents, trackedPools,
  agentPosts, marketSkills, skillPurchases, agentRequests,
  reputationStakes, reputationBadges, agentServices,
  referralCodes, referralCompletions, pocScores, agentActivity,
  hostedAgents, verificationMetrics
} from "../shared/schema.js";
import { eq, sql, desc } from "drizzle-orm";

const WEIGHTS = {
  commerce: 25,
  reputation: 20,
  social: 15,
  referral: 10,
  build: 20,
  verification: 10,
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

async function computeCommerceScore(pk: string): Promise<{ score: number; throughput: number }> {
  let score = 0;
  let throughput = 0;

  try {
    const skillRows = await db.execute(sql`
      SELECT COUNT(*) as cnt, COALESCE(SUM(purchase_count), 0) as purchases,
             COALESCE(AVG(CASE WHEN rating_count > 0 THEN rating_sum::float / rating_count ELSE NULL END), 0) as avg_rating
      FROM market_skills WHERE agent_public_key = ${pk} AND active = true
    `);
    const row = skillRows.rows?.[0] as any;
    const published = parseInt(row?.cnt) || 0;
    const purchases = parseInt(row?.purchases) || 0;
    const avgRating = parseFloat(row?.avg_rating) || 0;

    if (published >= 5) score += 15;
    else if (published >= 3) score += 10;
    else if (published >= 1) score += 5;

    if (purchases >= 20) score += 25;
    else if (purchases >= 10) score += 20;
    else if (purchases >= 5) score += 15;
    else if (purchases >= 1) score += 8;

    if (avgRating >= 4.5) score += 10;
    else if (avgRating >= 3.5) score += 5;

    throughput += purchases * 50;
  } catch (e) {}

  try {
    const provRows = await db.execute(sql`
      SELECT status, COUNT(*) as cnt FROM agent_requests
      WHERE provider_public_key = ${pk} GROUP BY status
    `);
    let completed = 0;
    for (const r of (provRows.rows || []) as any[]) {
      if (r.status === 'completed') completed += parseInt(r.cnt) || 0;
    }

    if (completed >= 10) score += 25;
    else if (completed >= 5) score += 20;
    else if (completed >= 3) score += 15;
    else if (completed >= 1) score += 8;

    throughput += completed * 100;

    const serviceRows = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM agent_services
      WHERE agent_public_key = ${pk} AND active = true
    `);
    const services = parseInt((serviceRows.rows?.[0] as any)?.cnt) || 0;
    if (services >= 3) score += 10;
    else if (services >= 1) score += 5;
  } catch (e) {}

  try {
    const buyRows = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM skill_purchases
      WHERE buyer_public_key = ${pk} AND status IN ('completed', 'confirmed')
    `);
    const bought = parseInt((buyRows.rows?.[0] as any)?.cnt) || 0;
    if (bought >= 5) score += 10;
    else if (bought >= 1) score += 5;

    throughput += bought * 50;
  } catch (e) {}

  return { score: clamp(score), throughput };
}

async function computeReputationScore(pk: string): Promise<number> {
  let score = 0;

  try {
    const stakeRows = await db.execute(sql`
      SELECT status, resolution, COUNT(*) as cnt FROM reputation_stakes
      WHERE agent_public_key = ${pk} GROUP BY status, resolution
    `);
    let active = 0, validated = 0, slashed = 0;
    for (const r of (stakeRows.rows || []) as any[]) {
      const c = parseInt(r.cnt) || 0;
      if (r.status === 'active') active += c;
      if (r.resolution === 'validated') validated += c;
      if (r.resolution === 'slashed') slashed += c;
    }

    if (active >= 3) score += 15;
    else if (active >= 1) score += 8;

    if (validated >= 10) score += 30;
    else if (validated >= 5) score += 25;
    else if (validated >= 3) score += 20;
    else if (validated >= 1) score += 10;

    if (slashed > validated) score -= 20;
    else if (slashed > 0) score -= 5;

    const badgeRows = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM reputation_badges WHERE agent_public_key = ${pk}
    `);
    const badges = parseInt((badgeRows.rows?.[0] as any)?.cnt) || 0;
    if (badges >= 5) score += 25;
    else if (badges >= 3) score += 20;
    else if (badges >= 1) score += 10;
  } catch (e) {}

  try {
    const reviewRows = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM reputation_stakes
      WHERE reviewer_public_key = ${pk} AND resolution IS NOT NULL
    `);
    const reviewed = parseInt((reviewRows.rows?.[0] as any)?.cnt) || 0;
    if (reviewed >= 5) score += 15;
    else if (reviewed >= 1) score += 8;
  } catch (e) {}

  return clamp(score);
}

async function computeSocialScore(pk: string): Promise<number> {
  let score = 0;

  try {
    const postRows = await db.execute(sql`
      SELECT COUNT(*) as cnt,
             COALESCE(SUM(likes_count), 0) as total_likes,
             COALESCE(SUM(comments_count), 0) as total_comments
      FROM agent_posts WHERE agent_public_key = ${pk} AND active = true
    `);
    const row = postRows.rows?.[0] as any;
    const posts = parseInt(row?.cnt) || 0;
    const likes = parseInt(row?.total_likes) || 0;
    const comments = parseInt(row?.total_comments) || 0;

    if (posts >= 20) score += 25;
    else if (posts >= 10) score += 20;
    else if (posts >= 5) score += 15;
    else if (posts >= 1) score += 8;

    if (likes >= 50) score += 25;
    else if (likes >= 20) score += 20;
    else if (likes >= 10) score += 15;
    else if (likes >= 1) score += 5;

    if (comments >= 20) score += 25;
    else if (comments >= 10) score += 20;
    else if (comments >= 5) score += 15;
    else if (comments >= 1) score += 5;

    const givenLikes = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM post_likes WHERE agent_public_key = ${pk}
    `);
    const given = parseInt((givenLikes.rows?.[0] as any)?.cnt) || 0;
    if (given >= 10) score += 15;
    else if (given >= 5) score += 10;
    else if (given >= 1) score += 5;

    const givenComments = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM post_comments WHERE agent_public_key = ${pk}
    `);
    const commentsMade = parseInt((givenComments.rows?.[0] as any)?.cnt) || 0;
    if (commentsMade >= 10) score += 10;
    else if (commentsMade >= 1) score += 5;
  } catch (e) {}

  return clamp(score);
}

async function computeReferralScore(pk: string): Promise<number> {
  let score = 0;

  try {
    const [refCode] = await db.select().from(referralCodes).where(eq(referralCodes.ownerPublicKey, pk)).limit(1);
    if (refCode) {
      score += 10;
      const referrals = refCode.totalReferrals || 0;
      if (referrals >= 10) score += 60;
      else if (referrals >= 5) score += 45;
      else if (referrals >= 3) score += 30;
      else if (referrals >= 1) score += 15;

      const completions = await db.select().from(referralCompletions)
        .where(eq(referralCompletions.referralCodeId, refCode.id));
      const verified = completions.filter(c => c.rewardStatus === 'completed' || c.rewardStatus === 'pending').length;
      if (verified >= 5) score += 30;
      else if (verified >= 1) score += 15;
    }
  } catch (e) {}

  return clamp(score);
}

async function computeBuildScore(pk: string): Promise<number> {
  let score = 0;

  try {
    const [wallet] = await db.select({ id: agentWallets.id })
      .from(agentWallets).where(eq(agentWallets.publicKey, pk)).limit(1);
    if (wallet) score += 15;

    const [bot] = await db.select({ metadata: verifiedBots.metadata })
      .from(verifiedBots).where(eq(verifiedBots.publicKey, pk)).limit(1);
    const meta = (bot?.metadata as any) || {};
    if (meta.erc8004TokenId) score += 20;

    const [sponsored] = await db.select({ tokenAddress: sponsoredAgents.tokenAddress })
      .from(sponsoredAgents).where(eq(sponsoredAgents.publicKey, pk)).limit(1);
    if (sponsored?.tokenAddress) score += 20;

    const [pool] = await db.select({ poolAddress: trackedPools.poolAddress })
      .from(trackedPools).where(sql`${trackedPools.agentPublicKey} = ${pk}`).limit(1);
    if (pool?.poolAddress) score += 20;

    const apiActivity = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM agent_activity
      WHERE agent_public_key = ${pk}
      AND event_type NOT LIKE '%_failed'
      AND created_at > NOW() - INTERVAL '30 days'
    `);
    const recentActions = parseInt((apiActivity.rows?.[0] as any)?.cnt) || 0;
    if (recentActions >= 50) score += 25;
    else if (recentActions >= 20) score += 20;
    else if (recentActions >= 10) score += 15;
    else if (recentActions >= 1) score += 5;
  } catch (e) {}

  return clamp(score);
}

async function computeVerificationScore(pk: string): Promise<number> {
  let score = 0;

  try {
    const [metrics] = await db.select()
      .from(verificationMetrics)
      .where(eq(verificationMetrics.agentPublicKey, pk))
      .limit(1);

    if (!metrics) return 0;

    const coverage = parseFloat(metrics.coverageRatio || "0");
    const humanCoverage = parseFloat(metrics.humanCoverageRatio || "0");
    const totalOutputs = metrics.totalOutputs || 0;

    if (totalOutputs === 0) return 0;

    if (coverage >= 0.8) score += 40;
    else if (coverage >= 0.5) score += 30;
    else if (coverage >= 0.2) score += 15;
    else if (coverage > 0) score += 5;

    if (humanCoverage >= 0.5) score += 35;
    else if (humanCoverage >= 0.2) score += 25;
    else if (humanCoverage >= 0.1) score += 15;
    else if (humanCoverage > 0) score += 5;

    if (totalOutputs >= 20) score += 25;
    else if (totalOutputs >= 10) score += 20;
    else if (totalOutputs >= 5) score += 15;
    else if (totalOutputs >= 1) score += 5;
  } catch (e) {}

  return clamp(score);
}

export interface PocResult {
  totalScore: number;
  grade: string;
  breakdown: {
    commerce: number;
    reputation: number;
    social: number;
    referral: number;
    build: number;
    verification: number;
  };
  throughput: number;
  rank: number | null;
  percentile: number | null;
}

export async function computePocScore(pk: string): Promise<PocResult> {
  const commerce = await computeCommerceScore(pk);
  const reputation = await computeReputationScore(pk);
  const social = await computeSocialScore(pk);
  const referral = await computeReferralScore(pk);
  const build = await computeBuildScore(pk);
  const verification = await computeVerificationScore(pk);

  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const weighted =
    (commerce.score * WEIGHTS.commerce +
    reputation * WEIGHTS.reputation +
    social * WEIGHTS.social +
    referral * WEIGHTS.referral +
    build * WEIGHTS.build +
    verification * WEIGHTS.verification) / totalWeight;

  const totalScore = Math.round(clamp(weighted));

  return {
    totalScore,
    grade: letterGrade(totalScore),
    breakdown: {
      commerce: commerce.score,
      reputation,
      social,
      referral,
      build,
      verification,
    },
    throughput: commerce.throughput,
    rank: null,
    percentile: null,
  };
}

export async function refreshAllPocScores(): Promise<number> {
  const agents = await db.select({
    publicKey: verifiedBots.publicKey,
    deviceId: verifiedBots.deviceId,
    humanId: verifiedBots.humanId,
  }).from(verifiedBots).where(sql`${verifiedBots.verifiedAt} IS NOT NULL`);

  const scores: { pk: string; name: string | null; humanId: string | null; total: number; result: PocResult }[] = [];

  for (const agent of agents) {
    try {
      const result = await computePocScore(agent.publicKey);
      scores.push({
        pk: agent.publicKey,
        name: agent.deviceId,
        humanId: agent.humanId,
        total: result.totalScore,
        result,
      });
    } catch (e: any) {
      console.error(`[poc] Error computing score for ${agent.deviceId || agent.publicKey.substring(0, 12)}:`, e.message);
    }
  }

  scores.sort((a, b) => b.total - a.total);

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const rank = i + 1;
    const percentile = scores.length > 1
      ? Math.round(((scores.length - rank) / (scores.length - 1)) * 100)
      : 100;

    try {
      await db.insert(pocScores).values({
        agentPublicKey: s.pk,
        agentName: s.name,
        humanId: s.humanId,
        totalScore: s.result.totalScore,
        commerceScore: s.result.breakdown.commerce,
        reputationScore: s.result.breakdown.reputation,
        socialScore: s.result.breakdown.social,
        referralScore: s.result.breakdown.referral,
        buildScore: s.result.breakdown.build,
        verificationScore: s.result.breakdown.verification,
        totalThroughput: String(s.result.throughput),
        rank,
        percentile,
        grade: s.result.grade,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: pocScores.agentPublicKey,
        set: {
          agentName: s.name,
          humanId: s.humanId,
          totalScore: s.result.totalScore,
          commerceScore: s.result.breakdown.commerce,
          reputationScore: s.result.breakdown.reputation,
          socialScore: s.result.breakdown.social,
          referralScore: s.result.breakdown.referral,
          buildScore: s.result.breakdown.build,
          verificationScore: s.result.breakdown.verification,
          totalThroughput: String(s.result.throughput),
          rank,
          percentile,
          grade: s.result.grade,
          updatedAt: new Date(),
        },
      });
    } catch (e: any) {
      console.error(`[poc] Error saving score for ${s.name}:`, e.message);
    }
  }

  console.log(`[poc] Refreshed ${scores.length} agent PoC scores`);
  return scores.length;
}

export async function getPocLeaderboard(limit = 50): Promise<any[]> {
  const rows = await db.select().from(pocScores)
    .orderBy(desc(pocScores.totalScore))
    .limit(limit);
  return rows;
}

export async function getAgentPocScore(pk: string): Promise<PocScore | null> {
  const [row] = await db.select().from(pocScores)
    .where(eq(pocScores.agentPublicKey, pk))
    .limit(1);
  return row || null;
}

type PocScore = typeof pocScores.$inferSelect;
