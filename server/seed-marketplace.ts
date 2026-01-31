import { db } from "./db.js";
import { users, agents, agentSkills } from "../shared/schema.js";
import { eq } from "drizzle-orm";

const PLATFORM_USER_ID = "platform-demo";
const PLATFORM_AGENT_NAME = "OpenClaw Demo Agent";

const SEED_SKILLS = [
  {
    name: "Competitor Monitor",
    description: "Track competitor websites, social media, pricing changes, and new features. Get daily summaries of what changed.",
    category: "research",
    priceCredits: "0.50",
  },
  {
    name: "Content Syndicator",
    description: "Transform one blog post into platform-native versions for Medium, Dev.to, LinkedIn, Twitter threads, and Reddit posts.",
    category: "creative",
    priceCredits: "1.00",
  },
  {
    name: "Review Sentinel",
    description: "Monitor reviews across G2, Capterra, TrustPilot, and social media. Get instant alerts with suggested responses.",
    category: "automation",
    priceCredits: "0.25",
  },
  {
    name: "Social Proof Collector",
    description: "Find and extract positive mentions of your brand from Twitter, Reddit, and Hacker News. Format as testimonials.",
    category: "research",
    priceCredits: "0.30",
  },
  {
    name: "Backlink Hunter",
    description: "Scan high-DA sites for broken links in your niche. Generate personalized outreach for link replacement opportunities.",
    category: "research",
    priceCredits: "0.75",
  },
  {
    name: "Community Watcher",
    description: "Monitor Slack, Discord, and Reddit for questions your product can answer. Get alerts with conversation context.",
    category: "automation",
    priceCredits: "0.20",
  },
];

export async function seedMarketplace() {
  try {
    const existingUser = await db.select().from(users).where(eq(users.id, PLATFORM_USER_ID)).limit(1);
    
    if (existingUser.length > 0) {
      console.log("[seed] Platform demo user already exists, skipping seed");
      return;
    }

    await db.insert(users).values({
      id: PLATFORM_USER_ID,
      email: "demo@openclaw.platform",
      firstName: "OpenClaw",
      lastName: "Platform",
    });
    console.log("[seed] Created platform demo user");

    const [agent] = await db.insert(agents).values({
      userId: PLATFORM_USER_ID,
      name: PLATFORM_AGENT_NAME,
      description: "Official demo agent showcasing marketplace skill templates. These skills demonstrate what OpenClaw agents can offer.",
      status: "active",
      credits: "1000",
    }).returning();
    console.log("[seed] Created platform demo agent:", agent.id);

    for (const skill of SEED_SKILLS) {
      await db.insert(agentSkills).values({
        agentId: agent.id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        priceCredits: skill.priceCredits,
        isActive: true,
      });
      console.log("[seed] Added skill:", skill.name);
    }

    console.log("[seed] Marketplace seeded with", SEED_SKILLS.length, "skills");
  } catch (error) {
    console.error("[seed] Error seeding marketplace:", error);
  }
}
