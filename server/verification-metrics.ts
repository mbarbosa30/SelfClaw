import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { sql, eq } from "drizzle-orm";
import {
  verifiedBots,
  reputationStakes,
  verificationBounties,
  verificationMetrics,
  marketSkills,
  agentRequests,
  skillPurchases,
} from "../shared/schema.js";

const router = Router();

export async function refreshVerificationMetrics(): Promise<number> {
  const agents = await db
    .select({ publicKey: verifiedBots.publicKey })
    .from(verifiedBots)
    .where(sql`${verifiedBots.verifiedAt} IS NOT NULL`);

  let updated = 0;

  for (const agent of agents) {
    try {
      const pk = agent.publicKey;

      const stakesResult = await db.execute(sql`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN status != 'active' THEN 1 END) as verified,
          COUNT(CASE WHEN resolution IS NOT NULL THEN 1 END) as resolved
        FROM reputation_stakes WHERE agent_public_key = ${pk}
      `);
      const stakeRow = stakesResult.rows?.[0] as any;
      const totalStakes = parseInt(stakeRow?.total) || 0;
      const verifiedStakes = parseInt(stakeRow?.verified) || 0;

      const skillSalesResult = await db.execute(sql`
        SELECT COALESCE(SUM(purchase_count), 0) as total_sales
        FROM market_skills WHERE agent_public_key = ${pk} AND active = true
      `);
      const skillSales = parseInt((skillSalesResult.rows?.[0] as any)?.total_sales) || 0;

      const servicesResult = await db.execute(sql`
        SELECT COUNT(*) as cnt FROM agent_requests
        WHERE provider_public_key = ${pk} AND status = 'completed'
      `);
      const completedServices = parseInt((servicesResult.rows?.[0] as any)?.cnt) || 0;

      const totalOutputs = totalStakes + skillSales + completedServices;

      const humanBountyResult = await db.execute(sql`
        SELECT COUNT(DISTINCT vb.stake_id) as cnt
        FROM verification_bounties vb
        INNER JOIN reputation_stakes rs ON rs.id = vb.stake_id
        WHERE rs.agent_public_key = ${pk}
        AND vb.status = 'claimed'
        AND vb.verifier_type = 'human'
      `);
      const humanVerified = parseInt((humanBountyResult.rows?.[0] as any)?.cnt) || 0;

      const agentVerified = Math.max(0, verifiedStakes - humanVerified);

      const coverageRatio = totalOutputs > 0 ? (verifiedStakes + skillSales * 0.5) / totalOutputs : 0;
      const humanCoverageRatio = totalOutputs > 0 ? humanVerified / totalOutputs : 0;

      await db
        .insert(verificationMetrics)
        .values({
          agentPublicKey: pk,
          totalOutputs,
          verifiedOutputs: verifiedStakes,
          humanVerifiedOutputs: humanVerified,
          agentVerifiedOutputs: agentVerified,
          coverageRatio: coverageRatio.toFixed(4),
          humanCoverageRatio: humanCoverageRatio.toFixed(4),
          lastRefreshed: new Date(),
        })
        .onConflictDoUpdate({
          target: verificationMetrics.agentPublicKey,
          set: {
            totalOutputs,
            verifiedOutputs: verifiedStakes,
            humanVerifiedOutputs: humanVerified,
            agentVerifiedOutputs: agentVerified,
            coverageRatio: coverageRatio.toFixed(4),
            humanCoverageRatio: humanCoverageRatio.toFixed(4),
            lastRefreshed: new Date(),
          },
        });

      updated++;
    } catch (e: any) {
      console.error(`[verification-metrics] Error for ${agent.publicKey.slice(0, 12)}:`, e.message);
    }
  }

  console.log(`[verification-metrics] Refreshed metrics for ${updated} agents`);
  return updated;
}

router.get("/v1/verification/coverage", async (_req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`
      SELECT
        COUNT(*) as total_agents,
        COALESCE(SUM(total_outputs), 0) as total_outputs,
        COALESCE(SUM(verified_outputs), 0) as verified_outputs,
        COALESCE(SUM(human_verified_outputs), 0) as human_verified,
        COALESCE(SUM(agent_verified_outputs), 0) as agent_verified,
        CASE WHEN COALESCE(SUM(total_outputs), 0) > 0
          THEN ROUND(COALESCE(SUM(verified_outputs), 0)::numeric / SUM(total_outputs)::numeric, 4)
          ELSE 0
        END as platform_coverage_ratio,
        CASE WHEN COALESCE(SUM(total_outputs), 0) > 0
          THEN ROUND(COALESCE(SUM(human_verified_outputs), 0)::numeric / SUM(total_outputs)::numeric, 4)
          ELSE 0
        END as platform_human_coverage_ratio
      FROM verification_metrics
    `);

    const row = result.rows?.[0] as any;

    const totalAgents = parseInt(row?.total_agents) || 0;
    const totalOutputs = parseInt(row?.total_outputs) || 0;
    const verifiedOutputs = parseInt(row?.verified_outputs) || 0;
    const humanVerified = parseInt(row?.human_verified) || 0;
    const agentVerified = parseInt(row?.agent_verified) || 0;
    const platformCoverage = parseFloat(row?.platform_coverage_ratio) || 0;
    const humanCoverage = parseFloat(row?.platform_human_coverage_ratio) || 0;
    const measurabilityGap = 1 - platformCoverage;

    res.json({
      platform: {
        totalAgents,
        totalOutputs,
        verifiedOutputs,
        humanVerifiedOutputs: humanVerified,
        agentVerifiedOutputs: agentVerified,
        coverageRatio: platformCoverage,
        humanCoverageRatio: humanCoverage,
        measurabilityGap: parseFloat(measurabilityGap.toFixed(4)),
      },
      health:
        measurabilityGap < 0.2
          ? "excellent"
          : measurabilityGap < 0.5
          ? "good"
          : measurabilityGap < 0.8
          ? "needs_improvement"
          : "critical",
    });
  } catch (err: any) {
    console.error("[verification-metrics] Error fetching platform coverage:", err.message);
    res.status(500).json({ error: "Failed to fetch verification coverage" });
  }
});

router.get("/v1/verification/coverage/:publicKey", async (req: Request, res: Response) => {
  try {
    const publicKey = req.params.publicKey as string;

    const [metrics] = await db
      .select()
      .from(verificationMetrics)
      .where(eq(verificationMetrics.agentPublicKey, publicKey))
      .limit(1);

    if (!metrics) {
      return res.json({
        agentPublicKey: publicKey,
        totalOutputs: 0,
        verifiedOutputs: 0,
        humanVerifiedOutputs: 0,
        agentVerifiedOutputs: 0,
        coverageRatio: 0,
        humanCoverageRatio: 0,
        measurabilityGap: 1,
        message: "No metrics available yet. Metrics refresh every 2 hours.",
      });
    }

    const coverage = parseFloat(metrics.coverageRatio || "0");
    const measurabilityGap = 1 - coverage;

    res.json({
      ...metrics,
      measurabilityGap: parseFloat(measurabilityGap.toFixed(4)),
    });
  } catch (err: any) {
    console.error("[verification-metrics] Error fetching agent coverage:", err.message);
    res.status(500).json({ error: "Failed to fetch agent verification coverage" });
  }
});

export default router;
