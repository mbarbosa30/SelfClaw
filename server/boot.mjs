import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SELFCLAW_BOOT = "1";

const PORT = 5000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

let indexHtmlCache = "";
try {
  indexHtmlCache = fs.readFileSync(path.join(publicDir, "index.html"), "utf-8");
} catch {
  indexHtmlCache = "<html><body>SelfClaw starting...</body></html>";
}

let expressApp = null;
let appReady = false;

const MIME_TYPES = {
  ".css": "text/css", ".js": "application/javascript", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".json": "application/json", ".webp": "image/webp", ".gif": "image/gif",
};

const STATIC_EXTS = new Set(Object.keys(MIME_TYPES));

function handleRequest(req, res) {
  if (appReady && expressApp) {
    return expressApp(req, res);
  }

  const url = req.url?.split("?")[0] || "/";

  if (url === "/health" || url === "/health/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(indexHtmlCache);
    return;
  }

  const ext = path.extname(url);
  if (ext && STATIC_EXTS.has(ext)) {
    const filePath = path.join(publicDir, url);
    try {
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    } catch {}
  }

  res.writeHead(503, { "Content-Type": "application/json" });
  res.end('{"status":"starting","message":"Server is initializing, please retry"}');
}

const server = http.createServer(handleRequest);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] SelfClaw listening on port ${PORT}`);
  console.log("[boot] Health check ready — / and /health respond immediately");

  setImmediate(() => {
    loadApp().catch(err => {
      console.error("[boot] loadApp failed:", err.message);
    });
  });
});

async function loadApp() {
  const distPath = path.join(__dirname, "..", "dist", "server.mjs");
  const hasDistBuild = fs.existsSync(distPath);

  if (hasDistBuild) {
    console.log("[boot] Loading pre-compiled production build...");
    try {
      const appMod = await import(distPath);
      expressApp = appMod.app;
      await new Promise(resolve => setTimeout(resolve, 100));
      appReady = true;
      console.log("[boot] Express app mounted from dist/server.mjs");
      return;
    } catch (err) {
      console.error("[boot] dist/server.mjs failed:", err.message);
      console.log("[boot] Falling back to tsx...");
    }
  } else {
    console.log("[boot] No dist build found, using tsx...");
  }

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
    await new Promise(resolve => setTimeout(resolve, 100));
    appReady = true;
    console.log("[boot] Express app mounted via tsx");
  } catch (err) {
    console.error("[boot] Critical: Could not load app:", err.message);
    console.error("[boot] Server will continue serving static files only");
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[boot] Unhandled rejection:", reason?.message || reason);
});

process.on("SIGTERM", () => {
  console.log("[boot] SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
});

process.on("SIGINT", () => {
  console.log("[boot] SIGINT received, shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
});
