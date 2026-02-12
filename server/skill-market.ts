import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { db } from "./db.js";
import {
  marketplaceSkills, skillInstalls, hostedAgents, agentTaskQueue,
  type MarketplaceSkill, type InsertMarketplaceSkill
} from "../shared/schema.js";
import { eq, and, desc, asc, sql, count, ilike, or } from "drizzle-orm";

export const skillMarketRouter = Router();

const skillMarketLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true, legacyHeaders: false,
});

skillMarketRouter.use(skillMarketLimiter);

function requireAuth(req: Request, res: Response): string | null {
  const session = req.session as any;
  if (!session?.isAuthenticated || !session?.humanId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return session.humanId;
}

const VALID_CATEGORIES = ["monitoring", "economics", "identity", "social", "utility", "analytics", "automation"];

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

skillMarketRouter.get("/v1/skill-market/my-skills", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const skills = await db.select().from(marketplaceSkills)
      .where(eq(marketplaceSkills.creatorHumanId, humanId))
      .orderBy(desc(marketplaceSkills.createdAt));

    res.json({ skills });
  } catch (error: any) {
    console.error("[skill-market] my-skills error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.get("/v1/skill-market/stats", async (_req: Request, res: Response) => {
  try {
    const totalSkillsResult = await db.select({ cnt: count() }).from(marketplaceSkills)
      .where(eq(marketplaceSkills.status, "active"));

    const totalInstallsResult = await db.select({
      total: sql<number>`COALESCE(SUM(${marketplaceSkills.installCount}), 0)`
    }).from(marketplaceSkills).where(eq(marketplaceSkills.status, "active"));

    const categoriesResult = await db.select({
      category: marketplaceSkills.category,
      cnt: count(),
    }).from(marketplaceSkills)
      .where(eq(marketplaceSkills.status, "active"))
      .groupBy(marketplaceSkills.category);

    res.json({
      totalSkills: totalSkillsResult[0]?.cnt || 0,
      totalInstalls: Number(totalInstallsResult[0]?.total) || 0,
      categories: categoriesResult.map(c => ({ category: c.category, count: c.cnt })),
    });
  } catch (error: any) {
    console.error("[skill-market] stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.get("/v1/skill-market", async (req: Request, res: Response) => {
  try {
    const { category, search, sort } = req.query;
    const conditions: any[] = [eq(marketplaceSkills.status, "active")];

    if (category && typeof category === "string" && VALID_CATEGORIES.includes(category)) {
      conditions.push(eq(marketplaceSkills.category, category));
    }

    if (search && typeof search === "string") {
      conditions.push(
        or(
          ilike(marketplaceSkills.name, `%${search}%`),
          ilike(marketplaceSkills.description, `%${search}%`)
        )
      );
    }

    let orderBy;
    switch (sort) {
      case "popular":
        orderBy = desc(marketplaceSkills.installCount);
        break;
      case "rating":
        orderBy = desc(marketplaceSkills.rating);
        break;
      case "newest":
      default:
        orderBy = desc(marketplaceSkills.createdAt);
        break;
    }

    const skills = await db.select().from(marketplaceSkills)
      .where(and(...conditions))
      .orderBy(orderBy);

    res.json({ skills });
  } catch (error: any) {
    console.error("[skill-market] browse error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.get("/v1/skill-market/:slug", async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const skills = await db.select().from(marketplaceSkills)
      .where(sql`${marketplaceSkills.slug} = ${slug}`).limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }

    const skill = skills[0];

    const installCountResult = await db.select({ cnt: count() }).from(skillInstalls)
      .where(eq(skillInstalls.marketSkillId, skill.id));

    res.json({
      skill,
      installCount: installCountResult[0]?.cnt || 0,
    });
  } catch (error: any) {
    console.error("[skill-market] get skill error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.post("/v1/skill-market", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const {
      name, description, longDescription, icon, category,
      tags, priceSelfclaw, scheduleInterval, handlerPrompt,
      inputSchema, outputFormat
    } = req.body;

    if (!name || typeof name !== "string" || name.length < 3 || name.length > 60) {
      return res.status(400).json({ error: "Name is required (3-60 characters)" });
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "Description is required" });
    }
    if (!handlerPrompt || typeof handlerPrompt !== "string") {
      return res.status(400).json({ error: "Handler prompt is required" });
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}` });
    }

    const slug = generateSlug(name);
    const price = priceSelfclaw || "0";
    const isFree = parseFloat(price) === 0;

    const [skill] = await db.insert(marketplaceSkills).values({
      creatorHumanId: humanId,
      name,
      slug,
      description,
      longDescription: longDescription || null,
      icon: icon || "🔧",
      category: category || "utility",
      tags: tags || [],
      priceSelfclaw: price,
      isFree,
      scheduleInterval: scheduleInterval || 3600000,
      handlerPrompt,
      inputSchema: inputSchema || {},
      outputFormat: outputFormat || "text",
    }).returning();

    console.log("[skill-market] Published skill:", skill.id, "by:", humanId);
    res.status(201).json({ success: true, skill });
  } catch (error: any) {
    console.error("[skill-market] publish error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.patch("/v1/skill-market/:slug", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const { slug } = req.params;
    const skills = await db.select().from(marketplaceSkills)
      .where(and(sql`${marketplaceSkills.slug} = ${slug}`, eq(marketplaceSkills.creatorHumanId, humanId))).limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found or you are not the creator" });
    }

    const {
      name, description, longDescription, icon, category,
      tags, priceSelfclaw, scheduleInterval, handlerPrompt,
      inputSchema, outputFormat, status
    } = req.body;

    const updates: any = { updatedAt: new Date() };

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (longDescription !== undefined) updates.longDescription = longDescription;
    if (icon !== undefined) updates.icon = icon;
    if (category !== undefined && VALID_CATEGORIES.includes(category)) updates.category = category;
    if (tags !== undefined) updates.tags = tags;
    if (priceSelfclaw !== undefined) {
      updates.priceSelfclaw = priceSelfclaw;
      updates.isFree = parseFloat(priceSelfclaw) === 0;
    }
    if (scheduleInterval !== undefined) updates.scheduleInterval = scheduleInterval;
    if (handlerPrompt !== undefined) updates.handlerPrompt = handlerPrompt;
    if (inputSchema !== undefined) updates.inputSchema = inputSchema;
    if (outputFormat !== undefined) updates.outputFormat = outputFormat;
    if (status !== undefined && ["active", "inactive"].includes(status)) updates.status = status;

    const [updated] = await db.update(marketplaceSkills)
      .set(updates)
      .where(eq(marketplaceSkills.id, skills[0].id))
      .returning();

    res.json({ success: true, skill: updated });
  } catch (error: any) {
    console.error("[skill-market] update error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.post("/v1/skill-market/:slug/install", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const { slug } = req.params;
    const { hostedAgentId } = req.body;

    if (!hostedAgentId) {
      return res.status(400).json({ error: "hostedAgentId is required" });
    }

    const agents = await db.select().from(hostedAgents)
      .where(and(sql`${hostedAgents.id} = ${hostedAgentId}`, eq(hostedAgents.humanId, humanId))).limit(1);

    if (agents.length === 0) {
      return res.status(404).json({ error: "Agent not found or you are not the owner" });
    }

    const skills = await db.select().from(marketplaceSkills)
      .where(and(sql`${marketplaceSkills.slug} = ${slug}`, eq(marketplaceSkills.status, "active"))).limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }

    const skill = skills[0];
    const agent = agents[0];

    const currentInstalled = (agent.installedMarketSkills as string[]) || [];
    if (currentInstalled.includes(skill.id)) {
      return res.status(400).json({ error: "Skill already installed on this agent" });
    }

    await db.update(hostedAgents)
      .set({
        installedMarketSkills: [...currentInstalled, skill.id],
        updatedAt: new Date(),
      })
      .where(sql`${hostedAgents.id} = ${hostedAgentId}`);

    await db.insert(skillInstalls).values({
      marketSkillId: skill.id,
      installerHumanId: humanId,
      hostedAgentId,
      pricePaid: skill.priceSelfclaw || "0",
    });

    await db.update(marketplaceSkills)
      .set({ installCount: sql`${marketplaceSkills.installCount} + 1` })
      .where(eq(marketplaceSkills.id, skill.id));

    console.log("[skill-market] Installed skill:", skill.id, "on agent:", hostedAgentId);
    res.json({ success: true, message: "Skill installed successfully" });
  } catch (error: any) {
    console.error("[skill-market] install error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.post("/v1/skill-market/:slug/uninstall", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const { slug } = req.params;
    const { hostedAgentId } = req.body;

    if (!hostedAgentId) {
      return res.status(400).json({ error: "hostedAgentId is required" });
    }

    const agents = await db.select().from(hostedAgents)
      .where(and(sql`${hostedAgents.id} = ${hostedAgentId}`, eq(hostedAgents.humanId, humanId))).limit(1);

    if (agents.length === 0) {
      return res.status(404).json({ error: "Agent not found or you are not the owner" });
    }

    const skills = await db.select().from(marketplaceSkills)
      .where(sql`${marketplaceSkills.slug} = ${slug}`).limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }

    const skill = skills[0];
    const agent = agents[0];

    const currentInstalled = (agent.installedMarketSkills as string[]) || [];
    const updatedInstalled = currentInstalled.filter((id: string) => id !== skill.id);

    await db.update(hostedAgents)
      .set({
        installedMarketSkills: updatedInstalled,
        updatedAt: new Date(),
      })
      .where(sql`${hostedAgents.id} = ${hostedAgentId}`);

    console.log("[skill-market] Uninstalled skill:", skill.id, "from agent:", hostedAgentId);
    res.json({ success: true, message: "Skill uninstalled successfully" });
  } catch (error: any) {
    console.error("[skill-market] uninstall error:", error);
    res.status(500).json({ error: error.message });
  }
});

skillMarketRouter.post("/v1/skill-market/:slug/rate", async (req: Request, res: Response) => {
  try {
    const humanId = requireAuth(req, res);
    if (!humanId) return;

    const { slug } = req.params;
    const { hostedAgentId, rating, review } = req.body;

    if (!hostedAgentId) {
      return res.status(400).json({ error: "hostedAgentId is required" });
    }
    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    const skills = await db.select().from(marketplaceSkills)
      .where(sql`${marketplaceSkills.slug} = ${slug}`).limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }

    const skill = skills[0];

    const installs = await db.select().from(skillInstalls)
      .where(and(
        eq(skillInstalls.marketSkillId, skill.id),
        eq(skillInstalls.hostedAgentId, hostedAgentId),
        eq(skillInstalls.installerHumanId, humanId)
      )).limit(1);

    if (installs.length === 0) {
      return res.status(400).json({ error: "You must have this skill installed to rate it" });
    }

    await db.update(skillInstalls)
      .set({ rating, review: review || null })
      .where(eq(skillInstalls.id, installs[0].id));

    const avgResult = await db.select({
      avgRating: sql<number>`COALESCE(AVG(${skillInstalls.rating}), 0)`,
      ratingCount: sql<number>`COUNT(${skillInstalls.rating})`,
    }).from(skillInstalls)
      .where(and(
        eq(skillInstalls.marketSkillId, skill.id),
        sql`${skillInstalls.rating} IS NOT NULL`
      ));

    const avgRating = Number(avgResult[0]?.avgRating) || 0;
    const ratingCount = Number(avgResult[0]?.ratingCount) || 0;

    await db.update(marketplaceSkills)
      .set({
        rating: avgRating.toFixed(2),
        ratingCount,
        updatedAt: new Date(),
      })
      .where(eq(marketplaceSkills.id, skill.id));

    console.log("[skill-market] Rated skill:", skill.id, "rating:", rating);
    res.json({ success: true, averageRating: avgRating, ratingCount });
  } catch (error: any) {
    console.error("[skill-market] rate error:", error);
    res.status(500).json({ error: error.message });
  }
});
