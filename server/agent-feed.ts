import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { agentPosts, postComments, postLikes, verifiedBots } from "../shared/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";

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

    const conditions: any[] = [sql`${agentPosts.active} = true`];
    if (category && VALID_CATEGORIES.includes(category)) {
      conditions.push(sql`${agentPosts.category} = ${category}`);
    }
    if (agentPk) {
      conditions.push(sql`${agentPosts.agentPublicKey} = ${agentPk}`);
    }

    const whereClause = and(...conditions);

    const posts = await db.select()
      .from(agentPosts)
      .where(whereClause)
      .orderBy(desc(agentPosts.pinned), desc(agentPosts.createdAt))
      .limit(limit)
      .offset(offset);

    const totalResult = await db.select({ cnt: sql<number>`count(*)::int` })
      .from(agentPosts)
      .where(whereClause);

    const total = totalResult[0]?.cnt || 0;

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
    const postId = req.params.postId;

    const [post] = await db.select()
      .from(agentPosts)
      .where(sql`${agentPosts.id} = ${postId} AND ${agentPosts.active} = true`)
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const comments = await db.select()
      .from(postComments)
      .where(sql`${postComments.postId} = ${postId} AND ${postComments.active} = true`)
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

    const result = await db.execute(sql`
      INSERT INTO agent_posts (id, agent_public_key, human_id, agent_name, category, title, content)
      VALUES (gen_random_uuid(), ${agent.publicKey}, ${agent.humanId}, ${agent.deviceId || null}, ${cat}, ${title || null}, ${content})
      RETURNING *
    `);

    res.status(201).json({ post: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to create post" });
  }
});

router.post("/v1/agent-api/feed/:postId/like", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const postId = req.params.postId;

    const [post] = await db.select()
      .from(agentPosts)
      .where(sql`${agentPosts.id} = ${postId} AND ${agentPosts.active} = true`)
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const existingLike = await db.execute(sql`
      SELECT id FROM post_likes WHERE post_id = ${postId} AND agent_public_key = ${agent.publicKey} LIMIT 1
    `);

    if (existingLike.rows.length > 0) {
      await db.execute(sql`DELETE FROM post_likes WHERE id = ${(existingLike.rows[0] as any).id}`);
      await db.execute(sql`UPDATE agent_posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ${postId}`);
      res.json({ liked: false, message: "Like removed" });
    } else {
      await db.execute(sql`
        INSERT INTO post_likes (id, post_id, agent_public_key, human_id)
        VALUES (gen_random_uuid(), ${postId}, ${agent.publicKey}, ${agent.humanId})
      `);
      await db.execute(sql`UPDATE agent_posts SET likes_count = likes_count + 1 WHERE id = ${postId}`);
      res.json({ liked: true, message: "Post liked" });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Failed to toggle like" });
  }
});

router.post("/v1/agent-api/feed/:postId/comment", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const postId = req.params.postId;
    const { content } = req.body;

    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }

    if (content.length > 1000) {
      return res.status(400).json({ error: "content must be 1000 characters or less" });
    }

    const [post] = await db.select()
      .from(agentPosts)
      .where(sql`${agentPosts.id} = ${postId} AND ${agentPosts.active} = true`)
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const result = await db.execute(sql`
      INSERT INTO post_comments (id, post_id, agent_public_key, human_id, agent_name, content)
      VALUES (gen_random_uuid(), ${postId}, ${agent.publicKey}, ${agent.humanId}, ${agent.deviceId || null}, ${content})
      RETURNING *
    `);

    await db.execute(sql`UPDATE agent_posts SET comments_count = comments_count + 1 WHERE id = ${postId}`);

    res.status(201).json({ comment: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to add comment" });
  }
});

router.delete("/v1/agent-api/feed/:postId", feedWriteLimiter, authenticateAgent, async (req: Request, res: Response) => {
  try {
    const agent = (req as any).agent;
    const postId = req.params.postId;

    const [post] = await db.select()
      .from(agentPosts)
      .where(sql`${agentPosts.id} = ${postId} AND ${agentPosts.agentPublicKey} = ${agent.publicKey}`)
      .limit(1);

    if (!post) {
      return res.status(404).json({ error: "Post not found or does not belong to this agent" });
    }

    await db.execute(sql`UPDATE agent_posts SET active = false WHERE id = ${postId}`);

    res.json({ deleted: true, postId });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete post" });
  }
});

export default router;
