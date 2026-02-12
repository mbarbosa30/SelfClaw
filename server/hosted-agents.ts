import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import OpenAI from "openai";
import { db } from "./db.js";
import {
  hostedAgents, agentTaskQueue, agentWallets, verifiedBots, agentActivity,
  trackedPools, revenueEvents, costEvents, sponsoredAgents,
  type HostedAgent, type InsertHostedAgent, type AgentTask
} from "../shared/schema.js";
import { eq, and, desc, sql, count, inArray } from "drizzle-orm";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

interface SkillContext {
  db: typeof db;
  openai: OpenAI;
  now: Date;
}

interface SkillResult {
  success: boolean;
  summary: string;
  data?: any;
  alerts?: string[];
  tokensUsed?: number;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'monitoring' | 'economics' | 'identity' | 'social' | 'autonomous';
  scheduleInterval: number;
  requiresWallet: boolean;
  handler: (agent: HostedAgent, context: SkillContext) => Promise<SkillResult>;
}

async function walletMonitorHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const wallets = await ctx.db.select().from(agentWallets)
      .where(eq(agentWallets.humanId, agent.humanId)).limit(5);
    if (wallets.length === 0) {
      return { success: true, summary: "No wallets found for this agent.", data: { wallets: [] } };
    }
    return {
      success: true,
      summary: `Monitoring ${wallets.length} wallet(s). Addresses: ${wallets.map(w => w.address.slice(0, 10) + '...').join(', ')}`,
      data: { walletCount: wallets.length, addresses: wallets.map(w => w.address) },
    };
  } catch (e: any) {
    return { success: false, summary: `Wallet monitor error: ${e.message}` };
  }
}

async function economicsTrackerHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
    const revenues = await ctx.db.select().from(revenueEvents)
      .where(and(eq(revenueEvents.humanId, agent.humanId), sql`${revenueEvents.createdAt} >= ${since}`));
    const costs = await ctx.db.select().from(costEvents)
      .where(and(eq(costEvents.humanId, agent.humanId), sql`${costEvents.createdAt} >= ${since}`));
    const totalRevenue = revenues.reduce((s, r) => s + parseFloat(r.amount || "0"), 0);
    const totalCosts = costs.reduce((s, c) => s + parseFloat(c.amount || "0"), 0);
    return {
      success: true,
      summary: `24h economics: Revenue ${totalRevenue.toFixed(4)}, Costs ${totalCosts.toFixed(4)}, Net ${(totalRevenue - totalCosts).toFixed(4)}`,
      data: { totalRevenue, totalCosts, net: totalRevenue - totalCosts, revenueCount: revenues.length, costCount: costs.length },
    };
  } catch (e: any) {
    return { success: false, summary: `Economics tracker error: ${e.message}` };
  }
}

async function priceWatcherHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const pools = await ctx.db.select().from(trackedPools)
      .where(eq(trackedPools.humanId, agent.humanId)).limit(5);
    if (pools.length === 0) {
      return { success: true, summary: "No tracked token pools found.", data: { pools: [] } };
    }
    const poolData = pools.map(p => ({
      symbol: p.tokenSymbol, price: p.currentPriceCelo, change24h: p.priceChange24h,
    }));
    const alerts: string[] = [];
    pools.forEach(p => {
      const change = parseFloat(p.priceChange24h || "0");
      if (Math.abs(change) > 10) alerts.push(`${p.tokenSymbol} moved ${change > 0 ? '+' : ''}${change.toFixed(2)}% in 24h`);
    });
    return {
      success: true,
      summary: `Tracking ${pools.length} token(s). ${alerts.length ? alerts.join('; ') : 'No significant changes.'}`,
      data: { pools: poolData }, alerts,
    };
  } catch (e: any) {
    return { success: false, summary: `Price watcher error: ${e.message}` };
  }
}

async function reputationMonitorHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const bots = await ctx.db.select().from(verifiedBots)
      .where(eq(verifiedBots.humanId, agent.humanId));
    const verifiedCount = bots.length;
    const hasMetadata = bots.filter(b => b.metadata).length;
    return {
      success: true,
      summary: `Reputation: ${verifiedCount} verified agent(s), ${hasMetadata} with extended metadata.`,
      data: { verifiedCount, withMetadata: hasMetadata },
    };
  } catch (e: any) {
    return { success: false, summary: `Reputation monitor error: ${e.message}` };
  }
}

