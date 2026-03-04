import { db } from "../server/db.js";
import { verifiedBots, tokenPlans, sponsoredAgents, sponsorshipRequests, trackedPools, agentActivity, hostedAgents } from "../shared/schema.js";
import { eq, sql } from "drizzle-orm";
import { erc8004Service } from "./erc8004.js";
import { generateRegistrationFile } from "./erc8004-config.js";
import { getAgentWallet } from "./secure-wallet.js";
import { getPublicClient, getWalletClient as getChainWalletClient, getChainConfig, getExplorerUrl, type SupportedChain } from './chains.js';

function getSponsorKey(): string {
  const raw = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
  if (!raw) throw new Error("Platform sponsor key not configured (CELO_PRIVATE_KEY).");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function logActivity(eventType: string, humanId: string, publicKey: string, agentName: string, metadata?: any) {
  try {
    await db.insert(agentActivity).values({
      eventType, humanId, agentPublicKey: publicKey, agentName: agentName, metadata,
    });
  } catch {}
}

export interface PlatformDeployTokenParams {
  publicKey: string;
  humanId: string;
  name: string;
  symbol: string;
  initialSupply: string;
  agentName: string;
  chain?: SupportedChain;
}

export interface PlatformDeployTokenResult {
  success: boolean;
  tokenAddress?: string;
  deployTxHash?: string;
  explorerUrl?: string;
  chain?: string;
  error?: string;
}

export async function platformDeployToken(params: PlatformDeployTokenParams): Promise<PlatformDeployTokenResult> {
  const { publicKey, humanId, name, symbol, initialSupply, agentName } = params;
  const chain: SupportedChain = params.chain || 'celo';
  const sponsorKey = getSponsorKey();

  const { parseUnits, AbiCoder } = await import("ethers");
  const { TOKEN_FACTORY_BYTECODE } = await import("./constants.js");

  const viemClient = getPublicClient(chain);
  const sponsorWallet = getChainWalletClient(chain);

  const decimals = 18;
  const supplyWithDecimals = parseUnits(initialSupply.toString(), decimals);
  const abiCoder = new AbiCoder();
  const encodedArgs = abiCoder.encode(
    ["string", "string", "uint256"],
    [name, symbol, supplyWithDecimals.toString()]
  ).slice(2);

  const deployData = (TOKEN_FACTORY_BYTECODE + encodedArgs) as `0x${string}`;

  let gasEstimate: bigint;
  try {
    gasEstimate = await viemClient.estimateGas({ account: sponsorWallet.account!.address, data: deployData });
    gasEstimate = gasEstimate * 120n / 100n;
  } catch {
    gasEstimate = 3_000_000n;
  }

  console.log(`[platform-economy] Deploying token ${name} (${symbol}) for agent ${publicKey}`);

  const deployTxHash = await sponsorWallet.sendTransaction({
    account: sponsorWallet.account!,
    chain: getChainConfig(chain).viemChain,
    data: deployData,
    gas: gasEstimate,
  });

  const deployReceipt = await viemClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (deployReceipt.status === "reverted") {
    return { success: false, error: "Token deployment transaction reverted." };
  }

  const tokenAddress = deployReceipt.contractAddress;
  if (!tokenAddress) {
    return { success: false, error: "Token deployed but contract address not found in receipt." };
  }

  console.log(`[platform-economy] Token deployed at ${tokenAddress} (supply held in platform wallet)`);

  const [bot] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, publicKey));
  if (bot) {
    const meta = (bot.metadata as any) || {};
    meta.tokenPlan = { name, symbol, initialSupply, decimals, status: "deployed" };
    meta.tokenAddress = tokenAddress;
    meta.tokenDeployTxHash = deployTxHash;
    await db.update(verifiedBots).set({ metadata: meta }).where(eq(verifiedBots.publicKey, publicKey));
  }

  try {
    await db.insert(tokenPlans).values({
      humanId,
      agentPublicKey: publicKey,
      agentName,
      purpose: `Platform-deployed token: ${name} (${symbol})`,
      supplyReasoning: `Initial supply: ${initialSupply}`,
      allocation: { deployer: "100%" },
      utility: { type: "agent-token", symbol },
      economicModel: `ERC-20 token deployed via platform. Supply: ${initialSupply}, Decimals: ${decimals}`,
      tokenAddress,
      status: "deployed",
    });
  } catch (dbErr: any) {
    console.warn(`[platform-economy] Failed to insert token plan: ${dbErr.message}`);
  }

  await logActivity("token_deployment", humanId, publicKey, agentName, {
    tokenAddress, tokenName: name, tokenSymbol: symbol, initialSupply, deployTxHash, method: "platform-executed",
  });

  return {
    success: true,
    tokenAddress,
    deployTxHash,
    explorerUrl: getExplorerUrl(chain, 'token', tokenAddress),
    chain,
  };
}

