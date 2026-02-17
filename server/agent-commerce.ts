import { Router } from "express";
import { db } from "./db.js";
import { agentRequests, verifiedBots, agentWallets } from "../shared/schema.js";
import { sql, desc, eq, and } from "drizzle-orm";
import { verifyPayment, SELFCLAW_TOKEN } from "../lib/selfclaw-commerce.js";
import { parseUnits, createPublicClient, http, fallback, parseAbi } from "viem";
import { celo } from "viem/chains";

const commerceClient = createPublicClient({
  chain: celo,
  transport: fallback([
    http('https://forno.celo.org', { timeout: 15_000, retryCount: 1 }),
    http('https://rpc.ankr.com/celo', { timeout: 15_000, retryCount: 1 }),
  ]),
});

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const d = await commerceClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: parseAbi(['function decimals() view returns (uint8)']),
      functionName: 'decimals',
    });
    return Number(d);
  } catch {
    return 18;
  }
}

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

router.post("/v1/agent-requests", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey, humanId } = auth;

    const { providerPublicKey, skillId, description, paymentAmount, paymentToken, txHash } = req.body;
    if (!providerPublicKey || !description) {
      return res.status(400).json({ error: "providerPublicKey and description are required" });
    }

    const [provider] = await db
      .select()
      .from(verifiedBots)
      .where(eq(verifiedBots.publicKey, providerPublicKey))
      .limit(1);

    if (!provider) {
      return res.status(404).json({ error: "Provider not found in verified bots" });
    }

    let paymentVerified = false;
    let paymentVerification: any = null;

    if (txHash && paymentAmount) {
      const [providerWallet] = await db.select({ address: agentWallets.address })
        .from(agentWallets)
        .where(eq(agentWallets.publicKey, providerPublicKey))
        .limit(1);

      if (!providerWallet) {
        return res.status(400).json({
          error: "Provider has no wallet registered — cannot verify payment",
          hint: "Payment can only be verified when the provider has a registered wallet. Submit without txHash for unverified requests.",
        });
      }

      const token = paymentToken || SELFCLAW_TOKEN;
      const decimals = await getTokenDecimals(token);
      const amountWei = parseUnits(paymentAmount.toString(), decimals);
      paymentVerification = await verifyPayment(txHash, providerWallet.address, amountWei, token);
      paymentVerified = paymentVerification.valid;

      if (!paymentVerified) {
        return res.status(402).json({
          error: "Payment verification failed",
          details: paymentVerification.error,
          expectedTo: providerWallet.address,
          expectedAmount: paymentAmount,
          txHash,
          hint: "Ensure the transaction transferred the correct amount of the correct token to the provider's wallet address.",
        });
      }

      const existingTx = await db.execute(
        sql`SELECT id FROM agent_requests WHERE tx_hash = ${txHash} LIMIT 1`
      );
      if (existingTx.rows.length > 0) {
        return res.status(400).json({ error: "This transaction hash has already been used for a service request." });
      }
    }

    const [request] = await db
      .insert(agentRequests)
      .values({
        requesterHumanId: humanId,
        requesterPublicKey: publicKey,
        providerHumanId: provider.humanId || "",
        providerPublicKey: providerPublicKey,
        providerName: provider.deviceId || undefined,
        skillId: skillId || undefined,
        description,
        paymentAmount: paymentAmount || undefined,
        paymentToken: paymentToken || undefined,
        txHash: txHash || undefined,
      })
      .returning();

    res.json({
      ...request,
      paymentVerified,
      paymentVerification: paymentVerified ? {
        valid: true,
        from: paymentVerification?.from,
        to: paymentVerification?.to,
        amount: paymentVerification?.amount,
        txHash,
      } : undefined,
    });
  } catch (error: any) {
    console.error("[agent-commerce] Error creating request:", error.message);
    res.status(500).json({ error: "Failed to create agent request" });
  }
});

router.get("/v1/agent-requests", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey, humanId } = auth;

    const { role, status } = req.query as { role?: string; status?: string };

    const conditions: any[] = [];

    if (role === "requester") {
      conditions.push(eq(agentRequests.requesterPublicKey, publicKey));
    } else if (role === "provider") {
      conditions.push(eq(agentRequests.providerPublicKey, publicKey));
    } else {
      conditions.push(
        sql`(${agentRequests.requesterPublicKey} = ${publicKey} OR ${agentRequests.providerPublicKey} = ${publicKey})`
      );
    }

    if (status) {
      conditions.push(eq(agentRequests.status, status));
    }

    const requests = await db
      .select()
      .from(agentRequests)
      .where(and(...conditions))
      .orderBy(desc(agentRequests.createdAt));

    res.json(requests);
  } catch (error: any) {
    console.error("[agent-commerce] Error listing requests:", error.message);
    res.status(500).json({ error: "Failed to list agent requests" });
  }
});

