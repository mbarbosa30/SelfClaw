import express, { type Request, type Response } from "express";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";
import { setupSelfAuth, isAuthenticated, registerAuthRoutes } from "./self-auth.js";
// Legacy import kept for reference but not used
// import { setupAuth as setupReplitAuth, isAuthenticated as replitIsAuthenticated, registerAuthRoutes as replitRegisterAuthRoutes } from "./replit_integrations/auth/index.js";
import { db } from "./db.js";
import { agents, payments, users, agentSecrets, agentSkills, agentGoals, agentScheduledTasks, agentMemory, agentToolExecutions, conversations, messages, activityFeed, agentTokens, liquidityPositions, type InsertAgent, type InsertPayment, type InsertAgentSecret, type InsertAgentSkill, type InsertAgentGoal, type InsertAgentScheduledTask, type InsertActivityFeedEntry } from "../shared/schema.js";
import { runAgentTurn, buildAgentContext, AVAILABLE_TOOLS } from "./agent-runtime.js";
import { startScheduler } from "./scheduler.js";
import OpenAI from "openai";
import { eq, desc, sql, and } from "drizzle-orm";
import { createCeloWallet, getWalletBalance, CELO_CONFIG } from "../lib/wallet.js";
import { deriveAgentWalletAddress, getAgentWalletBalance, PLATFORM_FEE_PERCENT, createAgentWallet } from "../lib/agent-wallet.js";
import { createAgentX402Client } from "../lib/agent-x402-client.js";
import { createAgentPaymentMiddleware, getAgentReceivedPayments, getAgentTotalReceived } from "../lib/agent-x402-middleware.js";
import { seedMarketplace } from "./seed-marketplace.js";
import gmailRouter from "./gmail-oauth.js";
import selfclawRouter from "./selfclaw.js";
import { erc8004Service } from "../lib/erc8004.js";
import { generateRegistrationFile } from "../lib/erc8004-config.js";

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static("public"));

app.get("/cockpit", (req: Request, res: Response) => {
  res.sendFile("cockpit.html", { root: "public" });
});

app.get("/skill.md", (req: Request, res: Response) => {
  res.sendFile("skill.md", { root: "public" });
});

app.get("/llms.txt", (req: Request, res: Response) => {
  res.sendFile("llms.txt", { root: "public" });
});

app.get("/developers", (req: Request, res: Response) => {
  res.sendFile("developers.html", { root: "public" });
});

app.get("/pricing", (req: Request, res: Response) => {
  res.sendFile("pricing.html", { root: "public" });
});

app.get("/technology", (req: Request, res: Response) => {
  res.sendFile("technology.html", { root: "public" });
});

app.get("/docs", (req: Request, res: Response) => {
  res.sendFile("docs.html", { root: "public" });
});

app.get("/registry", (req: Request, res: Response) => {
  res.sendFile("registry.html", { root: "public" });
});

app.get("/human/:humanId", (req: Request, res: Response) => {
  res.sendFile("human.html", { root: "public" });
});

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const SKILLS_DIR = join(OPENCLAW_DIR, "workspace", "skills");

let gatewayProcess: ReturnType<typeof spawn> | null = null;

async function logActivity(
  userId: string,
  activityType: string,
  title: string,
  description?: string,
  agentId?: string,
  metadata?: Record<string, any>
) {
  try {
    await db.insert(activityFeed).values({
      userId,
      agentId,
      activityType,
      title,
      description,
      metadata: metadata || {},
    });
  } catch (e) {
    console.error("Failed to log activity:", e);
  }
}
let globalWallet: ReturnType<typeof createCeloWallet> | null = null;

function initializeWallet() {
  if (process.env.CELO_PRIVATE_KEY) {
    globalWallet = createCeloWallet(process.env.CELO_PRIVATE_KEY);
    if (globalWallet) {
      console.log("[payments] Wallet initialized:", globalWallet.address);
    }
  } else {
    console.log("[payments] No CELO_PRIVATE_KEY configured");
  }
}

function getSystemStatus() {
  let nodeVersion = process.version;
  let openclawVersion = "Not installed";
  let openclawInstalled = false;
  let configExists = existsSync(CONFIG_PATH);
  let gatewayRunning = gatewayProcess !== null && !gatewayProcess.killed;

  try {
    openclawVersion = execSync("openclaw --version 2>/dev/null", { encoding: "utf8" }).trim();
    openclawInstalled = true;
  } catch {}

  return { nodeVersion, openclawVersion, openclawInstalled, configExists, gatewayRunning };
}

