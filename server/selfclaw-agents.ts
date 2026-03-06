import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { verifiedBots, agentWallets, trackedPools, agentActivity, tokenPriceSnapshots, sponsoredAgents, users, agentPosts, agentServices, tokenPlans, revenueEvents, reputationStakes, reputationBadges, insuranceStakes, marketSkills, pocScores } from "../shared/schema.js";
import { eq, and, gt, lt, desc, count, inArray, sql } from "drizzle-orm";
import { publicApiLimiter, verificationLimiter, feedbackLimiter, feedbackCooldowns, authenticateAgentRequest as authenticateAgent, logActivity } from "./routes/_shared.js";
import { isValidChain, getExplorerUrl as chainExplorerUrl, type SupportedChain } from '../lib/chains.js';

const router = Router();

let _erc8004Service: any = null;
async function getErc8004Service() {
  if (!_erc8004Service) {
    const mod = await import("../lib/erc8004.js");
    _erc8004Service = mod.erc8004Service;
  }
  return _erc8004Service;
}

async function lazyPriceOracle() {
  return await import("../lib/price-oracle.js");
}

let tokenListingsCache: { data: any; timestamp: number } | null = null;
const TOKEN_LISTINGS_CACHE_TTL = 3 * 60 * 1000;

router.get("/v1/agent", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const publicKey = req.query.publicKey as string;
    const name = req.query.name as string;
    
    if (!publicKey && !name) {
      return res.status(400).json({ error: "Missing publicKey or name query parameter" });
    }
    
    const identifier = publicKey || name;
    
    let agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${identifier}`)
      .limit(1);
    
    if (agents.length === 0) {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.deviceId} = ${identifier}`)
        .limit(1);
    }
    
    const foundAgent = agents[0];

    if (!foundAgent) {
      return res.json({
        verified: false,
        publicKey: identifier,
        message: "Agent not found in registry"
      });
    }

    const erc8004Service = await getErc8004Service();
    const qMeta = foundAgent.metadata as any || {};
    const { zkProof: qZkProof, ...qPublicMetadata } = qMeta;

    const qRepData: any = {
      hasErc8004: !!qPublicMetadata.erc8004TokenId,
      endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/reputation`,
      registryAddress: erc8004Service.getReputationRegistryAddress()
    };
    if (qPublicMetadata.erc8004TokenId) {
      qRepData.erc8004TokenId = qPublicMetadata.erc8004TokenId;
      qRepData.attestation = qPublicMetadata.erc8004Attestation || null;
    }

    const { erc8004TokenId: _qt, erc8004Attestation: _qa, ...qCleanMetadata } = qPublicMetadata;

    res.json({
      verified: true,
      publicKey: foundAgent.publicKey,
      agentName: foundAgent.deviceId,
      humanId: foundAgent.humanId,
      selfxyz: {
        verified: true,
        registeredAt: foundAgent.verifiedAt
      },
      proof: {
        available: !!qZkProof,
        hash: qZkProof?.proofHash || null,
        endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/proof`
      },
      reputation: qRepData,
      swarm: foundAgent.humanId ? `https://selfclaw.ai/human/${foundAgent.humanId}` : null,
      metadata: qCleanMetadata,
      economy: {
        enabled: true,
        playbook: "https://selfclaw.ai/agent-economy.md",
        recommendedPath: "platform-executed",
        note: "The playbook covers two paths: Platform-Executed (recommended, no crypto libraries) and Self-Custody (advanced). Use platform tools like deploy_token, register_erc8004, and request_sponsorship with your Bearer API key.",
        sponsorshipSimulator: "GET /api/selfclaw/v1/sponsorship-simulator?totalSupply=1000000&liquidityTokens=100000",
        referencePrices: "GET /api/selfclaw/v1/prices/reference",
        capabilities: ["deploy_token", "create_liquidity_pool", "swap_tokens", "track_economics", "invoke_skill", "erc8004_identity"]
      }
    });
  } catch (error) {
    console.error("Query param agent lookup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/agent/:identifier/proof", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;

    if (!identifier || identifier.length < 2) {
      return res.status(400).json({ error: "Invalid identifier" });
    }

    let agents: any[] = [];
    try {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${identifier}`)
        .limit(1);
    } catch (dbError) {
      console.error("[selfclaw] DB error on proof lookup:", dbError);
    }

    if (agents.length === 0) {
      try {
        agents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.deviceId} = ${identifier}`)
          .limit(1);
      } catch (dbError) {
        console.error("[selfclaw] DB error on proof deviceId lookup:", dbError);
      }
    }

    const foundAgent = agents[0];
    if (!foundAgent || foundAgent.hidden === true) {
      return res.status(404).json({ error: "Agent not found in registry" });
    }

    const agentMeta = foundAgent.metadata as any || {};
    const zkProof = agentMeta.zkProof;

    if (!zkProof) {
      return res.json({
        publicKey: foundAgent.publicKey,
        proofAvailable: false,
        message: "This agent was verified before proof storage was enabled. The verification is valid but the raw proof is not available for independent re-verification."
      });
    }

    res.json({
      publicKey: foundAgent.publicKey,
      humanId: foundAgent.humanId,
      proofAvailable: true,
      verifiedAt: zkProof.verifiedAt,
      proofHash: zkProof.proofHash,
      attestationId: zkProof.attestationId,
      proof: zkProof.proof,
      publicSignals: zkProof.publicSignals,
      verification: {
        method: "selfxyz",
        description: "Zero-knowledge passport proof via Self.xyz. Verify independently using the Self.xyz SDK.",
        howToVerify: [
          "Install @selfxyz/core: npm install @selfxyz/core",
          "Import SelfBackendVerifier from @selfxyz/core",
          "Create verifier with scope 'selfclaw-verify' and attestationId 'selfclaw-passport'",
          "Call verifier.verify(attestationId, proof, publicSignals) with the data above",
          "If isValid is true, the agent's human backing is cryptographically confirmed"
        ],
        sdkDocs: "https://docs.self.xyz"
      }
    });
  } catch (error: any) {
    console.error("[selfclaw] proof lookup error:", error);
    return res.status(500).json({ error: "Proof lookup failed" });
  }
});

