import express, { type Request, type Response } from "express";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";
import { setupAuth, isAuthenticated, registerAuthRoutes } from "./replit_integrations/auth/index.js";
import { db } from "./db.js";
import { agents, payments, users, type InsertAgent, type InsertPayment } from "../shared/schema.js";
import { eq, desc, sql } from "drizzle-orm";
import { createCeloWallet, getWalletBalance, CELO_CONFIG } from "../lib/wallet.js";
import { deriveAgentWalletAddress, getAgentWalletBalance, PLATFORM_FEE_PERCENT, createAgentWallet } from "../lib/agent-wallet.js";
import { createAgentX402Client } from "../lib/agent-x402-client.js";
import { createAgentPaymentMiddleware, getAgentReceivedPayments, getAgentTotalReceived } from "../lib/agent-x402-middleware.js";

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static("public"));

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const SKILLS_DIR = join(OPENCLAW_DIR, "workspace", "skills");

let gatewayProcess: ReturnType<typeof spawn> | null = null;
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
  await setupAuth(app);
  registerAuthRoutes(app);

  app.get("/api/status", (req: Request, res: Response) => {
    res.json(getSystemStatus());
  });

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
      const { name, description } = req.body;

      const tempId = crypto.randomUUID();
      let walletAddress: string | null = null;
      
      if (process.env.CELO_PRIVATE_KEY) {
        walletAddress = deriveAgentWalletAddress(process.env.CELO_PRIVATE_KEY, tempId);
      }

      const newAgent: InsertAgent = {
        id: tempId,
        userId,
        name,
        description,
        status: walletAddress ? "active" : "pending",
        tbaAddress: walletAddress,
        credits: "10.00",
        configJson: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      };

      const [agent] = await db.insert(agents).values(newAgent).returning();
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

  app.post("/api/agents/:id/ai/chat", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { messages, model } = req.body;
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

      const selectedModel = model || "claude-sonnet-4-20250514";
      let response;

      if (process.env.ANTHROPIC_API_KEY && selectedModel.includes("claude")) {
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
            messages: messages
          })
        });
        response = await anthropicResponse.json();
      } else if (process.env.OPENAI_API_KEY) {
        const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: messages
          })
        });
        response = await openaiResponse.json();
      } else {
        return res.status(503).json({ error: "No AI provider configured" });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║     OpenClaw Control Panel running on port ${PORT}           ║
╚════════════════════════════════════════════════════════════╝
`);
    console.log(`Access the control panel at: http://0.0.0.0:${PORT}`);
    console.log("System Status:", getSystemStatus());
    initializeWallet();
  });
}

main().catch(console.error);