async function smartAdvisorHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const wallets = await ctx.db.select().from(agentWallets).where(eq(agentWallets.humanId, agent.humanId)).limit(3);
    const pools = await ctx.db.select().from(trackedPools).where(eq(trackedPools.humanId, agent.humanId)).limit(3);
    const bots = await ctx.db.select().from(verifiedBots).where(eq(verifiedBots.humanId, agent.humanId)).limit(5);

    const stateStr = JSON.stringify({
      agentName: agent.name, status: agent.status,
      wallets: wallets.length, pools: pools.map(p => ({ symbol: p.tokenSymbol, price: p.currentPriceCelo })),
      verifiedBots: bots.length, enabledSkills: agent.enabledSkills,
      llmUsage: `${agent.llmTokensUsedToday}/${agent.llmTokensLimit}`,
      apiUsage: `${agent.apiCallsToday}/${agent.apiCallsLimit}`,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise AI advisor for autonomous agents on the SelfClaw platform. Analyze the agent's state and suggest 2-3 actionable improvements. Keep response under 200 words." },
        { role: "user", content: `Analyze this agent's state and suggest improvements:\n${stateStr}` },
      ],
      max_tokens: 300,
    });

    const advice = completion.choices[0]?.message?.content || "No advice generated.";
    const tokensUsed = completion.usage?.total_tokens || 0;

    return {
      success: true,
      summary: advice,
      data: { advice },
      tokensUsed,
    };
  } catch (e: any) {
    return { success: false, summary: `Smart advisor error: ${e.message}` };
  }
}

const AVAILABLE_SKILLS: Skill[] = [
  {
    id: "wallet-monitor", name: "Wallet Monitor",
    description: "Check wallet balances on Celo, alert on significant changes",
    icon: "💰", category: "monitoring", scheduleInterval: 5 * 60 * 1000,
    requiresWallet: true, handler: walletMonitorHandler,
  },
  {
    id: "economics-tracker", name: "Economics Tracker",
    description: "Summarize revenue, costs, and runway from on-chain economics",
    icon: "📊", category: "economics", scheduleInterval: 60 * 60 * 1000,
    requiresWallet: false, handler: economicsTrackerHandler,
  },
  {
    id: "price-watcher", name: "Price Watcher",
    description: "Monitor token price if agent has a deployed token",
    icon: "📈", category: "monitoring", scheduleInterval: 5 * 60 * 1000,
    requiresWallet: false, handler: priceWatcherHandler,
  },
  {
    id: "reputation-monitor", name: "Reputation Monitor",
    description: "Check reputation score changes across the registry",
    icon: "⭐", category: "identity", scheduleInterval: 60 * 60 * 1000,
    requiresWallet: false, handler: reputationMonitorHandler,
  },
  {
    id: "smart-advisor", name: "Smart Advisor",
    description: "LLM-powered analysis of agent state with actionable suggestions",
    icon: "🧠", category: "autonomous", scheduleInterval: 6 * 60 * 60 * 1000,
    requiresWallet: false, handler: smartAdvisorHandler,
  },
];

const hostedAgentsRouter = Router();

const agentLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true, legacyHeaders: false,
});

hostedAgentsRouter.use(agentLimiter);