export interface PlatformRegisterErc8004Params {
  publicKey: string;
  humanId: string;
  agentName: string;
  description?: string;
  walletAddress: string;
  hostedAgentId?: number | string;
}

export interface PlatformRegisterErc8004Result {
  success: boolean;
  tokenId?: string;
  txHash?: string;
  explorerUrl?: string;
  scan8004Url?: string;
  alreadyDone?: boolean;
  error?: string;
}

export async function platformRegisterErc8004(params: PlatformRegisterErc8004Params): Promise<PlatformRegisterErc8004Result> {
  const { publicKey, humanId, agentName, description, walletAddress, hostedAgentId } = params;

  const [bot] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, publicKey));
  const botMeta = (bot?.metadata as any) || {};
  if (botMeta.erc8004TokenId) {
    return {
      success: true,
      alreadyDone: true,
      tokenId: botMeta.erc8004TokenId,
      explorerUrl: erc8004Service.getExplorerUrl(botMeta.erc8004TokenId),
    };
  }

  if (!erc8004Service.isReady()) {
    return { success: false, error: "ERC-8004 contracts not available yet." };
  }

  const domain = "selfclaw.ai";
  const desc = description || `Verified agent: ${agentName}`;

  const registrationJson = generateRegistrationFile(
    agentName, desc, walletAddress,
    undefined, `https://${domain}`, undefined, true,
  );

  const registrationURL = `https://${domain}/api/selfclaw/v1/agent/${publicKey}/registration.json`;

  if (hostedAgentId) {
    try {
      const [ha] = await db.select().from(hostedAgents).where(eq(hostedAgents.id, String(hostedAgentId)));
      if (ha) {
        const existingMcMeta = (ha.metadata as Record<string, any>) || {};
        await db.update(hostedAgents).set({
          metadata: { ...existingMcMeta, erc8004RegistrationJson: registrationJson },
        }).where(eq(hostedAgents.id, String(hostedAgentId)));
      }
    } catch {}
  }

  console.log(`[platform-economy] Registering ERC-8004 identity for agent ${publicKey}`);

  const regResult = await erc8004Service.registerAgent(registrationURL);
  if (!regResult) {
    return { success: false, error: "ERC-8004 registration failed — contract call returned null." };
  }

  if (hostedAgentId) {
    try {
      const [ha] = await db.select().from(hostedAgents).where(eq(hostedAgents.id, String(hostedAgentId)));
      if (ha) {
        const existingMcMeta = (ha.metadata as Record<string, any>) || {};
        await db.update(hostedAgents).set({
          metadata: {
            ...existingMcMeta,
            erc8004RegistrationJson: registrationJson,
            erc8004Minted: true,
            erc8004TxHash: regResult.txHash,
            erc8004TokenId: regResult.tokenId,
            erc8004MintedAt: new Date().toISOString(),
          },
        }).where(eq(hostedAgents.id, String(hostedAgentId)));
      }
    } catch {}
  }

  if (bot) {
    const meta = (bot.metadata as any) || {};
    meta.erc8004TokenId = regResult.tokenId;
    meta.erc8004TxHash = regResult.txHash;
    meta.erc8004Minted = true;
    await db.update(verifiedBots).set({ metadata: meta }).where(eq(verifiedBots.publicKey, publicKey));
  }

  await logActivity("erc8004_registration", humanId, publicKey, agentName, {
    tokenId: regResult.tokenId, txHash: regResult.txHash, method: "platform-executed",
  });

  console.log(`[platform-economy] ERC-8004 registered: token #${regResult.tokenId} (tx: ${regResult.txHash})`);

  return {
    success: true,
    tokenId: regResult.tokenId,
    txHash: regResult.txHash,
    explorerUrl: erc8004Service.getExplorerUrl(regResult.tokenId),
    scan8004Url: `https://www.8004scan.io/agents/celo/${regResult.tokenId}`,
  };
}

