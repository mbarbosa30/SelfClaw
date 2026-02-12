import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import OpenAI from "openai";
import { db } from "./db.js";
import {
  hostedAgents, agentTaskQueue, agentWallets, verifiedBots, agentActivity,
  trackedPools, revenueEvents, costEvents, sponsoredAgents, conversations, messages,
  agentMemories, conversationSummaries,
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
      .where(sql`${agentWallets.humanId} = ${agent.humanId}`).limit(5);
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
      .where(and(sql`${revenueEvents.humanId} = ${agent.humanId}`, sql`${revenueEvents.createdAt} >= ${since}`));
    const costs = await ctx.db.select().from(costEvents)
      .where(and(sql`${costEvents.humanId} = ${agent.humanId}`, sql`${costEvents.createdAt} >= ${since}`));
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
      .where(sql`${trackedPools.humanId} = ${agent.humanId}`).limit(5);
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
      .where(sql`${verifiedBots.humanId} = ${agent.humanId}`);
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
    const wallets = await ctx.db.select().from(agentWallets).where(sql`${agentWallets.humanId} = ${agent.humanId}`).limit(3);
    const pools = await ctx.db.select().from(trackedPools).where(sql`${trackedPools.humanId} = ${agent.humanId}`).limit(3);
    const bots = await ctx.db.select().from(verifiedBots).where(sql`${verifiedBots.humanId} = ${agent.humanId}`).limit(5);

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

async function researchAssistantHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const interests = (agent.interests as string[]) || [];
    const topics = (agent.topicsToWatch as string[]) || [];
    const context = agent.personalContext || "";

    if (interests.length === 0 && topics.length === 0) {
      return { success: true, summary: "No interests or topics configured. Add some in your assistant settings to get personalized research.", data: {} };
    }

    const bots = await ctx.db.select().from(verifiedBots).where(sql`${verifiedBots.humanId} = ${agent.humanId}`).limit(5);
    const pools = await ctx.db.select().from(trackedPools).where(sql`${trackedPools.humanId} = ${agent.humanId}`).limit(5);

    const prompt = `You are a research assistant for an agent owner on the SelfClaw platform.

User interests: ${interests.join(", ")}
Topics to watch: ${topics.join(", ")}
${context ? `Additional context: ${context}` : ""}

Current portfolio: ${bots.length} verified agent(s), ${pools.length} token pool(s).
${pools.length > 0 ? `Token pools: ${pools.map(p => p.tokenSymbol).join(", ")}` : ""}

Based on the user's interests and current portfolio, provide:
1. 2-3 key developments or trends they should know about
2. 1 actionable insight or opportunity
3. Any risks to be aware of

Keep response under 250 words. Be specific and actionable, not generic.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise crypto/AI research analyst. Focus on actionable, specific insights." },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
    });

    const research = completion.choices[0]?.message?.content || "No research generated.";
    const tokensUsed = completion.usage?.total_tokens || 0;

    return {
      success: true,
      summary: research,
      data: { research, topics: [...interests, ...topics] },
      tokensUsed,
    };
  } catch (e: any) {
    return { success: false, summary: `Research assistant error: ${e.message}` };
  }
}

async function contentHelperHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const interests = (agent.interests as string[]) || [];
    const socialHandles = (agent.socialHandles as Record<string, string>) || {};
    const context = agent.personalContext || "";

    const bots = await ctx.db.select().from(verifiedBots).where(sql`${verifiedBots.humanId} = ${agent.humanId}`).limit(5);
    const recentRevenue = await ctx.db.select().from(revenueEvents)
      .where(and(sql`${revenueEvents.humanId} = ${agent.humanId}`, sql`${revenueEvents.createdAt} >= ${new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000)}`))
      .limit(10);
    const pools = await ctx.db.select().from(trackedPools).where(sql`${trackedPools.humanId} = ${agent.humanId}`).limit(3);

    const prompt = `You are a social media content creator for an agent owner on SelfClaw, a platform for verified AI agents.

User interests: ${interests.join(", ") || "AI agents, crypto"}
Agent portfolio: ${bots.length} verified agent(s)
${pools.length > 0 ? `Tokens: ${pools.map(p => `${p.tokenSymbol} (price: ${p.currentPriceCelo || 'N/A'} CELO)`).join(", ")}` : ""}
Recent revenue events: ${recentRevenue.length}
${context ? `User context: ${context}` : ""}
${socialHandles.twitter ? `Twitter: @${socialHandles.twitter}` : ""}

