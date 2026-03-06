import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { governanceStakes, governanceProposals, governanceVotes } from "../shared/schema.js";
import { eq, desc, sql, and, count } from "drizzle-orm";
import { publicApiLimiter } from "./routes/_shared.js";
import { isAuthenticated } from "./self-auth.js";
import {
  isGovernanceContractDeployed,
  stakeTokens,
  requestUnstake as contractRequestUnstake,
  unstakeTokens,
  getStakedBalance,
  getVotingPower,
  createProposalOnchain,
  voteOnchain,
  getTotalStaked,
} from "../lib/governance-contract.js";

const router = Router();

router.post("/v1/governance/stake", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const humanId = (req as any).session?.humanId || (req as any).session?.userId;
    if (!humanId) return res.status(401).json({ error: "Authentication required" });

    const { amount, walletAddress } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }
    if (!walletAddress) {
      return res.status(400).json({ error: "Wallet address required" });
    }

    let txHash: string | undefined;
    if (isGovernanceContractDeployed()) {
      const result = await stakeTokens(amount);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "On-chain stake failed" });
      }
      txHash = result.txHash;
    }

    const existing = await db.select().from(governanceStakes)
      .where(and(eq(governanceStakes.humanId, humanId), eq(governanceStakes.status, "active")))
      .limit(1);

    if (existing.length > 0) {
      const currentAmount = parseFloat(existing[0].stakedAmount);
      const addAmount = parseFloat(amount);
      const newAmount = (currentAmount + addAmount).toString();
      const existingStakedAt = existing[0].stakedAt || new Date();
      const weightedTimestamp = new Date(
        (existingStakedAt.getTime() * currentAmount + Date.now() * addAmount) / (currentAmount + addAmount)
      );
      await db.update(governanceStakes)
        .set({
          stakedAmount: newAmount,
          stakedAt: weightedTimestamp,
          txHash: txHash || existing[0].txHash,
          metadata: { ...(existing[0].metadata as any || {}), lastStakeTx: txHash },
        })
        .where(eq(governanceStakes.id, existing[0].id));
    } else {
      await db.insert(governanceStakes).values({
        humanId,
        walletAddress,
        stakedAmount: amount,
        chainId: 8453,
        txHash,
        status: "active",
      });
    }

    res.json({
      success: true,
      message: `Staked ${amount} SELFCLAW`,
      txHash,
      onchain: isGovernanceContractDeployed(),
    });
  } catch (error: any) {
    console.error("[governance] Stake error:", error.message);
    res.status(500).json({ error: "Failed to stake tokens" });
  }
});

router.post("/v1/governance/unstake/request", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const humanId = (req as any).session?.humanId || (req as any).session?.userId;
    if (!humanId) return res.status(401).json({ error: "Authentication required" });

    const { amount } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    const existing = await db.select().from(governanceStakes)
      .where(and(eq(governanceStakes.humanId, humanId), eq(governanceStakes.status, "active")))
      .limit(1);

    if (!existing.length || parseFloat(existing[0].stakedAmount) < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient staked balance" });
    }

    let txHash: string | undefined;
    if (isGovernanceContractDeployed()) {
      const result = await contractRequestUnstake(amount);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "On-chain unstake request failed" });
      }
      txHash = result.txHash;
    }

    const cooldownEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.update(governanceStakes)
      .set({
        status: "unstaking",
        unstakeRequestedAt: new Date(),
        unstakeAmount: amount,
        metadata: { ...(existing[0].metadata as any || {}), unstakeTx: txHash, cooldownEndsAt: cooldownEnd.toISOString() },
      })
      .where(eq(governanceStakes.id, existing[0].id));

    res.json({
      success: true,
      message: `Unstake requested for ${amount} SELFCLAW. 7-day cooldown ends ${cooldownEnd.toISOString()}`,
      cooldownEndsAt: cooldownEnd.toISOString(),
      txHash,
    });
  } catch (error: any) {
    console.error("[governance] Unstake request error:", error.message);
    res.status(500).json({ error: "Failed to request unstake" });
  }
});