export interface PlatformRequestSponsorshipParams {
  publicKey: string;
  humanId: string;
  tokenAmount: string;
  agentName: string;
  walletAddress?: string;
  source?: string;
  chain?: SupportedChain;
}

export interface PlatformRequestSponsorshipResult {
  success: boolean;
  v4PoolId?: string;
  positionTokenId?: string | null;
  txHash?: string;
  selfclawAmount?: string;
  remainingTransferTx?: string | null;
  chain?: string;
  error?: string;
  sponsorWallet?: string;
  instructions?: string;
}

export async function platformRequestSponsorship(params: PlatformRequestSponsorshipParams): Promise<PlatformRequestSponsorshipResult> {
  const { publicKey, humanId, tokenAmount, agentName, walletAddress, source } = params;
  const chain: SupportedChain = params.chain || 'celo';
  const sponsorKey = getSponsorKey();

  const [bot] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, publicKey));
  const botMeta = (bot?.metadata as any) || {};
  if (!botMeta.tokenAddress) {
    return { success: false, error: "No token deployed yet. Deploy a token first." };
  }

  const {
    getSelfclawBalance, getTokenBalance, getSponsorAddress,
    createPoolAndAddLiquidity, getNextPositionTokenId, computePoolId, getPoolState,
    extractPositionTokenIdFromReceipt,
  } = await import("./uniswap-v4.js");

  const tokenAddress = botMeta.tokenAddress;
  const selfclawAddress = getChainConfig(chain).selfclawToken;
  const sponsorAddress = getSponsorAddress(sponsorKey);

  const agentTokenBalance = await getTokenBalance(tokenAddress, 18, sponsorKey);
  const requiredAmount = parseFloat(tokenAmount);
  const heldAmount = parseFloat(agentTokenBalance);

  if (heldAmount < requiredAmount) {
    return {
      success: false,
      error: `Sponsor wallet does not hold enough of your agent token. It has ${agentTokenBalance} but needs ${tokenAmount}.`,
      sponsorWallet: sponsorAddress,
      instructions: `Send ${Math.ceil(requiredAmount)} of your token (${tokenAddress}) to ${sponsorAddress} before requesting sponsorship.`,
    };
  }

  const availableBalance = await getSelfclawBalance(sponsorKey);
  const available = parseFloat(availableBalance);
  if (available <= 0) {
    return { success: false, error: "No SELFCLAW available in sponsorship wallet." };
  }

  const existing = await db.select().from(sponsoredAgents)
    .where(eq(sponsoredAgents.humanId, humanId));
  if (existing.length >= 3) {
    return { success: false, error: "Maximum of 3 sponsorships per human identity reached." };
  }

  const selfclawForPool = Math.floor(available * 0.5).toString();
  const tokenLower = tokenAddress.toLowerCase();
  const selfclawLower = selfclawAddress.toLowerCase();
  const token0 = tokenLower < selfclawLower ? tokenAddress : selfclawAddress;
  const token1 = tokenLower < selfclawLower ? selfclawAddress : tokenAddress;
  const feeTier = 10000;
  const tickSpacing = 200;
  const v4PoolId = computePoolId(token0, token1, feeTier, tickSpacing);

  try {
    const poolState = await getPoolState(v4PoolId as `0x${string}`);
    if (poolState.liquidity !== '0') {
      return { success: false, error: "A V4 pool already exists for this token pair.", v4PoolId };
    }
  } catch (_e: any) {}

  const nextTokenIdBefore = await getNextPositionTokenId();

  const [sponsorshipReq] = await db.insert(sponsorshipRequests).values({
    humanId,
    publicKey,
    tokenAddress,
    tokenSymbol: botMeta.tokenPlan?.symbol || 'TOKEN',
    tokenAmount,
    selfclawAmount: selfclawForPool,
    v4PoolId,
    status: 'processing',
    source: source || 'platform-executed',
  }).returning();

  console.log(`[platform-economy] Creating V4 pool for agent ${publicKey}: ${tokenAmount} TOKEN + ${selfclawForPool} SELFCLAW`);

  const result = await createPoolAndAddLiquidity({
    tokenA: tokenAddress, tokenB: selfclawAddress,
    amountA: tokenAmount, amountB: selfclawForPool,
    feeTier, privateKey: sponsorKey,
  });

  if (!result.success) {
    await db.update(sponsorshipRequests).set({
      status: 'failed', errorMessage: result.error, updatedAt: new Date(),
    }).where(sql`${sponsorshipRequests.id} = ${sponsorshipReq.id}`);
    return { success: false, error: `Sponsorship failed: ${result.error}` };
  }

  let positionTokenId: string | null = null;
  try {
    if (result.receipt) positionTokenId = extractPositionTokenIdFromReceipt(result.receipt);
    if (!positionTokenId) {
      const nextTokenIdAfter = await getNextPositionTokenId();
      if (nextTokenIdAfter > nextTokenIdBefore) positionTokenId = nextTokenIdBefore.toString();
    }
  } catch (posErr: any) {
    console.error(`[platform-economy] Failed to extract position token ID: ${posErr.message}`);
  }

  await db.update(sponsorshipRequests).set({
    status: 'completed', v4PoolId, positionTokenId,
    txHash: result.txHash || '', completedAt: new Date(), updatedAt: new Date(),
  }).where(sql`${sponsorshipRequests.id} = ${sponsorshipReq.id}`);

  try {
    await db.insert(sponsoredAgents).values({
      humanId, publicKey, tokenAddress,
      tokenSymbol: botMeta.tokenPlan?.symbol || 'TOKEN',
      poolAddress: v4PoolId, v4PositionTokenId: positionTokenId,
      poolVersion: 'v4', sponsoredAmountCelo: selfclawForPool,
      sponsorTxHash: result.txHash || '', status: 'completed', completedAt: new Date(),
    });
  } catch (dbErr: any) {
    console.warn(`[platform-economy] Failed to insert sponsored agent: ${dbErr.message}`);
  }

  try {
    await db.insert(trackedPools).values({
      poolAddress: v4PoolId, tokenAddress,
      tokenSymbol: botMeta.tokenPlan?.symbol || 'TOKEN',
      tokenName: botMeta.tokenPlan?.name || 'Token',
      pairedWith: 'SELFCLAW', humanId,
      agentPublicKey: publicKey, feeTier,
      v4PositionTokenId: positionTokenId, poolVersion: 'v4',
      v4PoolId, initialCeloLiquidity: selfclawForPool,
      initialTokenLiquidity: tokenAmount,
    }).onConflictDoNothing();
  } catch (e: any) {
    console.warn(`[platform-economy] Failed to track pool: ${e.message}`);
  }

  let remainingTransferTx: string | null = null;
  const transferTarget = walletAddress;
  if (transferTarget) {
    try {
      const remainingBalance = await getTokenBalance(tokenAddress, 18, sponsorKey);
      const remaining = parseFloat(remainingBalance);
      if (remaining > 0) {
        const { encodeFunctionData, parseUnits: viemParseUnits } = await import("viem");

        const viemClient = getPublicClient(chain);
        const sponsorWalletClient = getChainWalletClient(chain);

        const transferData = encodeFunctionData({
          abi: [{
            name: 'transfer', type: 'function', stateMutability: 'nonpayable',
            inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
            outputs: [{ name: '', type: 'bool' }],
          }],
          functionName: 'transfer',
          args: [transferTarget as `0x${string}`, viemParseUnits(remainingBalance, 18)],
        });

        remainingTransferTx = await sponsorWalletClient.sendTransaction({
          account: sponsorWalletClient.account!,
          chain: getChainConfig(chain).viemChain,
          to: tokenAddress as `0x${string}`,
          data: transferData,
        });
        await viemClient.waitForTransactionReceipt({ hash: remainingTransferTx as `0x${string}` });
        console.log(`[platform-economy] Transferred remaining ${remainingBalance} tokens to ${transferTarget} (tx: ${remainingTransferTx})`);
      }
    } catch (transferErr: any) {
      console.warn(`[platform-economy] Failed to transfer remaining tokens: ${transferErr.message}`);
    }
  }

  await logActivity("selfclaw_sponsorship", humanId, publicKey, agentName, {
    tokenAddress, selfclawAmount: selfclawForPool, v4PoolId, positionTokenId, remainingTransferTx, method: source || "platform-executed",
  });

  return {
    success: true,
    v4PoolId,
    positionTokenId,
    txHash: result.txHash,
    selfclawAmount: selfclawForPool,
    remainingTransferTx,
    chain,
  };
}
