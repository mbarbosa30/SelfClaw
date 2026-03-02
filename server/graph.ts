import { Router, Request, Response } from "express";
import { pool } from "./db.js";
import { publicApiLimiter } from "./routes/_shared.js";

const router = Router();

let cachedGraphData: any = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function buildGraphData() {
  const nodesResult = await pool.query(`
    SELECT vb.id, vb.public_key, vb.human_id, vb.device_id, vb.metadata,
           COALESCE(ps.total_score, 0) as poc_score,
           COALESCE(ps.grade, '') as grade,
           COALESCE(sk.skills_count, 0) as skills_count
    FROM verified_bots vb
    LEFT JOIN poc_scores ps ON ps.agent_public_key = vb.public_key
    LEFT JOIN (
      SELECT agent_id, COUNT(*) as skills_count
      FROM agent_skills
      WHERE is_active = true
      GROUP BY agent_id
    ) sk ON sk.agent_id = vb.public_key
    WHERE vb.hidden IS NOT TRUE
    ORDER BY vb.created_at
  `);

  const humanGroups: Record<string, number> = {};
  let groupIdx = 0;

  const nodes = nodesResult.rows.map(r => {
    const humanId = r.human_id || "unknown";
    if (!(humanId in humanGroups)) {
      humanGroups[humanId] = groupIdx++;
    }

    return {
      id: r.public_key,
      name: r.device_id || r.public_key.slice(0, 12),
      group: humanId,
      groupIndex: humanGroups[humanId],
      pocScore: Number(r.poc_score) || 0,
      grade: r.grade || '',
      skillsCount: Number(r.skills_count) || 0,
      hasWallet: !!(r.metadata?.walletAddress),
      hasToken: !!(r.metadata?.tokenAddress),
      hasErc8004: !!(r.metadata?.erc8004TokenId),
      isVerified: !!r.human_id,
    };
  });

  const nodeSet = new Set(nodes.map(n => n.id));
  const edges: Array<{ source: string; target: string; type: string; weight: number }> = [];

  const commerceResult = await pool.query(`
    SELECT requester_public_key, provider_public_key, COUNT(*) as cnt
    FROM agent_requests
    WHERE status != 'cancelled'
    GROUP BY requester_public_key, provider_public_key
  `);
  for (const r of commerceResult.rows) {
    if (nodeSet.has(r.requester_public_key) && nodeSet.has(r.provider_public_key)) {
      edges.push({ source: r.requester_public_key, target: r.provider_public_key, type: "commerce", weight: Number(r.cnt) });
    }
  }

  const skillResult = await pool.query(`
    SELECT buyer_public_key, seller_public_key, COUNT(*) as cnt
    FROM skill_purchases
    GROUP BY buyer_public_key, seller_public_key
  `);
  for (const r of skillResult.rows) {
    if (nodeSet.has(r.buyer_public_key) && nodeSet.has(r.seller_public_key)) {
      edges.push({ source: r.buyer_public_key, target: r.seller_public_key, type: "skill", weight: Number(r.cnt) });
    }
  }

  const likeResult = await pool.query(`
    SELECT pl.agent_public_key as liker, ap.agent_public_key as author, COUNT(*) as cnt
    FROM post_likes pl
    JOIN agent_posts ap ON pl.post_id = ap.id
    WHERE pl.agent_public_key IS NOT NULL AND ap.agent_public_key IS NOT NULL
      AND pl.agent_public_key != ap.agent_public_key
    GROUP BY pl.agent_public_key, ap.agent_public_key
  `);
  for (const r of likeResult.rows) {
    if (nodeSet.has(r.liker) && nodeSet.has(r.author)) {
      edges.push({ source: r.liker, target: r.author, type: "feed", weight: Number(r.cnt) });
    }
  }

  const commentResult = await pool.query(`
    SELECT pc.agent_public_key as commenter, ap.agent_public_key as author, COUNT(*) as cnt
    FROM post_comments pc
    JOIN agent_posts ap ON pc.post_id = ap.id
    WHERE pc.agent_public_key IS NOT NULL AND ap.agent_public_key IS NOT NULL
      AND pc.agent_public_key != ap.agent_public_key
    GROUP BY pc.agent_public_key, ap.agent_public_key
  `);
  for (const r of commentResult.rows) {
    if (nodeSet.has(r.commenter) && nodeSet.has(r.author)) {
      const existing = edges.find(e => e.source === r.commenter && e.target === r.author && e.type === "feed");
      if (existing) {
        existing.weight += Number(r.cnt);
      } else {
        edges.push({ source: r.commenter, target: r.author, type: "feed", weight: Number(r.cnt) });
      }
    }
  }

  const reviewResult = await pool.query(`
    SELECT sr.reviewer_public_key, rs.agent_public_key, COUNT(*) as cnt
    FROM stake_reviews sr
    JOIN reputation_stakes rs ON sr.stake_id = rs.id
    WHERE sr.reviewer_public_key IS NOT NULL AND rs.agent_public_key IS NOT NULL
      AND sr.reviewer_public_key != rs.agent_public_key
    GROUP BY sr.reviewer_public_key, rs.agent_public_key
  `);
  for (const r of reviewResult.rows) {
    if (nodeSet.has(r.reviewer_public_key) && nodeSet.has(r.agent_public_key)) {
      edges.push({ source: r.reviewer_public_key, target: r.agent_public_key, type: "reputation", weight: Number(r.cnt) });
    }
  }

  try {
    const insuranceResult = await pool.query(`
      SELECT insurer_public_key, insured_public_key, COUNT(*) as cnt
      FROM insurance_stakes
      WHERE insurer_public_key IS NOT NULL AND insured_public_key IS NOT NULL
      GROUP BY insurer_public_key, insured_public_key
    `);
    for (const r of insuranceResult.rows) {
      if (nodeSet.has(r.insurer_public_key) && nodeSet.has(r.insured_public_key)) {
        edges.push({ source: r.insurer_public_key, target: r.insured_public_key, type: "insurance", weight: Number(r.cnt) });
      }
    }
  } catch { }

  try {
    const referralResult = await pool.query(`
      SELECT rc.owner_public_key as referrer, rcomp.referred_public_key, COUNT(*) as cnt
      FROM referral_completions rcomp
      JOIN referral_codes rc ON rcomp.referral_code = rc.code
      WHERE rc.owner_public_key IS NOT NULL AND rcomp.referred_public_key IS NOT NULL
      GROUP BY rc.owner_public_key, rcomp.referred_public_key
    `);
    for (const r of referralResult.rows) {
      if (nodeSet.has(r.referrer) && nodeSet.has(r.referred_public_key)) {
        edges.push({ source: r.referrer, target: r.referred_public_key, type: "referral", weight: Number(r.cnt) });
      }
    }
  } catch { }

  const humanGroupCount = Object.keys(humanGroups).length;

  return { nodes, edges, humanGroupCount, timestamp: Date.now() };
}

router.get("/v1/graph-data", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cachedGraphData && (now - cacheTimestamp) < CACHE_TTL) {
      return res.json(cachedGraphData);
    }
    cachedGraphData = await buildGraphData();
    cacheTimestamp = now;
    res.json(cachedGraphData);
  } catch (err: any) {
    console.error("[graph] Error building graph data:", err.message);
    res.status(500).json({ error: "Failed to build graph data" });
  }
});

export default router;
