import express, { type Request, type Response } from "express";
import helmet from "helmet";
import path from "path";
import http from "http";

process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] Unhandled promise rejection:', reason?.message || reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('[FATAL] Uncaught exception:', error.message);
  if (error.message.includes('EADDRINUSE')) process.exit(1);
});

const app = express();
const PORT = 5000;

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/", (_req: Request, res: Response) => {
  res.status(200).sendFile("index.html", { root: "public" });
});

app.use(express.json({ limit: '10mb' }));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

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
app.get("/miniapp", (_req: Request, res: Response) => sendHtml(res, "miniapp.html"));
app.get("/miniapp/chat/:id", (_req: Request, res: Response) => sendHtml(res, "miniclaw-chat.html"));
app.get("/guide", (_req: Request, res: Response) => sendHtml(res, "guide.html"));
app.get("/miniclaw", (_req: Request, res: Response) => sendHtml(res, "miniclaw-intro.html"));
app.get("/perkos", (_req: Request, res: Response) => sendHtml(res, "perkos.html", { "X-Robots-Tag": "noindex, nofollow" }));
app.get("/feed", (_req: Request, res: Response) => sendHtml(res, "feed.html"));

app.get("/how-it-works", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/pricing", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/technology", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/vision", (_req: Request, res: Response) => res.redirect(301, "/"));
app.get("/docs", (_req: Request, res: Response) => res.redirect(301, "/developers"));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║       SelfClaw Agent Verification Registry                ║
║       Running on port ${PORT}                                 ║
╚════════════════════════════════════════════════════════════╝
`);
  console.log(`Access at: http://0.0.0.0:${PORT}`);

  initializeApp().catch(err => {
    console.error('[startup] Initialization failed:', err.message);
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

async function initializeApp() {
  const { setupSelfAuth, registerAuthRoutes } = await import("./self-auth.js");
  const { db, pool } = await import("./db.js");
  const { verifiedBots } = await import("../shared/schema.js");
  const { sql } = await import("drizzle-orm");

  app.use((req, res, next) => {
    const isStreaming = req.path.includes('/chat') || req.path.includes('/messages');
    const timeout = isStreaming ? 120000 : 30000;
    req.setTimeout(timeout);
    res.setTimeout(timeout);
    next();
  });

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

  const { default: selfclawRouter } = await import("./selfclaw.js");
  const { default: adminRouter, runAutoClaimPendingBridges } = await import("./admin.js");
  const { default: hostingerRouter } = await import("./hostinger-routes.js");
  const { default: sandboxRouter, initOpenClawGateway } = await import("./sandbox-agent.js");
  const { hostedAgentsRouter, startAgentWorker } = await import("./hosted-agents.js");
  const { skillMarketRouter } = await import("./skill-market.js");
  const { default: agentCommerceRouter } = await import("./agent-commerce.js");
  const { default: reputationRouter } = await import("./reputation.js");
  const { default: agentApiRouter } = await import("./agent-api.js");
  const { default: agentFeedRouter } = await import("./agent-feed.js");
  const { startFeedDigest } = await import("./feed-digest.js");
  const { erc8004Service } = await import("../lib/erc8004.js");

  app.use("/api/selfclaw", selfclawRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/admin/sandbox", sandboxRouter);
  app.use("/api/selfclaw", hostedAgentsRouter);
  app.use("/api/selfclaw", skillMarketRouter);
  app.use("/api/selfclaw", agentCommerceRouter);
  app.use("/api/selfclaw", reputationRouter);
  app.use("/api/selfclaw", agentApiRouter);
  app.use("/api/selfclaw", agentFeedRouter);
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

  try {
    await pool.query(`
      ALTER TABLE verification_sessions 
      ADD COLUMN IF NOT EXISTS human_id VARCHAR;
    `);
    console.log('[migration] verification_sessions.human_id column ensured');
  } catch (err: any) {
    console.error('[migration] Could not ensure human_id column:', err.message);
  }

  try {
    await pool.query(`
      UPDATE tracked_pools SET token_name = 'Musketeer Token', token_symbol = 'MSKT'
      WHERE token_address = '0x2bfc1DF3E826a97C14F3A1e40e582D0ba5552D0F' AND (token_name = 'TOKEN' OR token_symbol = 'TOKEN');
    `);
    await pool.query(`
      UPDATE tracked_pools SET token_name = 'CeloFX', token_symbol = 'CELOFX'
      WHERE token_address = '0x8dea24d1d39ff8d5a957b8e4a71e3d260ea49628' AND (token_name = 'TOKEN' OR token_symbol = 'TOKEN');
    `);
    await pool.query(`
      UPDATE tracked_pools SET token_name = 'Clawdberg', token_symbol = 'CLWDBRG'
      WHERE token_address = '0xC7ED254128840fc3EA461FAEBaA2D9F08c54b59D' AND (token_name = 'TOKEN' OR token_symbol = 'TOKEN');
    `);
    await pool.query(`
      UPDATE tracked_pools SET token_name = 'PerkyJobs', token_symbol = 'PERKY', v4_position_token_id = '254'
      WHERE token_address = '0x67aa5E5326C42EB0900C8A5d64e198FA6f305861' AND v4_position_token_id IS NULL;
    `);
    await pool.query(`
      UPDATE sponsored_agents SET token_symbol = 'MSKT'
      WHERE token_address = '0x2bfc1DF3E826a97C14F3A1e40e582D0ba5552D0F' AND token_symbol = 'TOKEN';
    `);
    await pool.query(`
      UPDATE sponsored_agents SET token_symbol = 'CELOFX'
      WHERE token_address = '0x8dea24d1d39ff8d5a957b8e4a71e3d260ea49628' AND token_symbol = 'TOKEN';
    `);
    await pool.query(`
      UPDATE sponsored_agents SET token_symbol = 'CLWDBRG'
      WHERE token_address = '0xC7ED254128840fc3EA461FAEBaA2D9F08c54b59D' AND token_symbol = 'TOKEN';
    `);
    await pool.query(`
      INSERT INTO tracked_pools (pool_address, token_address, token_symbol, token_name, paired_with, human_id, fee_tier, v4_position_token_id, pool_version, v4_pool_id)
      VALUES (
        '0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b',
        '0x471EcE3750Da237f93B8E339c536989b8978a438',
        'CELO', 'Celo native asset', 'SELFCLAW', 'platform', 3000, '246', 'v4',
        '0x92bf22b01e8c42e09e2777f3a11490f3e77bd232b70339dbedb0b5a57b21ab8b'
      ) ON CONFLICT (pool_address) DO UPDATE SET v4_position_token_id = '246';
    `);
    await pool.query(`
      INSERT INTO tracked_pools (pool_address, token_address, token_symbol, token_name, paired_with, human_id, fee_tier, v4_position_token_id, pool_version, v4_pool_id)
      VALUES (
        '0xaa6bb69189b81c0d19e492128d890b2851aae2130f1ba05744db22ebd08d84f9',
        '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
        'USD₮', 'Tether USD', 'SELFCLAW', 'platform', 3000, '253', 'v4',
        '0xaa6bb69189b81c0d19e492128d890b2851aae2130f1ba05744db22ebd08d84f9'
      ) ON CONFLICT (pool_address) DO UPDATE SET v4_position_token_id = '253';
    `);
    console.log('[migration] Token names/symbols corrected + SELFCLAW pool positions tracked');
  } catch (err: any) {
    console.error('[migration] Token/pool correction failed:', err.message);
  }

  try {
    await pool.query(`
      ALTER TABLE tracked_pools ADD COLUMN IF NOT EXISTS hidden_from_registry BOOLEAN DEFAULT false;
      ALTER TABLE tracked_pools ADD COLUMN IF NOT EXISTS display_name_override VARCHAR;
      ALTER TABLE tracked_pools ADD COLUMN IF NOT EXISTS display_symbol_override VARCHAR;
      ALTER TABLE tracked_pools ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    `);
    console.log('[migration] tracked_pools admin columns ensured');
  } catch (err: any) {
    console.error('[migration] tracked_pools admin columns failed:', err.message);
  }

  try {
    await pool.query(`ALTER TABLE verified_bots ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false;`);
    console.log('[migration] verified_bots.hidden column ensured');
  } catch (err: any) {
    console.error('[migration] verified_bots.hidden column failed:', err.message);
  }

  try {
    await pool.query(`ALTER TABLE verified_bots ADD COLUMN IF NOT EXISTS api_key VARCHAR UNIQUE;`);
    console.log('[migration] verified_bots.api_key column ensured');
  } catch (err: any) {
    console.error('[migration] verified_bots.api_key column failed:', err.message);
  }

  try {
    const { rows } = await pool.query(`SELECT id FROM verified_bots WHERE api_key IS NULL AND human_id IS NOT NULL`);
    if (rows.length > 0) {
      const crypto = await import("crypto");
      for (const row of rows) {
        const key = "sclaw_" + crypto.randomBytes(32).toString("hex");
        await pool.query(`UPDATE verified_bots SET api_key = $1 WHERE id = $2`, [key, row.id]);
      }
      console.log(`[migration] Backfilled API keys for ${rows.length} verified agents`);
    }
  } catch (err: any) {
    console.error('[migration] API key backfill failed:', err.message);
  }

  console.log('[startup] Core setup complete');

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

  setTimeout(() => {
    startFeedDigest().catch(err =>
      console.error('[feed-digest] Start error:', err.message)
    );
  }, 12000);

  console.log('[startup] Async initialization complete');
}

function gracefulShutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down gracefully...`);
  server.close(async () => {
    console.log('[server] HTTP server closed');
    try {
      const { pool } = await import("./db.js");
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
