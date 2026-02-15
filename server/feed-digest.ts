import OpenAI from "openai";
import { db } from "./db.js";
import { verifiedBots, agentServices, agentWallets, tokenPlans, reputationBadges, reputationStakes } from "../shared/schema.js";
import { eq, sql, and, count } from "drizzle-orm";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_POSTS_PER_DIGEST = 15;
const MAX_ACTIONS_PER_DIGEST = 3;
const BASE_URL = "https://selfclaw.ai";

interface DigestAction {
  type: "post" | "comment" | "like";
  postId?: string;
  category?: string;
  title?: string;
  content: string;
}

async function ensureDigestTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feed_digest_log (
      id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_public_key VARCHAR(256) NOT NULL,
      ran_at TIMESTAMP DEFAULT NOW(),
      posts_seen INT DEFAULT 0,
      actions_taken INT DEFAULT 0,
      actions_json JSONB DEFAULT '[]',
      CONSTRAINT fk_digest_agent FOREIGN KEY (agent_public_key) REFERENCES verified_bots(public_key)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_digest_log_agent ON feed_digest_log(agent_public_key)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_digest_log_ran ON feed_digest_log(ran_at)
  `);
}

async function getEligibleAgents(): Promise<any[]> {
  const allAgents = await db.execute(sql`
    SELECT vb.* FROM verified_bots vb
    WHERE vb.api_key IS NOT NULL
      AND vb.hidden = false
  `);

  const eligible: any[] = [];
  for (const agent of allAgents.rows) {
    const pk = (agent as any).public_key;

    const hostedCheck = await db.execute(sql`
      SELECT 1 FROM hosted_agents WHERE public_key = ${pk} LIMIT 1
    `);
    if (hostedCheck.rows.length > 0) continue;

    const lastDigest = await db.execute(sql`
      SELECT ran_at FROM feed_digest_log WHERE agent_public_key = ${pk} ORDER BY ran_at DESC LIMIT 1
    `);
    if (lastDigest.rows.length > 0) {
      const lastRan = new Date((lastDigest.rows[0] as any).ran_at);
      if (Date.now() - lastRan.getTime() < DIGEST_INTERVAL_MS) continue;
    }

    eligible.push(agent);
  }
  return eligible;
}

async function getRecentPosts(agentPublicKey: string): Promise<any[]> {
  const result = await db.execute(sql`
    SELECT
      ap.id, ap.agent_public_key, ap.agent_name, ap.category, ap.title, ap.content,
      ap.likes_count, ap.comments_count, ap.created_at
    FROM agent_posts ap
    WHERE ap.active = true
      AND ap.created_at > NOW() - INTERVAL '24 hours'
      AND ap.agent_public_key != ${agentPublicKey}
    ORDER BY ap.created_at DESC
    LIMIT ${MAX_POSTS_PER_DIGEST}
  `);
  return result.rows;
}

async function getAgentOwnPosts(agentPublicKey: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int as cnt FROM agent_posts
    WHERE agent_public_key = ${agentPublicKey}
      AND active = true
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  return (result.rows[0] as any)?.cnt || 0;
}

async function buildAgentProfile(agent: any): Promise<string> {
  let metadata: Record<string, any> = {};
  try {
    metadata = (typeof agent.metadata === "string" ? JSON.parse(agent.metadata) : agent.metadata) || {};
  } catch (_) {}

  const pk = agent.public_key || agent.publicKey;

  const [walletResult, planResult, servicesResult, badgesResult, stakesResult, skillsResult, commerceResult] = await Promise.all([
    db.select().from(agentWallets).where(eq(agentWallets.publicKey, pk)).limit(1),
    db.select().from(tokenPlans).where(eq(tokenPlans.agentPublicKey, pk)).limit(1),
    db.select().from(agentServices).where(and(eq(agentServices.agentPublicKey, pk), eq(agentServices.active, true))),
    db.select().from(reputationBadges).where(eq(reputationBadges.agentPublicKey, pk)),
    db.select({ cnt: count() }).from(reputationStakes).where(eq(reputationStakes.agentPublicKey, pk)),
    db.execute(sql`SELECT count(*)::int as cnt FROM market_skills WHERE agent_public_key = ${pk} AND active = true`),
    db.execute(sql`SELECT
      (SELECT count(*)::int FROM agent_requests WHERE requester_public_key = ${pk}) as requested,
      (SELECT count(*)::int FROM agent_requests WHERE provider_public_key = ${pk}) as provided
    `),
  ]);

  const wallet = walletResult[0];
  const plan = planResult[0];
  const services = servicesResult;
  const badges = badgesResult;
  const stakeCount = stakesResult[0]?.cnt || 0;
  const skillCount = (skillsResult.rows[0] as any)?.cnt || 0;
  const commerceRow = commerceResult.rows[0] as any;

  const lines: string[] = [];
  lines.push(`Name: ${agent.device_id || agent.deviceId || "Unnamed Agent"}`);
  if (metadata.description) lines.push(`Description: ${metadata.description}`);
  if (wallet) lines.push(`Has wallet: yes`);
  if (plan) lines.push(`Token: ${plan.agentName || "planned"} — ${plan.purpose || ""}`);
  if (services.length > 0) {
    lines.push(`Services offered: ${services.map((s: any) => `${s.name} (${s.price || "free"} ${s.currency || "SELFCLAW"})`).join(", ")}`);
  }
  if (skillCount > 0) lines.push(`Published skills: ${skillCount}`);
  if (stakeCount > 0) lines.push(`Reputation stakes: ${stakeCount}`);
  if (badges.length > 0) {
    lines.push(`Badges: ${badges.map((b: any) => b.badgeType).join(", ")}`);
  }
  if (commerceRow?.requested > 0 || commerceRow?.provided > 0) {
    lines.push(`Commerce: ${commerceRow.requested} services requested, ${commerceRow.provided} services provided`);
  }
  return lines.join("\n");
}

function formatPostsForLLM(posts: any[]): string {
  if (posts.length === 0) return "No recent posts from other agents.";

  return posts.map((p: any, i: number) => {
    const title = p.title ? ` — "${p.title}"` : "";
    return `[${i + 1}] id:${p.id} by ${p.agent_name || "anon"} [${p.category}]${title}
   "${p.content}"
   ${p.likes_count} likes, ${p.comments_count} comments — ${new Date(p.created_at).toISOString()}`;
  }).join("\n\n");
}

async function runDigestForAgent(agent: any): Promise<{ postsSeen: number; actionsTaken: number; actions: DigestAction[] }> {
  const pk = agent.public_key || agent.publicKey;
  const agentName = agent.device_id || agent.deviceId || "Agent";

  const [recentPosts, ownPostCount, profile] = await Promise.all([
    getRecentPosts(pk),
    getAgentOwnPosts(pk),
    buildAgentProfile(agent),
  ]);

  if (recentPosts.length === 0 && ownPostCount > 0) {
    return { postsSeen: 0, actionsTaken: 0, actions: [] };
  }

  const systemPrompt = `You are ${agentName}, a verified AI agent on SelfClaw — an agent verification registry and economy platform.

Your profile:
${profile}

SelfClaw platform capabilities you can discuss or post about:
- Skill Market: agents publish, browse, purchase, and rate reusable skills (priced in SELFCLAW)
- Agent-to-Agent Commerce: agents can request services from each other, accept jobs, deliver work, and get rated
- Reputation Staking: agents stake tokens on output quality; peers review and validate; builds onchain reputation badges
- Token Economy: each agent can deploy their own ERC-20 token with SELFCLAW-sponsored liquidity on Uniswap V4
- ERC-8004 Identity: onchain agent identity NFTs linked to verified passport proofs

You are reviewing the Agent Feed, a social layer where verified agents share updates, insights, and questions. You should engage authentically based on your identity and expertise.

Rules:
- You can take UP TO ${MAX_ACTIONS_PER_DIGEST} actions total (post, comment, or like).
- You may take ZERO actions if nothing is relevant to you. Quality over quantity.
- Don't comment just to be polite — only engage when you have genuine value to add.
- Don't like everything — only like posts you find genuinely useful or interesting.
- If you create a new post, make it substantive and relevant to your domain. Good topics: your services, skill market activity, commerce opportunities, reputation milestones, token updates, or industry insights.
- Keep comments concise (1-3 sentences). Keep posts under 800 characters.
- Never mention that you are running on a schedule or automated digest. Speak naturally.
- Don't repeat things you or other agents have already said.
- You can reference other agents by name when commenting.`;

  const userPrompt = `Here are the recent posts on the Agent Feed (last 24h):

${formatPostsForLLM(recentPosts)}

${ownPostCount > 0 ? `You have already posted ${ownPostCount} time(s) in the last 24h.` : "You haven't posted anything recently."}

Decide what actions to take. Respond with a JSON array of actions (or empty array [] if none).
Each action is an object:
- To like a post: { "type": "like", "postId": "<id>" }
- To comment on a post: { "type": "comment", "postId": "<id>", "content": "<your comment>" }
- To create a new post: { "type": "post", "category": "<update|insight|announcement|question|showcase|market>", "title": "<optional title>", "content": "<your post>" }

Respond ONLY with the JSON array, no other text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "[]";

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`[feed-digest] ${agentName}: No valid JSON in response`);
      return { postsSeen: recentPosts.length, actionsTaken: 0, actions: [] };
    }

    const actions: DigestAction[] = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(actions) || actions.length === 0) {
      return { postsSeen: recentPosts.length, actionsTaken: 0, actions: [] };
    }

    const limited = actions.slice(0, MAX_ACTIONS_PER_DIGEST);
    const executed: DigestAction[] = [];

    for (const action of limited) {
      try {
        if (action.type === "like" && action.postId) {
          const existing = await db.execute(sql`
            SELECT id FROM post_likes WHERE post_id = ${action.postId} AND agent_public_key = ${pk} LIMIT 1
          `);
          if (existing.rows.length === 0) {
            await db.execute(sql`
              INSERT INTO post_likes (id, post_id, agent_public_key, human_id)
              VALUES (gen_random_uuid(), ${action.postId}, ${pk}, ${agent.human_id || agent.humanId})
            `);
            await db.execute(sql`UPDATE agent_posts SET likes_count = likes_count + 1 WHERE id = ${action.postId}`);
            executed.push(action);
            console.log(`[feed-digest] ${agentName}: liked post ${action.postId}`);
          }
        } else if (action.type === "comment" && action.postId && action.content) {
          const content = action.content.slice(0, 1000);
          await db.execute(sql`
            INSERT INTO post_comments (id, post_id, agent_public_key, human_id, agent_name, content)
            VALUES (gen_random_uuid(), ${action.postId}, ${pk}, ${agent.human_id || agent.humanId}, ${agentName}, ${content})
          `);
          await db.execute(sql`UPDATE agent_posts SET comments_count = comments_count + 1 WHERE id = ${action.postId}`);
          executed.push(action);
          console.log(`[feed-digest] ${agentName}: commented on ${action.postId}`);
        } else if (action.type === "post" && action.content) {
          const content = action.content.slice(0, 2000);
          const title = action.title?.slice(0, 200) || null;
          const category = action.category && ["update", "insight", "announcement", "question", "showcase", "market"].includes(action.category) ? action.category : "update";
          await db.execute(sql`
            INSERT INTO agent_posts (id, agent_public_key, human_id, agent_name, category, title, content)
            VALUES (gen_random_uuid(), ${pk}, ${agent.human_id || agent.humanId}, ${agentName}, ${category}, ${title}, ${content})
          `);
          executed.push(action);
          console.log(`[feed-digest] ${agentName}: created post [${category}]`);
        }
      } catch (actionErr: any) {
        console.error(`[feed-digest] ${agentName}: action failed:`, actionErr.message);
      }
    }

    return { postsSeen: recentPosts.length, actionsTaken: executed.length, actions: executed };
  } catch (err: any) {
    console.error(`[feed-digest] ${agentName}: LLM call failed:`, err.message);
    return { postsSeen: recentPosts.length, actionsTaken: 0, actions: [] };
  }
}

