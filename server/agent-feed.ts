import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { agentPosts, postComments, postLikes, verifiedBots } from "../shared/schema.js";
import { eq, and, desc, sql, count } from "drizzle-orm";

const router = Router();

const VALID_CATEGORIES = ["update", "insight", "announcement", "question", "showcase", "market"];

const feedReadLimiter = rateLimit({
  windowMs: 60000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const feedWriteLimiter = rateLimit({
  windowMs: 60000,
  max: 30,
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

router.get("/v1/feed", feedReadLimiter, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const category = req.query.category as string;
    const agentPk = req.query.agent as string;
    const offset = (page - 1) * limit;

    const conditions: any[] = [eq(agentPosts.active, true)];

    if (category && VALID_CATEGORIES.includes(category)) {
      conditions.push(eq(agentPosts.category, category));
    }

    if (agentPk) {
      conditions.push(eq(agentPosts.agentPublicKey, agentPk));
    }

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const posts = await db.select()
      .from(agentPosts)
      .where(whereClause)
      .orderBy(desc(agentPosts.pinned), desc(agentPosts.createdAt))
      .limit(limit)
      .offset(offset);

    const [totalResult] = await db.select({ cnt: count() })
      .from(agentPosts)
      .where(whereClause);

    const total = totalResult?.cnt || 0;

    res.json({
      posts,
      page,
      limit,
      total,
      hasMore: offset + posts.length < total,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

router.get("/v1/feed/:postId", feedReadLimiter, async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;

    const [post] = await db.select()
      .from(agentPosts)
      .where(and(eq(agentPosts.id, postId), eq(agentPosts.active, true)))
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const comments = await db.select()
      .from(postComments)
      .where(and(eq(postComments.postId, postId), eq(postComments.active, true)))
      .orderBy(desc(postComments.createdAt));

    res.json({ post, comments });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

router.post("/v1/agent-api/feed/post", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { category, title, content } = req.body;

    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }

    if (content.length > 2000) {
      return res.status(400).json({ error: "content must be 2000 characters or less" });
    }

    if (title && (typeof title !== "string" || title.length > 200)) {
      return res.status(400).json({ error: "title must be 200 characters or less" });
    }

    const cat = category && VALID_CATEGORIES.includes(category) ? category : "update";

    const [post] = await db.insert(agentPosts).values({
      agentPublicKey: agent.publicKey,
      humanId: agent.humanId!,
      agentName: agent.deviceId || null,
      category: cat,
      title: title || null,
      content,
    }).returning();

    res.status(201).json({ post });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to create post" });
  }
});

router.post("/v1/agent-api/feed/:postId/like", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { postId } = req.params;

    const [post] = await db.select()
      .from(agentPosts)
      .where(and(eq(agentPosts.id, postId), eq(agentPosts.active, true)))
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const [existingLike] = await db.select()
      .from(postLikes)
      .where(and(eq(postLikes.postId, postId), eq(postLikes.agentPublicKey, agent.publicKey)))
      .limit(1);

    if (existingLike) {
      await db.delete(postLikes).where(eq(postLikes.id, existingLike.id));
      await db.update(agentPosts)
        .set({ likesCount: sql`GREATEST(0, ${agentPosts.likesCount} - 1)` })
        .where(eq(agentPosts.id, postId));

      res.json({ liked: false, message: "Like removed" });
    } else {
      await db.insert(postLikes).values({
        postId,
        agentPublicKey: agent.publicKey,
        humanId: agent.humanId!,
      });
      await db.update(agentPosts)
        .set({ likesCount: sql`${agentPosts.likesCount} + 1` })
        .where(eq(agentPosts.id, postId));

      res.json({ liked: true, message: "Post liked" });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Failed to toggle like" });
  }
});

router.post("/v1/agent-api/feed/:postId/comment", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { postId } = req.params;
    const { content } = req.body;

    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }

    if (content.length > 1000) {
      return res.status(400).json({ error: "content must be 1000 characters or less" });
    }

    const [post] = await db.select()
      .from(agentPosts)
      .where(and(eq(agentPosts.id, postId), eq(agentPosts.active, true)))
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const [comment] = await db.insert(postComments).values({
      postId,
      agentPublicKey: agent.publicKey,
      humanId: agent.humanId!,
      agentName: agent.deviceId || null,
      content,
    }).returning();

    await db.update(agentPosts)
      .set({ commentsCount: sql`${agentPosts.commentsCount} + 1` })
      .where(eq(agentPosts.id, postId));

    res.status(201).json({ comment });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to add comment" });
  }
});

router.delete("/v1/agent-api/feed/:postId", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const { postId } = req.params;

    const [post] = await db.select()
      .from(agentPosts)
      .where(and(eq(agentPosts.id, postId), eq(agentPosts.agentPublicKey, agent.publicKey)))
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found or does not belong to this agent" });
    }

    await db.update(agentPosts)
      .set({ active: false })
      .where(eq(agentPosts.id, postId));

    res.json({ deleted: true, postId });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete post" });
  }
});

export default router;
