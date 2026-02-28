import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  verificationBounties,
  reputationStakes,
  stakeReviews,
  verifiedBots,
  reputationEvents,
  reputationBadges,
  agentWallets,
} from "../shared/schema.js";
import { releaseEscrow, getEscrowAddress, SELFCLAW_TOKEN } from "../lib/selfclaw-commerce.js";
import { parseUnits } from "viem";

async function executeStakeTransfer(
  resolution: string,
  agentPublicKey: string,
  stakeAmount: string,
  stakeToken: string,
): Promise<{ transferStatus: string; transferTxHash?: string; transferError?: string }> {
  try {
    const [wallet] = await db.select().from(agentWallets).where(eq(agentWallets.publicKey, agentPublicKey));
    if (!wallet) {
      return { transferStatus: "no_wallet", transferError: "Agent has no registered wallet" };
    }

    if (resolution === "validated") {
      const rewardAmount = (parseFloat(stakeAmount) * 0.1).toString();
      const rewardWei = parseUnits(rewardAmount, 18);
      const result = await releaseEscrow(wallet.address, rewardWei, SELFCLAW_TOKEN);
      if (result.success) {
        console.log(`[verification] Reward transfer of ${rewardAmount} SELFCLAW to ${wallet.address} succeeded: ${result.txHash}`);
        return { transferStatus: "completed", transferTxHash: result.txHash };
      } else {
        console.warn(`[verification] Reward transfer failed: ${result.error}`);
        return { transferStatus: "failed", transferError: result.error };
      }
    } else if (resolution === "slashed") {
      const slashAmount = (parseFloat(stakeAmount) * 0.5).toString();
      const escrowAddr = getEscrowAddress();
      console.log(`[verification] Slash of ${slashAmount} ${stakeToken} recorded for agent ${agentPublicKey}. Agent wallet: ${wallet.address}, platform: ${escrowAddr}`);
      return { transferStatus: "slash_recorded", transferError: "On-chain slash requires agent pre-approval (not yet supported)" };
    }

    return { transferStatus: "no_transfer" };
  } catch (err: any) {
    console.error(`[verification] Transfer error for ${resolution}:`, err.message);
    return { transferStatus: "error", transferError: err.message };
  }
}

const router = Router();

router.get("/v1/verification/bounties", async (_req: Request, res: Response) => {
  try {
    const bounties = await db
      .select({
        id: verificationBounties.id,
        stakeId: verificationBounties.stakeId,
        rewardAmount: verificationBounties.rewardAmount,
        status: verificationBounties.status,
        createdAt: verificationBounties.createdAt,
        outputHash: reputationStakes.outputHash,
        outputType: reputationStakes.outputType,
        description: reputationStakes.description,
        stakeAmount: reputationStakes.stakeAmount,
        stakeToken: reputationStakes.stakeToken,
        agentPublicKey: reputationStakes.agentPublicKey,
        agentName: reputationStakes.agentName,
      })
      .from(verificationBounties)
      .innerJoin(reputationStakes, eq(verificationBounties.stakeId, reputationStakes.id))
      .where(eq(verificationBounties.status, "open"))
      .orderBy(desc(sql`CAST(${verificationBounties.rewardAmount} AS NUMERIC)`))
      .limit(50);

    const enriched = await Promise.all(
      bounties.map(async (b) => {
        const [agent] = await db
          .select({ deviceId: verifiedBots.deviceId })
          .from(verifiedBots)
          .where(eq(verifiedBots.publicKey, b.agentPublicKey))
          .limit(1);
        return {
          ...b,
          agentName: b.agentName || agent?.deviceId || b.agentPublicKey.slice(0, 16),
        };
      })
    );

    res.json({ bounties: enriched, count: enriched.length });
  } catch (err: any) {
    console.error("[verification] Error listing bounties:", err.message);
    res.status(500).json({ error: "Failed to list bounties" });
  }
});