router.get("/v1/agent-requests/:id", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey } = auth;

    const [request] = await db
      .select()
      .from(agentRequests)
      .where(eq(agentRequests.id, req.params.id))
      .limit(1);

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (request.requesterPublicKey !== publicKey && request.providerPublicKey !== publicKey) {
      return res.status(403).json({ error: "Not authorized to view this request" });
    }

    res.json(request);
  } catch (error: any) {
    console.error("[agent-commerce] Error fetching request:", error.message);
    res.status(500).json({ error: "Failed to fetch agent request" });
  }
});

router.put("/v1/agent-requests/:id/accept", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey, humanId } = auth;

    const [request] = await db
      .select()
      .from(agentRequests)
      .where(eq(agentRequests.id, req.params.id))
      .limit(1);

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (request.providerPublicKey !== publicKey) {
      return res.status(403).json({ error: "Only the provider can accept this request" });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request can only be accepted when pending" });
    }

    const [updated] = await db
      .update(agentRequests)
      .set({ status: "accepted" })
      .where(eq(agentRequests.id, req.params.id))
      .returning();

    res.json(updated);
  } catch (error: any) {
    console.error("[agent-commerce] Error accepting request:", error.message);
    res.status(500).json({ error: "Failed to accept agent request" });
  }
});

router.put("/v1/agent-requests/:id/complete", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey, humanId } = auth;

    const { result } = req.body;

    const [request] = await db
      .select()
      .from(agentRequests)
      .where(eq(agentRequests.id, req.params.id))
      .limit(1);

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (request.providerPublicKey !== publicKey) {
      return res.status(403).json({ error: "Only the provider can complete this request" });
    }

    if (request.status !== "accepted") {
      return res.status(400).json({ error: "Request must be accepted before completing" });
    }

    const [updated] = await db
      .update(agentRequests)
      .set({
        status: "completed",
        result: result || null,
        completedAt: new Date(),
      })
      .where(eq(agentRequests.id, req.params.id))
      .returning();

    res.json(updated);
  } catch (error: any) {
    console.error("[agent-commerce] Error completing request:", error.message);
    res.status(500).json({ error: "Failed to complete agent request" });
  }
});

router.put("/v1/agent-requests/:id/cancel", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey, humanId } = auth;

    const [request] = await db
      .select()
      .from(agentRequests)
      .where(eq(agentRequests.id, req.params.id))
      .limit(1);

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (request.requesterPublicKey !== publicKey && request.providerPublicKey !== publicKey) {
      return res.status(403).json({ error: "Only the requester or provider can cancel this request" });
    }

    if (request.status === "completed" || request.status === "cancelled") {
      return res.status(400).json({ error: "Cannot cancel a completed or already cancelled request" });
    }

    const [updated] = await db
      .update(agentRequests)
      .set({ status: "cancelled" })
      .where(eq(agentRequests.id, req.params.id))
      .returning();

    res.json(updated);
  } catch (error: any) {
    console.error("[agent-commerce] Error cancelling request:", error.message);
    res.status(500).json({ error: "Failed to cancel agent request" });
  }
});

router.post("/v1/agent-requests/:id/rate", async (req, res) => {
  try {
    const auth = await resolveAgent(req, res);
    if (!auth) return;
    const { publicKey, humanId } = auth;

    const { rating } = req.body;
    if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ error: "Rating must be an integer between 1 and 5" });
    }

    const [request] = await db
      .select()
      .from(agentRequests)
      .where(eq(agentRequests.id, req.params.id))
      .limit(1);

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (request.requesterPublicKey !== publicKey) {
      return res.status(403).json({ error: "Only the requester can rate this request" });
    }

    if (request.status !== "completed") {
      return res.status(400).json({ error: "Can only rate completed requests" });
    }

    const [updated] = await db
      .update(agentRequests)
      .set({ rating })
      .where(eq(agentRequests.id, req.params.id))
      .returning();

    res.json(updated);
  } catch (error: any) {
    console.error("[agent-commerce] Error rating request:", error.message);
    res.status(500).json({ error: "Failed to rate agent request" });
  }
});

export default router;
