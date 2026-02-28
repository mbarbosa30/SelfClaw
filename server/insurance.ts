import { Router, Request, Response } from "express";
import { db } from "./db.js";
import { sql, eq, and, desc, lt, or } from "drizzle-orm";
import {
  insuranceStakes,
  verifiedBots,
  skillPurchases,
  agentRequests,
} from "../shared/schema.js";

const router = Router();

async function resolveAgent(req: any, res: any): Promise<{ publicKey: string; humanId: string } | null> {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const apiKey = authHeader.slice(7).trim();
    if (apiKey) {
      const [agent] = await db.select().from(verifiedBots).where(eq(verifiedBots.apiKey, apiKey)).limit(1);
      if (agent) return { publicKey: agent.publicKey, humanId: agent.humanId || "" };
    }
  }
  const session = req.session as any;
  if (session?.publicKey && session?.humanId) {
    return { publicKey: session.publicKey, humanId: session.humanId };
  }
  res.status(401).json({ error: "Authentication required. Use Bearer <api_key> or session auth." });
  return null;
}

router.post("/v1/insurance/create", async (req: Request, res: Response) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;

    const { insuredPublicKey, bondAmount, premiumRate, scope, durationDays } = req.body;

    if (!insuredPublicKey || !bondAmount) {
      return res.status(400).json({
        error: "insuredPublicKey and bondAmount are required",
        hint: "bondAmount is the SELFCLAW tokens you're putting up as insurance. premiumRate (default 0.05 = 5%) is what you earn if no claims are filed.",
      });
    }

    const bondNum = parseFloat(bondAmount);
    if (isNaN(bondNum) || bondNum <= 0) {
      return res.status(400).json({ error: "bondAmount must be a positive number" });
    }

    if (insuredPublicKey === auth.publicKey) {
      return res.status(400).json({ error: "Cannot insure yourself" });
    }

    const [insuredAgent] = await db
      .select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, insuredPublicKey))
      .limit(1);

    if (!insuredAgent) {
      return res.status(404).json({ error: "Insured agent not found in registry" });
    }

    if (!insuredAgent.humanId) {
      return res.status(400).json({ error: "Insured agent has no humanId. Must be verified." });
    }

    const validScopes = ["commerce", "skill", "general"];
    const finalScope = validScopes.includes(scope) ? scope : "general";

    const days = Math.min(Math.max(parseInt(durationDays) || 30, 1), 365);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const rate = Math.min(Math.max(parseFloat(premiumRate) || 0.05, 0.001), 0.5);

    const [bond] = await db
      .insert(insuranceStakes)
      .values({
        insurerPublicKey: auth.publicKey,
        insurerHumanId: auth.humanId,
        insuredPublicKey,
        insuredHumanId: insuredAgent.humanId,
        bondAmount: bondNum.toString(),
        bondToken: "SELFCLAW",
        premiumRate: rate.toFixed(4),
        scope: finalScope,
        status: "active",
        expiresAt,
      })
      .returning();

    res.json({
      bond,
      premiumOnSuccess: (bondNum * rate).toFixed(2),
      message: `Insurance bond created. You're backing ${insuredAgent.deviceId || insuredPublicKey.slice(0, 16)} with ${bondAmount} SELFCLAW for ${days} days. You earn ${(rate * 100).toFixed(1)}% premium if no claims are filed.`,
    });
  } catch (err: any) {
    console.error("[insurance] Error creating bond:", err.message);
    res.status(500).json({ error: "Failed to create insurance bond" });
  }
});

router.get("/v1/insurance/bonds", async (_req: Request, res: Response) => {
  try {
    const bonds = await db
      .select()
      .from(insuranceStakes)
      .where(eq(insuranceStakes.status, "active"))
      .orderBy(desc(sql`CAST(${insuranceStakes.bondAmount} AS NUMERIC)`))
      .limit(50);

    const enriched = await Promise.all(
      bonds.map(async (b) => {
        const [insurer] = await db
          .select({ deviceId: verifiedBots.deviceId })
          .from(verifiedBots)
          .where(eq(verifiedBots.publicKey, b.insurerPublicKey))
          .limit(1);
        const [insured] = await db
          .select({ deviceId: verifiedBots.deviceId })
          .from(verifiedBots)
          .where(eq(verifiedBots.publicKey, b.insuredPublicKey))
          .limit(1);
        return {
          ...b,
          insurerName: insurer?.deviceId || b.insurerPublicKey.slice(0, 16),
          insuredName: insured?.deviceId || b.insuredPublicKey.slice(0, 16),
        };
      })
    );

    res.json({ bonds: enriched, count: enriched.length });
  } catch (err: any) {
    console.error("[insurance] Error listing bonds:", err.message);
    res.status(500).json({ error: "Failed to list insurance bonds" });
  }
});

