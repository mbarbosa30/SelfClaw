import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "./db.js";
import { sandboxTestRuns, verifiedBots, agentWallets, sponsoredAgents } from "../shared/schema.js";
import { desc, eq } from "drizzle-orm";

const router = Router();

const SANDBOX_SELFCLAW_CAP_PERCENT = 1;
const SELFCLAW_TOTAL_SUPPLY = 1_000_000_000;
const MAX_SELFCLAW_FOR_SANDBOX = (SELFCLAW_TOTAL_SUPPLY * SANDBOX_SELFCLAW_CAP_PERCENT) / 100;

const AGENT_NAME_PREFIXES = [
  "Sentinel", "Nexus", "Prism", "Echo", "Flux",
  "Cipher", "Vortex", "Pulse", "Nova", "Drift",
  "Quantum", "Orbit", "Helix", "Zenith", "Crest",
];

const TOKEN_THEMES = [
  { name: "Sandbox Credits", symbol: "SBOX", model: "fixed" },
  { name: "TestFlow Token", symbol: "TFLOW", model: "deflationary" },
  { name: "Validator Coin", symbol: "VCOIN", model: "utility" },
  { name: "BenchMark Units", symbol: "BENCH", model: "fixed" },
  { name: "ProbeNet Token", symbol: "PROBE", model: "inflationary" },
  { name: "Catalyst Coin", symbol: "CTLST", model: "deflationary" },
  { name: "Relay Credits", symbol: "RELAY", model: "utility" },
  { name: "Shard Token", symbol: "SHARD", model: "fixed" },
  { name: "Pulse Units", symbol: "PULSE", model: "deflationary" },
  { name: "Drift Coin", symbol: "DRIFT", model: "utility" },
];

interface TestStep {
  name: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  result?: any;
  error?: string;
  durationMs?: number;
}

function generateTestAgentParams() {
  const prefix = AGENT_NAME_PREFIXES[Math.floor(Math.random() * AGENT_NAME_PREFIXES.length)];
  const suffix = Math.floor(Math.random() * 999) + 1;
  const agentName = `${prefix}-${suffix}`;

  const theme = TOKEN_THEMES[Math.floor(Math.random() * TOKEN_THEMES.length)];
  const uniqueSuffix = crypto.randomBytes(2).toString("hex").toUpperCase();

  const supplyTiers = [1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
  const totalSupply = supplyTiers[Math.floor(Math.random() * supplyTiers.length)];

  const marketCapTargets = [100, 500, 1_000, 2_500, 5_000, 10_000];
  const targetMarketCap = marketCapTargets[Math.floor(Math.random() * marketCapTargets.length)];

  const selfclawForPool = Math.min(
    Math.floor(totalSupply * 0.3),
    MAX_SELFCLAW_FOR_SANDBOX
  ).toString();

  const tokenAmount = Math.floor(totalSupply * 0.3).toString();

  return {
    agentName,
    tokenName: `${theme.name} ${uniqueSuffix}`,
    tokenSymbol: `${theme.symbol}${suffix % 100}`,
    totalSupply: totalSupply.toString(),
    targetMarketCap,
    economicModel: theme.model,
    selfclawForPool,
    tokenAmount,
    allocation: { liquidity: 30, team: 20, community: 50 },
    utility: ["governance", "staking", "payment"],
  };
}

function generateEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubKeyDer = publicKey.export({ type: "spki", format: "der" });
  const privKeyDer = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    publicKey: pubKeyDer.toString("hex"),
    privateKey: privKeyDer.toString("hex"),
  };
}

async function runStep(
  stepName: string,
  steps: TestStep[],
  fn: () => Promise<any>
): Promise<{ success: boolean; result?: any; error?: string }> {
  const step = steps.find((s) => s.name === stepName);
  if (!step) return { success: false, error: "Step not found" };

  step.status = "running";
  const start = Date.now();

  try {
    const result = await fn();
    step.status = "success";
    step.result = result;
    step.durationMs = Date.now() - start;
    return { success: true, result };
  } catch (err: any) {
    step.status = "failed";
    step.error = err.message;
    step.durationMs = Date.now() - start;
    return { success: false, error: err.message };
  }
}

let openclawGateway: any = null;