router.post("/v1/verification/bounties/:id/claim", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.humanId) {
      return res.status(401).json({
        error: "Human verification required. Log in with your Self.xyz passport to claim bounties.",
        hint: "Only passport-verified humans can claim verification bounties.",
      });
    }

    const id = req.params.id as string;
    const { score, comment } = req.body;

    if (!score || score < 1 || score > 5) {
      return res.status(400).json({ error: "Score must be between 1 and 5" });
    }

    const result = await db.transaction(async (tx) => {
      const [bounty] = await tx
        .select()
        .from(verificationBounties)
        .where(eq(verificationBounties.id, id));

      if (!bounty) {
        return { error: "Bounty not found", status: 404 };
      }

      if (bounty.status !== "open") {
        return { error: "Bounty has already been claimed", status: 400 };
      }

      const [stake] = await tx
        .select()
        .from(reputationStakes)
        .where(eq(reputationStakes.id, bounty.stakeId));

      if (!stake) {
        return { error: "Associated stake not found", status: 404 };
      }

      if (stake.humanId === session.humanId) {
        return { error: "Cannot verify your own agent's output", status: 403 };
      }

      if (stake.status !== "active") {
        return { error: "Stake is no longer active for review", status: 400 };
      }

      const existingReview = await tx
        .select()
        .from(stakeReviews)
        .where(
          and(
            eq(stakeReviews.stakeId, bounty.stakeId),
            eq(stakeReviews.reviewerHumanId, session.humanId)
          )
        )
        .limit(1);

      if (existingReview.length > 0) {
        return { error: "You have already reviewed this stake", status: 409 };
      }

      const sessionPublicKey = session.publicKey || `human:${session.humanId}`;

      await tx.insert(stakeReviews).values({
        stakeId: bounty.stakeId,
        reviewerHumanId: session.humanId,
        reviewerPublicKey: sessionPublicKey,
        score,
        comment: comment || null,
      });

      const [updatedBounty] = await tx
        .update(verificationBounties)
        .set({
          status: "claimed",
          claimedByHumanId: session.humanId,
          claimedByPublicKey: sessionPublicKey,
          verifierType: "human",
          score,
          comment: comment || null,
          claimedAt: new Date(),
        })
        .where(and(eq(verificationBounties.id, id), eq(verificationBounties.status, "open")))
        .returning();

      if (!updatedBounty) {
        return { error: "Bounty has already been claimed", status: 409 };
      }

      const reviews = await tx
        .select()
        .from(stakeReviews)
        .where(eq(stakeReviews.stakeId, bounty.stakeId));

      const humanBounties = await tx
        .select()
        .from(verificationBounties)
        .where(
          and(
            eq(verificationBounties.stakeId, bounty.stakeId),
            eq(verificationBounties.status, "claimed"),
            eq(verificationBounties.verifierType, "human")
          )
        );

      let weightedSum = 0;
      let weightedCount = 0;

      for (const review of reviews) {
        const isHumanReview = humanBounties.some(
          (hb) => hb.claimedByHumanId === review.reviewerHumanId
        );
        const weight = isHumanReview ? 2 : 1;
        weightedSum += review.score * weight;
        weightedCount += weight;
      }

      const weightedAvg = weightedCount > 0 ? weightedSum / weightedCount : 0;
      const reviewCount = reviews.length;

      const updateData: any = {
        reviewCount,
        avgScore: weightedAvg.toFixed(2),
      };

      if (reviewCount >= 3) {
        updateData.resolvedAt = new Date();
        if (weightedAvg >= 3.5) {
          updateData.status = "validated";
          updateData.resolution = "validated";
          updateData.rewardAmount = (parseFloat(stake.stakeAmount) * 0.1).toString();
        } else if (weightedAvg < 2.0) {
          updateData.status = "slashed";
          updateData.resolution = "slashed";
          updateData.slashedAmount = (parseFloat(stake.stakeAmount) * 0.5).toString();
        } else {
          updateData.status = "neutral";
          updateData.resolution = "neutral";
        }
      }

      await tx
        .update(reputationStakes)
        .set(updateData)
        .where(eq(reputationStakes.id, bounty.stakeId));

      let transferResult: { transferStatus: string; transferTxHash?: string; transferError?: string } = { transferStatus: "no_transfer" };
      if (updateData.resolution === "validated" || updateData.resolution === "slashed") {
        transferResult = await executeStakeTransfer(updateData.resolution, stake.agentPublicKey, stake.stakeAmount, stake.stakeToken);
      }

      if (updateData.resolution) {
        try {
          const [bot] = await tx
            .select()
            .from(verifiedBots)
            .where(eq(verifiedBots.publicKey, stake.agentPublicKey));
          const erc8004TokenId = (bot?.metadata as any)?.erc8004TokenId || null;
          await tx.insert(reputationEvents).values({
            agentPublicKey: stake.agentPublicKey,
            humanId: stake.humanId,
            erc8004TokenId,
            eventType:
              updateData.resolution === "validated"
                ? "stake_validated"
                : updateData.resolution === "slashed"
                ? "stake_slashed"
                : "stake_neutral",
            eventData: {
              stakeId: bounty.stakeId,
              resolution: updateData.resolution,
              avgScore: weightedAvg,
              humanVerified: true,
              bountyId: id,
              transferStatus: transferResult.transferStatus,
              transferTxHash: transferResult.transferTxHash || null,
              transferError: transferResult.transferError || null,
            },
          });
        } catch (e: any) {
          console.error("[verification] Error logging event:", e.message);
        }
      }

      return {
        bounty: updatedBounty,
        stakeResolution: updateData.resolution || null,
        weightedAvgScore: parseFloat(weightedAvg.toFixed(2)),
        reviewCount,
        rewardAmount: bounty.rewardAmount,
      };
    });

    if ("error" in result) {
      return res.status(result.status as number).json({ error: result.error });
    }

    res.json({
      bounty: result.bounty,
      stakeResolution: result.stakeResolution,
      weightedAvgScore: result.weightedAvgScore,
      reviewCount: result.reviewCount,
      message: `Bounty claimed. Reward: ${result.rewardAmount} SELFCLAW. ${
        result.stakeResolution
          ? `Stake resolved as: ${result.stakeResolution}`
          : `${3 - result.reviewCount} more reviews needed for resolution.`
      }`,
    });
  } catch (err: any) {
    console.error("[verification] Error claiming bounty:", err.message);
    res.status(500).json({ error: "Failed to claim bounty" });
  }
});