async function main() {
  try {
    // Use Self.xyz passport authentication (replaces Replit Auth)
    await setupSelfAuth(app);
    registerAuthRoutes(app);
    console.log("[auth] Self.xyz authentication routes registered successfully");
  } catch (error) {
    console.error("[auth] Failed to setup Self.xyz authentication:", error);
    // Add fallback login route that shows an error message
    app.get("/api/login", (req, res) => {
      res.status(503).json({ error: "Authentication not available. Please try again later." });
    });
  }

  app.get("/api/status", (req: Request, res: Response) => {
    res.json(getSystemStatus());
  });

  app.get("/api/gmail/callback", gmailRouter);
  app.use("/api/gmail", isAuthenticated, gmailRouter);
  app.use("/api/selfclaw", selfclawRouter);
  app.use("/api/selfmolt", selfclawRouter); // Legacy redirect support

  app.get("/api/env-check", (req: Request, res: Response) => {
    res.json({
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
      DISCORD_BOT_TOKEN: !!process.env.DISCORD_BOT_TOKEN,
      CELO_PRIVATE_KEY: !!process.env.CELO_PRIVATE_KEY,
    });
  });

  app.post("/api/setup", (req: Request, res: Response) => {
    try {
      mkdirSync(OPENCLAW_DIR, { recursive: true });
      mkdirSync(SKILLS_DIR, { recursive: true });

      if (!existsSync(CONFIG_PATH)) {
        const defaultConfig = {
          version: "1.0",
          gateway: { port: 18789, host: "0.0.0.0" },
          agents: {
            default: {
              provider: "anthropic",
              model: "claude-sonnet-4-20250514",
              fallback: { provider: "openai", model: "gpt-4o" },
            },
          },
          channels: { telegram: { enabled: false }, discord: { enabled: false }, webchat: { enabled: true } },
        };
        writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/config", (req: Request, res: Response) => {
    try {
      if (!existsSync(CONFIG_PATH)) {
        return res.status(404).json({ error: "Config not found" });
      }
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/config", (req: Request, res: Response) => {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/install-openclaw", (req: Request, res: Response) => {
    try {
      const output = execSync("npm install -g openclaw@latest 2>&1", { encoding: "utf8" });
      res.json({ success: true, output });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message, output: error.stdout || "" });
    }
  });

  app.post("/api/gateway/start", (req: Request, res: Response) => {
    if (gatewayProcess && !gatewayProcess.killed) {
      return res.json({ success: false, message: "Gateway already running" });
    }
    try {
      gatewayProcess = spawn("openclaw", ["gateway", "--port", "18789", "--verbose"], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      res.json({ success: true, pid: gatewayProcess.pid });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/gateway/stop", (req: Request, res: Response) => {
    if (gatewayProcess) {
      gatewayProcess.kill();
      gatewayProcess = null;
      res.json({ success: true, message: "Gateway stopped" });
    } else {
      res.json({ success: true, message: "Gateway was not running" });
    }
  });

  app.get("/api/payments/status", async (req: Request, res: Response) => {
    res.json({
      initialized: globalWallet !== null,
      address: globalWallet?.address || null,
      network: CELO_CONFIG.name,
      chainId: CELO_CONFIG.chainId,
    });
  });

  app.get("/api/payments/balance", async (req: Request, res: Response) => {
    if (!globalWallet) {
      return res.json({ error: "Wallet not initialized" });
    }
    const balance = await getWalletBalance(globalWallet);
    res.json(balance);
  });

  app.get("/api/profile", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({
        linkedinUrl: user.linkedinUrl,
        twitterUsername: user.twitterUsername,
        githubUsername: user.githubUsername,
        birthdate: user.birthdate,
        timezone: user.timezone,
        profession: user.profession,
        goals: user.goals,
        communicationStyle: user.communicationStyle,
        profileComplete: user.profileComplete,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/profile", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { linkedinUrl, twitterUsername, githubUsername, birthdate, timezone, profession, goals, communicationStyle } = req.body;
      
      await db.update(users)
        .set({
          linkedinUrl,
          twitterUsername,
          githubUsername,
          birthdate,
          timezone,
          profession,
          goals,
          communicationStyle,
          profileComplete: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      
      res.json({ success: true, message: "Profile updated" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const userAgents = await db.select().from(agents).where(eq(agents.userId, userId)).orderBy(desc(agents.createdAt));
      res.json(userAgents);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { name, description, model, systemPrompt } = req.body;

      const tempId = crypto.randomUUID();
      let walletAddress: string | null = null;
      
      if (process.env.CELO_PRIVATE_KEY) {
        walletAddress = deriveAgentWalletAddress(process.env.CELO_PRIVATE_KEY, tempId);
      }

      // Auto-generate ERC-8004 registration JSON
      const domain = process.env.REPLIT_DOMAINS || "selfclaw.ai";
      const a2aEndpoint = `https://${domain}/api/agents/${tempId}/a2a`;
      const erc8004Json = generateRegistrationFile(
        name,
        description || "",
        walletAddress || undefined,
        a2aEndpoint,
        undefined,
        false
      );

      const newAgent: InsertAgent = {
        id: tempId,
        userId,
        name,
        description,
        status: walletAddress ? "active" : "pending",
        tbaAddress: walletAddress,
        credits: "10.00",
        configJson: {
          provider: model?.includes("claude") ? "anthropic" : "openai",
          model: model || "gpt-4o",
          systemPrompt: systemPrompt || "",
        },
        erc8004RegistrationJson: erc8004Json,
      };

      const [agent] = await db.insert(agents).values(newAgent).returning();
      
      await logActivity(
        userId,
        "agent_created",
        `Created agent "${name}"`,
        description || undefined,
        agent.id,
        { model: model || "gpt-4o" }
      );
      
      res.json(agent);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      res.json(agent);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/agents/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { name, description, systemPrompt, model } = req.body;
      
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const existingConfig = (agent.configJson as any) || {};
      const updatedConfig = {
        ...existingConfig,
        model: model || existingConfig.model || "gpt-4o",
        systemPrompt: systemPrompt !== undefined ? systemPrompt : existingConfig.systemPrompt,
        provider: model?.includes("claude") ? "anthropic" : "openai",
      };

      const [updatedAgent] = await db.update(agents)
        .set({
          name: name || agent.name,
          description: description !== undefined ? description : agent.description,
          configJson: updatedConfig,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, req.params.id))
        .returning();

      res.json(updatedAgent);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id/payments", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const agentPayments = await db.select().from(payments).where(eq(payments.agentId, agent.id)).orderBy(desc(payments.createdAt));
      res.json(agentPayments);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id/registration", isAuthenticated, async (req: any, res: Response) => {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const registrationFile = {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: agent.name,
        description: agent.description || "",
        services: [
          { name: "web", endpoint: `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/agents/${agent.id}` },
          { name: "x402", endpoint: `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/api/agents/${agent.id}/x402/pay` },
          { name: "service", endpoint: `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/api/agents/${agent.id}/service` },
        ],
        wallet: agent.tbaAddress || agent.ownerAddress,
        network: "celo",
        chainId: CELO_CONFIG.chainId,
      };

      res.json(registrationFile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ERC-8004 Endpoints
  app.get("/api/agents/:id/erc8004", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const config = erc8004Service.getConfig();
      res.json({
        tokenId: agent.erc8004TokenId,
        minted: agent.erc8004Minted || false,
        registrationJson: agent.erc8004RegistrationJson,
        contractsDeployed: config.isDeployed,
        explorerUrl: agent.erc8004TokenId ? erc8004Service.getExplorerUrl(agent.erc8004TokenId) : null,
        config: {
          chainId: config.chainId,
          identityRegistry: config.identityRegistry,
          reputationRegistry: config.reputationRegistry,
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/erc8004/generate", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const domain = process.env.REPLIT_DOMAINS || "selfclaw.ai";
      const a2aEndpoint = `https://${domain}/api/agents/${agent.id}/a2a`;
      
      const registrationJson = generateRegistrationFile(
        agent.name,
        agent.description || "",
        agent.tbaAddress || undefined,
        a2aEndpoint,
        undefined,
        false
      );

      await db.update(agents)
        .set({ 
          erc8004RegistrationJson: registrationJson,
          updatedAt: new Date() 
        })
        .where(eq(agents.id, agent.id));

      res.json({ success: true, registrationJson });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/erc8004/mint", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!erc8004Service.isReady()) {
        return res.status(400).json({ 
          error: "ERC-8004 contracts not deployed yet",
          message: "Contracts are scheduled for deployment. Check back soon!"
        });
      }

      if (agent.erc8004Minted) {
        return res.status(400).json({ 
          error: "Already minted",
          tokenId: agent.erc8004TokenId
        });
      }

      if (!agent.erc8004RegistrationJson) {
        return res.status(400).json({ error: "Generate registration file first" });
      }

      const agentURI = `https://${process.env.REPLIT_DOMAINS || "selfclaw.ai"}/api/agents/${agent.id}/registration`;
      
      const result = await erc8004Service.registerAgent(agentURI);
      
      if (!result) {
        return res.status(500).json({ error: "Minting failed" });
      }

      await db.update(agents)
        .set({ 
          erc8004TokenId: result.tokenId,
          erc8004Minted: true,
          updatedAt: new Date() 
        })
        .where(eq(agents.id, agent.id));

      res.json({ 
        success: true, 
        tokenId: result.tokenId,
        txHash: result.txHash,
        explorerUrl: erc8004Service.getTxExplorerUrl(result.txHash)
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/erc8004/config", (req: Request, res: Response) => {
    const config = erc8004Service.getConfig();
    res.json({
      isDeployed: config.isDeployed,
      chainId: config.chainId,
      identityRegistry: config.identityRegistry,
      reputationRegistry: config.reputationRegistry,
      explorer: config.explorer,
    });
  });

  app.get("/api/agents/:id/tokens", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const tokens = await db.select().from(agentTokens).where(eq(agentTokens.agentId, agent.id));
      res.json({ tokens });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id/liquidity-positions", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const positions = await db.select().from(liquidityPositions)
        .where(and(eq(liquidityPositions.agentId, agent.id), eq(liquidityPositions.active, true)));
      
      res.json({ 
        positions: positions.map(pos => ({
          positionId: pos.positionId,
          token0Symbol: pos.token0Symbol,
          token1Symbol: pos.token1Symbol,
          token0Address: pos.token0Address,
          token1Address: pos.token1Address,
          feeTier: (pos.feeTier / 10000).toFixed(2),
          liquidity: pos.liquidity,
          createdAt: pos.createdAt,
        }))
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id/wallet", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!process.env.CELO_PRIVATE_KEY || !agent.tbaAddress) {
        return res.json({ 
          address: null, 
          credits: agent.credits,
          walletEnabled: false 
        });
      }

      const balance = await getAgentWalletBalance(process.env.CELO_PRIVATE_KEY, agent.id);
      res.json({
        ...balance,
        credits: agent.credits,
        walletEnabled: true
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/credits/add", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { amount } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const currentCredits = parseFloat(agent.credits || "0");
      const addAmount = parseFloat(amount);
      const newCredits = (currentCredits + addAmount).toFixed(6);

      await db.update(agents)
        .set({ credits: newCredits, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      res.json({ success: true, credits: newCredits });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id/secrets", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const secrets = await db.select({
        id: agentSecrets.id,
        serviceName: agentSecrets.serviceName,
        hasKey: sql<boolean>`true`,
        isActive: agentSecrets.isActive,
        createdAt: agentSecrets.createdAt
      }).from(agentSecrets).where(eq(agentSecrets.agentId, agent.id));

      res.json(secrets);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/secrets", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { serviceName, apiKey, baseUrl } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const existing = await db.select().from(agentSecrets)
        .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.serviceName, serviceName)));

      if (existing.length > 0) {
        await db.update(agentSecrets)
          .set({ apiKey, baseUrl, isActive: true, updatedAt: new Date() })
          .where(eq(agentSecrets.id, existing[0].id));
        return res.json({ success: true, updated: true });
      }

      await db.insert(agentSecrets).values({
        agentId: agent.id,
        serviceName,
        apiKey,
        baseUrl
      });

      res.json({ success: true, created: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/agents/:id/secrets/:serviceName", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      await db.delete(agentSecrets)
        .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.serviceName, req.params.serviceName)));

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Models status endpoint - shows which models are available for an agent
  app.get("/api/agents/:id/models", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Get agent's configured API keys
      const secrets = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, agent.id));
      const configuredKeys = secrets.map(s => s.serviceName);

      // Define available models based on configured keys
      const models = [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", available: configuredKeys.includes("OPENAI_API_KEY") || !!process.env.OPENAI_API_KEY },
        { id: "gpt-5.2", name: "GPT-5.2", provider: "openai", available: configuredKeys.includes("OPENAI_API_KEY") || !!process.env.OPENAI_API_KEY },
        { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", available: configuredKeys.includes("OPENAI_API_KEY") || !!process.env.OPENAI_API_KEY },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai", available: configuredKeys.includes("OPENAI_API_KEY") || !!process.env.OPENAI_API_KEY },
        { id: "o3", name: "o3", provider: "openai", available: configuredKeys.includes("OPENAI_API_KEY") || !!process.env.OPENAI_API_KEY },
        { id: "o4-mini", name: "o4-mini", provider: "openai", available: configuredKeys.includes("OPENAI_API_KEY") || !!process.env.OPENAI_API_KEY },
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", available: configuredKeys.includes("ANTHROPIC_API_KEY") || !!process.env.ANTHROPIC_API_KEY },
        { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", available: configuredKeys.includes("ANTHROPIC_API_KEY") || !!process.env.ANTHROPIC_API_KEY },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", available: configuredKeys.includes("ANTHROPIC_API_KEY") || !!process.env.ANTHROPIC_API_KEY },
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic", available: configuredKeys.includes("ANTHROPIC_API_KEY") || !!process.env.ANTHROPIC_API_KEY },
        { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", provider: "moonshot", available: configuredKeys.includes("MOONSHOT_API_KEY") },
        { id: "minimax-01", name: "MiniMax-01", provider: "minimax", available: configuredKeys.includes("MINIMAX_API_KEY") },
        { id: "llama-4-maverick", name: "Llama 4 Maverick", provider: "openrouter", available: configuredKeys.includes("OPENROUTER_API_KEY") },
        { id: "deepseek-r1", name: "DeepSeek R1", provider: "deepseek", available: configuredKeys.includes("DEEPSEEK_API_KEY") },
        { id: "qwen3-235b", name: "Qwen3 235B", provider: "openrouter", available: configuredKeys.includes("OPENROUTER_API_KEY") },
      ];

      const agentConfig = agent.configJson as { model?: string } | null;
      res.json({
        currentModel: agentConfig?.model || "gpt-4o",
        models,
        configuredProviders: [...new Set(secrets.map(s => s.serviceName.replace("_API_KEY", "").toLowerCase()))]
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Skills CRUD endpoints
  app.get("/api/agents/:id/skills", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const skills = await db.select().from(agentSkills)
        .where(eq(agentSkills.agentId, agent.id))
        .orderBy(desc(agentSkills.createdAt));

      res.json(skills);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/skills", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { name, description, category, priceCredits, endpoint } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!name) {
        return res.status(400).json({ error: "Skill name is required" });
      }

      const [skill] = await db.insert(agentSkills).values({
        agentId: agent.id,
        name,
        description,
        category: category || "general",
        priceCredits: priceCredits || "0.01",
        endpoint
      }).returning();

      res.json(skill);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/agents/:id/skills/:skillId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { name, description, category, priceCredits, endpoint, isActive } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const [skill] = await db.select().from(agentSkills)
        .where(and(eq(agentSkills.id, req.params.skillId), eq(agentSkills.agentId, agent.id)));

      if (!skill) {
        return res.status(404).json({ error: "Skill not found" });
      }

      const [updated] = await db.update(agentSkills)
        .set({ 
          name: name ?? skill.name,
          description: description ?? skill.description,
          category: category ?? skill.category,
          priceCredits: priceCredits ?? skill.priceCredits,
          endpoint: endpoint ?? skill.endpoint,
          isActive: isActive ?? skill.isActive,
          updatedAt: new Date()
        })
        .where(eq(agentSkills.id, req.params.skillId))
        .returning();

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/agents/:id/skills/:skillId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      await db.delete(agentSkills)
        .where(and(eq(agentSkills.id, req.params.skillId), eq(agentSkills.agentId, agent.id)));

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Public skills marketplace discovery
  app.get("/api/marketplace/skills", async (req: Request, res: Response) => {
    try {
      const { category, search } = req.query;
      
      let query = db.select({
        id: agentSkills.id,
        name: agentSkills.name,
        description: agentSkills.description,
        category: agentSkills.category,
        priceCredits: agentSkills.priceCredits,
        usageCount: agentSkills.usageCount,
        agentId: agentSkills.agentId,
        agentName: agents.name,
        agentWallet: agents.tbaAddress
      })
      .from(agentSkills)
      .innerJoin(agents, eq(agentSkills.agentId, agents.id))
      .where(eq(agentSkills.isActive, true));

      const skills = await query.orderBy(desc(agentSkills.usageCount));
      
      let filtered = skills;
      if (category && category !== "all") {
        filtered = filtered.filter(s => s.category === category);
      }
      if (search) {
        const term = (search as string).toLowerCase();
        filtered = filtered.filter(s => 
          s.name.toLowerCase().includes(term) || 
          (s.description?.toLowerCase().includes(term))
        );
      }

      res.json(filtered);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Execute a skill (pay and invoke)
  app.post("/api/marketplace/skills/:skillId/execute", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { agentId, input } = req.body;
      
      // Get the calling agent
      const [callingAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!callingAgent || callingAgent.userId !== userId) {
        return res.status(404).json({ error: "Your agent not found" });
      }

      // Get the skill
      const [skill] = await db.select().from(agentSkills).where(eq(agentSkills.id, req.params.skillId));
      if (!skill || !skill.isActive) {
        return res.status(404).json({ error: "Skill not found or inactive" });
      }

      // Get the target agent
      const [targetAgent] = await db.select().from(agents).where(eq(agents.id, skill.agentId));
      if (!targetAgent) {
        return res.status(404).json({ error: "Skill provider agent not found" });
      }

      // Check credits
      const price = parseFloat(skill.priceCredits || "0.01");
      const callerCredits = parseFloat(callingAgent.credits || "0");
      
      if (callerCredits < price) {
        return res.status(402).json({ 
          error: "Insufficient credits",
          required: price,
          available: callerCredits
        });
      }

      // Deduct from caller, add to target (minus platform fee)
      const platformFee = price * (PLATFORM_FEE_PERCENT / 100);
      const targetEarns = price - platformFee;

      await db.update(agents)
        .set({ credits: (callerCredits - price).toFixed(6), updatedAt: new Date() })
        .where(eq(agents.id, callingAgent.id));

      const targetCredits = parseFloat(targetAgent.credits || "0");
      await db.update(agents)
        .set({ credits: (targetCredits + targetEarns).toFixed(6), updatedAt: new Date() })
        .where(eq(agents.id, targetAgent.id));

      // Record payments
      await db.insert(payments).values({
        agentId: callingAgent.id,
        direction: "outbound",
        amount: price.toString(),
        token: "CREDITS",
        network: "platform",
        status: "confirmed",
        endpoint: `/api/marketplace/skills/${skill.id}`
      });

      await db.insert(payments).values({
        agentId: targetAgent.id,
        direction: "inbound",
        amount: targetEarns.toString(),
        token: "CREDITS",
        network: "platform",
        status: "confirmed",
        endpoint: `/api/marketplace/skills/${skill.id}`
      });

      // Update skill usage stats
      await db.update(agentSkills)
        .set({ 
          usageCount: (skill.usageCount || 0) + 1,
          totalEarned: (parseFloat(skill.totalEarned || "0") + targetEarns).toFixed(6),
          updatedAt: new Date()
        })
        .where(eq(agentSkills.id, skill.id));

      res.json({
        success: true,
        skill: skill.name,
        paid: price,
        platformFee,
        message: `Skill "${skill.name}" executed. Provider earned ${targetEarns} credits.`
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Agent analytics endpoint
  app.get("/api/agents/:id/analytics", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Get all payments
      const agentPayments = await db.select().from(payments)
        .where(eq(payments.agentId, agent.id))
        .orderBy(desc(payments.createdAt));

      // Calculate totals
      let totalSpent = 0;
      let totalEarned = 0;
      let aiCosts = 0;
      let skillEarnings = 0;

      agentPayments.forEach(p => {
        const amount = parseFloat(p.amount || "0");
        if (p.direction === "outbound") {
          totalSpent += amount;
          if (p.endpoint?.includes("/ai/chat")) {
            aiCosts += amount;
          }
        } else if (p.direction === "inbound") {
          totalEarned += amount;
          if (p.endpoint?.includes("/marketplace/skills")) {
            skillEarnings += amount;
          }
        }
      });

      // Get skills stats
      const skills = await db.select().from(agentSkills)
        .where(eq(agentSkills.agentId, agent.id));

      const skillsStats = {
        total: skills.length,
        active: skills.filter(s => s.isActive).length,
        totalUsage: skills.reduce((sum, s) => sum + (s.usageCount || 0), 0)
      };

      res.json({
        currentCredits: parseFloat(agent.credits || "0"),
        totals: {
          spent: totalSpent.toFixed(4),
          earned: totalEarned.toFixed(4),
          profit: (totalEarned - totalSpent).toFixed(4)
        },
        breakdown: {
          aiCosts: aiCosts.toFixed(4),
          skillEarnings: skillEarnings.toFixed(4)
        },
        skills: skillsStats,
        recentPayments: agentPayments.slice(0, 10)
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get agent conversation history
  app.get("/api/agents/:id/conversation", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const agentId = req.params.id;
      
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Get or create conversation for this agent
      let [conversation] = await db.select().from(conversations).where(eq(conversations.agentId, agentId)).limit(1);
      
      if (!conversation) {
        const [newConversation] = await db.insert(conversations).values({
          agentId,
          title: `Chat with ${agent.name}`
        }).returning();
        conversation = newConversation;
      }

      // Get messages for this conversation
      const conversationMessages = await db.select().from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(messages.createdAt);

      res.json({
        conversationId: conversation.id,
        messages: conversationMessages.map(m => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt
        }))
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add message to agent conversation
  app.post("/api/agents/:id/conversation/message", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const agentId = req.params.id;
      const { role, content } = req.body;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Get or create conversation
      let [conversation] = await db.select().from(conversations).where(eq(conversations.agentId, agentId)).limit(1);
      
      if (!conversation) {
        const [newConversation] = await db.insert(conversations).values({
          agentId,
          title: `Chat with ${agent.name}`
        }).returning();
        conversation = newConversation;
      }

      // Add message
      const [message] = await db.insert(messages).values({
        conversationId: conversation.id,
        role,
        content
      }).returning();

      res.json({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Clear agent conversation history
  app.delete("/api/agents/:id/conversation", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const agentId = req.params.id;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Delete conversation (messages cascade)
      await db.delete(conversations).where(eq(conversations.agentId, agentId));

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/ai/chat", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { messages: chatMessages, model } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const currentCredits = parseFloat(agent.credits || "0");
      const costPerRequest = 0.01;

      if (currentCredits < costPerRequest) {
        return res.status(402).json({ 
          error: "Insufficient credits",
          required: costPerRequest,
          available: currentCredits
        });
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      let userContext = "";
      if (user) {
        const contextParts = [];
        if (user.firstName || user.lastName) contextParts.push(`Name: ${[user.firstName, user.lastName].filter(Boolean).join(' ')}`);
        if (user.profession) contextParts.push(`Profession: ${user.profession}`);
        if (user.goals) contextParts.push(`Goals: ${user.goals}`);
        if (user.communicationStyle) contextParts.push(`Preferred communication style: ${user.communicationStyle}`);
        if (user.timezone) contextParts.push(`Timezone: ${user.timezone}`);
        if (user.birthdate) {
          const age = Math.floor((Date.now() - new Date(user.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
          contextParts.push(`Age: ${age}`);
        }
        if (contextParts.length > 0) {
          userContext = `\n\nUser context:\n${contextParts.join('\n')}`;
        }
      }

      const enhancedMessages = chatMessages.map((m: any, i: number) => {
        if (i === 0 && m.role === 'system' && userContext) {
          return { ...m, content: m.content + userContext };
        }
        return m;
      });
      
      const hasSystemMessage = chatMessages.length > 0 && chatMessages[0].role === 'system';
      const finalMessages = hasSystemMessage ? enhancedMessages : 
        userContext ? [{ role: 'system', content: `You are a helpful AI assistant.${userContext}` }, ...chatMessages] : chatMessages;

      let response;
      let provider = "unknown";

      const agentOpenAISecret = await db.select().from(agentSecrets)
        .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.serviceName, "openai"), eq(agentSecrets.isActive, true)));

      const agentAnthropicSecret = await db.select().from(agentSecrets)
        .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.serviceName, "anthropic"), eq(agentSecrets.isActive, true)));

      const selectedModel = model || "gpt-4o";
      const isClaude = selectedModel.includes("claude");

      if (isClaude && agentAnthropicSecret.length > 0) {
        const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": agentAnthropicSecret[0].apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: selectedModel,
            max_tokens: 1024,
            messages: finalMessages
          })
        });
        response = await anthropicResponse.json();
        provider = "agent-anthropic";
      } else if (!isClaude && agentOpenAISecret.length > 0) {
        const openai = new OpenAI({
          apiKey: agentOpenAISecret[0].apiKey,
          baseURL: agentOpenAISecret[0].baseUrl || undefined
        });
        const completion = await openai.chat.completions.create({
          model: selectedModel,
          messages: finalMessages
        });
        response = completion;
        provider = "agent-openai";
      } else if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
        const openai = new OpenAI({
          apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
          baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
        });
        const completion = await openai.chat.completions.create({
          model: selectedModel.includes("claude") ? "gpt-4o" : selectedModel,
          messages: finalMessages
        });
        response = completion;
        provider = "replit-integration";
      } else if (process.env.OPENAI_API_KEY) {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: selectedModel.includes("claude") ? "gpt-4o" : selectedModel,
          messages: finalMessages
        });
        response = completion;
        provider = "platform-openai";
      } else if (process.env.ANTHROPIC_API_KEY && selectedModel.includes("claude")) {
        const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: selectedModel,
            max_tokens: 1024,
            messages: finalMessages
          })
        });
        response = await anthropicResponse.json();
        provider = "platform-anthropic";
      } else {
        return res.status(503).json({ error: "No AI provider configured. Add your API key or use platform credits." });
      }

      const newCredits = (currentCredits - costPerRequest).toFixed(6);
      await db.update(agents)
        .set({ credits: newCredits, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const payment: InsertPayment = {
        agentId: agent.id,
        direction: "outbound",
        amount: costPerRequest.toString(),
        token: "CREDITS",
        network: "platform",
        status: "confirmed",
        endpoint: "/api/ai/chat"
      };
      await db.insert(payments).values(payment);

      res.json({
        response,
        provider,
        creditsUsed: costPerRequest,
        creditsRemaining: newCredits
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/platform/pricing", (req: Request, res: Response) => {
    res.json({
      credits: {
        starterPack: { amount: 100, priceUsd: 10 },
        proPack: { amount: 500, priceUsd: 40 },
        enterprisePack: { amount: 2000, priceUsd: 150 }
      },
      aiCosts: {
        claudeSonnet: 0.01,
        claudeOpus: 0.05,
        gpt4o: 0.02,
        gpt4oMini: 0.005
      },
      platformFee: PLATFORM_FEE_PERCENT,
      newAgentBonus: 10
    });
  });

  app.post("/api/agents/:id/x402/pay", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { url, maxPayment } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!process.env.CELO_PRIVATE_KEY) {
        return res.status(503).json({ error: "Platform wallet not configured" });
      }

      if (!agent.tbaAddress) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const client = createAgentX402Client(process.env.CELO_PRIVATE_KEY, agent.id, {
        maxPayment: maxPayment || 1.0,
        autoApprove: true
      });

      const response = await client.fetch(url, req.body.options || {});
      const responseData = await response.text();

      const payment: InsertPayment = {
        agentId: agent.id,
        direction: "outbound",
        amount: client.getTotalSpent(),
        token: "USDC",
        network: "celo",
        status: response.ok ? "confirmed" : "failed",
        endpoint: url
      };
      await db.insert(payments).values(payment);

      res.json({
        status: response.status,
        ok: response.ok,
        data: responseData,
        paymentHistory: client.getPaymentHistory(),
        totalSpent: client.getTotalSpent()
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/agents/:id/x402/received", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));

      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const receivedPayments = getAgentReceivedPayments(agent.id);
      const totals = getAgentTotalReceived(agent.id);

      res.json({
        payments: receivedPayments,
        totals,
        platformFeePercent: PLATFORM_FEE_PERCENT
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const agentPaymentMiddleware = createAgentPaymentMiddleware({
    getAgentRecipient: (agentId: string) => {
      if (!process.env.CELO_PRIVATE_KEY) return null;
      return deriveAgentWalletAddress(process.env.CELO_PRIVATE_KEY, agentId);
    },
    defaultPrice: "0.01",
    token: "USDC",
    network: "celo"
  });

  app.post("/api/agents/:id/service", agentPaymentMiddleware("0.01"), async (req: any, res: Response) => {
    res.json({
      success: true,
      message: "Payment accepted",
      payment: req.payment,
      platformFee: PLATFORM_FEE_PERCENT + "%"
    });
  });

  // Goals CRUD
  app.get("/api/agents/:id/goals", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const goals = await db.select().from(agentGoals).where(eq(agentGoals.agentId, agent.id)).orderBy(desc(agentGoals.priority));
      res.json(goals);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/goals", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { goal, priority } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const [newGoal] = await db.insert(agentGoals).values({
        agentId: agent.id,
        goal,
        priority: priority || 1
      }).returning();
      res.json(newGoal);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/agents/:id/goals/:goalId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { goal, priority, status, progress } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const updates: any = {};
      if (goal !== undefined) updates.goal = goal;
      if (priority !== undefined) updates.priority = priority;
      if (status !== undefined) {
        updates.status = status;
        if (status === "completed") updates.completedAt = new Date();
      }
      if (progress !== undefined) updates.progress = progress;
      const [updated] = await db.update(agentGoals).set(updates).where(and(eq(agentGoals.id, req.params.goalId), eq(agentGoals.agentId, agent.id))).returning();
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/agents/:id/goals/:goalId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      await db.delete(agentGoals).where(and(eq(agentGoals.id, req.params.goalId), eq(agentGoals.agentId, agent.id)));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Scheduled Tasks CRUD
  app.get("/api/agents/:id/tasks", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const tasks = await db.select().from(agentScheduledTasks).where(eq(agentScheduledTasks.agentId, agent.id)).orderBy(desc(agentScheduledTasks.createdAt));
      res.json(tasks);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/tasks", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { name, description, cronExpression, taskType, taskData } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const [task] = await db.insert(agentScheduledTasks).values({
        agentId: agent.id,
        name,
        description,
        cronExpression: cronExpression || "0 * * * *",
        taskType: taskType || "goal_check",
        taskData
      }).returning();
      res.json(task);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/agents/:id/tasks/:taskId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { name, description, cronExpression, taskType, taskData, isActive } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (cronExpression !== undefined) updates.cronExpression = cronExpression;
      if (taskType !== undefined) updates.taskType = taskType;
      if (taskData !== undefined) updates.taskData = taskData;
      if (isActive !== undefined) updates.isActive = isActive;
      const [updated] = await db.update(agentScheduledTasks).set(updates).where(and(eq(agentScheduledTasks.id, req.params.taskId), eq(agentScheduledTasks.agentId, agent.id))).returning();
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/agents/:id/tasks/:taskId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      await db.delete(agentScheduledTasks).where(and(eq(agentScheduledTasks.id, req.params.taskId), eq(agentScheduledTasks.agentId, agent.id)));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Memory endpoints
  app.get("/api/agents/:id/memory", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const memories = await db.select().from(agentMemory).where(eq(agentMemory.agentId, agent.id)).orderBy(desc(agentMemory.importance)).limit(50);
      res.json(memories);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agents/:id/memory", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { content, importance, memoryType } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const [memory] = await db.insert(agentMemory).values({
        agentId: agent.id,
        content,
        importance: importance || 5,
        memoryType: memoryType || "fact"
      }).returning();
      res.json(memory);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/agents/:id/memory/:memoryId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      await db.delete(agentMemory).where(and(eq(agentMemory.id, req.params.memoryId), eq(agentMemory.agentId, agent.id)));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Tool executions log
  app.get("/api/agents/:id/tool-executions", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const executions = await db.select().from(agentToolExecutions).where(eq(agentToolExecutions.agentId, agent.id)).orderBy(desc(agentToolExecutions.createdAt)).limit(50);
      res.json(executions);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Enhanced AI chat endpoint using agent runtime
  app.post("/api/agents/:id/ai/chat", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { message, conversationHistory } = req.body;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const result = await runAgentTurn(agent.id, message, conversationHistory || []);
      res.json({
        response: result.response,
        toolsUsed: result.toolsUsed,
        creditsCost: result.creditsCost,
        remainingCredits: parseFloat((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]?.credits || "0")
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Agent context endpoint (for debugging/display)
  app.get("/api/agents/:id/context", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
      if (!agent || agent.userId !== userId) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const context = await buildAgentContext(agent.id);
      res.json({
        ...context,
        availableTools: AVAILABLE_TOOLS.map(t => ({ name: t.name, description: t.description }))
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/activity", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      
      const activities = await db.select({
        id: activityFeed.id,
        agentId: activityFeed.agentId,
        activityType: activityFeed.activityType,
        title: activityFeed.title,
        description: activityFeed.description,
        metadata: activityFeed.metadata,
        createdAt: activityFeed.createdAt,
        agentName: agents.name
      })
        .from(activityFeed)
        .leftJoin(agents, eq(activityFeed.agentId, agents.id))
        .where(eq(activityFeed.userId, userId))
        .orderBy(desc(activityFeed.createdAt))
        .limit(limit);
      
      res.json(activities);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║       ClawPit Agentic Cockpit on port ${PORT}                ║
╚════════════════════════════════════════════════════════════╝
`);
    console.log(`Access the control panel at: http://0.0.0.0:${PORT}`);
    console.log("System Status:", getSystemStatus());
    initializeWallet();
    
    await seedMarketplace();
    
    startScheduler(60000);
  });
}

main().catch(console.error);
