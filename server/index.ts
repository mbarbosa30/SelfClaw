import express, { type Request, type Response } from "express";
import { setupSelfAuth, isAuthenticated, registerAuthRoutes } from "./self-auth.js";
import { db } from "./db.js";
import { verifiedBots } from "../shared/schema.js";
import { sql } from "drizzle-orm";
import selfclawRouter from "./selfclaw.js";
import adminRouter, { runAutoClaimPendingBridges } from "./admin.js";
import { erc8004Service } from "../lib/erc8004.js";

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '10mb' }));

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

app.get("/developers", (_req: Request, res: Response) => sendHtml(res, "developers.html"));
app.get("/how-it-works", (_req: Request, res: Response) => sendHtml(res, "how-it-works.html"));
app.get("/economy", (_req: Request, res: Response) => sendHtml(res, "economy.html"));
app.get("/pricing", (_req: Request, res: Response) => sendHtml(res, "pricing.html"));
app.get("/technology", (_req: Request, res: Response) => sendHtml(res, "technology.html"));
app.get("/docs", (_req: Request, res: Response) => sendHtml(res, "docs.html"));
app.get("/vision", (_req: Request, res: Response) => sendHtml(res, "vision.html"));
app.get("/whitepaper", (_req: Request, res: Response) => sendHtml(res, "whitepaper.html"));
app.get("/dashboard", (_req: Request, res: Response) => sendHtml(res, "dashboard.html"));
app.get("/registry", (_req: Request, res: Response) => sendHtml(res, "registry.html"));
app.get("/admin", (_req: Request, res: Response) => sendHtml(res, "admin.html", { "X-Robots-Tag": "noindex, nofollow" }));
app.get("/human/:humanId", (_req: Request, res: Response) => sendHtml(res, "human.html"));

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

  app.get("/.well-known/agent-registration.json", async (req: Request, res: Response) => {
    try {
      const minted = await db.select()
        .from(verifiedBots)
        .where(sql`(${verifiedBots.metadata}->>'erc8004Minted')::boolean = true`);

      const domain = process.env.REPLIT_DOMAINS || "selfclaw.ai";
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

  app.listen(PORT, "0.0.0.0", () => {
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
  });
}

main().catch(console.error);
