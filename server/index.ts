import express, { type Request, type Response } from "express";
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";
import { setupAuth, isAuthenticated, registerAuthRoutes } from "./replit_integrations/auth/index.js";
import { db } from "./db.js";
import { agents, payments, reputations, users, type InsertAgent, type InsertPayment } from "../shared/schema.js";
import { eq, desc } from "drizzle-orm";
import { createCeloWallet, getWalletBalance, CELO_CONFIG } from "../lib/wallet.js";

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

      const newAgent: InsertAgent = {
        userId,
        name,
        description,
        status: "pending",
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
          { name: "x402", endpoint: `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/api/agents/${agent.id}/pay` },
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