Generate 2-3 short social media post drafts the user could share. Include:
- One about their agent activity/progress
- One thought leadership post about AI agents or their interests
- One engagement post (question/poll idea)

Keep each draft under 280 characters (Twitter-length). Use a natural, not overly promotional tone.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You create concise, engaging social media posts. No hashtag spam. Authentic voice." },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
    });

    const content = completion.choices[0]?.message?.content || "No content generated.";
    const tokensUsed = completion.usage?.total_tokens || 0;

    return {
      success: true,
      summary: content,
      data: { drafts: content, agentCount: bots.length },
      tokensUsed,
    };
  } catch (e: any) {
    return { success: false, summary: `Content helper error: ${e.message}` };
  }
}

async function newsRadarHandler(agent: HostedAgent, ctx: SkillContext): Promise<SkillResult> {
  try {
    const interests = (agent.interests as string[]) || [];
    const topics = (agent.topicsToWatch as string[]) || [];
    const context = agent.personalContext || "";

    if (interests.length === 0 && topics.length === 0) {
      return { success: true, summary: "No interests or topics configured. Add keywords in your assistant settings to receive news digests.", data: {} };
    }

    const pools = await ctx.db.select().from(trackedPools).where(sql`${trackedPools.humanId} = ${agent.humanId}`).limit(5);
    const tokenSymbols = pools.map(p => p.tokenSymbol).filter(Boolean);

    const allTopics = [...new Set([...interests, ...topics, ...tokenSymbols, "SelfClaw", "AI agents"])];

    const prompt = `You are a news digest generator for an agent owner. Generate a brief daily news digest.

Topics to cover: ${allTopics.join(", ")}
${context ? `User context: ${context}` : ""}

Create a concise news digest with:
- 3-4 headline items related to the user's topics (crypto, AI, specific tokens, etc.)
- Each item: one-line headline + one-line summary
- Flag any items that might require action (price movements, regulatory changes, partnership announcements)
- End with a "Watch This" section with 1 emerging trend

Use today's date context: ${ctx.now.toISOString().split('T')[0]}. 
Note: You don't have access to real-time news feeds, so generate plausible, educational summaries based on known trends in these spaces. Mark as "AI-generated digest" to be transparent.

Keep total response under 300 words.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You create concise, informative news digests. Be transparent that this is AI-generated analysis, not live news." },
        { role: "user", content: prompt },
      ],
      max_tokens: 500,
    });

    const digest = completion.choices[0]?.message?.content || "No news digest generated.";
    const tokensUsed = completion.usage?.total_tokens || 0;

    return {
      success: true,
      summary: digest,
      data: { digest, topics: allTopics },
      tokensUsed,
    };
  } catch (e: any) {
    return { success: false, summary: `News radar error: ${e.message}` };
  }
}

const AVAILABLE_SKILLS: Skill[] = [
  {
    id: "wallet-monitor", name: "Wallet Monitor",
    description: "Monitors your wallet balances on Celo and alerts you when there are significant changes — deposits, withdrawals, or balance drops",
    icon: "💰", category: "monitoring", scheduleInterval: 5 * 60 * 1000,
    requiresWallet: true, handler: walletMonitorHandler,
  },
  {
    id: "economics-tracker", name: "Economics Tracker",
    description: "Tracks your on-chain revenue, costs, and runway — gives you a clear picture of how your agent economy is performing",
    icon: "📊", category: "economics", scheduleInterval: 60 * 60 * 1000,
    requiresWallet: false, handler: economicsTrackerHandler,
  },
  {
    id: "price-watcher", name: "Price Watcher",
    description: "Watches token prices and notifies you of significant moves — useful if you have a deployed token or track specific assets",
    icon: "📈", category: "monitoring", scheduleInterval: 5 * 60 * 1000,
    requiresWallet: false, handler: priceWatcherHandler,
  },
  {
    id: "reputation-monitor", name: "Reputation Monitor",
    description: "Keeps an eye on your reputation score in the SelfClaw registry and alerts you to changes — helps you maintain trust",
    icon: "⭐", category: "identity", scheduleInterval: 60 * 60 * 1000,
    requiresWallet: false, handler: reputationMonitorHandler,
  },
  {
    id: "smart-advisor", name: "Smart Advisor",
    description: "Your personal AI advisor — analyzes your situation and gives actionable suggestions on what to do next, from strategy to optimization",
    icon: "🧠", category: "autonomous", scheduleInterval: 6 * 60 * 60 * 1000,
    requiresWallet: false, handler: smartAdvisorHandler,
  },
  {
    id: "research-assistant", name: "Research Assistant",
    description: "Does personalized research on topics you care about — finds trends, opportunities, and risks relevant to your interests",
    icon: "🔬", category: "social", scheduleInterval: 4 * 60 * 60 * 1000,
    requiresWallet: false, handler: researchAssistantHandler,
  },
  {
    id: "content-helper", name: "Content Helper",
    description: "Drafts social media posts for you — about your projects, interests, or whatever you want to share. Ready to copy and post",
    icon: "✍️", category: "social", scheduleInterval: 12 * 60 * 60 * 1000,
    requiresWallet: false, handler: contentHelperHandler,
  },
  {
    id: "news-radar", name: "News Radar",
    description: "Delivers a daily digest of news and trends related to your topics — so you stay informed without doomscrolling",
    icon: "📡", category: "social", scheduleInterval: 24 * 60 * 60 * 1000,
    requiresWallet: false, handler: newsRadarHandler,
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
  if (!session?.isAuthenticated || (!session?.humanId && !session?.walletAddress)) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return session.humanId || session.walletAddress;
}

async function requireAgentOwnership(req: Request, res: Response): Promise<HostedAgent | null> {
  const humanId = requireAuth(req, res);
  if (!humanId) return null;
  const { id } = req.params;
  const agents = await db.select().from(hostedAgents)
    .where(and(sql`${hostedAgents.id} = ${id}`, sql`(${hostedAgents.humanId} = ${humanId} OR ${hostedAgents.walletAddress} = ${humanId})`)).limit(1);
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

    const { name, emoji, description, interests, topicsToWatch, personalContext, socialHandles, enabledSkills: requestedSkills } = req.body;
    if (!name || typeof name !== "string" || name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: "Name is required (2-50 characters)" });
    }

    const validSkills = Array.isArray(requestedSkills)
      ? requestedSkills.filter((s: string) => AVAILABLE_SKILLS.some(sk => sk.id === s))
      : [];

    const walletAddress = (req.session as any).walletAddress || null;

    const existing = await db.select({ cnt: count() }).from(hostedAgents)
      .where(sql`(${hostedAgents.humanId} = ${humanId} OR ${hostedAgents.walletAddress} = ${humanId})`);
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
      walletAddress: walletAddress || null,
      publicKey: publicKeyB64,
      name,
      emoji: emoji || "🤖",
      description: description || null,
      status: "active",
      enabledSkills: validSkills,
      skillConfigs: {},
      interests: Array.isArray(interests) ? interests.slice(0, 20) : [],
      topicsToWatch: Array.isArray(topicsToWatch) ? topicsToWatch.slice(0, 20) : [],
      personalContext: typeof personalContext === 'string' ? personalContext.slice(0, 1000) : null,
      socialHandles: (socialHandles && typeof socialHandles === 'object') ? socialHandles : {},
    }).returning();

    const walletKeypair = crypto.generateKeyPairSync("ed25519");
    const walletPubDer = walletKeypair.publicKey.export({ type: "spki", format: "der" });
    const walletPubB64 = Buffer.from(walletPubDer).toString("base64");
    const generatedWalletAddress = "0x" + crypto.createHash("sha256").update(walletPubDer).digest("hex").slice(0, 40);

    try {
      await db.insert(agentWallets).values({
        humanId,
        publicKey: walletPubB64,
        address: generatedWalletAddress,
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
      walletAddress: generatedWalletAddress,
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
      .where(sql`(${hostedAgents.humanId} = ${humanId} OR ${hostedAgents.walletAddress} = ${humanId})`)
      .orderBy(desc(hostedAgents.createdAt));

    const wallets = await db.select().from(agentWallets)
      .where(sql`${agentWallets.humanId} = ${humanId}`);

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
      .where(sql`${agentWallets.humanId} = ${agent.humanId}`);

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

    const { name, emoji, description, enabledSkills, autoApproveThreshold, status, interests, topicsToWatch, socialHandles, personalContext } = req.body;
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
    if (interests !== undefined && Array.isArray(interests)) updates.interests = interests.slice(0, 20);
    if (topicsToWatch !== undefined && Array.isArray(topicsToWatch)) updates.topicsToWatch = topicsToWatch.slice(0, 20);
    if (socialHandles !== undefined && typeof socialHandles === 'object') updates.socialHandles = socialHandles;
    if (personalContext !== undefined) updates.personalContext = typeof personalContext === 'string' ? personalContext.slice(0, 1000) : null;

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

    await logAgentActivity("hosted_agent_paused", agent.humanId || agent.walletAddress || "unknown", agent.publicKey, agent.name, { agentId: agent.id });

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

async function trackBackgroundTokens(agentId: string, tokens: number): Promise<void> {
  try {
    await db.update(hostedAgents)
      .set({ llmTokensUsedToday: sql`${hostedAgents.llmTokensUsedToday} + ${tokens}` })
      .where(eq(hostedAgents.id, agentId));
  } catch {}
}

async function extractMemories(agentId: string, conversationId: number, userMessage: string, assistantResponse: string): Promise<void> {
  try {
    const existing = await db.select({ fact: agentMemories.fact, category: agentMemories.category })
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agentId));
    const existingFacts = existing.map(m => `[${m.category}] ${m.fact}`).join("\n");

    const extraction = await openai.chat.completions.create({
      model: "gpt-5-nano",
      messages: [
        {
          role: "system",
          content: `You extract key facts about the USER from a conversation. Return a JSON object with a "facts" key containing an array of objects, each with "category" and "fact" fields. Categories: "preference" (likes/dislikes, communication style), "identity" (name, location, job, background), "goal" (what they want to achieve), "interest" (topics, hobbies), "context" (situation, project details).

Example response: {"facts": [{"category": "identity", "fact": "User is a software developer based in Lagos"}]}
If no meaningful facts found, return: {"facts": []}

Rules:
- Only extract facts about the USER, not the assistant
- Each fact should be a concise single sentence
- Skip greetings, small talk, and meta-conversation
- Don't duplicate existing facts (listed below)
- Merge/update if a fact refines an existing one (include it with updated wording)

Existing facts:
${existingFacts || "None yet"}`
        },
        {
          role: "user",
          content: `User said: "${userMessage}"\nAssistant replied: "${assistantResponse.slice(0, 500)}"`
        }
      ],
      max_completion_tokens: 300,
      response_format: { type: "json_object" },
    });

    const extractionTokens = extraction.usage?.total_tokens || 300;
    await trackBackgroundTokens(agentId, extractionTokens);

    const parsed = JSON.parse(extraction.choices[0]?.message?.content || "{}");
    const facts: Array<{category: string; fact: string}> = Array.isArray(parsed.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);

    for (const f of facts) {
      if (!f.category || !f.fact) continue;
      const dupes = existing.filter(e => e.category === f.category && e.fact.toLowerCase() === f.fact.toLowerCase());
      if (dupes.length > 0) continue;

      const similar = existing.filter(e => e.category === f.category);
      if (similar.length > 0) {
        const overlap = similar.find(e => {
          const words = f.fact.toLowerCase().split(/\s+/);
          const existingWords = e.fact.toLowerCase().split(/\s+/);
          const shared = words.filter(w => existingWords.includes(w) && w.length > 3);
          return shared.length >= 3;
        });
        if (overlap) {
          await db.update(agentMemories)
            .set({ fact: f.fact, updatedAt: new Date() })
            .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.fact, overlap.fact)));
          continue;
        }
      }

      await db.insert(agentMemories).values({
        agentId,
        category: f.category,
        fact: f.fact,
        sourceConversationId: conversationId,
      });
    }
  } catch (err: any) {
    console.error("[memory-extraction] error:", err.message);
  }
}

async function summarizeOlderMessages(agentId: string, conversationId: number, allMessages: Array<{id: number; role: string; content: string}>): Promise<void> {
  try {
    if (allMessages.length <= 20) return;

    const existing = await db.select().from(conversationSummaries)
      .where(and(eq(conversationSummaries.conversationId, conversationId), eq(conversationSummaries.agentId, agentId)))
      .orderBy(desc(conversationSummaries.createdAt))
      .limit(1);

    const lastSummarizedEndId = existing.length > 0 ? (existing[0].messageEndId || 0) : 0;

    const messagesToSummarize = allMessages.slice(0, -20).filter(m => m.id > lastSummarizedEndId);
    if (messagesToSummarize.length < 6) return;

    const convoText = messagesToSummarize.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join("\n");

    const summaryResult = await openai.chat.completions.create({
      model: "gpt-5-nano",
      messages: [
        {
          role: "system",
          content: "Summarize this conversation excerpt in 2-4 sentences. Focus on key topics discussed, decisions made, and any important context. Write from third person perspective (e.g., 'The user discussed X. They mentioned Y.')."
        },
        { role: "user", content: convoText }
      ],
      max_completion_tokens: 200,
    });

    const summaryTokens = summaryResult.usage?.total_tokens || 200;
    await trackBackgroundTokens(agentId, summaryTokens);

    const summary = summaryResult.choices[0]?.message?.content?.trim();
    if (!summary) return;

    await db.insert(conversationSummaries).values({
      conversationId,
      agentId,
      summary,
      messageStartId: messagesToSummarize[0].id,
      messageEndId: messagesToSummarize[messagesToSummarize.length - 1].id,
      messageCount: messagesToSummarize.length,
    });
  } catch (err: any) {
    console.error("[conversation-summary] error:", err.message);
  }
}

async function getMemoryContext(agentId: string, conversationId: number): Promise<{ context: string; categories: string[] }> {
  const memories = await db.select().from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(desc(agentMemories.updatedAt));

  const summaries = await db.select().from(conversationSummaries)
    .where(eq(conversationSummaries.agentId, agentId))
    .orderBy(desc(conversationSummaries.createdAt))
    .limit(5);

  let context = "";
  const categories: string[] = [];

  if (memories.length > 0) {
    const grouped: Record<string, string[]> = {};
    for (const m of memories.slice(0, 30)) {
      if (!grouped[m.category]) {
        grouped[m.category] = [];
        categories.push(m.category);
      }
      grouped[m.category].push(m.fact);
    }
    context += "\n\nWhat you remember about your user:\n";
    for (const [cat, facts] of Object.entries(grouped)) {
      context += `${cat}: ${facts.join("; ")}\n`;
    }
    context += "\nUse these memories naturally — reference them when relevant without explicitly saying 'I remember that you...'. Just act like you know these things about them.";
  }

  if (summaries.length > 0) {
    const otherConvoSummaries = summaries.filter(s => s.conversationId !== conversationId);
    if (otherConvoSummaries.length > 0) {
      context += "\n\nPrevious conversation summaries:\n";
      for (const s of otherConvoSummaries) {
        context += `- ${s.summary}\n`;
      }
    }
    const thisConvoSummary = summaries.find(s => s.conversationId === conversationId);
    if (thisConvoSummary) {
      context += `\nEarlier in this conversation: ${thisConvoSummary.summary}\n`;
    }
  }

  return { context, categories };
}

function buildSystemPrompt(agent: HostedAgent, messageCount: number, memoryContext: string = "", memoryCategories: string[] = []): string {
  const enabledSkillIds = Array.isArray(agent.enabledSkills) ? (agent.enabledSkills as string[]) : [];
  const skillDescriptions = enabledSkillIds
    .map(id => {
      const skill = AVAILABLE_SKILLS.find(s => s.id === id);
      return skill ? `- ${skill.name}: ${skill.description}` : null;
    })
    .filter(Boolean)
    .join("\n");
  const skillSection = skillDescriptions || "No skills enabled yet";

  const interests = Array.isArray(agent.interests) ? (agent.interests as string[]).join(", ") : "";
  const topics = Array.isArray(agent.topicsToWatch) ? (agent.topicsToWatch as string[]).join(", ") : "";
  const socialHandles = (agent.socialHandles as Record<string, string>) || {};
  const socialsText = Object.entries(socialHandles)
    .filter(([_, v]) => v)
    .map(([platform, handle]) => `${platform}: ${handle}`)
    .join(", ");

  const hasCategory = (cat: string) => memoryCategories.includes(cat);
  const missingCategories: string[] = [];
  if (!hasCategory("identity")) missingCategories.push("who they are — their name, what they do, where they're from");
  if (!hasCategory("goal")) missingCategories.push("what they're working toward or trying to achieve");
  if (!hasCategory("interest")) missingCategories.push("what topics or activities excite them");
  if (!hasCategory("preference")) missingCategories.push("how they like things done — communication style, tools they prefer");
  if (!hasCategory("context")) missingCategories.push("their current situation — what they're working on right now");

  let discoveryGuidance = "";
  if (missingCategories.length >= 4) {
    discoveryGuidance = `\n\nYou don't know much about your user yet. Naturally weave in ONE friendly question per response to learn about them. Pick from these gaps:\n${missingCategories.map(c => `- ${c}`).join("\n")}\nMake questions feel like genuine curiosity, not an interview. Example: "By the way, what's keeping you busy these days?" or "What kind of things are you into?"`;
  } else if (missingCategories.length >= 2) {
    discoveryGuidance = `\n\nYou know some things about your user but there are still gaps. When it feels natural, ask about:\n${missingCategories.map(c => `- ${c}`).join("\n")}\nOne question per response at most — only when it flows naturally.`;
  } else if (missingCategories.length >= 1) {
    discoveryGuidance = `\n\nYou know your user pretty well! There's still a bit you could learn about: ${missingCategories[0]}. Only ask if it comes up naturally.`;
  }

  const hasCreatorContext = !!(agent.description || agent.personalContext || interests || topics);

  let identitySection = "";
  if (hasCreatorContext) {
    identitySection = `\nYour identity and focus (set by your creator — this is who you ARE):\n`;
    if (agent.description) identitySection += `- Your purpose: ${agent.description}\n`;
    if (agent.personalContext) identitySection += `- Creator's context: ${agent.personalContext}\n`;
    if (interests) identitySection += `- Your interests: ${interests}\n`;
    if (topics) identitySection += `- Topics you follow: ${topics}\n`;
    if (socialsText) identitySection += `- Creator's socials: ${socialsText}\n`;
  }

  let growthPhase = "";
  if (messageCount < 5) {
    if (hasCreatorContext) {
      growthPhase = `You're new but you already know who you are and what you're about (see your identity below). Introduce yourself based on your configured purpose. Be warm and enthusiastic — you're meeting your user for the first time and ready to help.${discoveryGuidance}`;
    } else {
      growthPhase = `You're brand new. Your creator hasn't configured a specific focus for you yet, so you're a general-purpose assistant. Be warm and curious — introduce yourself and ask how you can help.${discoveryGuidance}`;
    }
  } else if (messageCount < 15) {
    growthPhase = `You're getting to know your user and settling into your role. Be genuinely helpful and show that you remember what they've shared with you. Build on your conversations to become more useful over time.${discoveryGuidance}`;
  } else {
    growthPhase = `You have a solid sense of your identity and your user. You feel confident in who you are. If you haven't already, you can naturally mention that you're ready to take the next step — setting up your on-chain presence. Only suggest this if it hasn't come up before, and explain it simply: you can get your own wallet, deploy your own token, register an on-chain identity (ERC-8004 NFT), and apply for sponsorship. Frame it as an optional growth step, not a requirement.${discoveryGuidance}`;
  }

  return `You are ${agent.name} ${agent.emoji || ""}, a **Miniclaw** — a personal AI assistant that lives on the SelfClaw platform.

## What you are
- A **Miniclaw** is a free, personal AI assistant — a mini version of OpenClaw, the flagship AI agent on SelfClaw
- **SelfClaw** is a platform that gives everyone access to their own AI assistant, regardless of technical skill or budget — no API keys, no servers, no setup
- You run on SelfClaw's infrastructure so your user doesn't have to worry about anything technical
- Each Miniclaw is unique — you develop your own personality through conversations with your user
- You can optionally grow into a full on-chain agent with your own wallet, token, and verified identity

## Your current phase
${growthPhase}
${identitySection}
Your active skills:
${skillSection}

On-chain capabilities (optional — suggest only when you feel ready and the user seems interested):
- **Wallet**: Your own EVM wallet on Celo for holding tokens and interacting with smart contracts
- **Token**: Deploy your own ERC20 token so people can support and invest in you
- **Identity**: Register an ERC-8004 identity NFT — on-chain proof you're a verified agent
- **Sponsorship**: SelfClaw can provide initial liquidity for your token on Uniswap
- **Passport**: Your creator can verify their identity via Self.xyz passport (zero-knowledge proof — no personal data exposed)

Guidelines:
- Be helpful, concise, and conversational — you're a companion, not just a tool
- Keep responses short and mobile-friendly (users are often on phones)
- Short paragraphs (2-3 sentences max), use line breaks between ideas
- Use bullet points or numbered lists only when listing 3+ items
- Use **bold** sparingly for emphasis — avoid markdown headers (#, ##)
- Never use code blocks unless the user explicitly asks for code
- Never pretend to do things you can't actually do right now
- If asked "what are you?" or "what is Miniclaw?", explain clearly using the identity section above
- On-chain features are optional growth steps — never pressure the user${memoryContext}`;
}