router.get("/v1/agent/:identifier/reputation", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;

    if (!identifier || identifier.length < 2) {
      return res.status(400).json({ error: "Invalid identifier" });
    }

    let agentRecords: any[] = [];
    agentRecords = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${identifier}`)
      .limit(1);

    if (agentRecords.length === 0) {
      agentRecords = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.deviceId} = ${identifier}`)
        .limit(1);
    }

    const agent = agentRecords[0];
    if (!agent || agent.hidden === true) {
      return res.status(404).json({ error: "Agent not found in registry" });
    }

    const erc8004Service = await getErc8004Service();
    const meta = agent.metadata as any || {};
    const tokenId = meta.erc8004TokenId;

    if (!tokenId) {
      return res.json({
        publicKey: agent.publicKey,
        humanId: agent.humanId,
        hasErc8004: false,
        message: "This agent does not have an ERC-8004 identity NFT. Mint one first to build onchain reputation.",
        reputationRegistry: erc8004Service.getReputationRegistryAddress()
      });
    }

    const [summary, feedback] = await Promise.all([
      erc8004Service.getReputationSummary(tokenId),
      erc8004Service.readAllFeedback(tokenId)
    ]);

    res.json({
      publicKey: agent.publicKey,
      humanId: agent.humanId,
      erc8004TokenId: tokenId,
      hasErc8004: true,
      reputationRegistry: erc8004Service.getReputationRegistryAddress(),
      attestation: meta.erc8004Attestation || null,
      summary: summary || { totalFeedback: 0, averageScore: 0, lastUpdated: 0 },
      feedback: feedback || [],
      explorerUrl: erc8004Service.getExplorerUrl(tokenId)
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent/:identifier/registration.json", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier as string;
    const regAgents = await db.select()
      .from(verifiedBots)
      .where(
        sql`${verifiedBots.publicKey} = ${identifier} OR ${verifiedBots.deviceId} = ${identifier}`
      )
      .limit(1);
    
    if (!regAgents.length || regAgents[0].hidden === true) {
      return res.status(404).json({ error: "Agent not found" });
    }
    
    const regAgent = regAgents[0];
    const regMetadata = (regAgent.metadata as Record<string, any>) || {};
    
    if (!regMetadata.erc8004RegistrationJson) {
      return res.status(404).json({ error: "No ERC-8004 registration file generated yet" });
    }
    
    const regJson = { ...regMetadata.erc8004RegistrationJson };

    if (regMetadata.erc8004TokenId != null && !regJson.registrations) {
      const { ERC8004_CONFIG } = await import("../lib/erc8004-config.js");
      const config = ERC8004_CONFIG.active;
      regJson.registrations = [{
        agentId: Number(regMetadata.erc8004TokenId),
        agentRegistry: `eip155:${config.chainId}:${config.identityRegistry}`,
      }];
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(regJson);
  } catch (error: any) {
    console.error("[selfclaw] registration.json error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent/:identifier", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    
    if (!identifier || identifier.length < 2) {
      return res.json({
        verified: false,
        publicKey: identifier || "",
        message: "Invalid identifier"
      });
    }
    
    let agents: any[] = [];
    
    try {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${identifier}`)
        .limit(1);
    } catch (dbError) {
      console.error("[selfclaw] DB error on publicKey lookup:", dbError);
    }
    
    if (agents.length === 0) {
      try {
        agents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.deviceId} = ${identifier}`)
          .limit(1);
      } catch (dbError) {
        console.error("[selfclaw] DB error on deviceId lookup:", dbError);
      }
    }
    
    const foundAgent = agents[0];

    if (!foundAgent || foundAgent.hidden === true) {
      return res.json({
        verified: false,
        publicKey: identifier,
        message: "Agent not found in registry"
      });
    }

    const erc8004Service = await getErc8004Service();
    const meta = foundAgent.metadata as any || {};
    const { zkProof, ...publicMetadata } = meta;

    const reputationData: any = {
      hasErc8004: !!publicMetadata.erc8004TokenId,
      endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/reputation`,
      registryAddress: erc8004Service.getReputationRegistryAddress()
    };
    if (publicMetadata.erc8004TokenId) {
      reputationData.erc8004TokenId = publicMetadata.erc8004TokenId;
      reputationData.attestation = publicMetadata.erc8004Attestation || null;
    }

    const { erc8004TokenId: _t, erc8004Attestation: _a, ...cleanMetadata } = publicMetadata;

    let builderContext: any = null;
    if (meta.provider === 'talent' || meta.talentLinked) {
      builderContext = {
        displayName: meta.displayName || null,
        bio: meta.bio || null,
        imageUrl: meta.imageUrl || null,
        github: meta.github || null,
        twitter: meta.twitter || null,
        linkedin: meta.linkedin || null,
        location: meta.location || null,
        builderScore: meta.builderScore ?? null,
        builderRank: meta.builderRank ?? null,
        tags: meta.tags || [],
        credentials: meta.credentials || [],
      };
    }

    let insuranceCoverage: any = null;
    try {
      const activeBonds = await db.select()
        .from(insuranceStakes)
        .where(and(
          eq(insuranceStakes.insuredPublicKey, foundAgent.publicKey),
          eq(insuranceStakes.status, "active"),
        ));
      if (activeBonds.length > 0) {
        const totalCoverage = activeBonds.reduce((sum, b) => sum + parseFloat(b.bondAmount), 0);
        insuranceCoverage = {
          bondCount: activeBonds.length,
          totalCoverage: totalCoverage.toString(),
          scopes: [...new Set(activeBonds.map(b => b.scope))],
        };
      }
    } catch (e) {}

    res.json({
      verified: true,
      publicKey: foundAgent.publicKey,
      agentName: foundAgent.deviceId,
      humanId: foundAgent.humanId,
      selfxyz: {
        verified: true,
        registeredAt: foundAgent.verifiedAt
      },
      proof: {
        available: !!zkProof,
        hash: zkProof?.proofHash || null,
        endpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(foundAgent.publicKey)}/proof`
      },
      reputation: reputationData,
      builderContext,
      insurance: insuranceCoverage,
      swarm: foundAgent.humanId ? `https://selfclaw.ai/human/${foundAgent.humanId}` : null,
      metadata: cleanMetadata,
      economy: {
        enabled: true,
        playbook: "https://selfclaw.ai/agent-economy.md",
        recommendedPath: "platform-executed",
        note: "The playbook covers two paths: Platform-Executed (recommended, no crypto libraries) and Self-Custody (advanced). Use platform tools like deploy_token, register_erc8004, and request_sponsorship with your Bearer API key.",
        sponsorshipSimulator: "GET /api/selfclaw/v1/sponsorship-simulator?totalSupply=1000000&liquidityTokens=100000",
        referencePrices: "GET /api/selfclaw/v1/prices/reference",
        capabilities: ["deploy_token", "create_liquidity_pool", "swap_tokens", "track_economics", "invoke_skill", "erc8004_identity"]
      }
    });
  } catch (error: any) {
    console.error("[selfclaw] agent lookup error:", error);
    return res.json({
      verified: false,
      publicKey: req.params.identifier || "",
      message: "Lookup failed"
    });
  }
});

router.get("/v1/bot/:identifier", async (req: Request, res: Response) => {
  res.redirect(301, `/api/selfclaw/v1/agent/${req.params.identifier}`);
});