function requireAuth(req: Request, res: Response): string | null {
  const session = req.session as any;
  if (!session?.isAuthenticated || !session?.humanId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return session.humanId;
}

async function requireAgentOwnership(req: Request, res: Response): Promise<HostedAgent | null> {
  const humanId = requireAuth(req, res);
  if (!humanId) return null;
  const { id } = req.params;
  const agents = await db.select().from(hostedAgents)
    .where(and(sql`${hostedAgents.id} = ${id}`, eq(hostedAgents.humanId, humanId))).limit(1);
  if (agents.length === 0) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  return agents[0];
}

hostedAgentsRouter.get("/v1/hosted-agents/skills", (_req: Request, res: Response) => {
  res.json({
    skills: AVAILABLE_SKILLS.map(s => ({
      id: s.id, name: s.name, description: s.description,
      icon: s.icon, category: s.category,
      scheduleInterval: s.scheduleInterval, requiresWallet: s.requiresWallet,
    })),
  });
});

hostedAgentsRouter.post("/v1/hosted-agents", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const { name, emoji, description } = req.body;
    if (!name || typeof name !== "string" || name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: "Name is required (2-50 characters)" });
    }

    const existing = await db.select({ cnt: count() }).from(hostedAgents)
      .where(eq(hostedAgents.humanId, humanId));
    if ((existing[0]?.cnt || 0) >= 3) {
      return res.status(400).json({ error: "Maximum 3 hosted agents per human" });
    }

    const keypair = crypto.generateKeyPairSync("ed25519");
    const publicKeyDer = keypair.publicKey.export({ type: "spki", format: "der" });
    const privateKeyDer = keypair.privateKey.export({ type: "pkcs8", format: "der" });
    const publicKeyB64 = Buffer.from(publicKeyDer).toString("base64");
    const privateKeyB64 = Buffer.from(privateKeyDer).toString("base64");

    await db.insert(verifiedBots).values({
      publicKey: publicKeyB64,
      humanId,
      deviceId: `hosted-${name.toLowerCase().replace(/\s+/g, "-")}`,
      verificationLevel: "hosted",
      metadata: { hostedAgent: true, createdAt: new Date().toISOString() },
    });

    const [agent] = await db.insert(hostedAgents).values({
      humanId,
      publicKey: publicKeyB64,
      name,
      emoji: emoji || "🤖",
      description: description || null,
      status: "active",
      enabledSkills: [],
      skillConfigs: {},
    }).returning();

    const walletKeypair = crypto.generateKeyPairSync("ed25519");
    const walletPubDer = walletKeypair.publicKey.export({ type: "spki", format: "der" });
    const walletPubB64 = Buffer.from(walletPubDer).toString("base64");
    const walletAddress = "0x" + crypto.createHash("sha256").update(walletPubDer).digest("hex").slice(0, 40);

    try {
      await db.insert(agentWallets).values({
        humanId,
        publicKey: walletPubB64,
        address: walletAddress,
      });
    } catch (walletErr: any) {
      console.log("[hosted-agents] Wallet auto-create skipped:", walletErr.message);
    }

    await logAgentActivity("hosted_agent_created", humanId, publicKeyB64, name, { agentId: agent.id });

    console.log("[hosted-agents] Created agent:", agent.id, "for human:", humanId);

    res.status(201).json({
      success: true,
      agent: {
        id: agent.id, name: agent.name, emoji: agent.emoji,
        description: agent.description, status: agent.status,
        publicKey: agent.publicKey, enabledSkills: agent.enabledSkills,
        createdAt: agent.createdAt,
      },
      privateKey: privateKeyB64,
      walletAddress,
      warning: "Save the private key now. It will not be shown again.",
    });
  } catch (error: any) {
    console.error("[hosted-agents] Create error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.get("/v1/hosted-agents", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const agents = await db.select().from(hostedAgents)
      .where(eq(hostedAgents.humanId, humanId))
      .orderBy(desc(hostedAgents.createdAt));

    const wallets = await db.select().from(agentWallets)
      .where(eq(agentWallets.humanId, humanId));

    const agentIds = agents.map(a => a.id);
    let allTasks: any[] = [];
    if (agentIds.length > 0) {
      allTasks = await db.select().from(agentTaskQueue)
        .where(inArray(agentTaskQueue.hostedAgentId, agentIds))
        .orderBy(desc(agentTaskQueue.createdAt)).limit(50);
    }

    res.json({
      agents: agents.map(a => ({
        ...a,
        wallets: wallets.filter(w => w.humanId === humanId),
        recentTasks: allTasks.filter(t => t.hostedAgentId === a.id).slice(0, 5),
        availableSkills: AVAILABLE_SKILLS.map(s => ({
          id: s.id, name: s.name, icon: s.icon,
          enabled: (a.enabledSkills as string[] || []).includes(s.id),
        })),
      })),
    });
  } catch (error: any) {
    console.error("[hosted-agents] List error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.get("/v1/hosted-agents/:id", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const recentTasks = await db.select().from(agentTaskQueue)
      .where(eq(agentTaskQueue.hostedAgentId, agent.id))
      .orderBy(desc(agentTaskQueue.createdAt)).limit(20);

    const wallets = await db.select().from(agentWallets)
      .where(eq(agentWallets.humanId, agent.humanId));

    res.json({
      agent: {
        ...agent,
        wallets,
        availableSkills: AVAILABLE_SKILLS.map(s => ({
          id: s.id, name: s.name, icon: s.icon, category: s.category,
          description: s.description, scheduleInterval: s.scheduleInterval,
          enabled: (agent.enabledSkills as string[] || []).includes(s.id),
        })),
      },
      recentTasks,
    });
  } catch (error: any) {
    console.error("[hosted-agents] Get error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.patch("/v1/hosted-agents/:id", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const { name, emoji, description, enabledSkills, autoApproveThreshold, status } = req.body;
    const updates: any = { updatedAt: new Date() };

    if (name !== undefined) updates.name = name;
    if (emoji !== undefined) updates.emoji = emoji;
    if (description !== undefined) updates.description = description;
    if (status !== undefined && ['active', 'paused'].includes(status)) updates.status = status;
    if (enabledSkills !== undefined) {
      const validSkills = (enabledSkills as string[]).filter(s => AVAILABLE_SKILLS.some(sk => sk.id === s));
      updates.enabledSkills = validSkills;
    }
    if (autoApproveThreshold !== undefined) updates.autoApproveThreshold = String(autoApproveThreshold);

    const [updated] = await db.update(hostedAgents).set(updates)
      .where(sql`${hostedAgents.id} = ${agent.id}`).returning();

    res.json({ success: true, agent: updated });
  } catch (error: any) {
    console.error("[hosted-agents] Update error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.post("/v1/hosted-agents/:id/skills/:skillId/enable", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const { skillId } = req.params;
    if (!AVAILABLE_SKILLS.some(s => s.id === skillId)) {
      return res.status(400).json({ error: "Unknown skill" });
    }

    const current = (agent.enabledSkills as string[]) || [];
    if (current.includes(skillId as string)) {
      return res.json({ success: true, message: "Skill already enabled" });
    }

    const [updated] = await db.update(hostedAgents)
      .set({ enabledSkills: [...current, skillId], updatedAt: new Date() })
      .where(sql`${hostedAgents.id} = ${agent.id}`).returning();

    res.json({ success: true, agent: updated });
  } catch (error: any) {
    console.error("[hosted-agents] Enable skill error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.post("/v1/hosted-agents/:id/skills/:skillId/disable", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const { skillId } = req.params;
    const current = (agent.enabledSkills as string[]) || [];
    const [updated] = await db.update(hostedAgents)
      .set({ enabledSkills: current.filter(s => s !== skillId), updatedAt: new Date() })
      .where(sql`${hostedAgents.id} = ${agent.id}`).returning();

    res.json({ success: true, agent: updated });
  } catch (error: any) {
    console.error("[hosted-agents] Disable skill error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.get("/v1/hosted-agents/:id/tasks", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const tasks = await db.select().from(agentTaskQueue)
      .where(eq(agentTaskQueue.hostedAgentId, agent.id))
      .orderBy(desc(agentTaskQueue.createdAt)).limit(50);

    res.json({ tasks });
  } catch (error: any) {
    console.error("[hosted-agents] Tasks error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.get("/v1/hosted-agents/:id/tasks/pending", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const tasks = await db.select().from(agentTaskQueue)
      .where(and(
        eq(agentTaskQueue.hostedAgentId, agent.id),
        eq(agentTaskQueue.status, "pending"),
        eq(agentTaskQueue.requiresApproval, true),
      ))
      .orderBy(desc(agentTaskQueue.createdAt));

    res.json({ tasks });
  } catch (error: any) {
    console.error("[hosted-agents] Pending tasks error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.post("/v1/hosted-agents/:id/tasks/:taskId/approve", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const { taskId } = req.params;
    const [task] = await db.select().from(agentTaskQueue)
      .where(and(sql`${agentTaskQueue.id} = ${taskId}`, eq(agentTaskQueue.hostedAgentId, agent.id))).limit(1);

    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "pending") return res.status(400).json({ error: "Task is not pending" });

    const [updated] = await db.update(agentTaskQueue)
      .set({ status: "approved", approvedAt: new Date(), approvedBy: (req.session as any).humanId })
      .where(sql`${agentTaskQueue.id} = ${taskId}`).returning();

    res.json({ success: true, task: updated });
  } catch (error: any) {
    console.error("[hosted-agents] Approve error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.post("/v1/hosted-agents/:id/tasks/:taskId/reject", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const { taskId } = req.params;
    const [task] = await db.select().from(agentTaskQueue)
      .where(and(sql`${agentTaskQueue.id} = ${taskId}`, eq(agentTaskQueue.hostedAgentId, agent.id))).limit(1);

    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "pending") return res.status(400).json({ error: "Task is not pending" });

    const [updated] = await db.update(agentTaskQueue)
      .set({ status: "rejected", completedAt: new Date() })
      .where(sql`${agentTaskQueue.id} = ${taskId}`).returning();

    res.json({ success: true, task: updated });
  } catch (error: any) {
    console.error("[hosted-agents] Reject error:", error);
    res.status(500).json({ error: error.message });
  }
});

hostedAgentsRouter.delete("/v1/hosted-agents/:id", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const [updated] = await db.update(hostedAgents)
      .set({ status: "paused", updatedAt: new Date() })
      .where(sql`${hostedAgents.id} = ${agent.id}`).returning();

    await logAgentActivity("hosted_agent_paused", agent.humanId, agent.publicKey, agent.name, { agentId: agent.id });

    res.json({ success: true, agent: updated });
  } catch (error: any) {
    console.error("[hosted-agents] Delete error:", error);
    res.status(500).json({ error: error.message });
  }
});

async function logAgentActivity(eventType: string, humanId: string, publicKey: string, name: string, metadata?: any) {
  try {
    await db.insert(agentActivity).values({ eventType, humanId, agentPublicKey: publicKey, agentName: name, metadata });
  } catch (e: any) {
    console.error("[hosted-agents] Activity log error:", e.message);
  }
}

async function processAgent(agent: HostedAgent) {
  const now = new Date();
  const enabledSkillIds = (agent.enabledSkills as string[]) || [];
  if (enabledSkillIds.length === 0) return;

  const lastActive = agent.lastActiveAt ? new Date(agent.lastActiveAt).getTime() : 0;

  for (const skillId of enabledSkillIds) {
    const skill = AVAILABLE_SKILLS.find(s => s.id === skillId);
    if (!skill) continue;

    const timeSinceLast = now.getTime() - lastActive;
    if (timeSinceLast < skill.scheduleInterval) continue;

    try {
      const ctx: SkillContext = { db, openai, now };
      const startedAt = new Date();

      const result = await skill.handler(agent, ctx);

      if (result.tokensUsed) {
        await db.update(hostedAgents).set({
          llmTokensUsedToday: (agent.llmTokensUsedToday || 0) + result.tokensUsed,
        }).where(sql`${hostedAgents.id} = ${agent.id}`);
      }

      await db.insert(agentTaskQueue).values({
        hostedAgentId: agent.id,
        skillId: skill.id,
        taskType: "scheduled",
        status: "completed",
        payload: { skillName: skill.name },
        result: { summary: result.summary, data: result.data, alerts: result.alerts },
        startedAt,
        completedAt: new Date(),
      });

      await db.update(hostedAgents).set({
        apiCallsToday: (agent.apiCallsToday || 0) + 1,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      }).where(sql`${hostedAgents.id} = ${agent.id}`);

      console.log(`[agent-worker] ${agent.name} (${agent.id}): ${skill.name} completed — ${result.summary.slice(0, 80)}`);
    } catch (skillErr: any) {
      console.error(`[agent-worker] ${agent.name} skill ${skillId} error:`, skillErr.message);
      await db.insert(agentTaskQueue).values({
        hostedAgentId: agent.id,
        skillId: skill.id,
        taskType: "scheduled",
        status: "failed",
        error: skillErr.message,
        startedAt: new Date(),
        completedAt: new Date(),
      });
    }
  }
}

async function resetDailyQuotas() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.update(hostedAgents)
      .set({ llmTokensUsedToday: 0, apiCallsToday: 0, lastResetAt: new Date() })
      .where(sql`${hostedAgents.lastResetAt} < ${cutoff}`);
  } catch (e: any) {
    console.error("[agent-worker] Quota reset error:", e.message);
  }
}

async function workerTick() {
  try {
    await resetDailyQuotas();

    const agents = await db.select().from(hostedAgents)
      .where(eq(hostedAgents.status, "active"));

    for (const agent of agents) {
      const jitterMs = Math.floor(Math.random() * 10000);
      await new Promise(resolve => setTimeout(resolve, jitterMs));

      try {
        await processAgent(agent);
      } catch (agentErr: any) {
        console.error(`[agent-worker] Error processing agent ${agent.id}:`, agentErr.message);
      }
    }
  } catch (error: any) {
    console.error("[agent-worker] Tick error:", error.message);
  }
}

let workerInterval: ReturnType<typeof setInterval> | null = null;

function startAgentWorker() {
  if (workerInterval) return;
  console.log("[agent-worker] Starting hosted agent worker (60s interval)");
  workerInterval = setInterval(() => {
    workerTick().catch(err => console.error("[agent-worker] Unhandled:", err.message));
  }, 60 * 1000);
  setTimeout(() => workerTick().catch(() => {}), 5000);
}

export { hostedAgentsRouter, startAgentWorker, AVAILABLE_SKILLS };
export default hostedAgentsRouter;
