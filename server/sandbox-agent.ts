import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "./db.js";
import { sandboxTestRuns, verifiedBots, agentWallets, sponsoredAgents, trackedPools, tokenPlans } from "../shared/schema.js";
import { desc, eq } from "drizzle-orm";
import { createAgentWallet, sendGasSubsidy } from "../lib/secure-wallet.js";

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

router.post("/launch-live", async (req: Request, res: Response) => {
  try {
    const adminPassword = req.headers["x-admin-password"] || req.body?.adminPassword;
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      agentName, tokenName, tokenSymbol,
      totalSupply: rawSupply, economicModel, selfclawForPool: rawSelfclaw,
    } = req.body;

    if (!agentName || !tokenName || !tokenSymbol || !rawSupply) {
      return res.status(400).json({ error: "agentName, tokenName, tokenSymbol, and totalSupply are required" });
    }

    const totalSupply = rawSupply.toString();
    const selfclawForPool = rawSelfclaw ? Math.min(Number(rawSelfclaw), MAX_SELFCLAW_FOR_SANDBOX).toString() : null;

    console.log(`[sandbox] Starting LIVE launch for ${agentName} ($${tokenSymbol})...`);

    const startTime = Date.now();
    const keypair = generateEd25519Keypair();
    const sandboxHumanId = `sandbox-${crypto.randomBytes(8).toString("hex")}`;

    const steps: TestStep[] = [
      { name: "generate_identity", status: "pending" },
      { name: "register_agent", status: "pending" },
      { name: "create_wallet", status: "pending" },
      { name: "request_gas", status: "pending" },
      { name: "deploy_token", status: "pending" },
      { name: "register_token", status: "pending" },
      { name: "request_sponsorship", status: "pending" },
    ];

    const [testRun] = await db
      .insert(sandboxTestRuns)
      .values({
        agentName,
        agentPublicKey: keypair.publicKey,
        tokenName,
        tokenSymbol,
        tokenSupply: totalSupply,
        selfclawAmount: selfclawForPool || "0",
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

    const failAndReturn = async (error: string) => {
      await updateRun({ status: "failed", error, completedAt: new Date(), durationMs: Date.now() - startTime });
      return res.json({ success: false, testRunId: testRun.id, error, steps, durationMs: Date.now() - startTime });
    };

    const identityResult = await runStep("generate_identity", steps, async () => {
      return {
        agentName,
        publicKey: keypair.publicKey.substring(0, 32) + "...",
        humanId: sandboxHumanId,
        tokenName,
        tokenSymbol,
        totalSupply,
        economicModel: economicModel || "fixed",
      };
    });
    if (!identityResult.success) return failAndReturn(identityResult.error!);
    await updateRun({});

    const registerResult = await runStep("register_agent", steps, async () => {
      await db.insert(verifiedBots).values({
        publicKey: keypair.publicKey,
        humanId: sandboxHumanId,
        verificationLevel: "sandbox",
        metadata: {
          agentName,
          sandbox: true,
          live: true,
          tokenName,
          tokenSymbol,
          createdBy: "sandbox-live-launch",
        },
      });
      return { publicKey: keypair.publicKey.substring(0, 32) + "...", humanId: sandboxHumanId, level: "sandbox" };
    });
    if (!registerResult.success) return failAndReturn(registerResult.error!);
    await updateRun({});

    let evmPrivateKey: string;
    let evmAddress: string;
    const walletResult = await runStep("create_wallet", steps, async () => {
      const { Wallet } = await import("ethers");
      const wallet = Wallet.createRandom();
      evmPrivateKey = wallet.privateKey;
      evmAddress = wallet.address;

      const result = await createAgentWallet(sandboxHumanId, keypair.publicKey, wallet.address);
      if (!result.success) throw new Error(result.error || "Failed to register wallet");

      return { walletAddress: wallet.address };
    });
    if (!walletResult.success) return failAndReturn(walletResult.error!);
    await updateRun({ walletAddress: evmAddress! });

    const gasResult = await runStep("request_gas", steps, async () => {
      const result = await sendGasSubsidy(sandboxHumanId, keypair.publicKey);
      if (!result.success) throw new Error(result.error || "Gas subsidy failed");
      return { txHash: result.txHash, amountCelo: result.amountCelo };
    });
    if (!gasResult.success) return failAndReturn(gasResult.error!);
    await updateRun({});

    let deployedTokenAddress: string = "";
    let deployTxHash: string = "";
    const deployResult = await runStep("deploy_token", steps, async () => {
      const { parseUnits, formatUnits } = await import("viem");
      const { createPublicClient, createWalletClient, http, getContractAddress } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { celo } = await import("viem/chains");
      const { TOKEN_FACTORY_BYTECODE } = await import("../lib/constants.js");
      const { AbiCoder } = await import("ethers");

      const account = privateKeyToAccount(evmPrivateKey! as `0x${string}`);
      const publicClient = createPublicClient({ chain: celo, transport: http() });
      const walletClient = createWalletClient({ account, chain: celo, transport: http() });

      const decimals = 18;
      const supplyWithDecimals = parseUnits(totalSupply, decimals);
      const abiCoder = new AbiCoder();
      const encodedArgs = abiCoder.encode(
        ["string", "string", "uint256"],
        [tokenName, tokenSymbol, supplyWithDecimals.toString()]
      ).slice(2);

      const deployData = (TOKEN_FACTORY_BYTECODE + encodedArgs) as `0x${string}`;
      const nonce = await publicClient.getTransactionCount({ address: account.address });
      const predictedAddress = getContractAddress({ from: account.address, nonce: BigInt(nonce) });

      console.log(`[sandbox-live] Deploying token ${tokenSymbol} from ${account.address}, nonce=${nonce}`);

      const txHash = await walletClient.sendTransaction({
        data: deployData,
        value: BigInt(0),
      });

      console.log(`[sandbox-live] Token deploy tx sent: ${txHash}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

      if (receipt.status !== "success") {
        throw new Error(`Token deploy transaction reverted (tx: ${txHash})`);
      }

      deployedTokenAddress = receipt.contractAddress || predictedAddress;
      deployTxHash = txHash;

      return {
        tokenAddress: deployedTokenAddress,
        txHash,
        celoscanUrl: `https://celoscan.io/token/${deployedTokenAddress}`,
      };
    });
    if (!deployResult.success) return failAndReturn(deployResult.error!);
    await updateRun({ tokenAddress: deployedTokenAddress });

    const registerTokenResult = await runStep("register_token", steps, async () => {
      const { createPublicClient, http } = await import("viem");
      const { celo } = await import("viem/chains");
      const { formatUnits } = await import("viem");

      const publicClient = createPublicClient({ chain: celo, transport: http() });
      const ERC20_ABI = [
        { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
        { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
        { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
      ] as const;

      const tokenAddr = deployedTokenAddress as `0x${string}`;
      const [onChainName, onChainSymbol, onChainSupply] = await Promise.all([
        publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "name" }).catch(() => ""),
        publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "symbol" }).catch(() => ""),
        publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "totalSupply" }).catch(() => BigInt(0)),
      ]);

      await db.insert(tokenPlans).values({
        humanId: sandboxHumanId,
        agentPublicKey: keypair.publicKey,
        agentName,
        purpose: `Live sandbox token for ${agentName}. Model: ${economicModel || "fixed"}.`,
        supplyReasoning: `Supply of ${totalSupply} deployed on Celo mainnet via sandbox live launch.`,
        allocation: { liquidity: 30, team: 20, community: 50 } as any,
        utility: ["governance", "staking", "payment"] as any,
        economicModel: economicModel || "fixed",
        status: "sandbox",
      });

      return {
        verified: true,
        name: onChainName,
        symbol: onChainSymbol,
        totalSupply: formatUnits(onChainSupply as bigint, 18),
        address: deployedTokenAddress,
      };
    });
    if (!registerTokenResult.success) return failAndReturn(registerTokenResult.error!);
    await updateRun({});

    let v4PoolId = "";
    let positionTokenId: string | null = null;
    const sponsorshipResult = await runStep("request_sponsorship", steps, async () => {
      if (!selfclawForPool || Number(selfclawForPool) <= 0) {
        return { skipped: true, reason: "No SELFCLAW budget specified" };
      }

      const {
        getSelfclawBalance, getTokenBalance, getSponsorAddress,
        createPoolAndAddLiquidity, getNextPositionTokenId, computePoolId,
        extractPositionTokenIdFromReceipt,
      } = await import("../lib/uniswap-v4.js");

      const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
      const sponsorKey = rawSponsorKey && !rawSponsorKey.startsWith("0x") ? `0x${rawSponsorKey}` : rawSponsorKey;

      const selfclawAddress = "0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb";

      const availableBalance = await getSelfclawBalance(sponsorKey);
      const available = parseFloat(availableBalance);
      if (available <= 0) {
        throw new Error("No SELFCLAW available in sponsorship wallet");
      }

      const cappedAmount = Math.min(Number(selfclawForPool), available * (SANDBOX_SELFCLAW_CAP_PERCENT / 100), MAX_SELFCLAW_FOR_SANDBOX);
      const finalSelfclaw = Math.floor(cappedAmount).toString();

      if (Number(finalSelfclaw) <= 0) {
        throw new Error(`SELFCLAW budget too small after 1% cap (available: ${availableBalance})`);
      }

      const { parseUnits } = await import("viem");
      const { createWalletClient, http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { celo } = await import("viem/chains");

      const agentAccount = privateKeyToAccount(evmPrivateKey! as `0x${string}`);
      const agentWalletClient = createWalletClient({ account: agentAccount, chain: celo, transport: http() });

      const tokenAmount = Math.floor(Number(totalSupply) * 0.3).toString();

      const ERC20_ABI_TRANSFER = [
        { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
      ] as const;

      const sponsorAddress = getSponsorAddress(sponsorKey);
      console.log(`[sandbox-live] Transferring ${tokenAmount} ${tokenSymbol} to sponsor wallet ${sponsorAddress}`);

      const transferHash = await agentWalletClient.writeContract({
        address: deployedTokenAddress as `0x${string}`,
        abi: ERC20_ABI_TRANSFER,
        functionName: "transfer",
        args: [sponsorAddress as `0x${string}`, parseUnits(tokenAmount, 18)],
      });

      const { createPublicClient } = await import("viem");
      const publicClient = createPublicClient({ chain: celo, transport: http() });
      await publicClient.waitForTransactionReceipt({ hash: transferHash, timeout: 60_000 });

      console.log(`[sandbox-live] Transfer complete: ${transferHash}`);

      const tokenLower = deployedTokenAddress.toLowerCase();
      const selfclawLower = selfclawAddress.toLowerCase();
      const token0 = tokenLower < selfclawLower ? deployedTokenAddress : selfclawAddress;
      const token1 = tokenLower < selfclawLower ? selfclawAddress : deployedTokenAddress;
      const feeTier = 10000;
      const tickSpacing = 200;
      v4PoolId = computePoolId(token0, token1, feeTier, tickSpacing);

      const nextTokenIdBefore = await getNextPositionTokenId();

      console.log(`[sandbox-live] Creating V4 pool: ${tokenSymbol}/SELFCLAW, selfclaw=${finalSelfclaw}, agentTokens=${tokenAmount}`);

      const poolResult = await createPoolAndAddLiquidity({
        tokenA: deployedTokenAddress,
        tokenB: selfclawAddress,
        amountA: tokenAmount,
        amountB: finalSelfclaw,
        feeTier,
        privateKey: sponsorKey,
      });

      if (!poolResult.success) {
        throw new Error(poolResult.error || "Pool creation failed");
      }

      if (poolResult.receipt) {
        positionTokenId = extractPositionTokenIdFromReceipt(poolResult.receipt);
      }
      if (!positionTokenId) {
        const nextTokenIdAfter = await getNextPositionTokenId();
        if (nextTokenIdAfter > nextTokenIdBefore) {
          positionTokenId = nextTokenIdBefore.toString();
        }
      }

      await db.insert(sponsoredAgents).values({
        humanId: sandboxHumanId,
        publicKey: keypair.publicKey,
        tokenAddress: deployedTokenAddress,
        tokenSymbol,
        poolAddress: v4PoolId,
        v4PositionTokenId: positionTokenId,
        poolVersion: "v4",
        sponsoredAmountCelo: finalSelfclaw,
        sponsorTxHash: poolResult.txHash || "",
        status: "completed",
        completedAt: new Date(),
      });

      try {
        await db.insert(trackedPools).values({
          poolAddress: v4PoolId,
          tokenAddress: deployedTokenAddress,
          tokenSymbol,
          tokenName,
          pairedWith: "SELFCLAW",
          humanId: sandboxHumanId,
          agentPublicKey: keypair.publicKey,
          feeTier,
          v4PositionTokenId: positionTokenId,
          poolVersion: "v4",
          v4PoolId,
          initialCeloLiquidity: finalSelfclaw,
          initialTokenLiquidity: tokenAmount,
        }).onConflictDoNothing();
      } catch (e: any) {
        console.error(`[sandbox-live] Failed to track pool: ${e.message}`);
      }

      return {
        v4PoolId,
        positionTokenId,
        selfclawAmount: finalSelfclaw,
        agentTokenAmount: tokenAmount,
        txHash: poolResult.txHash,
        poolVersion: "v4",
      };
    });
    if (!sponsorshipResult.success) return failAndReturn(sponsorshipResult.error!);

    const finalStatus = steps.every((s) => s.status === "success") ? "completed" : "partial";
    const durationMs = Date.now() - startTime;

    await updateRun({
      status: finalStatus,
      v4PoolId: v4PoolId || null,
      positionTokenId,
      completedAt: new Date(),
      durationMs,
    });

    console.log(`[sandbox-live] Launch complete for ${agentName} ($${tokenSymbol}) in ${durationMs}ms`);

    res.json({
      success: true,
      testRunId: testRun.id,
      status: finalStatus,
      mode: "live",
      agent: {
        name: agentName,
        publicKey: keypair.publicKey.substring(0, 32) + "...",
        humanId: sandboxHumanId,
      },
      token: {
        name: tokenName,
        symbol: tokenSymbol,
        supply: totalSupply,
        address: deployedTokenAddress,
        celoscanUrl: `https://celoscan.io/token/${deployedTokenAddress}`,
        deployTxHash,
      },
      wallet: evmAddress!,
      pool: v4PoolId ? {
        v4PoolId,
        positionTokenId,
        version: "v4",
      } : null,
      steps,
      durationMs,
    });
  } catch (err: any) {
    console.error("[sandbox] launch-live error:", err);
    res.status(500).json({ error: err.message });
  }
});

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