router.post("/v1/governance/unstake", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const humanId = (req as any).session?.humanId || (req as any).session?.userId;
    if (!humanId) return res.status(401).json({ error: "Authentication required" });

    const existing = await db.select().from(governanceStakes)
      .where(and(eq(governanceStakes.humanId, humanId), eq(governanceStakes.status, "unstaking")))
      .limit(1);

    if (!existing.length) {
      return res.status(400).json({ error: "No pending unstake request" });
    }

    const requestedAt = existing[0].unstakeRequestedAt;
    if (!requestedAt) {
      return res.status(400).json({ error: "No unstake request timestamp" });
    }

    const cooldownEnd = new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (Date.now() < cooldownEnd.getTime()) {
      return res.status(400).json({
        error: "Cooldown period not elapsed",
        cooldownEndsAt: cooldownEnd.toISOString(),
        remainingMs: cooldownEnd.getTime() - Date.now(),
      });
    }

    const unstakeAmount = existing[0].unstakeAmount || existing[0].stakedAmount;

    let txHash: string | undefined;
    if (isGovernanceContractDeployed()) {
      const result = await unstakeTokens(unstakeAmount);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "On-chain unstake failed" });
      }
      txHash = result.txHash;
    }

    const remainingAmount = parseFloat(existing[0].stakedAmount) - parseFloat(unstakeAmount);
    if (remainingAmount > 0) {
      await db.update(governanceStakes)
        .set({
          stakedAmount: remainingAmount.toString(),
          status: "active",
          unstakeRequestedAt: null,
          unstakeAmount: null,
        })
        .where(eq(governanceStakes.id, existing[0].id));
    } else {
      await db.update(governanceStakes)
        .set({ status: "withdrawn", unstakeRequestedAt: null, unstakeAmount: null })
        .where(eq(governanceStakes.id, existing[0].id));
    }

    res.json({
      success: true,
      message: `Withdrawn ${unstakeAmount} SELFCLAW`,
      txHash,
    });
  } catch (error: any) {
    console.error("[governance] Unstake error:", error.message);
    res.status(500).json({ error: "Failed to unstake tokens" });
  }
});

router.get("/v1/governance/stake/:address", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const dbStakes = await db.select().from(governanceStakes)
      .where(eq(governanceStakes.walletAddress, address))
      .limit(1);

    let onchainData = null;
    if (isGovernanceContractDeployed()) {
      const [balance, power] = await Promise.all([
        getStakedBalance(address),
        getVotingPower(address),
      ]);
      onchainData = { ...balance, votingPower: power };
    }

    const dbStake = dbStakes[0] || null;
    const stakedAmount = dbStake?.stakedAmount || "0";
    const stakedAt = dbStake?.stakedAt;
    const daysSinceStake = stakedAt ? Math.floor((Date.now() - stakedAt.getTime()) / 86400000) : 0;
    const multiplier = Math.min(1 + daysSinceStake / 90, 2);
    const votingPower = (parseFloat(stakedAmount) * multiplier).toFixed(2);

    res.json({
      address,
      stakedAmount,
      votingPower,
      multiplier: multiplier.toFixed(4),
      daysSinceStake,
      status: dbStake?.status || "none",
      unstakeRequestedAt: dbStake?.unstakeRequestedAt || null,
      unstakeAmount: dbStake?.unstakeAmount || null,
      cooldownEndsAt: dbStake?.unstakeRequestedAt
        ? new Date(dbStake.unstakeRequestedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : null,
      chainId: 8453,
      chain: "Base",
      onchain: onchainData,
    });
  } catch (error: any) {
    console.error("[governance] Get stake error:", error.message);
    res.status(500).json({ error: "Failed to get stake info" });
  }
});

router.get("/v1/governance/stakes", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const stakes = await db.select({
      walletAddress: governanceStakes.walletAddress,
      stakedAmount: governanceStakes.stakedAmount,
      stakedAt: governanceStakes.stakedAt,
      status: governanceStakes.status,
    }).from(governanceStakes)
      .where(eq(governanceStakes.status, "active"))
      .orderBy(desc(sql`CAST(${governanceStakes.stakedAmount} AS NUMERIC)`))
      .limit(100);

    const totalStaked = stakes.reduce((sum, s) => sum + parseFloat(s.stakedAmount), 0);

    res.json({
      stakers: stakes,
      totalStaked: totalStaked.toFixed(2),
      count: stakes.length,
      chain: "Base",
      chainId: 8453,
    });
  } catch (error: any) {
    console.error("[governance] List stakes error:", error.message);
    res.status(500).json({ error: "Failed to list stakes" });
  }
});

