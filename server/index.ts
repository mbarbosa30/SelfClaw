import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { setupSelfAuth, isAuthenticated, registerAuthRoutes } from "./self-auth.js";
import { db, pool } from "./db.js";
import { verifiedBots } from "../shared/schema.js";
import { sql } from "drizzle-orm";
import selfclawRouter from "./selfclaw.js";
import adminRouter, { runAutoClaimPendingBridges } from "./admin.js";
import hostingerRouter from "./hostinger-routes.js";
import sandboxRouter, { initOpenClawGateway } from "./sandbox-agent.js";
import { hostedAgentsRouter, startAgentWorker } from "./hosted-agents.js";
import { skillMarketRouter } from "./skill-market.js";
import { erc8004Service } from "../lib/erc8004.js";

process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] Unhandled promise rejection:', reason?.message || reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('[FATAL] Uncaught exception:', error.message);
  if (error.message.includes('EADDRINUSE')) process.exit(1);
});

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '10mb' }));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.get("/skill.md", (req: Request, res: Response) => {
  res.sendFile("skill.md", { root: "public" });
});

function sendHtml(res: Response, file: string, extraHeaders?: Record<string, string>) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.sendFile(file, { root: "public" });
}

app.get("/verify", (_req: Request, res: Response) => sendHtml(res, "verify.html"));
app.get("/economy", (_req: Request, res: Response) => sendHtml(res, "token.html"));
app.get("/token", (_req: Request, res: Response) => res.redirect(301, "/economy"));
app.get("/developers", (_req: Request, res: Response) => sendHtml(res, "developers.html"));
app.get("/whitepaper", (_req: Request, res: Response) => sendHtml(res, "whitepaper.html"));
app.get("/manifesto", (_req: Request, res: Response) => sendHtml(res, "manifesto.html"));
app.get("/dashboard", (_req: Request, res: Response) => sendHtml(res, "dashboard.html"));
app.get("/registry", (_req: Request, res: Response) => sendHtml(res, "registry.html"));
app.get("/agents", (_req: Request, res: Response) => sendHtml(res, "registry.html"));
app.get("/agent/:name", (_req: Request, res: Response) => sendHtml(res, "agent.html"));
app.get("/human/:humanId", (_req: Request, res: Response) => sendHtml(res, "human.html"));
app.get("/admin", (_req: Request, res: Response) => sendHtml(res, "admin.html", { "X-Robots-Tag": "noindex, nofollow" }));
app.get("/sandbox", (_req: Request, res: Response) => sendHtml(res, "sandbox.html", { "X-Robots-Tag": "noindex, nofollow" }));
app.get("/explorer", (_req: Request, res: Response) => sendHtml(res, "explorer.html"));
app.get("/create-agent", (_req: Request, res: Response) => sendHtml(res, "create-agent.html"));
app.get("/my-agents", (_req: Request, res: Response) => sendHtml(res, "my-agents.html"));
app.get("/create-assistant", (_req: Request, res: Response) => sendHtml(res, "create-assistant.html"));
app.get("/skill-market", (_req: Request, res: Response) => sendHtml(res, "skill-market.html"));
app.get("/guide", (_req: Request, res: Response) => sendHtml(res, "guide.html"));

app.get("/how-it-works", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/pricing", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/technology", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/vision", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/docs", (_req: Request, res: Response) => res.redirect(301, "/developers"));

async function main() {
  try {
    await setupSelfAuth(app);
    registerAuthRoutes(app);
    console.log("[auth] Self.xyz authentication routes registered");
  } catch (error) {
    console.error("[auth] Failed to setup Self.xyz authentication:", error);
    app.get("/api/login", (req, res) => {
      res.status(503).json({ error: "Authentication not available. Please try again later." });
    });
  }

  app.use("/api/selfclaw", selfclawRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/admin/sandbox", sandboxRouter);
  app.use("/api/selfclaw", hostedAgentsRouter);
  app.use("/api/selfclaw", skillMarketRouter);
  app.use("/api/hostinger", hostingerRouter);

  app.get("/.well-known/agent-registration.json", async (req: Request, res: Response) => {
    try {
      const minted = await db.select()
        .from(verifiedBots)
        .where(sql`(${verifiedBots.metadata}->>'erc8004Minted')::boolean = true`);

      const rawDomains = process.env.REPLIT_DOMAINS || "selfclaw.ai";
      const domainParts = rawDomains.split(",").map(d => d.trim()).filter(Boolean);
      const domain = domainParts.find(d => d.endsWith(".ai") || d.endsWith(".com") || d.endsWith(".app")) || domainParts[domainParts.length - 1] || rawDomains;
      const registrations = minted.map((a: any) => {
        const meta = (a.metadata as Record<string, any>) || {};
        return {
          agentRegistry: `eip155:42220:${erc8004Service.getConfig().identityRegistry}`,
          agentId: meta.erc8004TokenId,
          agentURI: `https://${domain}/api/selfclaw/v1/agent/${a.publicKey || a.deviceId}/registration.json`,
        };
      }).filter((r: any) => r.agentId);

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json({ registrations });
    } catch (error: any) {
      console.error("[well-known] agent-registration error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/erc8004/config", (req: Request, res: Response) => {
    const config = erc8004Service.getConfig();
    res.json({
      isDeployed: config.isDeployed,
      chainId: config.chainId,
      identityRegistry: config.identityRegistry,
      resolver: config.resolver,
      explorer: config.explorer,
    });
  });

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
    } catch (err: any) {
      res.status(503).json({ status: "unhealthy", error: err.message });
    }
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║       SelfClaw Agent Verification Registry                ║
║       Running on port ${PORT}                                 ║
╚════════════════════════════════════════════════════════════╝
`);
    console.log(`Access at: http://0.0.0.0:${PORT}`);

    setTimeout(() => {
      runAutoClaimPendingBridges().catch(err =>
        console.error('[auto-bridge] Startup auto-claim error:', err.message)
      );
    }, 5000);

    setTimeout(() => {
      initOpenClawGateway().catch(err =>
        console.log('[sandbox] OpenClaw init deferred:', err.message)
      );
    }, 3000);

    setTimeout(() => {
      startAgentWorker();
      console.log('[hosted-agents] Agent worker started');
    }, 8000);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  function gracefulShutdown(signal: string) {
    console.log(`[server] ${signal} received, shutting down gracefully...`);
    server.close(async () => {
      console.log('[server] HTTP server closed');
      try {
        await pool.end();
        console.log('[server] Database pool closed');
      } catch (e) {}
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[server] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(console.error);
