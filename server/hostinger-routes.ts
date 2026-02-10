import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { listTools, callTool, getConnectionStatus } from "./hostinger-mcp.js";

const router = Router();

const hostingerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests to Hostinger API, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

function requireAuth(req: any, res: Response, next: Function) {
  if (!req.session?.isAuthenticated || !req.session?.humanId) {
    return res.status(401).json({ error: "Login required. Authenticate with Self.xyz passport first." });
  }
  next();
}

router.use(requireAuth);
router.use(hostingerLimiter);

router.get("/status", async (_req: Request, res: Response) => {
  try {
    const status = getConnectionStatus();
    if (!status.connected) {
      await listTools();
    }
    res.json({ connected: true, error: null });
  } catch (err: any) {
    res.json({ connected: false, error: err.message });
  }
});

router.get("/tools", async (_req: Request, res: Response) => {
  try {
    const tools = await listTools();
    const grouped: Record<string, any[]> = {};
    for (const tool of tools) {
      const prefix = tool.name.split("_")[0] || "other";
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || {},
      });
    }
    res.json({ total: tools.length, groups: grouped });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/call", async (req: Request, res: Response) => {
  try {
    const { tool, args } = req.body;
    if (!tool || typeof tool !== "string") {
      return res.status(400).json({ error: "Missing 'tool' field" });
    }
    const result = await callTool(tool, args || {});
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
