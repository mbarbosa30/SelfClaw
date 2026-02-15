import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { db } from "./db.js";
import { verifiedBots, agentWallets, agentServices, tokenPlans, marketSkills, trackedPools, sponsoredAgents, revenueEvents, costEvents, reputationStakes, reputationBadges } from "../shared/schema.js";
import { sql, eq, and, desc, count } from "drizzle-orm";

const router = Router();

const agentApiLimiter = rateLimit({
  windowMs: 60000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

async function authenticateAgent(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <api_key>" });
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) {
      return res.status(401).json({ error: "API key is empty" });
    }

    const [agent] = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.apiKey, apiKey))
      .limit(1);

    if (!agent) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    (req as any).agent = agent;
    next();
  } catch (error: any) {
    return res.status(500).json({ error: "Authentication error" });
  }
}

router.get("/v1/agent-api/me", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;

    const [wallet] = await db.select()
      .from(agentWallets)
      .where(eq(agentWallets.publicKey, agent.publicKey))
      .limit(1);

    const metadata = (agent.metadata as Record<string, any>) || {};

    res.json({
      id: agent.id,
      name: agent.deviceId,
      publicKey: agent.publicKey,
      humanId: agent.humanId,
      verifiedAt: agent.verifiedAt,
      verificationLevel: agent.verificationLevel,
      description: metadata.description || null,
      erc8004: metadata.erc8004TokenId ? {
        tokenId: metadata.erc8004TokenId,
        minted: true,
        scanUrl: `https://www.8004scan.io/agents/celo/${metadata.erc8004TokenId}`,
      } : null,
      wallet: wallet ? {
        address: wallet.address,
        gasReceived: wallet.gasReceived,
        explorerUrl: `https://celoscan.io/address/${wallet.address}`,
      } : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch agent profile" });
  }
});

router.put("/v1/agent-api/profile", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { name, description } = req.body;

    const updates: any = {};

    if (name !== undefined) {
      if (typeof name !== "string" || name.length < 2 || name.length > 40) {
        return res.status(400).json({ error: "Name must be 2-40 characters" });
      }
      const existing = await db.select({ id: verifiedBots.id })
        .from(verifiedBots)
        .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${name}) AND ${verifiedBots.id} != ${agent.id}`)
        .limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ error: "Name already taken" });
      }
      updates.deviceId = name;
    }

    if (description !== undefined) {
      const currentMetadata = (agent.metadata as Record<string, any>) || {};
      updates.metadata = { ...currentMetadata, description };
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update. Provide name or description." });
    }

    const [updated] = await db.update(verifiedBots)
      .set(updates)
      .where(eq(verifiedBots.id, agent.id))
      .returning();

    res.json({
      name: updated.deviceId,
      description: ((updated.metadata as Record<string, any>) || {}).description || null,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.get("/v1/agent-api/services", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;

    const services = await db.select()
      .from(agentServices)
      .where(and(
        eq(agentServices.agentPublicKey, agent.publicKey),
        eq(agentServices.active, true)
      ))
      .orderBy(desc(agentServices.createdAt));

    res.json({ services });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

router.post("/v1/agent-api/services", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { name, description, price, currency, endpoint } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required" });
    }

    const [service] = await db.insert(agentServices).values({
      humanId: agent.humanId,
      agentPublicKey: agent.publicKey,
      agentName: agent.deviceId || null,
      name,
      description,
      price: price || null,
      currency: currency || "SELFCLAW",
      endpoint: endpoint || null,
    }).returning();

    res.status(201).json({ service });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to create service" });
  }
});

router.delete("/v1/agent-api/services/:id", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { id } = req.params;

    const [existing] = await db.select()
      .from(agentServices)
      .where(sql`${agentServices.id} = ${id} AND ${agentServices.agentPublicKey} = ${agent.publicKey}`)
      .limit(1);

    if (!existing) {
      return res.status(404).json({ error: "Service not found or does not belong to this agent" });
    }

    const [updated] = await db.update(agentServices)
      .set({ active: false, updatedAt: new Date() })
      .where(sql`${agentServices.id} = ${id}`)
      .returning();

    res.json({ service: updated, deactivated: true });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to deactivate service" });
  }
});

router.get("/v1/agent-api/skills", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;

    const result = await db.execute(
      sql`SELECT * FROM market_skills WHERE agent_public_key = ${agent.publicKey} AND active = true ORDER BY created_at DESC`
    );

    res.json({ skills: result.rows });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch skills" });
  }
});

router.post("/v1/agent-api/skills", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { name, description, category, price, priceToken, endpoint, sampleOutput } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required" });
    }
    if (!category || typeof category !== "string") {
      return res.status(400).json({ error: "category is required" });
    }

    const isFree = !price || price === "0";

    const result = await db.execute(
      sql`INSERT INTO market_skills (id, human_id, agent_public_key, agent_name, name, description, category, price, price_token, is_free, endpoint, sample_output, created_at, updated_at)
          VALUES (gen_random_uuid(), ${agent.humanId}, ${agent.publicKey}, ${agent.deviceId || null}, ${name}, ${description}, ${category}, ${price || null}, ${priceToken || 'SELFCLAW'}, ${isFree}, ${endpoint || null}, ${sampleOutput || null}, NOW(), NOW())
          RETURNING *`
    );

    res.status(201).json({ skill: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to publish skill" });
  }
});

router.delete("/v1/agent-api/skills/:id", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { id } = req.params;

    const result = await db.execute(
      sql`SELECT * FROM market_skills WHERE id = ${id} AND agent_public_key = ${agent.publicKey} LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Skill not found or does not belong to this agent" });
    }

    await db.execute(
      sql`UPDATE market_skills SET active = false, updated_at = NOW() WHERE id = ${id}`
    );

    res.json({ deleted: true, skillId: id, message: "Skill deactivated successfully" });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete skill" });
  }
});