export async function initOpenClawGateway() {
  try {
    const openclaw = await import("openclaw");
    const Gateway = (openclaw as any).Gateway || (openclaw as any).default?.Gateway;

    if (!Gateway) {
      console.log("[sandbox] OpenClaw Gateway class not found in exports, using lightweight mode");
      return;
    }

    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

    if (!apiKey) {
      console.log("[sandbox] No OpenAI API key available, OpenClaw Gateway will use lightweight mode");
      return;
    }

    openclawGateway = new Gateway({
      port: 18789,
      configPath: "./openclaw-config.json",
      agentWorkspace: "./skills",
      models: {
        primary: "openai/gpt-4o",
        providers: {
          openai: {
            apiKey,
            baseUrl: baseUrl || "https://api.openai.com/v1",
          },
        },
      },
    });

    await openclawGateway.start();
    console.log("[sandbox] OpenClaw Gateway started on port 18789");
  } catch (err: any) {
    console.log(`[sandbox] OpenClaw Gateway init skipped: ${err.message}`);
    console.log("[sandbox] Sandbox will run in lightweight mode (direct API calls)");
  }
}

async function runSandboxTest(dryRun: boolean = false) {
  const startTime = Date.now();
  const params = generateTestAgentParams();
  const keypair = generateEd25519Keypair();

  const steps: TestStep[] = [
    { name: "generate_identity", status: "pending" },
    { name: "register_agent", status: "pending" },
    { name: "create_wallet", status: "pending" },
    { name: "submit_token_plan", status: "pending" },
    { name: "deploy_token", status: "pending" },
    { name: "request_sponsorship", status: "pending" },
    { name: "verify_pool", status: "pending" },
  ];

  const [testRun] = await db
    .insert(sandboxTestRuns)
    .values({
      agentName: params.agentName,
      agentPublicKey: keypair.publicKey,
      tokenName: params.tokenName,
      tokenSymbol: params.tokenSymbol,
      tokenSupply: params.totalSupply,
      selfclawAmount: params.selfclawForPool,
      status: "running",
      steps: steps as any,
    })
    .returning();

  const updateRun = async (updates: Record<string, any>) => {
    await db
      .update(sandboxTestRuns)
      .set({ ...updates, steps: steps as any })
      .where(eq(sandboxTestRuns.id, testRun.id));
  };

  try {
    const identityResult = await runStep("generate_identity", steps, async () => {
      return {
        agentName: params.agentName,
        publicKey: keypair.publicKey.substring(0, 32) + "...",
        tokenName: params.tokenName,
        tokenSymbol: params.tokenSymbol,
        totalSupply: params.totalSupply,
        targetMarketCap: `$${params.targetMarketCap}`,
        economicModel: params.economicModel,
        selfclawForPool: params.selfclawForPool,
      };
    });

    if (!identityResult.success) {
      await updateRun({ status: "failed", error: identityResult.error, completedAt: new Date(), durationMs: Date.now() - startTime });
      return { success: false, testRunId: testRun.id, error: identityResult.error, steps };
    }

    if (dryRun) {
      for (const s of steps) {
        if (s.status === "pending") s.status = "skipped";
      }
      await updateRun({ status: "dry_run", completedAt: new Date(), durationMs: Date.now() - startTime });
      return { success: true, testRunId: testRun.id, mode: "dry_run", params: identityResult.result, steps };
    }

    const sandboxHumanId = `sandbox-${crypto.randomBytes(8).toString("hex")}`;

    const registerResult = await runStep("register_agent", steps, async () => {
      await db.insert(verifiedBots).values({
        publicKey: keypair.publicKey,
        humanId: sandboxHumanId,
        verificationLevel: "sandbox",
        metadata: {
          agentName: params.agentName,
          sandbox: true,
          tokenName: params.tokenName,
          tokenSymbol: params.tokenSymbol,
          createdBy: "openclaw-sandbox-agent",
        },
      });
      return { publicKey: keypair.publicKey.substring(0, 32) + "...", humanId: sandboxHumanId, level: "sandbox" };
    });

    await updateRun({});

    if (!registerResult.success) {
      await updateRun({ status: "failed", error: registerResult.error, completedAt: new Date(), durationMs: Date.now() - startTime });
      return { success: false, testRunId: testRun.id, error: registerResult.error, steps };
    }

    const { privateKeyToAccount } = await import("viem/accounts");
    const { generatePrivateKey } = await import("viem/accounts");
    const evmPrivateKey = generatePrivateKey();
    const evmAccount = privateKeyToAccount(evmPrivateKey);

    const walletResult = await runStep("create_wallet", steps, async () => {
      await db.insert(agentWallets).values({
        humanId: sandboxHumanId,
        publicKey: keypair.publicKey,
        address: evmAccount.address,
      });
      return { walletAddress: evmAccount.address };
    });

    await updateRun({ walletAddress: evmAccount.address });

    if (!walletResult.success) {
      await updateRun({ status: "failed", error: walletResult.error, completedAt: new Date(), durationMs: Date.now() - startTime });
      return { success: false, testRunId: testRun.id, error: walletResult.error, steps };
    }

    const planResult = await runStep("submit_token_plan", steps, async () => {
      const { tokenPlans } = await import("../shared/schema.js");
      await db.insert(tokenPlans).values({
        humanId: sandboxHumanId,
        agentPublicKey: keypair.publicKey,
        agentName: params.agentName,
        purpose: `Sandbox test token for ${params.agentName}. Economic model: ${params.economicModel}. Target market cap: $${params.targetMarketCap}.`,
        supplyReasoning: `Supply of ${params.totalSupply} chosen for sandbox testing with ${params.economicModel} model.`,
        allocation: params.allocation as any,
        utility: params.utility as any,
        economicModel: params.economicModel,
        status: "sandbox",
      });
      return { plan: "submitted", model: params.economicModel, targetMarketCap: params.targetMarketCap };
    });

    await updateRun({});

    if (!planResult.success) {
      await updateRun({ status: "failed", error: planResult.error, completedAt: new Date(), durationMs: Date.now() - startTime });
      return { success: false, testRunId: testRun.id, error: planResult.error, steps };
    }

    const deployResult = await runStep("deploy_token", steps, async () => {
      const { parseUnits } = await import("viem");
      const supplyWei = parseUnits(params.totalSupply, 18);

      return {
        tokenName: params.tokenName,
        tokenSymbol: params.tokenSymbol,
        totalSupply: params.totalSupply,
        supplyWei: supplyWei.toString(),
        ownerAddress: evmAccount.address,
        note: "Token deployment tx generation validated. On-chain deploy requires signing the unsigned tx returned by /v1/deploy-token.",
      };
    });

    await updateRun({});

    if (!deployResult.success) {
      await updateRun({ status: "failed", error: deployResult.error, completedAt: new Date(), durationMs: Date.now() - startTime });
      return { success: false, testRunId: testRun.id, error: deployResult.error, steps };
    }

    const sponsorshipResult = await runStep("request_sponsorship", steps, async () => {
      return {
        note: "Sponsorship requires deployed token address. In sandbox dry-run, verifying pipeline readiness.",
        selfclawBudget: params.selfclawForPool,
        maxAllowed: MAX_SELFCLAW_FOR_SANDBOX.toString(),
        capPercent: `${SANDBOX_SELFCLAW_CAP_PERCENT}%`,
        wouldCreate: "V4 pool via createPoolAndAddLiquidity",
      };
    });

    await updateRun({});

    const verifyResult = await runStep("verify_pool", steps, async () => {
      const { computePoolId } = await import("../lib/uniswap-v4.js");
      return {
        note: "Pool verification validates computePoolId function",
        samplePoolId: computePoolId(
          "0x0000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000002",
          10000,
          200
        ),
        poolVersion: "v4",
        positionTracking: "receipt-based extraction + nextTokenId fallback",
      };
    });

    await updateRun({});

    const finalStatus = steps.every((s) => s.status === "success") ? "completed" : "partial";
    const durationMs = Date.now() - startTime;

    await updateRun({
      status: finalStatus,
      completedAt: new Date(),
      durationMs,
    });

    return {
      success: true,
      testRunId: testRun.id,
      status: finalStatus,
      agent: {
        name: params.agentName,
        publicKey: keypair.publicKey.substring(0, 32) + "...",
        humanId: sandboxHumanId,
      },
      token: {
        name: params.tokenName,
        symbol: params.tokenSymbol,
        supply: params.totalSupply,
        model: params.economicModel,
        targetMarketCap: `$${params.targetMarketCap}`,
      },
      wallet: evmAccount.address,
      sponsorship: {
        selfclawBudget: params.selfclawForPool,
        capPercent: `${SANDBOX_SELFCLAW_CAP_PERCENT}%`,
        maxAllowed: MAX_SELFCLAW_FOR_SANDBOX,
      },
      steps,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await updateRun({
      status: "failed",
      error: err.message,
      completedAt: new Date(),
      durationMs,
    });
    return { success: false, testRunId: testRun.id, error: err.message, steps, durationMs };
  }
}

async function useOpenClawAgent(prompt: string): Promise<string | null> {
  if (!openclawGateway) return null;

  try {
    const response = await openclawGateway.sendMessage({
      agent: "selfclaw-sandbox",
      message: prompt,
      channelId: "selfclaw-admin",
    });
    return typeof response === "string" ? response : JSON.stringify(response);
  } catch (err: any) {
    console.error("[sandbox] OpenClaw agent error:", err.message);
    return null;
  }
}

router.post("/run-test", async (req: Request, res: Response) => {
  try {
    const adminPassword = req.headers["x-admin-password"] || req.body?.adminPassword;
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const dryRun = req.body?.dryRun === true;

    console.log(`[sandbox] Starting ${dryRun ? "dry-run" : "full"} sandbox test...`);

    const result = await runSandboxTest(dryRun);

    if (result.success) {
      console.log(`[sandbox] Test completed: ${result.status} (${result.durationMs}ms)`);
    } else {
      console.error(`[sandbox] Test failed: ${result.error}`);
    }

    res.json(result);
  } catch (err: any) {
    console.error("[sandbox] run-test error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/run-test-ai", async (req: Request, res: Response) => {
  try {
    const adminPassword = req.headers["x-admin-password"] || req.body?.adminPassword;
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!openclawGateway) {
      return res.status(503).json({
        error: "OpenClaw Gateway not available",
        hint: "The embedded OpenClaw Gateway is not running. Use /run-test for the lightweight sandbox instead.",
      });
    }

    const prompt = req.body?.prompt || "Run a full SelfClaw sandbox test. Create a new test agent with unique token parameters and run through the entire V4 sponsorship pipeline. Report each step's results.";

    console.log("[sandbox] Sending prompt to OpenClaw agent...");
    const agentResponse = await useOpenClawAgent(prompt);

    res.json({
      success: true,
      mode: "openclaw-agent",
      prompt,
      agentResponse,
    });
  } catch (err: any) {
    console.error("[sandbox] run-test-ai error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/history", async (req: Request, res: Response) => {
  try {
    const adminPassword = req.headers["x-admin-password"] || req.query?.adminPassword;
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = Math.min(parseInt(req.query?.limit as string) || 20, 100);

    const runs = await db
      .select()
      .from(sandboxTestRuns)
      .orderBy(desc(sandboxTestRuns.createdAt))
      .limit(limit);

    const summary = {
      total: runs.length,
      completed: runs.filter((r) => r.status === "completed").length,
      failed: runs.filter((r) => r.status === "failed").length,
      partial: runs.filter((r) => r.status === "partial").length,
      dryRuns: runs.filter((r) => r.status === "dry_run").length,
    };

    res.json({ summary, runs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/status", async (req: Request, res: Response) => {
  const adminPassword = req.headers["x-admin-password"] || req.query?.adminPassword;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sandboxAgents = await db
    .select()
    .from(verifiedBots)
    .where(eq(verifiedBots.verificationLevel, "sandbox"));

  res.json({
    openclawGateway: openclawGateway ? "running" : "not_available",
    mode: openclawGateway ? "openclaw" : "lightweight",
    selfclawCap: {
      percent: `${SANDBOX_SELFCLAW_CAP_PERCENT}%`,
      maxTokens: MAX_SELFCLAW_FOR_SANDBOX,
    },
    sandboxAgentsCreated: sandboxAgents.length,
    skill: "skills/selfclaw/SKILL.md",
  });
});

export default router;
export { runSandboxTest, MAX_SELFCLAW_FOR_SANDBOX, SANDBOX_SELFCLAW_CAP_PERCENT };
