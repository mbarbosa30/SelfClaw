import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { listTools, callTool, getConnectionStatus } from "./hostinger-mcp.js";

const router = Router();

const ALLOWED_TOOLS = new Set([
  "vps_get_virtual_machine_list",
  "vps_get_virtual_machine",
  "vps_get_running_processes",
  "vps_get_virtual_machine_metrics",
  "vps_get_docker_compose_projects",
  "vps_docker_compose_create_project",
  "vps_docker_compose_start_project",
  "vps_docker_compose_stop_project",
  "vps_docker_compose_get_project_logs",
  "vps_get_firewall_rules",
  "dns_get_dns_zone_records",
  "dns_get_dns_snapshot",
  "domain_get_domain_list",
  "domain_get_domain",
  "hosting_get_hosting_list",
  "hosting_get_hosting",
  "ssl_get_ssl_certificate_list",
  "ssl_get_ssl_certificate",
  "billing_get_catalog_item_list",
  "billing_get_subscription_list",
]);

const BLOCKED_PATTERNS = [
  /delete/i,
  /remove/i,
  /destroy/i,
  /purge/i,
  /reset_password/i,
  /cancel/i,
  /terminate/i,
];

function isToolAllowed(toolName: string): boolean {
  if (ALLOWED_TOOLS.has(toolName)) return true;
  if (BLOCKED_PATTERNS.some(p => p.test(toolName))) return false;
  return false;
}

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

function sanitizeError(err: any): string {
  const msg = typeof err === "string" ? err : err?.message || "Unknown error";
  if (msg.includes("/") || msg.includes("\\") || msg.length > 200) {
    return "Hostinger API operation failed. Please try again.";
  }
  return msg;
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
    res.json({ connected: false, error: sanitizeError(err) });
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
        allowed: isToolAllowed(tool.name),
      });
    }
    res.json({ total: tools.length, groups: grouped });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

router.post("/call", async (req: Request, res: Response) => {
  try {
    const { tool, args } = req.body;
    if (!tool || typeof tool !== "string") {
      return res.status(400).json({ error: "Missing 'tool' field" });
    }

    if (!isToolAllowed(tool)) {
      return res.status(403).json({
        error: "Tool not allowed",
        hint: "This tool is restricted for security reasons. Only read-only and approved deploy operations are permitted.",
      });
    }

    if (args && typeof args !== "object") {
      return res.status(400).json({ error: "Invalid 'args' — must be an object" });
    }

    const result = await callTool(tool, args || {});
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

router.get("/vms", async (_req: Request, res: Response) => {
  try {
    const result = await callTool("vps_get_virtual_machine_list", {});
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({
      error: sanitizeError(err),
      hint: "Could not connect to Hostinger. Make sure HOSTINGER_API_TOKEN is set.",
    });
  }
});

export default router;