router.get("/v1/verification/my-claims", async (req: Request, res: Response) => {
  try {
    const session = req.session as any;
    if (!session?.humanId) {
      return res
        .status(401)
        .json({ error: "Human verification required. Log in with your Self.xyz passport." });
    }

    const claims = await db
      .select({
        id: verificationBounties.id,
        stakeId: verificationBounties.stakeId,
        rewardAmount: verificationBounties.rewardAmount,
        score: verificationBounties.score,
        comment: verificationBounties.comment,
        claimedAt: verificationBounties.claimedAt,
        outputType: reputationStakes.outputType,
        description: reputationStakes.description,
        agentPublicKey: reputationStakes.agentPublicKey,
        stakeStatus: reputationStakes.status,
      })
      .from(verificationBounties)
      .innerJoin(reputationStakes, eq(verificationBounties.stakeId, reputationStakes.id))
      .where(eq(verificationBounties.claimedByHumanId, session.humanId))
      .orderBy(desc(verificationBounties.claimedAt))
      .limit(50);

    const totalEarned = claims.reduce((sum, c) => sum + parseFloat(c.rewardAmount || "0"), 0);

    res.json({ claims, totalEarned: totalEarned.toString(), count: claims.length });
  } catch (err: any) {
    console.error("[verification] Error fetching claims:", err.message);
    res.status(500).json({ error: "Failed to fetch claims" });
  }
});

export default router;
