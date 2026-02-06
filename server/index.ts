import express, { type Request, type Response } from "express";
import { setupSelfAuth, isAuthenticated, registerAuthRoutes } from "./self-auth.js";
import { db } from "./db.js";
import { verifiedBots } from "../shared/schema.js";
import { sql } from "drizzle-orm";
import selfclawRouter from "./selfclaw.js";
import { erc8004Service } from "../lib/erc8004.js";

const app = express();
const PORT = 5000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static("public"));

app.get("/skill.md", (req: Request, res: Response) => {
  res.sendFile("skill.md", { root: "public" });
});

app.get("/developers", (req: Request, res: Response) => {
  res.sendFile("developers.html", { root: "public" });
});

app.get("/how-it-works", (req: Request, res: Response) => {
  res.sendFile("how-it-works.html", { root: "public" });
});

app.get("/economy", (req: Request, res: Response) => {
  res.sendFile("economy.html", { root: "public" });
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
  });
}

main().catch(console.error);