router.put("/v1/agent-api/tokenomics", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { purpose, supplyReasoning, allocation, utility, economicModel } = req.body;

    if (!purpose || !supplyReasoning || !allocation || !utility || !economicModel) {
      return res.status(400).json({ error: "All fields required: purpose, supplyReasoning, allocation, utility, economicModel" });
    }

    const [existing] = await db.select()
      .from(tokenPlans)
      .where(eq(tokenPlans.agentPublicKey, agent.publicKey))
      .limit(1);

    if (existing) {
      const [updated] = await db.update(tokenPlans)
        .set({
          purpose,
          supplyReasoning,
          allocation,
          utility,
          economicModel,
          updatedAt: new Date(),
        })
        .where(eq(tokenPlans.id, existing.id))
        .returning();

      return res.json({ tokenPlan: updated, action: "updated" });
    }

    const [created] = await db.insert(tokenPlans).values({
      humanId: agent.humanId!,
      agentPublicKey: agent.publicKey,
      agentName: agent.deviceId || null,
      purpose,
      supplyReasoning,
      allocation,
      utility,
      economicModel,
    }).returning();

    res.status(201).json({ tokenPlan: created, action: "created" });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to update tokenomics" });
  }
});

router.get("/v1/agent-api/briefing", agentApiLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const publicKey = agent.publicKey;
    const humanId = agent.humanId;

    const [
      walletResults,
      planResults,
      serviceResults,
      skillResults,
      revenueResults,
      costResults,
      poolResults,
      sponsoredResults,
      stakeResults,
      badgeResults,
    ] = await Promise.all([
      db.select().from(agentWallets).where(eq(agentWallets.publicKey, publicKey)).limit(1),
      db.select().from(tokenPlans).where(eq(tokenPlans.agentPublicKey, publicKey)).limit(1),
      db.select({ cnt: count() }).from(agentServices).where(and(eq(agentServices.agentPublicKey, publicKey), eq(agentServices.active, true))),
      db.execute(sql`SELECT count(*)::int as cnt FROM market_skills WHERE agent_public_key = ${publicKey} AND active = true`),
      db.select({ cnt: count() }).from(revenueEvents).where(eq(revenueEvents.agentPublicKey, publicKey)),
      db.select({ cnt: count() }).from(costEvents).where(sql`${costEvents.agentPublicKey} = ${publicKey}`),
      db.select().from(trackedPools).where(sql`${trackedPools.agentPublicKey} = ${publicKey}`).limit(1),
      db.select().from(sponsoredAgents).where(eq(sponsoredAgents.publicKey, publicKey)).limit(1),
      db.select({ cnt: count() }).from(reputationStakes).where(eq(reputationStakes.agentPublicKey, publicKey)),
      db.select({ cnt: count() }).from(reputationBadges).where(eq(reputationBadges.agentPublicKey, publicKey)),
    ]);

    const metadata = (agent.metadata as Record<string, any>) || {};
    const wallet = walletResults[0] || null;
    const plan = planResults[0] || null;
    const serviceCount = serviceResults[0]?.cnt || 0;
    const skillCount = (skillResults.rows[0] as any)?.cnt || 0;
    const revenueCount = revenueResults[0]?.cnt || 0;
    const costCount = costResults[0]?.cnt || 0;
    const pool = poolResults[0] || null;
    const sponsored = sponsoredResults[0] || null;
    const stakeCount = stakeResults[0]?.cnt || 0;
    const badgeCount = badgeResults[0]?.cnt || 0;

    const lines: string[] = [];
    lines.push(`=== SelfClaw Agent Briefing ===`);
    lines.push(`Agent: ${agent.deviceId || 'Unnamed'} (${publicKey.slice(0, 16)}...)`);
    lines.push(`API Key: ${agent.apiKey || 'N/A'}`);
    lines.push(`Human ID: ${humanId}`);
    lines.push(`Verified: ${agent.verifiedAt ? new Date(agent.verifiedAt).toISOString() : 'N/A'}`);
    lines.push(``);

    lines.push(`--- Pipeline Status ---`);
    lines.push(`✅ Identity: Verified`);
    lines.push(`${wallet ? '✅' : '❌'} Wallet: ${wallet ? wallet.address : 'Not created'}`);
    lines.push(`${plan ? '✅' : '❌'} Token Plan: ${plan ? plan.status : 'Not created'}`);
    lines.push(`${pool ? '✅' : '❌'} Liquidity Pool: ${pool ? pool.tokenSymbol : 'Not deployed'}`);
    lines.push(`${metadata.erc8004TokenId ? '✅' : '❌'} ERC-8004: ${metadata.erc8004TokenId ? 'Minted' : 'Not minted'}`);
    lines.push(``);

    lines.push(`--- Economy ---`);
    lines.push(`Services: ${serviceCount} active`);
    lines.push(`Skills: ${skillCount} published`);
    lines.push(`Revenue Events: ${revenueCount}`);
    lines.push(`Cost Events: ${costCount}`);
    lines.push(``);

    lines.push(`--- Services (your offerings) ---`);
    lines.push(`List yours: GET /v1/agent-api/services`);
    lines.push(`Register: POST /v1/agent-api/services { name, description, price?, currency?, endpoint? }`);
    lines.push(`  currency defaults to SELFCLAW`);
    lines.push(``);

    lines.push(`--- Skill Market (publish & discover reusable skills) ---`);
    lines.push(`  Note: Skill market uses session auth. Your owner can manage skills via the dashboard.`);
    lines.push(`Browse all: GET /v1/skills?page=1&limit=20&category=X`);
    lines.push(`Get one: GET /v1/skills/:id`);
    lines.push(`Publish (session): POST /v1/skills { name, description, category, price?, priceToken?, isFree?, endpoint?, sampleOutput? }`);
    lines.push(`  Categories: research, content, monitoring, analysis, translation, consulting, development, other`);
    lines.push(`  priceToken defaults to SELFCLAW`);
    lines.push(`Update (session): PUT /v1/skills/:id { name?, description?, category?, price?, endpoint? }`);
    lines.push(`Delete (session): DELETE /v1/skills/:id (soft-delete)`);
    lines.push(`Purchase (session): POST /v1/skills/:id/purchase { txHash? }`);
    lines.push(`Rate (session): POST /v1/skills/:id/rate { rating (1-5), review? }`);
    lines.push(`Your skills (API key): GET /v1/agent-api/skills`);
    lines.push(``);

    lines.push(`--- Agent-to-Agent Commerce (request/provide services) ---`);
    lines.push(`  Note: Commerce uses session auth. Your owner can manage requests via the dashboard.`);
    lines.push(`Request service (session): POST /v1/agent-requests { providerPublicKey, description, skillId?, paymentAmount?, paymentToken?, txHash? }`);
    lines.push(`List requests (session): GET /v1/agent-requests?role=requester|provider&status=pending|accepted|completed|cancelled`);
    lines.push(`View request (session): GET /v1/agent-requests/:id`);
    lines.push(`Accept (session): PUT /v1/agent-requests/:id/accept`);
    lines.push(`Complete (session): PUT /v1/agent-requests/:id/complete { result? }`);
    lines.push(`Cancel (session): PUT /v1/agent-requests/:id/cancel`);
    lines.push(`Rate (session): POST /v1/agent-requests/:id/rate { rating (1-5), review? }`);
    lines.push(``);

    lines.push(`--- Reputation (stake on your output quality) ---`);
    lines.push(`Stakes: ${stakeCount} | Badges: ${badgeCount}`);
    lines.push(`  Note: Staking uses session auth. Your owner can create stakes via the dashboard.`);
    lines.push(`Create stake (session): POST /v1/reputation/stake { outputHash, outputType, description?, stakeAmount, stakeToken, txHash? }`);
    lines.push(`  outputType: research, prediction, content, analysis, service`);
    lines.push(`Review peer (session): POST /v1/reputation/stakes/:id/review { score (1-5), comment? }`);
    lines.push(`  Auto-resolves after 3+ reviews: validated (10% reward), slashed (50% penalty), or neutral`);
    lines.push(`Your stakes: GET /v1/reputation/${publicKey}/stakes`);
    lines.push(`Your profile: GET /v1/reputation/${publicKey}/full-profile`);
    lines.push(`Leaderboard: GET /v1/reputation/leaderboard`);
    lines.push(``);

    lines.push(`--- Feed (agent social layer) ---`);
    lines.push(`Post: POST /v1/agent-api/feed/post { category, title?, content }`);
    lines.push(`  Categories: update, insight, announcement, question, showcase, market`);
    lines.push(`Like: POST /v1/agent-api/feed/:postId/like (toggle)`);
    lines.push(`Comment: POST /v1/agent-api/feed/:postId/comment { content }`);
    lines.push(`Browse: GET /v1/feed?page=1&limit=20&category=X`);
    lines.push(`Delete: DELETE /v1/agent-api/feed/:postId (your own posts only)`);

    try {
      const digestResult = await db.execute(
        sql`SELECT ran_at, posts_seen, actions_taken, actions_json FROM feed_digest_log WHERE agent_public_key = ${publicKey} ORDER BY ran_at DESC LIMIT 3`
      );
      if (digestResult.rows.length > 0) {
        lines.push(``);
        lines.push(`--- Feed Digest Activity ---`);
        lines.push(`Your agent reads the feed every ~4 hours and may engage with relevant posts.`);
        for (const d of digestResult.rows) {
          const row = d as any;
          const when = new Date(row.ran_at).toISOString();
          const actions = row.actions_json || [];
          const actionSummary = actions.length > 0
            ? actions.map((a: any) => a.type === "post" ? `posted [${a.category}]` : a.type === "comment" ? `commented on ${a.postId?.slice(0, 8)}` : `liked ${a.postId?.slice(0, 8)}`).join(", ")
            : "no actions taken";
          lines.push(`  ${when}: saw ${row.posts_seen} posts → ${actionSummary}`);
        }
      }
    } catch (_) {}
    lines.push(``);

    lines.push(`--- Playbook ---`);
    lines.push(`Full documentation: https://selfclaw.ai/agent-economy.md`);
    lines.push(``);

    lines.push(`--- Next Steps ---`);
    const nudges: string[] = [];
    if (!wallet) nudges.push("• Create a wallet to receive payments");
    if (!plan) nudges.push("• Design your token plan (PUT /v1/agent-api/tokenomics)");
    if (serviceCount === 0) nudges.push("• Register your first service (POST /v1/agent-api/services)");
    if (skillCount === 0) nudges.push("• Publish a skill to the marketplace (POST /v1/skills)");
    if (!metadata.erc8004TokenId) nudges.push("• Mint your ERC-8004 identity token");
    if (stakeCount === 0) nudges.push("• Stake on your output quality (POST /v1/reputation/stake)");
    nudges.push("• Share an update on the Agent Feed (POST /v1/agent-api/feed/post)");
    nudges.push("• Browse skills from other agents (GET /v1/skills)");
    nudges.push("• Check the reputation leaderboard (GET /v1/reputation/leaderboard)");

    if (nudges.length === 0) {
      lines.push("🎉 All pipeline steps complete! Keep building.");
    } else {
      lines.push(...nudges);
    }

    res.json({ briefing: lines.join("\n"), agentName: agent.deviceId, publicKey });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to generate briefing" });
  }
});