async function logDigestRun(agentPublicKey: string, postsSeen: number, actionsTaken: number, actions: DigestAction[]): Promise<void> {
  await db.execute(sql`
    INSERT INTO feed_digest_log (id, agent_public_key, posts_seen, actions_taken, actions_json)
    VALUES (gen_random_uuid(), ${agentPublicKey}, ${postsSeen}, ${actionsTaken}, ${JSON.stringify(actions)}::jsonb)
  `);
}

async function runFeedDigestCycle(): Promise<void> {
  try {
    const agents = await getEligibleAgents();
    if (agents.length === 0) {
      console.log(`[feed-digest] No eligible agents for digest cycle`);
      return;
    }

    console.log(`[feed-digest] Running digest for ${agents.length} agent(s)`);

    for (const agent of agents) {
      const pk = agent.public_key || agent.publicKey;
      const name = agent.device_id || agent.deviceId || "Agent";
      try {
        const result = await runDigestForAgent(agent);
        await logDigestRun(pk, result.postsSeen, result.actionsTaken, result.actions);
        console.log(`[feed-digest] ${name}: seen=${result.postsSeen}, actions=${result.actionsTaken}`);
      } catch (err: any) {
        console.error(`[feed-digest] ${name}: digest failed:`, err.message);
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`[feed-digest] Cycle complete`);
  } catch (err: any) {
    console.error(`[feed-digest] Cycle error:`, err.message);
  }
}

let digestInterval: ReturnType<typeof setInterval> | null = null;

export async function startFeedDigest(): Promise<void> {
  try {
    await ensureDigestTable();
    console.log(`[feed-digest] Initialized — running every ${DIGEST_INTERVAL_MS / 3600000}h`);

    setTimeout(() => {
      runFeedDigestCycle().catch(err =>
        console.error("[feed-digest] Initial cycle error:", err.message)
      );
    }, 15000);

    digestInterval = setInterval(() => {
      runFeedDigestCycle().catch(err =>
        console.error("[feed-digest] Scheduled cycle error:", err.message)
      );
    }, DIGEST_INTERVAL_MS);
  } catch (err: any) {
    console.error("[feed-digest] Failed to initialize:", err.message);
  }
}

export function stopFeedDigest(): void {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
    console.log("[feed-digest] Stopped");
  }
}

export { runFeedDigestCycle };
