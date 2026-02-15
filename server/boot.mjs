import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SELFCLAW_BOOT = "1";

const PORT = 5000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

let expressApp = null;

const server = http.createServer((req, res) => {
  if (expressApp) {
    return expressApp(req, res);
  }

  if (req.url === "/health" || req.url === "/health/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    const indexPath = path.join(publicDir, "index.html");
    try {
      const html = fs.readFileSync(indexPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("SelfClaw starting...");
    }
    return;
  }

  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "starting", message: "Server is initializing, please retry" }));
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║       SelfClaw Agent Verification Registry                ║
║       Running on port ${PORT}                                 ║
╚════════════════════════════════════════════════════════════╝
`);
  console.log(`Access at: http://0.0.0.0:${PORT}`);
  console.log("[boot] Health check ready, loading application...");

  loadApp();
});

async function loadApp() {
  try {
    const mod = await import("tsx/esm/api");
    const tsImport = mod.tsImport || mod.default?.tsImport;
    if (tsImport) {
      const appMod = await tsImport("./index.ts", import.meta.url);
      expressApp = appMod.app;
    } else {
      const appMod = await import("./index.ts");
      expressApp = appMod.app;
    }
    console.log("[boot] Express app mounted successfully");
  } catch (err) {
    console.error("[boot] tsx/esm/api failed:", err.message);
    try {
      const appMod = await import("./index.ts");
      expressApp = appMod.app;
      console.log("[boot] Express app mounted via direct import");
    } catch (err2) {
      console.error("[boot] Critical: Could not load app:", err2.message);
    }
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason?.message || reason);
});

process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
});

process.on("SIGINT", () => {
  console.log("[server] SIGINT received, shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
});