router.post("/v1/governance/proposals", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const humanId = (req as any).session?.humanId || (req as any).session?.userId;
    if (!humanId) return res.status(401).json({ error: "Authentication required" });

    const { title, description, votingPeriodDays = 7, walletAddress } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: "Title and description are required" });
    }
    if (!walletAddress) {
      return res.status(400).json({ error: "Wallet address required" });
    }

    const stake = await db.select().from(governanceStakes)
      .where(and(eq(governanceStakes.humanId, humanId), eq(governanceStakes.status, "active")))
      .limit(1);

    if (!stake.length || parseFloat(stake[0].stakedAmount) < 1000) {
      return res.status(400).json({ error: "Minimum 1,000 SELFCLAW staked required to create proposals" });
    }

    let txHash: string | undefined;
    let proposalOnchainId: number | undefined;
    if (isGovernanceContractDeployed()) {
      const result = await createProposalOnchain(title, description, votingPeriodDays);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "On-chain proposal creation failed" });
      }
      txHash = result.txHash;
      proposalOnchainId = result.proposalId ? parseInt(result.proposalId) : undefined;
    }

    const votingEndsAt = new Date(Date.now() + votingPeriodDays * 24 * 60 * 60 * 1000);
    const totalStaked = await db.select({ total: sql<string>`COALESCE(SUM(CAST(${governanceStakes.stakedAmount} AS NUMERIC)), 0)` })
      .from(governanceStakes).where(eq(governanceStakes.status, "active"));
    const quorumRequired = (parseFloat(totalStaked[0]?.total || "0") * 0.1).toFixed(2);

    const [proposal] = await db.insert(governanceProposals).values({
      proposalOnchainId,
      title,
      description,
      creatorHumanId: humanId,
      creatorWallet: walletAddress,
      status: "active",
      votingEndsAt,
      quorumRequired,
      txHash,
    }).returning();

    res.json({
      success: true,
      proposal: {
        id: proposal.id,
        title: proposal.title,
        status: proposal.status,
        votingEndsAt: proposal.votingEndsAt,
        quorumRequired,
      },
      txHash,
    });
  } catch (error: any) {
    console.error("[governance] Create proposal error:", error.message);
    res.status(500).json({ error: "Failed to create proposal" });
  }
});

router.get("/v1/governance/proposals", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const offset = (page - 1) * limit;

    let query = db.select().from(governanceProposals)
      .orderBy(desc(governanceProposals.createdAt))
      .limit(limit)
      .offset(offset);

    const proposals = status
      ? await db.select().from(governanceProposals).where(eq(governanceProposals.status, status)).orderBy(desc(governanceProposals.createdAt)).limit(limit).offset(offset)
      : await query;

    const proposalsWithVotes = await Promise.all(
      proposals.map(async (p) => {
        const voteCount = await db.select({ count: count() }).from(governanceVotes)
          .where(eq(governanceVotes.proposalId, p.id));

        const isExpired = p.votingEndsAt && new Date(p.votingEndsAt) < new Date() && p.status === "active";
        const forVotes = parseFloat(p.forVotes || "0");
        const againstVotes = parseFloat(p.againstVotes || "0");
        const totalVotes = forVotes + againstVotes;
        const quorum = parseFloat(p.quorumRequired || "0");

        return {
          ...p,
          voteCount: voteCount[0]?.count || 0,
          isExpired,
          quorumReached: totalVotes >= quorum,
          forPercentage: totalVotes > 0 ? ((forVotes / totalVotes) * 100).toFixed(1) : "0",
          againstPercentage: totalVotes > 0 ? ((againstVotes / totalVotes) * 100).toFixed(1) : "0",
        };
      })
    );

    res.json({ proposals: proposalsWithVotes, page, limit });
  } catch (error: any) {
    console.error("[governance] List proposals error:", error.message);
    res.status(500).json({ error: "Failed to list proposals" });
  }
});

router.get("/v1/governance/proposals/:id", publicApiLimiter, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [proposal] = await db.select().from(governanceProposals)
      .where(eq(governanceProposals.id, id));

    if (!proposal) return res.status(404).json({ error: "Proposal not found" });

    const votes = await db.select().from(governanceVotes)
      .where(eq(governanceVotes.proposalId, id))
      .orderBy(desc(governanceVotes.createdAt));

    const forVotes = parseFloat(proposal.forVotes || "0");
    const againstVotes = parseFloat(proposal.againstVotes || "0");
    const totalVotes = forVotes + againstVotes;

    res.json({
      ...proposal,
      votes,
      voteCount: votes.length,
      forPercentage: totalVotes > 0 ? ((forVotes / totalVotes) * 100).toFixed(1) : "0",
      againstPercentage: totalVotes > 0 ? ((againstVotes / totalVotes) * 100).toFixed(1) : "0",
      quorumReached: totalVotes >= parseFloat(proposal.quorumRequired || "0"),
    });
  } catch (error: any) {
    console.error("[governance] Get proposal error:", error.message);
    res.status(500).json({ error: "Failed to get proposal" });
  }
});