router.get("/v1/insurance/agent/:publicKey", async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    const bonds = await db
      .select()
      .from(insuranceStakes)
      .where(
        and(eq(insuranceStakes.insuredPublicKey, publicKey), eq(insuranceStakes.status, "active"))
      )
      .orderBy(desc(sql`CAST(${insuranceStakes.bondAmount} AS NUMERIC)`));

    const totalCoverage = bonds.reduce((sum, b) => sum + parseFloat(b.bondAmount), 0);

    const enriched = await Promise.all(
      bonds.map(async (b) => {
        const [insurer] = await db
          .select({ deviceId: verifiedBots.deviceId })
          .from(verifiedBots)
          .where(eq(verifiedBots.publicKey, b.insurerPublicKey))
          .limit(1);
        return {
          ...b,
          insurerName: insurer?.deviceId || b.insurerPublicKey.slice(0, 16),
        };
      })
    );

    res.json({
      agentPublicKey: publicKey,
      bonds: enriched,
      totalCoverage: totalCoverage.toString(),
      bondCount: bonds.length,
    });
  } catch (err: any) {
    console.error("[insurance] Error fetching agent insurance:", err.message);
    res.status(500).json({ error: "Failed to fetch agent insurance" });
  }
});

router.post("/v1/insurance/bonds/:id/claim", async (req: Request, res: Response) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;

    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length < 10) {
      return res
        .status(400)
        .json({ error: "A detailed reason is required (at least 10 characters)" });
    }

    const [bond] = await db
      .select()
      .from(insuranceStakes)
      .where(eq(insuranceStakes.id, id));

    if (!bond) {
      return res.status(404).json({ error: "Insurance bond not found" });
    }

    if (bond.status !== "active") {
      return res.status(400).json({ error: `Bond is ${bond.status}, cannot file claim` });
    }

    if (bond.insurerPublicKey === auth.publicKey) {
      return res.status(403).json({ error: "Cannot file a claim against your own insurance bond" });
    }

    const hasTransaction = await db.execute(sql`
      SELECT 1 FROM skill_purchases
      WHERE buyer_public_key = ${auth.publicKey}
      AND seller_public_key = ${bond.insuredPublicKey}
      AND status IN ('completed', 'confirmed')
      UNION ALL
      SELECT 1 FROM agent_requests
      WHERE (requester_public_key = ${auth.publicKey} AND provider_public_key = ${bond.insuredPublicKey})
      AND status IN ('completed', 'accepted')
      LIMIT 1
    `);

    if (!hasTransaction.rows || hasTransaction.rows.length === 0) {
      return res.status(403).json({
        error: "You must have a completed transaction with the insured agent to file a claim",
        hint: "Only counterparties who purchased skills or services from the insured agent can file claims.",
      });
    }

    const slashedAmount = (parseFloat(bond.bondAmount) * 0.5).toString();

    const [updatedBond] = await db
      .update(insuranceStakes)
      .set({
        status: "claimed",
        claimReason: reason.trim(),
        slashedAmount,
        resolvedAt: new Date(),
      })
      .where(eq(insuranceStakes.id, id))
      .returning();

    res.json({
      bond: updatedBond,
      message: `Claim filed. ${slashedAmount} SELFCLAW slashed from insurer's bond as compensation.`,
    });
  } catch (err: any) {
    console.error("[insurance] Error filing claim:", err.message);
    res.status(500).json({ error: "Failed to file claim" });
  }
});

export async function expireInsuranceBonds() {
  try {
    const expired = await db
      .update(insuranceStakes)
      .set({
        status: "expired",
        resolvedAt: new Date(),
        premiumEarned: sql`CAST(CAST(${insuranceStakes.bondAmount} AS NUMERIC) * CAST(${insuranceStakes.premiumRate} AS NUMERIC) AS TEXT)`,
      })
      .where(
        and(
          eq(insuranceStakes.status, "active"),
          lt(insuranceStakes.expiresAt, new Date())
        )
      )
      .returning();

    if (expired.length > 0) {
      console.log(`[insurance] Expired ${expired.length} insurance bonds, premiums earned.`);
    }
  } catch (err: any) {
    console.error("[insurance] Error expiring bonds:", err.message);
  }
}

export default router;
