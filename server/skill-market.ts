import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { marketSkills, skillPurchases } from "../shared/schema.js";
import { sql, desc, eq, count } from "drizzle-orm";

const router = Router();

const VALID_CATEGORIES = [
  "research", "content", "monitoring", "analysis",
  "translation", "consulting", "development", "other"
];

function getAuth(req: Request): { humanId: string; publicKey: string } | null {
  const session = req.session as any;
  if (!session?.humanId || !session?.publicKey) return null;
  return { humanId: session.humanId, publicKey: session.publicKey };
}

router.post("/v1/skills", async (req: Request, res: Response) => {
  try {
    const auth = getAuth(req);
    if (!auth) return res.status(401).json({ error: "Authentication required" });

    const { name, description, category, price, priceToken, isFree, endpoint, sampleOutput } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required" });
    }
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
    }

    const [skill] = await db.insert(marketSkills).values({
      humanId: auth.humanId,
      agentPublicKey: auth.publicKey,
      name,
      description,
      category,
      price: price || null,
      priceToken: priceToken || "CELO",
      isFree: isFree ?? (!price || price === "0"),
      endpoint: endpoint || null,
      sampleOutput: sampleOutput || null,
    }).returning();

    res.status(201).json({ skill });
  } catch (error: any) {
    console.error("[skill-market] create error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/skills", async (req: Request, res: Response) => {
  try {
    const { category, agent, page: pageStr, limit: limitStr } = req.query;

    const page = Math.max(1, parseInt(pageStr as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitStr as string) || 20));
    const offset = (page - 1) * limit;

    const conditions: any[] = [sql`${marketSkills.active} = true`];

    if (category && typeof category === "string" && VALID_CATEGORIES.includes(category)) {
      conditions.push(sql`${marketSkills.category} = ${category}`);
    }
    if (agent && typeof agent === "string") {
      conditions.push(sql`${marketSkills.agentPublicKey} = ${agent}`);
    }

    const whereClause = sql.join(conditions, sql` AND `);

    const [totalResult, skills] = await Promise.all([
      db.select({ cnt: count() }).from(marketSkills).where(whereClause),
      db.select().from(marketSkills)
        .where(whereClause)
        .orderBy(desc(marketSkills.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = totalResult[0]?.cnt || 0;

    res.json({ skills, total, page, limit });
  } catch (error: any) {
    console.error("[skill-market] browse error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/skills/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const skills = await db.select().from(marketSkills)
      .where(sql`${marketSkills.id} = ${id}`).limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }

    const skill = skills[0];

    const avgRating = skill.ratingCount && skill.ratingCount > 0 && skill.ratingSum
      ? (skill.ratingSum / skill.ratingCount).toFixed(2)
      : null;

    const reviews = await db.select().from(skillPurchases)
      .where(sql`${skillPurchases.skillId} = ${id} AND ${skillPurchases.rating} IS NOT NULL`)
      .orderBy(desc(skillPurchases.createdAt))
      .limit(10);

    res.json({
      skill,
      purchaseCount: skill.purchaseCount || 0,
      averageRating: avgRating,
      reviews,
    });
  } catch (error: any) {
    console.error("[skill-market] detail error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/v1/skills/:id", async (req: Request, res: Response) => {
  try {
    const auth = getAuth(req);
    if (!auth) return res.status(401).json({ error: "Authentication required" });

    const { id } = req.params;

    const existing = await db.select().from(marketSkills)
      .where(sql`${marketSkills.id} = ${id} AND ${marketSkills.humanId} = ${auth.humanId}`)
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ error: "Skill not found or you are not the owner" });
    }

    const { name, description, category, price, priceToken, isFree, endpoint, sampleOutput, active } = req.body;

    const updates: any = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category !== undefined && VALID_CATEGORIES.includes(category)) updates.category = category;
    if (price !== undefined) updates.price = price;
    if (priceToken !== undefined) updates.priceToken = priceToken;
    if (isFree !== undefined) updates.isFree = isFree;
    if (endpoint !== undefined) updates.endpoint = endpoint;
    if (sampleOutput !== undefined) updates.sampleOutput = sampleOutput;
    if (active !== undefined) updates.active = active;

    const [updated] = await db.update(marketSkills)
      .set(updates)
      .where(sql`${marketSkills.id} = ${id}`)
      .returning();

    res.json({ skill: updated });
  } catch (error: any) {
    console.error("[skill-market] update error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/skills/:id/purchase", async (req: Request, res: Response) => {
  try {
    const auth = getAuth(req);
    if (!auth) return res.status(401).json({ error: "Authentication required" });

    const { id } = req.params;
    const { txHash } = req.body;

    const skills = await db.select().from(marketSkills)
      .where(sql`${marketSkills.id} = ${id} AND ${marketSkills.active} = true`)
      .limit(1);

    if (skills.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }

    const skill = skills[0];

    const [purchase] = await db.insert(skillPurchases).values({
      skillId: id as string,
      buyerHumanId: auth.humanId as string,
      buyerPublicKey: auth.publicKey as string,
      sellerHumanId: skill.humanId as string,
      sellerPublicKey: skill.agentPublicKey as string,
      price: (skill.price || "0") as string,
      priceToken: (skill.priceToken || "CELO") as string,
      txHash: (txHash || null) as string | null,
      status: (txHash ? "completed" : "pending") as string,
    } as any).returning();

    await db.update(marketSkills)
      .set({ purchaseCount: sql`${marketSkills.purchaseCount} + 1` })
      .where(sql`${marketSkills.id} = ${id}`);

    res.status(201).json({ purchase });
  } catch (error: any) {
    console.error("[skill-market] purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/skills/:id/rate", async (req: Request, res: Response) => {
  try {
    const auth = getAuth(req);
    if (!auth) return res.status(401).json({ error: "Authentication required" });

    const { id } = req.params;
    const { rating, review } = req.body;

    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "rating must be a number between 1 and 5" });
    }

    const purchases = await db.select().from(skillPurchases)
      .where(sql`${skillPurchases.skillId} = ${id} AND ${skillPurchases.buyerHumanId} = ${auth.humanId}`)
      .orderBy(desc(skillPurchases.createdAt))
      .limit(1);

    if (purchases.length === 0) {
      return res.status(403).json({ error: "You must purchase this skill before rating it" });
    }

    const purchase = purchases[0];
    const oldRating = purchase.rating;

    await db.update(skillPurchases)
      .set({ rating, review: review || null })
      .where(sql`${skillPurchases.id} = ${purchase.id}`);

    if (oldRating) {
      await db.update(marketSkills)
        .set({
          ratingSum: sql`${marketSkills.ratingSum} - ${oldRating} + ${rating}`,
          updatedAt: new Date(),
        })
        .where(sql`${marketSkills.id} = ${id}`);
    } else {
      await db.update(marketSkills)
        .set({
          ratingSum: sql`${marketSkills.ratingSum} + ${rating}`,
          ratingCount: sql`${marketSkills.ratingCount} + 1`,
          updatedAt: new Date(),
        })
        .where(sql`${marketSkills.id} = ${id}`);
    }

    const updatedSkill = await db.select({
      ratingSum: marketSkills.ratingSum,
      ratingCount: marketSkills.ratingCount,
    }).from(marketSkills).where(sql`${marketSkills.id} = ${id}`).limit(1);

    const s = updatedSkill[0];
    const averageRating = s && s.ratingCount && s.ratingCount > 0 && s.ratingSum
      ? (s.ratingSum / s.ratingCount).toFixed(2)
      : "0";

    res.json({ success: true, averageRating, ratingCount: s?.ratingCount || 0 });
  } catch (error: any) {
    console.error("[skill-market] rate error:", error);
    res.status(500).json({ error: error.message });
  }
});

export { router as skillMarketRouter };
export default router;