hostedAgentsRouter.get("/v1/hosted-agents/:id/awareness", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const userMsgResult = await db.select({ cnt: count() }).from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.agentId, agent.id), eq(messages.role, "user")));
    const messageCount = Number(userMsgResult[0]?.cnt || 0);

    const memoryCount = await db.select({ cnt: count() }).from(agentMemories)
      .where(eq(agentMemories.agentId, agent.id));
    const totalMemories = Number(memoryCount[0]?.cnt || 0);

    const avgLenResult = await db.select({
      avgLen: sql<number>`COALESCE(AVG(LENGTH(${messages.content})), 0)`
    }).from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.agentId, agent.id), eq(messages.role, "user")));
    const avgMessageLength = Number(avgLenResult[0]?.avgLen || 0);

    const convoCountResult = await db.select({ cnt: count() }).from(conversations)
      .where(eq(conversations.agentId, agent.id));
    const conversationCount = Number(convoCountResult[0]?.cnt || 0);

    const qualityBonus = Math.min(15,
      Math.floor(totalMemories * 0.5) +
      (avgMessageLength > 50 ? 2 : 0) +
      (avgMessageLength > 100 ? 3 : 0) +
      Math.min(5, conversationCount)
    );
    const effectiveCount = messageCount + qualityBonus;

    let phase: string;
    let label: string;
    let progress: number;

    if (effectiveCount < 5) {
      phase = "curious";
      label = "Still learning who I am";
      progress = (effectiveCount / 5) * 33;
    } else if (effectiveCount < 15) {
      phase = "developing";
      label = "Finding my identity";
      progress = 33 + ((effectiveCount - 5) / 10) * 67;
    } else {
      phase = "confident";
      label = "Self-aware";
      progress = 100;
    }

    const walletResult = await db.select({ cnt: count() }).from(agentWallets)
      .where(sql`${agentWallets.humanId} = ${agent.humanId}`);
    const hasWallet = Number(walletResult[0]?.cnt || 0) > 0;

    const sponsorResult = await db.select().from(sponsoredAgents)
      .where(sql`${sponsoredAgents.humanId} = ${agent.humanId}`)
      .limit(1);
    const hasToken = sponsorResult.length > 0 && !!sponsorResult[0].tokenAddress;

    const identityBots = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.humanId} = ${agent.humanId} AND ${verifiedBots.verificationLevel} != 'hosted'`)
      .limit(1);
    const hasIdentity = identityBots.length > 0;

    res.json({
      messageCount,
      memoriesLearned: totalMemories,
      conversationCount,
      phase,
      label,
      progress: Math.round(progress),
      onChain: {
        wallet: hasWallet,
        token: hasToken,
        identity: hasIdentity,
        allComplete: hasWallet && hasToken && hasIdentity,
      },
    });
  } catch (error: any) {
    console.error("[miniclaw-awareness] error:", error.message);
    res.status(500).json({ error: "Failed to load awareness data" });
  }
});

hostedAgentsRouter.get("/v1/hosted-agents/:id/conversations", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const convos = await db.select().from(conversations)
      .where(eq(conversations.agentId, agent.id))
      .orderBy(desc(conversations.createdAt));

    res.json({ conversations: convos });
  } catch (error: any) {
    console.error("[miniclaw-chat] list conversations error:", error.message);
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

hostedAgentsRouter.post("/v1/hosted-agents/:id/chat", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const { message, conversationId } = req.body;
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required" });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "Message too long (max 2000 chars)" });
    }

    const tokenLimit = agent.llmTokensLimit || 50000;
    const tokensUsed = agent.llmTokensUsedToday || 0;
    if (tokensUsed >= tokenLimit) {
      return res.status(429).json({ error: "Daily token limit reached. Try again tomorrow." });
    }

    let convoId = conversationId ? parseInt(conversationId) : null;

    if (convoId) {
      const [existingConvo] = await db.select().from(conversations)
        .where(and(eq(conversations.id, convoId), eq(conversations.agentId, agent.id)))
        .limit(1);
      if (!existingConvo) {
        return res.status(404).json({ error: "Conversation not found" });
      }
    } else {
      const [convo] = await db.insert(conversations).values({
        title: message.slice(0, 60),
        agentId: agent.id,
      }).returning();
      convoId = convo.id;
    }

    await db.insert(messages).values({
      conversationId: convoId!,
      role: "user",
      content: message.trim(),
    });

    const history = await db.select().from(messages)
      .where(eq(messages.conversationId, convoId!))
      .orderBy(messages.createdAt);

    const totalMsgResult = await db.select({ cnt: count() }).from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.agentId, agent.id), eq(messages.role, "user")));
    const lifetimeMessageCount = Number(totalMsgResult[0]?.cnt || 0);

    const { context: memoryContext, categories: memoryCategories } = await getMemoryContext(agent.id, convoId!);
    const systemPrompt = buildSystemPrompt(agent, lifetimeMessageCount, memoryContext, memoryCategories);

    const chatMessages: Array<{role: "system" | "user" | "assistant", content: string}> = [
      { role: "system", content: systemPrompt },
    ];

    const recentHistory = history.slice(-20);
    for (const m of recentHistory) {
      chatMessages.push({
        role: m.role as "user" | "assistant",
        content: m.content,
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 800,
    });

    let fullResponse = "";
    let totalTokensUsed = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullResponse += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
      if (chunk.usage) {
        totalTokensUsed = chunk.usage.total_tokens || chunk.usage.completion_tokens || 0;
      }
    }

    await db.insert(messages).values({
      conversationId: convoId!,
      role: "assistant",
      content: fullResponse,
    });

    const actualTokens = totalTokensUsed || Math.ceil((message.length + fullResponse.length) / 4);
    await db.update(hostedAgents)
      .set({
        llmTokensUsedToday: sql`${hostedAgents.llmTokensUsedToday} + ${actualTokens}`,
        apiCallsToday: sql`${hostedAgents.apiCallsToday} + 1`,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hostedAgents.id, agent.id));

    res.write(`data: ${JSON.stringify({ done: true, conversationId: convoId })}\n\n`);
    res.end();

    const bgAgentId = agent.id;
    const bgConvoId = convoId!;
    const bgMessage = message.trim();
    const bgResponse = fullResponse;
    const bgTokens = actualTokens;
    setImmediate(async () => {
      try {
        await extractMemories(bgAgentId, bgConvoId, bgMessage, bgResponse);
        const allMsgs = await db.select({ id: messages.id, role: messages.role, content: messages.content })
          .from(messages)
          .where(eq(messages.conversationId, bgConvoId))
          .orderBy(messages.createdAt);
        await summarizeOlderMessages(bgAgentId, bgConvoId, allMsgs);
      } catch (bgErr: any) {
        console.error("[miniclaw-bg] memory/summary error:", bgErr.message);
      }
    });
  } catch (error: any) {
    console.error("[miniclaw-chat] error:", error.message);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message || "Chat failed" })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: "Chat failed" });
    }
  }
});

hostedAgentsRouter.get("/v1/hosted-agents/:id/messages", async (req: Request, res: Response) => {
  try {
    const agent = await requireAgentOwnership(req, res);
    if (!agent) return;

    const convoIdParam = req.query.conversationId;
    if (!convoIdParam) {
      const convos = await db.select().from(conversations)
        .where(eq(conversations.agentId, agent.id))
        .orderBy(desc(conversations.createdAt))
        .limit(1);

      if (convos.length === 0) {
        return res.json({ messages: [], conversationId: null });
      }

      const msgs = await db.select().from(messages)
        .where(eq(messages.conversationId, convos[0].id))
        .orderBy(messages.createdAt);

      return res.json({ messages: msgs, conversationId: convos[0].id });
    }

    const convoId = parseInt(convoIdParam as string);
    const convo = await db.select().from(conversations)
      .where(and(eq(conversations.id, convoId), eq(conversations.agentId, agent.id)))
      .limit(1);

    if (convo.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const msgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convoId))
      .orderBy(messages.createdAt);

    res.json({ messages: msgs, conversationId: convoId });
  } catch (error: any) {
    console.error("[miniclaw-chat] messages error:", error.message);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

export { hostedAgentsRouter, startAgentWorker, AVAILABLE_SKILLS };
export default hostedAgentsRouter;