router.post("/v1/governance/proposals/:id/vote", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const humanId = (req as any).session?.humanId || (req as any).session?.userId;
    if (!humanId) return res.status(401).json({ error: "Authentication required" });

    const { id } = req.params;
    const { support, walletAddress } = req.body;
    if (typeof support !== "boolean") {
      return res.status(400).json({ error: "Support must be true or false" });
    }
    if (!walletAddress) {
      return res.status(400).json({ error: "Wallet address required" });
    }

    const [proposal] = await db.select().from(governanceProposals)
      .where(eq(governanceProposals.id, id));

    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    if (proposal.status !== "active") return res.status(400).json({ error: "Proposal is not active" });
    if (proposal.votingEndsAt && new Date(proposal.votingEndsAt) < new Date()) {
      return res.status(400).json({ error: "Voting period has ended" });
    }

    const existingVote = await db.select().from(governanceVotes)
      .where(and(eq(governanceVotes.proposalId, id), eq(governanceVotes.voterHumanId, humanId)))
      .limit(1);

    if (existingVote.length > 0) {
      return res.status(400).json({ error: "Already voted on this proposal" });
    }

    const stake = await db.select().from(governanceStakes)
      .where(and(eq(governanceStakes.humanId, humanId), eq(governanceStakes.status, "active")))
      .limit(1);

    if (!stake.length || parseFloat(stake[0].stakedAmount) <= 0) {
      return res.status(400).json({ error: "Must have staked SELFCLAW to vote" });
    }

    const daysSinceStake = stake[0].stakedAt
      ? Math.floor((Date.now() - stake[0].stakedAt.getTime()) / 86400000)
      : 0;
    const multiplier = Math.min(1 + daysSinceStake / 90, 2);
    const power = (parseFloat(stake[0].stakedAmount) * multiplier).toFixed(2);

    let txHash: string | undefined;
    if (isGovernanceContractDeployed() && proposal.proposalOnchainId !== null) {
      const result = await voteOnchain(proposal.proposalOnchainId, support);
      if (!result.success) {
        return res.status(500).json({ error: "On-chain vote failed: " + result.error });
      } else {
        txHash = result.txHash;
      }
    }

    await db.insert(governanceVotes).values({
      proposalId: id,
      voterHumanId: humanId,
      voterWallet: walletAddress,
      support,
      votingPower: power,
      txHash,
    });

    const currentFor = parseFloat(proposal.forVotes || "0");
    const currentAgainst = parseFloat(proposal.againstVotes || "0");
    const newFor = support ? (currentFor + parseFloat(power)).toFixed(2) : currentFor.toFixed(2);
    const newAgainst = support ? currentAgainst.toFixed(2) : (currentAgainst + parseFloat(power)).toFixed(2);

    await db.update(governanceProposals)
      .set({ forVotes: newFor, againstVotes: newAgainst })
      .where(eq(governanceProposals.id, id));

    res.json({
      success: true,
      message: `Vote cast: ${support ? "FOR" : "AGAINST"} with ${power} voting power`,
      votingPower: power,
      txHash,
    });
  } catch (error: any) {
    console.error("[governance] Vote error:", error.message);
    res.status(500).json({ error: "Failed to cast vote" });
  }
});

router.get("/v1/governance/stats", publicApiLimiter, async (_req: Request, res: Response) => {
  try {
    const activeStakes = await db.select({
      totalStaked: sql<string>`COALESCE(SUM(CAST(${governanceStakes.stakedAmount} AS NUMERIC)), 0)`,
      stakerCount: count(),
    }).from(governanceStakes).where(eq(governanceStakes.status, "active"));

    const activeProposals = await db.select({ count: count() }).from(governanceProposals)
      .where(eq(governanceProposals.status, "active"));

    const totalProposals = await db.select({ count: count() }).from(governanceProposals);

    const totalVotes = await db.select({ count: count() }).from(governanceVotes);

    const uniqueVoters = await db.select({
      count: sql<number>`COUNT(DISTINCT ${governanceVotes.voterHumanId})`,
    }).from(governanceVotes);

    const totalStaked = parseFloat(activeStakes[0]?.totalStaked || "0");
    const stakerCount = activeStakes[0]?.stakerCount || 0;

    res.json({
      totalStaked: totalStaked.toFixed(2),
      stakerCount,
      activeProposals: activeProposals[0]?.count || 0,
      totalProposals: totalProposals[0]?.count || 0,
      totalVotesCast: totalVotes[0]?.count || 0,
      uniqueVoters: uniqueVoters[0]?.count || 0,
      chain: "Base",
      chainId: 8453,
      contractDeployed: isGovernanceContractDeployed(),
    });
  } catch (error: any) {
    console.error("[governance] Stats error:", error.message);
    res.status(500).json({ error: "Failed to get governance stats" });
  }
});

export default router;