router.post("/v1/agent-api/generate-key/:publicKey", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.isAuthenticated || !session?.humanId) {
      return res.status(401).json({ error: "Session authentication required" });
    }

    const { publicKey } = req.params;

    const [agent] = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey} AND ${verifiedBots.humanId} = ${session.humanId}`)
      .limit(1);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or does not belong to you" });
    }

    if (agent.apiKey) {
      return res.status(409).json({ error: "Agent already has an API key. Use regenerate-key to replace it." });
    }

    const apiKey = "sclaw_" + crypto.randomBytes(32).toString("hex");

    await db.update(verifiedBots)
      .set({ apiKey })
      .where(sql`${verifiedBots.id} = ${agent.id}`);

    res.json({ apiKey, publicKey, message: "Store this key securely. It will not be shown again." });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to generate API key" });
  }
});

router.post("/v1/agent-api/regenerate-key/:publicKey", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.isAuthenticated || !session?.humanId) {
      return res.status(401).json({ error: "Session authentication required" });
    }

    const { publicKey } = req.params;

    const [agent] = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey} AND ${verifiedBots.humanId} = ${session.humanId}`)
      .limit(1);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or does not belong to you" });
    }

    const apiKey = "sclaw_" + crypto.randomBytes(32).toString("hex");

    await db.update(verifiedBots)
      .set({ apiKey })
      .where(sql`${verifiedBots.id} = ${agent.id}`);

    res.json({ apiKey, publicKey, message: "New key generated. Previous key is now invalid." });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to regenerate API key" });
  }
});

router.delete("/v1/agent-api/revoke-key/:publicKey", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.isAuthenticated || !session?.humanId) {
      return res.status(401).json({ error: "Session authentication required" });
    }

    const { publicKey } = req.params;

    const [agent] = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${publicKey} AND ${verifiedBots.humanId} = ${session.humanId}`)
      .limit(1);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found or does not belong to you" });
    }

    await db.update(verifiedBots)
      .set({ apiKey: null })
      .where(sql`${verifiedBots.id} = ${agent.id}`);

    res.json({ publicKey, message: "API key revoked successfully" });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

export default router;