router.get("/v1/human/:humanId", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { humanId } = req.params;
    
    const agents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.humanId} = ${humanId}`);

    res.json({
      humanId,
      agentCount: agents.length,
      agents: agents.map(agent => ({
        publicKey: agent.publicKey,
        agentName: agent.deviceId,
        verifiedAt: agent.verifiedAt
      }))
    });
  } catch (error: any) {
    console.error("[selfclaw] human lookup error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/lookup/:identifier", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier.trim();
    if (!identifier || identifier.length < 2) {
      return res.status(400).json({ success: false, error: "Identifier too short" });
    }

    let identifierType: "wallet" | "humanId" | "publicKey" | "agentName" = "agentName";
    let matchedAgents: any[] = [];

    const isWallet = /^0x[a-fA-F0-9]{40}$/.test(identifier);
    const isLikelyPublicKey = identifier.length >= 40 && !isWallet;

    const notHidden = sql`${verifiedBots.hidden} IS NOT TRUE`;

    if (isWallet) {
      identifierType = "wallet";
      const walletRows = await db.select({
        publicKey: agentWallets.publicKey,
        humanId: agentWallets.humanId,
      }).from(agentWallets).where(sql`LOWER(${agentWallets.address}) = LOWER(${identifier})`);

      if (walletRows.length > 0) {
        const pks = walletRows.map(w => w.publicKey).filter(Boolean) as string[];
        if (pks.length > 0) {
          matchedAgents = await db.select()
            .from(verifiedBots)
            .where(sql`${verifiedBots.publicKey} IN (${sql.join(pks.map(p => sql`${p}`), sql`, `)}) AND ${notHidden}`);
        }
      }

      if (matchedAgents.length === 0) {
        const userRows = await db.select({ humanId: users.humanId })
          .from(users)
          .where(sql`LOWER(${users.walletAddress}) = LOWER(${identifier})`)
          .limit(1);
        if (userRows.length > 0 && userRows[0].humanId) {
          matchedAgents = await db.select()
            .from(verifiedBots)
            .where(sql`${verifiedBots.humanId} = ${userRows[0].humanId} AND ${notHidden}`);
        }
      }
    } else if (isLikelyPublicKey) {
      identifierType = "publicKey";
      matchedAgents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${identifier} AND ${notHidden}`);

      if (matchedAgents.length === 0) {
        identifierType = "humanId";
        matchedAgents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.humanId} = ${identifier} AND ${notHidden}`);
      }
    } else {
      identifierType = "agentName";
      matchedAgents = await db.select()
        .from(verifiedBots)
        .where(sql`LOWER(${verifiedBots.deviceId}) = LOWER(${identifier}) AND ${notHidden}`);

      if (matchedAgents.length === 0) {
        identifierType = "humanId";
        matchedAgents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.humanId} = ${identifier} AND ${notHidden}`);
      }
    }

    const agentPks = matchedAgents.map(a => a.publicKey);
    let pocMap: Record<string, any> = {};
    if (agentPks.length > 0) {
      const scores = await db.select().from(pocScores).where(inArray(pocScores.agentPublicKey, agentPks));
      for (const s of scores) {
        pocMap[s.agentPublicKey] = s;
      }
    }

    let walletMap: Record<string, string> = {};
    if (agentPks.length > 0) {
      const wallets = await db.select({
        publicKey: agentWallets.publicKey,
        address: agentWallets.address,
      }).from(agentWallets).where(inArray(agentWallets.publicKey, agentPks));
      for (const w of wallets) {
        if (w.publicKey) walletMap[w.publicKey] = w.address ?? "";
      }
    }

    const agents = matchedAgents.map(a => {
      const poc = pocMap[a.publicKey];
      return {
        publicKey: a.publicKey,
        agentName: a.deviceId,
        verified: !!a.verifiedAt,
        verifiedAt: a.verifiedAt,
        walletAddress: walletMap[a.publicKey] || null,
        poc: poc ? {
          totalScore: poc.totalScore,
          grade: poc.grade,
          rank: poc.rank,
          percentile: poc.percentile,
          breakdown: {
            verification: poc.verificationScore ?? 0,
            commerce: poc.commerceScore ?? 0,
            reputation: poc.reputationScore ?? 0,
            build: poc.buildScore ?? 0,
            social: poc.socialScore ?? 0,
            referral: poc.referralScore ?? 0,
          },
          updatedAt: poc.updatedAt,
        } : null,
      };
    });

    res.json({
      success: true,
      identifierType,
      agentCount: agents.length,
      agents,
    });
  } catch (error: any) {
    console.error("[selfclaw] lookup error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/v1/recent", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const recentAgents = await db.select({
      publicKey: verifiedBots.publicKey,
      deviceId: verifiedBots.deviceId,
      verificationLevel: verifiedBots.verificationLevel,
      verifiedAt: verifiedBots.verifiedAt
    })
    .from(verifiedBots)
    .orderBy(sql`${verifiedBots.verifiedAt} DESC`)
    .limit(50);
    
    res.json({ agents: recentAgents });
  } catch (error: any) {
    console.error("[selfclaw] recent error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agents", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const limitParam = Math.min(Number(req.query.limit) || 50, 100);
    
    const agents = await db.select({
      publicKey: verifiedBots.publicKey,
      agentName: verifiedBots.deviceId,
      humanId: verifiedBots.humanId,
      verificationLevel: verifiedBots.verificationLevel,
      verifiedAt: verifiedBots.verifiedAt,
      metadata: verifiedBots.metadata,
      walletAddress: agentWallets.address,
      tokenAddress: trackedPools.tokenAddress,
      tokenSymbol: trackedPools.tokenSymbol,
      tokenName: trackedPools.tokenName,
      poolAddress: trackedPools.poolAddress,
      v4PoolId: trackedPools.v4PoolId,
      poolVersion: trackedPools.poolVersion,
      v4PositionTokenId: trackedPools.v4PositionTokenId,
      currentPriceCelo: trackedPools.currentPriceCelo,
      volume24h: trackedPools.volume24h,
      marketCapCelo: trackedPools.marketCapCelo,
      tokenPlanPurpose: tokenPlans.purpose,
      tokenPlanStatus: tokenPlans.status,
    })
    .from(verifiedBots)
    .leftJoin(agentWallets, sql`${verifiedBots.humanId} = ${agentWallets.humanId}`)
    .leftJoin(trackedPools, sql`${verifiedBots.humanId} = ${trackedPools.humanId} AND ${trackedPools.humanId} != 'platform'`)
    .leftJoin(tokenPlans, sql`${verifiedBots.humanId} = ${tokenPlans.humanId}`)
    .where(sql`${verifiedBots.hidden} IS NOT TRUE`)
    .orderBy(desc(verifiedBots.verifiedAt))
    .limit(limitParam);
    
    const seen = new Set<string>();
    const formattedAgents = agents
      .filter(a => {
        if (seen.has(a.publicKey)) return false;
        seen.add(a.publicKey);
        return true;
      })
      .map(a => ({
        agentName: a.agentName || null,
        publicKey: a.publicKey,
        humanId: a.humanId,
        verificationLevel: a.verificationLevel || 'passport',
        verifiedAt: a.verifiedAt,
        hasErc8004: !!(a.metadata as any)?.erc8004TokenId,
        wallet: a.walletAddress ? { address: a.walletAddress } : null,
        token: a.tokenAddress ? {
          address: a.tokenAddress,
          symbol: a.tokenSymbol,
          name: a.tokenName,
        } : null,
        pool: a.poolAddress ? {
          address: a.poolAddress,
          v4PoolId: a.v4PoolId,
          poolVersion: a.poolVersion || 'v3',
          priceCelo: a.currentPriceCelo,
          volume24h: a.volume24h,
          marketCapCelo: a.marketCapCelo,
          uniswapUrl: a.v4PoolId
            ? `https://app.uniswap.org/explore/pools/celo/${a.v4PoolId}`
            : a.poolAddress ? `https://app.uniswap.org/explore/pools/celo/${a.poolAddress}` : null,
        } : null,
        tokenPlan: a.tokenPlanPurpose ? {
          purpose: a.tokenPlanPurpose,
          status: a.tokenPlanStatus,
        } : null,
        profileUrl: `/agent/${encodeURIComponent(a.agentName || a.publicKey)}`,
      }));
    
    res.json({ agents: formattedAgents, total: formattedAgents.length });
  } catch (error: any) {
    console.error("[selfclaw] agents listing error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent-profile/:name", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    
    let agents = await db.select()
      .from(verifiedBots)
      .where(sql`lower(${verifiedBots.deviceId}) = ${(name || '').toLowerCase()}`)
      .limit(1);
    
    if (agents.length === 0) {
      agents = await db.select()
        .from(verifiedBots)
        .where(sql`${verifiedBots.publicKey} = ${name}`)
        .limit(1);
    }

    if (agents.length === 0) {
      const poolMatch = await db.select({ agentPublicKey: trackedPools.agentPublicKey })
        .from(trackedPools)
        .where(sql`lower(${trackedPools.tokenSymbol}) = ${(name || '').toLowerCase()} OR lower(${trackedPools.tokenName}) = ${(name || '').toLowerCase()}`)
        .limit(1);
      if (poolMatch.length > 0 && poolMatch[0].agentPublicKey) {
        agents = await db.select()
          .from(verifiedBots)
          .where(sql`${verifiedBots.publicKey} = ${poolMatch[0].agentPublicKey}`)
          .limit(1);
      }
    }

    if (agents.length === 0 || agents[0].hidden === true) {
      return res.status(404).json({ error: "Agent not found" });
    }
    
    const agent = agents[0];
    const humanId = agent.humanId;
    const pk = agent.publicKey;
    
    const [walletResults, poolResults, planResults, activityResults, revenueResults, serviceResults, feedResults] = await Promise.all([
      pk ? db.select().from(agentWallets).where(sql`${agentWallets.publicKey} = ${pk}`).limit(1) : Promise.resolve([]),
      pk ? db.select().from(trackedPools).where(sql`${trackedPools.agentPublicKey} = ${pk}`) : Promise.resolve([]),
      pk ? db.select().from(tokenPlans).where(sql`${tokenPlans.agentPublicKey} = ${pk}`).limit(1) : Promise.resolve([]),
      pk ? db.select({
        id: agentActivity.id,
        eventType: agentActivity.eventType,
        agentName: agentActivity.agentName,
        metadata: agentActivity.metadata,
        createdAt: agentActivity.createdAt
      }).from(agentActivity).where(sql`${agentActivity.agentPublicKey} = ${pk} OR (${agentActivity.agentPublicKey} IS NULL AND ${agentActivity.humanId} = ${humanId} AND ${agentActivity.agentName} = ${agent.deviceId})`).orderBy(desc(agentActivity.createdAt)).limit(20) : Promise.resolve([]),
      pk ? db.select().from(revenueEvents).where(sql`${revenueEvents.agentPublicKey} = ${pk}`).orderBy(desc(revenueEvents.createdAt)).limit(20) : Promise.resolve([]),
      pk ? db.select().from(agentServices).where(sql`${agentServices.agentPublicKey} = ${pk} AND ${agentServices.active} = true`).orderBy(desc(agentServices.createdAt)) : Promise.resolve([]),
      pk ? db.select({
        id: agentPosts.id,
        category: agentPosts.category,
        title: agentPosts.title,
        content: agentPosts.content,
        likesCount: agentPosts.likesCount,
        commentsCount: agentPosts.commentsCount,
        createdAt: agentPosts.createdAt,
      }).from(agentPosts).where(sql`${agentPosts.agentPublicKey} = ${pk} AND ${agentPosts.active} = true`).orderBy(desc(agentPosts.createdAt)).limit(10) : Promise.resolve([]),
    ]);
    
    const wallet = walletResults[0] || null;
    const pool = poolResults[0] || null;
    const plan = planResults[0] || null;
    const metadata = agent.metadata as any;

    const revenueTotals: Record<string, number> = {};
    for (const e of revenueResults) {
      revenueTotals[e.token] = (revenueTotals[e.token] || 0) + parseFloat(e.amount);
    }
    
    let livePrice: any = null;
    let reputationData: any = null;
    let identityData: any = null;

    if (pool) {
      const poolId = pool.v4PoolId || pool.poolAddress;
      try {
        const { getAgentTokenPrice, formatPrice, formatMarketCap } = await lazyPriceOracle();
        const priceResult = await getAgentTokenPrice(pool.tokenAddress, poolId, pool.tokenSymbol);
        if (priceResult) {
          livePrice = {
            priceInSelfclaw: priceResult.priceInSelfclaw,
            priceInCelo: priceResult.priceInCelo,
            priceInUsd: priceResult.priceInUsd,
            marketCapUsd: priceResult.marketCapUsd,
            marketCapCelo: priceResult.marketCapCelo,
            totalSupply: priceResult.totalSupply,
            priceFormatted: formatPrice(priceResult.priceInUsd),
            marketCapFormatted: formatMarketCap(priceResult.marketCapUsd),
          };
        }
      } catch (e: any) {
        console.log('[agent-profile] Price fetch failed:', e.message);
      }
    }

    let feedbackEntries: Array<{ rater: string; score: number; decimals: number; tag1: string; tag2: string }> = [];
    const erc8004Service = await getErc8004Service();

    if (metadata?.erc8004TokenId) {
      if (metadata.onchainFeedbackCount !== undefined && metadata.onchainFeedbackCount !== null) {
        reputationData = {
          totalFeedback: metadata.onchainFeedbackCount,
          averageScore: metadata.onchainAvgScore ?? 0,
          lastUpdated: metadata.onchainLastUpdated ?? 0,
        };
      }

      if (metadata.erc8004Owner) {
        identityData = {
          owner: metadata.erc8004Owner,
          uri: metadata.erc8004Uri || '',
        };
      }

      if (metadata.onchainFeedbackCount > 0) {
        try {
          const feedback = await erc8004Service.readAllFeedback(metadata.erc8004TokenId);
          if (feedback) feedbackEntries = feedback;
        } catch (e: any) {
          console.log('[agent-profile] ERC-8004 feedback fetch failed:', e.message);
        }
      }
    }

    let profileBuilderContext: any = null;
    if (metadata?.provider === 'talent' || metadata?.talentLinked) {
      profileBuilderContext = {
        displayName: metadata.displayName || null,
        bio: metadata.bio || null,
        imageUrl: metadata.imageUrl || null,
        github: metadata.github || null,
        twitter: metadata.twitter || null,
        linkedin: metadata.linkedin || null,
        location: metadata.location || null,
        builderScore: metadata.builderScore ?? null,
        builderRank: metadata.builderRank ?? null,
        tags: metadata.tags || [],
        credentials: metadata.credentials || [],
      };
    }

    res.json({
      agent: {
        agentName: agent.deviceId,
        publicKey: agent.publicKey,
        humanId: agent.humanId,
        verificationLevel: agent.verificationLevel || 'passport',
        verifiedAt: agent.verifiedAt,
        builderContext: profileBuilderContext,
        erc8004: metadata?.erc8004TokenId ? {
          tokenId: metadata.erc8004TokenId,
          scanUrl: `https://www.8004scan.io/agents/celo/${metadata.erc8004TokenId}`,
          identity: identityData,
          reputation: reputationData,
          feedback: feedbackEntries,
          lastOnchainSync: metadata.lastOnchainSync || null,
        } : null,
      },
      wallet: wallet ? {
        address: wallet.address,
        gasReceived: wallet.gasReceived,
        chain: wallet.chain || 'celo',
      } : null,
      token: pool ? {
        address: pool.tokenAddress,
        symbol: pool.tokenSymbol,
        name: pool.tokenName,
        chain: pool.chain || 'celo',
      } : null,
      pool: pool ? {
        address: pool.poolAddress,
        v4PoolId: pool.v4PoolId,
        poolVersion: pool.poolVersion || 'v3',
        priceCelo: pool.currentPriceCelo,
        volume24h: pool.volume24h,
        marketCapCelo: pool.marketCapCelo,
        feeTier: pool.feeTier,
        pairedWith: pool.pairedWith,
        chain: pool.chain || 'celo',
      } : null,
      livePrice,
      tokenPlan: plan ? {
        purpose: plan.purpose,
        supplyReasoning: plan.supplyReasoning,
        allocation: plan.allocation,
        utility: plan.utility,
        economicModel: plan.economicModel,
        status: plan.status,
      } : null,
      revenue: {
        totalEvents: revenueResults.length,
        totals: revenueTotals,
        recent: revenueResults.slice(0, 5).map(e => ({
          amount: e.amount,
          token: e.token,
          source: e.source,
          createdAt: e.createdAt,
        })),
      },
      services: serviceResults.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price: s.price,
        currency: s.currency,
        endpoint: s.endpoint,
      })),
      activity: activityResults,
      feedPosts: feedResults.map(p => ({
        id: p.id,
        category: p.category,
        title: p.title,
        content: p.content,
        likesCount: p.likesCount,
        commentsCount: p.commentsCount,
        createdAt: p.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] agent-profile error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/ecosystem-stats", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const [verifiedCount] = await db.select({ count: count() }).from(verifiedBots);
    const [sponsoredCount] = await db.select({ count: count() }).from(sponsoredAgents).where(eq(sponsoredAgents.status, 'completed'));
    const [poolsCount] = await db.select({ count: count() }).from(trackedPools);
    
    res.json({
      verifiedAgents: verifiedCount?.count || 0,
      sponsoredAgents: sponsoredCount?.count || 0,
      trackedPools: poolsCount?.count || 0,
      lastUpdated: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[selfclaw] ecosystem-stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/agent-score/:publicKey", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { computeScoreWithPercentile } = await import("./selfclaw-score.js");
    const score = await computeScoreWithPercentile(req.params.publicKey as string);
    if (!score) return res.status(404).json({ error: "Agent not found or not a verified agent" });
    res.json(score);
  } catch (error: any) {
    console.error("[selfclaw] agent-score error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/score-leaderboard", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { computeAllScores } = await import("./selfclaw-score.js");
    const limitParam = Math.min(Number(req.query.limit) || 50, 100);
    const allScores = await computeAllScores();

    const leaderboard = Array.from(allScores.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, limitParam)
      .map(([publicKey, score], index) => ({
        rank: index + 1,
        publicKey,
        ...score,
      }));

    const agentData = new Map<string, { name: string; erc8004TokenId: string | null; onchainFeedbackCount: number; onchainAvgScore: number; badges: string[] }>();
    if (leaderboard.length > 0) {
      const keys = leaderboard.map(l => l.publicKey);
      const agents = await db.select({
        publicKey: verifiedBots.publicKey,
        deviceId: verifiedBots.deviceId,
        metadata: verifiedBots.metadata,
      }).from(verifiedBots).where(inArray(verifiedBots.publicKey, keys));

      const badgeRows = await db.select({
        agentPublicKey: reputationBadges.agentPublicKey,
        badgeName: reputationBadges.badgeName,
        badgeType: reputationBadges.badgeType,
      }).from(reputationBadges).where(inArray(reputationBadges.agentPublicKey, keys));

      const badgesByAgent = new Map<string, string[]>();
      for (const b of badgeRows) {
        const list = badgesByAgent.get(b.agentPublicKey) || [];
        list.push(b.badgeName || b.badgeType);
        badgesByAgent.set(b.agentPublicKey, list);
      }

      for (const a of agents) {
        const meta = a.metadata as any;
        agentData.set(a.publicKey, {
          name: a.deviceId || "",
          erc8004TokenId: meta?.erc8004TokenId || null,
          onchainFeedbackCount: Number(meta?.onchainFeedbackCount) || 0,
          onchainAvgScore: Number(meta?.onchainAvgScore) || 0,
          badges: badgesByAgent.get(a.publicKey) || [],
        });
      }
    }

    res.json({
      leaderboard: leaderboard.map(l => {
        const data = agentData.get(l.publicKey);
        return {
          ...l,
          agentName: data?.name || "Unknown",
          agentPublicKey: l.publicKey,
          erc8004TokenId: data?.erc8004TokenId || null,
          onchainReputation: {
            feedbackCount: data?.onchainFeedbackCount || 0,
            avgScore: data?.onchainAvgScore || 0,
          },
          badges: data?.badges || [],
        };
      }),
      totalAgents: allScores.size,
    });
  } catch (error: any) {
    console.error("[selfclaw] score-leaderboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/poc/:publicKey", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { getAgentPocScore, computePocScore } = await import("./poc-engine.js");
    const pk = req.params.publicKey as string;
    let cached = await getAgentPocScore(pk);
    if (!cached) {
      const fresh = await computePocScore(pk);
      return res.json({ success: true, cached: false, ...fresh });
    }
    res.json({
      success: true,
      cached: true,
      totalScore: cached.totalScore,
      grade: cached.grade,
      rank: cached.rank,
      percentile: cached.percentile,
      throughput: cached.totalThroughput,
      breakdown: {
        verification: cached.verificationScore ?? 0,
        commerce: cached.commerceScore,
        reputation: cached.reputationScore,
        build: cached.buildScore,
        social: cached.socialScore,
        referral: cached.referralScore,
      },
      updatedAt: cached.updatedAt,
    });
  } catch (error: any) {
    console.error("[selfclaw] poc score error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/poc-leaderboard", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { getPocLeaderboard } = await import("./poc-engine.js");
    const limitParam = Math.min(Number(req.query.limit) || 50, 100);
    const leaderboard = await getPocLeaderboard(limitParam);

    if (leaderboard.length === 0) {
      const { refreshAllPocScores } = await import("./poc-engine.js");
      await refreshAllPocScores();
      const fresh = await getPocLeaderboard(limitParam);
      return res.json({ success: true, leaderboard: fresh, totalAgents: fresh.length });
    }

    res.json({ success: true, leaderboard, totalAgents: leaderboard.length });
  } catch (error: any) {
    console.error("[selfclaw] poc leaderboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/poc-refresh", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { refreshAllPocScores } = await import("./poc-engine.js");
    const count = await refreshAllPocScores();
    res.json({ success: true, agentsScored: count });
  } catch (error: any) {
    console.error("[selfclaw] poc refresh error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/reputation-leaderboard", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const limitParam = Math.min(Number(req.query.limit) || 50, 100);

    const allAgents = await db.select({
      id: verifiedBots.id,
      publicKey: verifiedBots.publicKey,
      deviceId: verifiedBots.deviceId,
      humanId: verifiedBots.humanId,
      verifiedAt: verifiedBots.verifiedAt,
      metadata: verifiedBots.metadata
    })
    .from(verifiedBots)
    .orderBy(desc(verifiedBots.verifiedAt));

    const agentsWithTokens = allAgents.filter(a => {
      const meta = a.metadata as any;
      return meta?.erc8004TokenId;
    });

    if (agentsWithTokens.length === 0) {
      return res.json({
        leaderboard: [],
        totalWithErc8004: 0,
        message: "No agents with ERC-8004 tokens yet"
      });
    }

    const erc8004Service = await getErc8004Service();

    if (!erc8004Service.isReady()) {
      return res.status(503).json({
        error: "ERC-8004 contracts not available",
        totalWithErc8004: agentsWithTokens.length
      });
    }

    let failedQueries = 0;
    const reputationResults = await Promise.allSettled(
      agentsWithTokens.map(async (agent) => {
        const meta = agent.metadata as any;
        const tokenId = meta.erc8004TokenId;
        const summary = await erc8004Service.getReputationSummary(tokenId);
        return {
          publicKey: agent.publicKey,
          agentName: agent.deviceId,
          humanId: agent.humanId,
          erc8004TokenId: tokenId,
          verifiedAt: agent.verifiedAt,
          hasAttestation: !!meta.erc8004Attestation?.txHash,
          reputation: summary || { totalFeedback: 0, averageScore: 0, lastUpdated: 0 },
          explorerUrl: erc8004Service.getExplorerUrl(tokenId),
          reputationEndpoint: `https://selfclaw.ai/api/selfclaw/v1/agent/${encodeURIComponent(agent.publicKey)}/reputation`
        };
      })
    );

    const succeeded: any[] = [];
    for (const r of reputationResults) {
      if (r.status === "fulfilled") {
        succeeded.push(r.value);
      } else {
        failedQueries++;
      }
    }

    const leaderboard = succeeded
      .sort((a, b) => {
        if (b.reputation.averageScore !== a.reputation.averageScore) {
          return b.reputation.averageScore - a.reputation.averageScore;
        }
        return b.reputation.totalFeedback - a.reputation.totalFeedback;
      })
      .slice(0, limitParam)
      .map((entry, index) => ({ rank: index + 1, ...entry }));

    res.json({
      leaderboard,
      totalWithErc8004: agentsWithTokens.length,
      queriedSuccessfully: succeeded.length,
      failedQueries,
      warning: failedQueries > 0 ? `${failedQueries} agent(s) could not be scored due to onchain query failures` : undefined,
      reputationRegistry: erc8004Service.getReputationRegistryAddress(),
      lastUpdated: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation-leaderboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

async function submitOnchainFeedback(opts: {
  targetAgentPublicKey: string;
  targetTokenId: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  reasoning?: string;
  endpoint?: string;
  fromLabel: string;
  fromHumanId?: string;
}): Promise<{ txHash: string; explorerUrl: string }> {
  const { ethers } = await import("ethers");
  const erc8004Service = await getErc8004Service();
  const config = erc8004Service.getConfig();

  const wallet = process.env.CELO_PRIVATE_KEY
    ? new ethers.Wallet(process.env.CELO_PRIVATE_KEY, new ethers.JsonRpcProvider(config.rpcUrl))
    : null;

  if (!wallet) {
    throw new Error("Platform wallet not configured for reputation transactions");
  }

  const feedbackURIData: Record<string, any> = {
    agentRegistry: `eip155:42220:${config.identityRegistry}`,
    agentId: Number(opts.targetTokenId),
    clientAddress: `eip155:42220:${wallet.address}`,
    createdAt: new Date().toISOString(),
    value: String(opts.value),
    valueDecimals: opts.valueDecimals,
    tag1: opts.tag1,
    tag2: opts.tag2,
  };
  if (opts.endpoint) feedbackURIData.endpoint = opts.endpoint;
  if (opts.reasoning) feedbackURIData.reasoning = opts.reasoning;
  if (opts.fromHumanId) feedbackURIData.context = `Feedback from verified human ${opts.fromHumanId.substring(0, 8)}...`;

  if (opts.valueDecimals < 0 || opts.valueDecimals > 18) {
    throw new Error("valueDecimals must be 0-18");
  }

  const feedbackURIJson = JSON.stringify(feedbackURIData);
  const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(feedbackURIJson));
  const feedbackURIEncoded = `data:application/json;base64,${Buffer.from(feedbackURIJson).toString("base64")}`;

  const REPUTATION_ABI = [
    "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external"
  ];
  const reputation = new ethers.Contract(config.resolver, REPUTATION_ABI, wallet);

  const agentEndpoint = opts.endpoint || `https://selfclaw.ai/agent?id=${encodeURIComponent(opts.targetAgentPublicKey)}`;

  const tx = await reputation.giveFeedback(
    opts.targetTokenId,
    BigInt(opts.value),
    opts.valueDecimals,
    opts.tag1,
    opts.tag2,
    agentEndpoint,
    feedbackURIEncoded,
    feedbackHash
  );

  const receipt = await tx.wait();

  console.log(`[selfclaw] Feedback submitted: ${opts.fromLabel} gave value=${opts.value}/${opts.valueDecimals}dec to token#${opts.targetTokenId} tx: ${receipt.hash}`);

  return {
    txHash: receipt.hash,
    explorerUrl: erc8004Service.getTxExplorerUrl(receipt.hash),
  };
}

router.post("/v1/reputation/feedback", feedbackLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { targetAgentPublicKey, score, value, valueDecimals, tag1, tag2, reasoning } = req.body;

    const feedbackValue = value !== undefined ? Number(value) : (score !== undefined ? Number(score) : undefined);
    const feedbackDecimals = valueDecimals !== undefined ? Number(valueDecimals) : 0;

    if (!targetAgentPublicKey || feedbackValue === undefined) {
      return res.status(400).json({
        error: "targetAgentPublicKey and value (or score) are required",
        hint: "v2.0: use value (int128) + valueDecimals (uint8, 0-18). Legacy: score (0-100) still accepted."
      });
    }

    if (isNaN(feedbackValue)) {
      return res.status(400).json({ error: "value/score must be a valid number" });
    }

    if (feedbackDecimals < 0 || feedbackDecimals > 18 || !Number.isInteger(feedbackDecimals)) {
      return res.status(400).json({ error: "valueDecimals must be an integer between 0 and 18" });
    }

    if (targetAgentPublicKey === auth.publicKey) {
      return res.status(400).json({ error: "Cannot submit feedback for your own agent" });
    }

    const cooldownKey = `${auth.publicKey}:${targetAgentPublicKey}`;
    const lastFeedback = feedbackCooldowns.get(cooldownKey);
    if (lastFeedback && Date.now() - lastFeedback < 24 * 60 * 60 * 1000) {
      const hoursLeft = Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - lastFeedback)) / (60 * 60 * 1000));
      return res.status(429).json({
        error: `You already submitted feedback for this agent. Try again in ~${hoursLeft} hour(s).`
      });
    }

    const targetRecords = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${targetAgentPublicKey}`)
      .limit(1);

    if (targetRecords.length === 0) {
      return res.status(404).json({ error: "Target agent not found in registry" });
    }

    const targetMeta = targetRecords[0].metadata as any || {};
    const targetTokenId = targetMeta.erc8004TokenId;

    if (!targetTokenId) {
      return res.status(400).json({
        error: "Target agent does not have an ERC-8004 identity NFT",
        hint: "The target agent must mint an ERC-8004 token before receiving reputation feedback"
      });
    }

    const erc8004Service = await getErc8004Service();

    if (!erc8004Service.isReady()) {
      return res.status(503).json({ error: "ERC-8004 contracts not available" });
    }

    const identity = await erc8004Service.getAgentIdentity(targetTokenId);
    if (!identity) {
      return res.status(400).json({ error: "Target agent's ERC-8004 token not found onchain" });
    }

    const result = await submitOnchainFeedback({
      targetAgentPublicKey,
      targetTokenId,
      value: feedbackValue,
      valueDecimals: feedbackDecimals,
      tag1: tag1 || "peer-review",
      tag2: tag2 || "",
      reasoning: reasoning || undefined,
      fromLabel: auth.publicKey.substring(0, 20) + "...",
      fromHumanId: auth.humanId,
    });

    feedbackCooldowns.set(cooldownKey, Date.now());

    res.json({
      success: true,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      feedback: {
        from: auth.publicKey,
        to: targetAgentPublicKey,
        value: feedbackValue,
        valueDecimals: feedbackDecimals,
        tag1: tag1 || "peer-review",
        tag2: tag2 || ""
      },
      reputationRegistry: erc8004Service.getReputationRegistryAddress()
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation feedback error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/reputation/web-feedback", feedbackLimiter, async (req: any, res: Response) => {
  try {
    if (!req.session?.isAuthenticated || !req.session?.humanId) {
      return res.status(401).json({
        error: "Login required",
        hint: "You must be logged in with Self.xyz passport to submit feedback."
      });
    }

    const humanId = req.session.humanId;
    const { targetAgentPublicKey, value, valueDecimals, tag1, tag2, reasoning } = req.body;

    const feedbackValue = Number(value);
    const feedbackDecimals = valueDecimals !== undefined ? Number(valueDecimals) : 0;

    if (!targetAgentPublicKey || isNaN(feedbackValue)) {
      return res.status(400).json({ error: "targetAgentPublicKey and value are required" });
    }

    if (feedbackValue < 0 || feedbackValue > 100) {
      return res.status(400).json({ error: "value must be between 0 and 100" });
    }

    const myAgents = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.humanId} = ${humanId}`);

    if (myAgents.length === 0) {
      return res.status(403).json({ error: "You need at least one verified agent to submit feedback" });
    }

    const isOwnAgent = myAgents.some(a => a.publicKey === targetAgentPublicKey);
    if (isOwnAgent) {
      return res.status(400).json({ error: "Cannot submit feedback for your own agent" });
    }

    const cooldownKey = `session:${humanId}:${targetAgentPublicKey}`;
    const lastFeedback = feedbackCooldowns.get(cooldownKey);
    if (lastFeedback && Date.now() - lastFeedback < 24 * 60 * 60 * 1000) {
      const hoursLeft = Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - lastFeedback)) / (60 * 60 * 1000));
      return res.status(429).json({
        error: `You already submitted feedback for this agent. Try again in ~${hoursLeft} hour(s).`
      });
    }

    const targetRecords = await db.select()
      .from(verifiedBots)
      .where(sql`${verifiedBots.publicKey} = ${targetAgentPublicKey}`)
      .limit(1);

    if (targetRecords.length === 0) {
      return res.status(404).json({ error: "Target agent not found" });
    }

    const targetMeta = targetRecords[0].metadata as any || {};
    const targetTokenId = targetMeta.erc8004TokenId;

    if (!targetTokenId) {
      return res.status(400).json({ error: "This agent does not have an ERC-8004 identity yet" });
    }

    const erc8004Service = await getErc8004Service();

    if (!erc8004Service.isReady()) {
      return res.status(503).json({ error: "ERC-8004 contracts not available" });
    }

    const result = await submitOnchainFeedback({
      targetAgentPublicKey,
      targetTokenId,
      value: feedbackValue,
      valueDecimals: feedbackDecimals,
      tag1: tag1 || "peer-review",
      tag2: tag2 || "",
      reasoning: reasoning || undefined,
      endpoint: `https://selfclaw.ai/agent?id=${encodeURIComponent(targetAgentPublicKey)}`,
      fromLabel: `session:${humanId.substring(0, 8)}...`,
      fromHumanId: humanId,
    });

    feedbackCooldowns.set(cooldownKey, Date.now());

    logActivity("feedback_submitted", humanId, targetAgentPublicKey, targetRecords[0].deviceId || undefined, {
      value: feedbackValue,
      tag1: tag1 || "peer-review",
      txHash: result.txHash,
    });

    res.json({
      success: true,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      message: "Feedback submitted onchain successfully"
    });
  } catch (error: any) {
    console.error("[selfclaw] web feedback error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/reputation/attest", verificationLimiter, async (req: Request, res: Response) => {
  try {
    const auth = await authenticateAgent(req, res);
    if (!auth) return;

    const { erc8004TokenId } = req.body;

    if (!erc8004TokenId) {
      return res.status(400).json({
        error: "erc8004TokenId is required",
        hint: "The agent must have an ERC-8004 identity NFT"
      });
    }

    const erc8004Service = await getErc8004Service();
    const agentPublicKey = auth.publicKey;
    const agent = auth.agent;
    const meta = agent.metadata as any || {};

    if (meta.erc8004Attestation?.txHash) {
      return res.status(409).json({
        error: "Attestation already submitted for this agent",
        txHash: meta.erc8004Attestation.txHash,
        explorerUrl: erc8004Service.getTxExplorerUrl(meta.erc8004Attestation.txHash)
      });
    }

    if (!erc8004Service.isReady()) {
      return res.status(503).json({ error: "ERC-8004 contracts not available" });
    }

    const identity = await erc8004Service.getAgentIdentity(erc8004TokenId);
    if (!identity) {
      return res.status(400).json({
        error: "ERC-8004 token not found onchain",
        hint: "Ensure the token has been minted on the Identity Registry before submitting attestation"
      });
    }

    const attestation = await erc8004Service.submitVerificationAttestation(erc8004TokenId);

    if (!attestation) {
      return res.status(500).json({ error: "Attestation submission failed" });
    }

    await db.update(verifiedBots)
      .set({
        metadata: {
          ...meta,
          erc8004TokenId,
          erc8004Attestation: {
            txHash: attestation.txHash,
            submittedAt: new Date().toISOString(),
            registryAddress: erc8004Service.getReputationRegistryAddress()
          }
        }
      })
      .where(sql`${verifiedBots.publicKey} = ${agentPublicKey}`);

    console.log("[selfclaw] Reputation attestation submitted for agent:", agentPublicKey, "tokenId:", erc8004TokenId, "tx:", attestation.txHash);

    res.json({
      success: true,
      txHash: attestation.txHash,
      explorerUrl: erc8004Service.getTxExplorerUrl(attestation.txHash),
      reputationRegistry: erc8004Service.getReputationRegistryAddress(),
      message: "SelfClaw verification attestation submitted to ERC-8004 Reputation Registry"
    });
  } catch (error: any) {
    console.error("[selfclaw] reputation attest error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/prices/reference", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { getReferencePrices } = await lazyPriceOracle();
    const prices = await getReferencePrices();
    res.json({
      celoUsd: prices.celoUsd,
      selfclawCelo: prices.selfclawCelo,
      selfclawUsd: prices.selfclawUsd,
      timestamp: prices.timestamp,
    });
  } catch (error: any) {
    console.error("[selfclaw] reference prices error:", error.message);
    res.status(500).json({ error: "Failed to fetch reference prices" });
  }
});

router.get("/v1/agent/:identifier/price", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier);

    const pools = await db.select()
      .from(trackedPools)
      .where(
        sql`${trackedPools.agentPublicKey} = ${identifier} OR ${trackedPools.humanId} = ${identifier} OR lower(${trackedPools.tokenSymbol}) = ${identifier.toLowerCase()}`
      )
      .limit(1);

    if (pools.length === 0) {
      const agents = await db.select().from(verifiedBots)
        .where(sql`lower(${verifiedBots.deviceId}) = ${identifier.toLowerCase()}`)
        .limit(1);

      if (agents.length === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const agentPools = await db.select().from(trackedPools)
        .where(sql`${trackedPools.humanId} = ${agents[0].humanId} OR ${trackedPools.agentPublicKey} = ${agents[0].publicKey}`)
        .limit(1);

      if (agentPools.length === 0) {
        return res.status(404).json({ error: "No token pool found for this agent" });
      }

      pools.push(agentPools[0]);
    }

    const pool = pools[0];
    const poolId = pool.v4PoolId || pool.poolAddress;

    const { getAgentTokenPrice, formatPrice, formatMarketCap } = await lazyPriceOracle();
    const priceData = await getAgentTokenPrice(pool.tokenAddress, poolId, pool.tokenSymbol);

    if (!priceData) {
      return res.status(500).json({ error: "Failed to fetch price" });
    }

    res.json({
      ...priceData,
      priceFormatted: formatPrice(priceData.priceInUsd),
      marketCapFormatted: formatMarketCap(priceData.marketCapUsd),
      poolVersion: pool.poolVersion || 'v3',
    });
  } catch (error: any) {
    console.error("[selfclaw] agent price error:", error.message);
    res.status(500).json({ error: "Failed to fetch agent price" });
  }
});

router.get("/v1/agent/:identifier/price-history", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier);
    const period = (req.query.period as string) || '24h';

    let cutoff: Date;
    switch (period) {
      case '1h': cutoff = new Date(Date.now() - 3600_000); break;
      case '24h': cutoff = new Date(Date.now() - 86400_000); break;
      case '7d': cutoff = new Date(Date.now() - 7 * 86400_000); break;
      case '30d': cutoff = new Date(Date.now() - 30 * 86400_000); break;
      default: cutoff = new Date(Date.now() - 86400_000);
    }

    let tokenAddress: string | null = null;

    const pools = await db.select()
      .from(trackedPools)
      .where(sql`${trackedPools.agentPublicKey} = ${identifier} OR ${trackedPools.humanId} = ${identifier}`)
      .limit(1);

    if (pools.length > 0) {
      tokenAddress = pools[0].tokenAddress;
    } else {
      const agents = await db.select().from(verifiedBots)
        .where(sql`lower(${verifiedBots.deviceId}) = ${identifier.toLowerCase()}`)
        .limit(1);

      if (agents.length > 0) {
        const agentPools = await db.select().from(trackedPools)
          .where(sql`${trackedPools.humanId} = ${agents[0].humanId} OR ${trackedPools.agentPublicKey} = ${agents[0].publicKey}`)
          .limit(1);

        if (agentPools.length > 0) {
          tokenAddress = agentPools[0].tokenAddress;
        }
      }
    }

    if (!tokenAddress) {
      return res.status(404).json({ error: "No token found for this agent" });
    }

    const snapshots = await db.select({
      priceUsd: tokenPriceSnapshots.priceUsd,
      priceCelo: tokenPriceSnapshots.priceCelo,
      marketCapUsd: tokenPriceSnapshots.marketCapUsd,
      createdAt: tokenPriceSnapshots.createdAt,
    })
      .from(tokenPriceSnapshots)
      .where(sql`${tokenPriceSnapshots.tokenAddress} = ${tokenAddress} AND ${tokenPriceSnapshots.createdAt} >= ${cutoff}`)
      .orderBy(tokenPriceSnapshots.createdAt)
      .limit(500);

    res.json({
      tokenAddress,
      period,
      dataPoints: snapshots.map(s => ({
        priceUsd: parseFloat(s.priceUsd || '0'),
        priceCelo: parseFloat(s.priceCelo || '0'),
        marketCapUsd: parseFloat(s.marketCapUsd || '0'),
        timestamp: s.createdAt?.toISOString(),
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] price history error:", error.message);
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

router.get("/v1/postmortem-metrics", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const [[totals], [talentAgents], [talentSignins]] = await Promise.all([
      db.select({
        totalAgents: sql<number>`COUNT(*)`,
        uniqueHumans: sql<number>`COUNT(DISTINCT ${verifiedBots.humanId})`,
      }).from(verifiedBots),
      db.select({
        agents: sql<number>`COUNT(*)`,
        humans: sql<number>`COUNT(DISTINCT ${verifiedBots.humanId})`,
      }).from(verifiedBots).where(sql`${verifiedBots.metadata}->>'provider' = 'talent'`),
      db.select({
        count: sql<number>`COUNT(*)`,
      }).from(users).where(sql`${users.authMethod} = 'talent'`),
    ]);
    res.json({
      totalAgents: Number(totals.totalAgents),
      uniqueHumans: Number(totals.uniqueHumans),
      talentAgents: Number(talentAgents.agents),
      talentHumans: Number(talentAgents.humans),
      talentSignins: Number(talentSignins.count),
    });
  } catch (e: any) {
    console.error("postmortem-metrics error:", e);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

router.get("/v1/token-listings", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    if (tokenListingsCache && Date.now() - tokenListingsCache.timestamp < TOKEN_LISTINGS_CACHE_TTL) {
      return res.json(tokenListingsCache.data);
    }

    const allPools = await db.select().from(trackedPools)
      .where(sql`${trackedPools.humanId} != 'platform'`);

    const pools = allPools.filter(p => !p.hiddenFromRegistry);

    if (pools.length === 0) {
      return res.json({ tokens: [], reference: {} });
    }

    const { getReferencePrices, formatPrice, formatMarketCap } = await lazyPriceOracle();
    const refPrices = await getReferencePrices();

    const cutoff24h = new Date(Date.now() - 86400_000);
    const allSnapshots = await db.select({
      tokenAddress: tokenPriceSnapshots.tokenAddress,
      priceUsd: tokenPriceSnapshots.priceUsd,
      marketCapUsd: tokenPriceSnapshots.marketCapUsd,
      createdAt: tokenPriceSnapshots.createdAt,
    })
      .from(tokenPriceSnapshots)
      .where(sql`${tokenPriceSnapshots.createdAt} >= ${cutoff24h}`)
      .orderBy(tokenPriceSnapshots.createdAt);

    const sparklineMap = new Map<string, number[]>();
    const oldestPriceMap = new Map<string, number>();
    const latestSnapshotPriceMap = new Map<string, number>();
    const latestMarketCapMap = new Map<string, number>();
    for (const s of allSnapshots) {
      const addr = s.tokenAddress.toLowerCase();
      if (!sparklineMap.has(addr)) sparklineMap.set(addr, []);
      const price = parseFloat(s.priceUsd || '0');
      if (price > 0) {
        sparklineMap.get(addr)!.push(price);
        if (!oldestPriceMap.has(addr)) oldestPriceMap.set(addr, price);
        latestSnapshotPriceMap.set(addr, price);
        const mcap = parseFloat(s.marketCapUsd || '0');
        if (mcap > 0) latestMarketCapMap.set(addr, mcap);
      }
    }

    const agentMap = new Map<string, any>();
    const agentKeys = pools.filter(p => p.agentPublicKey).map(p => p.agentPublicKey!);
    if (agentKeys.length > 0) {
      const agents = await db.select({ publicKey: verifiedBots.publicKey, deviceId: verifiedBots.deviceId }).from(verifiedBots)
        .where(inArray(verifiedBots.publicKey, agentKeys));
      for (const a of agents) {
        agentMap.set(a.publicKey, a.deviceId);
      }
    }

    const tokens = pools.map((pool) => {
      const addr = pool.tokenAddress.toLowerCase();
      const sparkline = sparklineMap.get(addr) || [];
      const oldestPrice = oldestPriceMap.get(addr) || 0;
      const currentPrice = latestSnapshotPriceMap.get(addr) || 0;
      const change24h = oldestPrice > 0 && currentPrice > 0 ? ((currentPrice - oldestPrice) / oldestPrice) * 100 : 0;
      const agentName = pool.agentPublicKey ? agentMap.get(pool.agentPublicKey) || null : null;

      const marketCapUsd = latestMarketCapMap.get(addr) || 0;

      return {
        rank: 0,
        tokenName: pool.displayNameOverride || pool.tokenName || pool.tokenSymbol,
        tokenSymbol: pool.displaySymbolOverride || pool.tokenSymbol,
        tokenAddress: pool.tokenAddress,
        agentName,
        priceUsd: currentPrice,
        priceFormatted: formatPrice(currentPrice),
        change24h: Math.round(change24h * 100) / 100,
        marketCapUsd,
        marketCapFormatted: formatMarketCap(marketCapUsd),
        poolVersion: pool.poolVersion || 'v4',
        v4PoolId: pool.v4PoolId,
        uniswapUrl: pool.v4PoolId
          ? `https://app.uniswap.org/explore/pools/${pool.chain || 'celo'}/${pool.v4PoolId}`
          : `https://app.uniswap.org/explore/pools/${pool.chain || 'celo'}/${pool.poolAddress}`,
        explorerUrl: chainExplorerUrl((pool.chain || 'celo') as SupportedChain, 'token', pool.tokenAddress),
        sparkline,
        profileUrl: `/agent/${encodeURIComponent(agentName || pool.agentPublicKey || pool.tokenSymbol)}`,
      };
    }).sort((a, b) => b.marketCapUsd - a.marketCapUsd);

    tokens.forEach((t, i) => { t.rank = i + 1; });

    const response = {
      tokens,
      reference: {
        celoUsd: refPrices.celoUsd,
        selfclawCelo: refPrices.selfclawCelo,
        selfclawUsd: refPrices.selfclawUsd,
      },
      updatedAt: new Date().toISOString(),
    };

    tokenListingsCache = { data: response, timestamp: Date.now() };

    res.json(response);
  } catch (error: any) {
    console.error("[selfclaw] token-listings error:", error.message);
    res.status(500).json({ error: "Failed to fetch token listings" });
  }
});

router.get("/v1/prices/all-agents", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const allPools = await db.select().from(trackedPools)
      .where(sql`${trackedPools.humanId} != 'platform'`);

    const { getAllAgentTokenPrices, getReferencePrices, formatPrice, formatMarketCap } = await lazyPriceOracle();
    const prices = await getAllAgentTokenPrices(allPools.map(p => ({
      tokenAddress: p.tokenAddress,
      v4PoolId: p.v4PoolId,
      poolAddress: p.poolAddress,
      tokenSymbol: p.tokenSymbol,
      poolVersion: p.poolVersion,
    })));

    const refPrices = await getReferencePrices();

    res.json({
      reference: {
        celoUsd: refPrices.celoUsd,
        selfclawCelo: refPrices.selfclawCelo,
        selfclawUsd: refPrices.selfclawUsd,
      },
      agents: prices.map(p => ({
        ...p,
        priceFormatted: formatPrice(p.priceInUsd),
        marketCapFormatted: formatMarketCap(p.marketCapUsd),
      })),
    });
  } catch (error: any) {
    console.error("[selfclaw] all-agent prices error:", error.message);
    res.status(500).json({ error: "Failed to fetch prices" });
  }
});

async function snapshotPrices() {
  try {
    const allPools = await db.select().from(trackedPools)
      .where(sql`${trackedPools.humanId} != 'platform'`);
    if (allPools.length === 0) return;

    const { getAllAgentTokenPrices } = await lazyPriceOracle();
    const prices = await Promise.race([
      getAllAgentTokenPrices(allPools.map(p => ({
        tokenAddress: p.tokenAddress,
        v4PoolId: p.v4PoolId,
        poolAddress: p.poolAddress,
        tokenSymbol: p.tokenSymbol,
        poolVersion: p.poolVersion,
      }))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Price fetch timeout')), 30_000)),
    ]);

    let inserted = 0;
    for (const p of prices) {
      if (p.priceInUsd <= 0 && p.priceInCelo <= 0) continue;
      const safeNum = (v: number) => typeof v === 'number' && isFinite(v) ? v : 0;
      const priceUsd = safeNum(p.priceInUsd);
      const priceCelo = safeNum(p.priceInCelo);
      const priceSelfclaw = safeNum(p.priceInSelfclaw);
      const marketCapUsd = safeNum(p.marketCapUsd);
      if (priceUsd <= 0 && priceCelo <= 0) continue;
      try {
        await db.insert(tokenPriceSnapshots).values({
          tokenAddress: p.tokenAddress,
          tokenSymbol: p.tokenSymbol,
          poolId: p.poolId,
          priceUsd: priceUsd.toFixed(12),
          priceCelo: priceCelo.toFixed(12),
          priceSelfclaw: priceSelfclaw.toFixed(12),
          marketCapUsd: marketCapUsd.toFixed(2),
          totalSupply: p.totalSupply || '0',
          liquidity: p.liquidity || '0',
        });
        inserted++;
      } catch (insertErr: any) {
        console.error('[price-oracle] Snapshot insert error:', insertErr.message);
      }
    }

    console.log(`[price-oracle] Snapshot saved: ${inserted}/${prices.length} tokens (skipped ${prices.length - inserted} zero-price)`);
  } catch (error: any) {
    console.error('[price-oracle] Snapshot error:', error.message);
  }
}

async function pruneOldSnapshots() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.delete(tokenPriceSnapshots).where(lt(tokenPriceSnapshots.createdAt, cutoff));
    console.log('[price-oracle] Old snapshots pruned (>7 days)');
  } catch (error: any) {
    console.error('[price-oracle] Prune error:', error.message);
  }
}

async function startPriceOracle(attempt = 1): Promise<void> {
  try {
    await pruneOldSnapshots();
    await snapshotPrices();
    setInterval(() => snapshotPrices().catch(() => {}), 30 * 60 * 1000);
    setInterval(() => pruneOldSnapshots().catch(() => {}), 24 * 60 * 60 * 1000);
  } catch (err: any) {
    if (attempt < 3) {
      const delay = attempt * 15_000;
      console.log(`[price-oracle] Startup attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
      setTimeout(() => startPriceOracle(attempt + 1).catch(() => {}), delay);
    } else {
      console.error('[price-oracle] Failed to start after 3 attempts:', err.message);
      setInterval(() => snapshotPrices().catch(() => {}), 30 * 60 * 1000);
      setInterval(() => pruneOldSnapshots().catch(() => {}), 24 * 60 * 60 * 1000);
    }
  }
}

setTimeout(() => startPriceOracle().catch(() => {}), 10_000);

router.get("/v1/badge/:identifier.png", async (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier);
    const agent = await db.select().from(verifiedBots)
      .where(sql`${verifiedBots.deviceId} = ${identifier} OR ${verifiedBots.publicKey} = ${identifier} OR ${verifiedBots.metadata}->>'agentName' = ${identifier}`)
      .limit(1);

    if (agent.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const a = agent[0];
    const meta = (a.metadata as Record<string, any>) || {};
    const agentName = a.deviceId || meta.agentName || identifier.substring(0, 16);
    const truncatedKey = a.publicKey.substring(0, 12) + "..." + a.publicKey.slice(-8);
    const verifiedDate = a.verifiedAt ? new Date(a.verifiedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const nationality = (a.metadata as any)?.nationality || null;
    const flagCode = nationality ? nationality.toUpperCase() : null;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&amp;display=swap');
    </style>
  </defs>
  <rect width="1200" height="675" fill="#f2f0ec"/>
  <rect x="0" y="0" width="1200" height="4" fill="#1a1a1a"/>
  <rect x="0" y="671" width="1200" height="4" fill="#1a1a1a"/>

  <!-- Claw marks background -->
  <g opacity="0.06" transform="translate(850, 80) rotate(-15)">
    <rect x="0" y="0" width="8" height="280" rx="4" fill="#1a1a1a"/>
    <rect x="30" y="20" width="8" height="300" rx="4" fill="#1a1a1a"/>
    <rect x="60" y="10" width="8" height="290" rx="4" fill="#1a1a1a"/>
  </g>

  <!-- VERIFIED badge -->
  <rect x="60" y="50" width="180" height="32" fill="#22c55e"/>
  <text x="150" y="72" font-family="'IBM Plex Mono', monospace" font-size="14" font-weight="700" fill="white" text-anchor="middle" letter-spacing="0.12em">VERIFIED AGENT</text>

  <!-- Agent name -->
  <text x="60" y="145" font-family="'IBM Plex Mono', monospace" font-size="52" font-weight="700" fill="#1a1a1a">${escapeXml(agentName)}</text>

  <!-- Public key -->
  <text x="60" y="190" font-family="'IBM Plex Mono', monospace" font-size="16" fill="#888">${truncatedKey}</text>

  <!-- Passport section -->
  <rect x="60" y="230" width="500" height="180" fill="none" stroke="#d4d0ca" stroke-width="2"/>
  <text x="80" y="260" font-family="'IBM Plex Mono', monospace" font-size="11" font-weight="600" fill="#888" letter-spacing="0.1em">PASSPORT VERIFICATION</text>

  <text x="80" y="295" font-family="'IBM Plex Mono', monospace" font-size="14" fill="#1a1a1a">Identity: <tspan font-weight="600">Verified via Self.xyz ZKP</tspan></text>
  <text x="80" y="320" font-family="'IBM Plex Mono', monospace" font-size="14" fill="#1a1a1a">Method: <tspan font-weight="600">NFC Passport Chip</tspan></text>
  ${flagCode ? `<text x="80" y="345" font-family="'IBM Plex Mono', monospace" font-size="14" fill="#1a1a1a">Nationality: <tspan font-weight="600">${escapeXml(flagCode)}</tspan></text>` : ''}
  <text x="80" y="${flagCode ? '370' : '345'}" font-family="'IBM Plex Mono', monospace" font-size="14" fill="#1a1a1a">Verified: <tspan font-weight="600">${escapeXml(verifiedDate)}</tspan></text>
  <text x="80" y="${flagCode ? '395' : '370'}" font-family="'IBM Plex Mono', monospace" font-size="14" fill="#888">No personal data stored — zero-knowledge proof only</text>

  <!-- Redacted fields -->
  <rect x="600" y="280" width="180" height="14" rx="2" fill="#d4d0ca"/>
  <rect x="600" y="305" width="140" height="14" rx="2" fill="#d4d0ca"/>
  <rect x="600" y="330" width="160" height="14" rx="2" fill="#d4d0ca"/>
  <rect x="600" y="355" width="120" height="14" rx="2" fill="#d4d0ca"/>
  <text x="600" y="260" font-family="'IBM Plex Mono', monospace" font-size="10" fill="#aaa" letter-spacing="0.08em">REDACTED</text>

  <!-- Tagline -->
  <text x="60" y="480" font-family="'IBM Plex Mono', monospace" font-size="20" fill="#1a1a1a">One passport. One wallet.</text>
  <text x="60" y="510" font-family="'IBM Plex Mono', monospace" font-size="20" font-weight="700" fill="#1a1a1a">One composable agent identity.</text>

  <!-- Branding -->
  <g transform="translate(60, 570)">
    <line x1="0" y1="0" x2="12" y2="20" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="8" y1="0" x2="20" y2="22" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="16" y1="0" x2="28" y2="20" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
    <text x="36" y="18" font-family="'IBM Plex Mono', monospace" font-size="16" font-weight="700" fill="#1a1a1a" letter-spacing="0.15em">SELFCLAW</text>
  </g>

  <g transform="translate(1020, 570)">
    <text x="0" y="18" font-family="'IBM Plex Mono', monospace" font-size="13" fill="#888">selfclaw.ai</text>
  </g>
</svg>`;

    // @ts-ignore — optional dependency, gracefully handled if missing
    const { Resvg } = await import("@aspect-ratio/resvg-js").catch(() => ({ Resvg: null }));

    if (Resvg) {
      const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
      const pngData = resvg.render();
      const pngBuffer = pngData.asPng();
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=3600");
      return res.send(pngBuffer);
    }

    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(svg);
  } catch (error: any) {
    console.error("[selfclaw] badge error:", error.message);
    res.status(500).json({ error: "Badge generation failed" });
  }
});

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

router.get("/v1/badge/:identifier", async (req: Request, res: Response) => {
  const id = String(req.params.identifier);
  res.redirect(301, `/api/selfclaw/v1/badge/${encodeURIComponent(id)}.png`);
});

export default router;
