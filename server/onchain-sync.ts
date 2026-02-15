import { db } from "./db.js";
import { verifiedBots, trackedPools } from "../shared/schema.js";
import { sql, eq } from "drizzle-orm";
import { erc8004Service } from "../lib/erc8004.js";

const SYNC_INTERVAL = 6 * 60 * 60 * 1000;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;

async function syncAllAgents(): Promise<{ synced: number; updated: number; errors: number }> {
  if (isSyncing) {
    console.log("[onchain-sync] Sync already running, skipping");
    return { synced: 0, updated: 0, errors: 0 };
  }

  isSyncing = true;
  let synced = 0;
  let updated = 0;
  let errors = 0;
  const startTime = Date.now();

  try {
    if (!erc8004Service.isReady()) {
      console.log("[onchain-sync] ERC-8004 contracts not deployed, skipping sync");
      return { synced, updated, errors };
    }

    const agents = await db.select({
      id: verifiedBots.id,
      publicKey: verifiedBots.publicKey,
      metadata: verifiedBots.metadata,
    })
      .from(verifiedBots)
      .where(sql`(${verifiedBots.metadata}->>'erc8004TokenId') IS NOT NULL`);

    console.log(`[onchain-sync] Starting sync for ${agents.length} agents with ERC-8004 identity`);

    const BATCH_SIZE = 3;
    for (let i = 0; i < agents.length; i += BATCH_SIZE) {
      const batch = agents.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (agent) => {
        try {
          const meta = (agent.metadata || {}) as Record<string, any>;
          const tokenId = meta.erc8004TokenId;
          if (!tokenId) return;

          const [identity, repSummary] = await Promise.all([
            erc8004Service.getAgentIdentity(tokenId),
            erc8004Service.getReputationSummary(tokenId),
          ]);

          const updates: Record<string, any> = {};
          let changed = false;

          if (identity) {
            if (identity.owner && identity.owner !== meta.erc8004Owner) {
              updates.erc8004Owner = identity.owner;
              changed = true;
            }
            if (identity.uri && identity.uri !== meta.erc8004Uri) {
              updates.erc8004Uri = identity.uri;
              changed = true;
            }
          }

          if (repSummary) {
            const prevFeedback = meta.onchainFeedbackCount || 0;
            const prevAvgScore = meta.onchainAvgScore || 0;
            if (repSummary.totalFeedback !== prevFeedback || repSummary.averageScore !== prevAvgScore) {
              updates.onchainFeedbackCount = repSummary.totalFeedback;
              updates.onchainAvgScore = repSummary.averageScore;
              updates.onchainLastUpdated = repSummary.lastUpdated;
              changed = true;
            }
          }

          if (changed) {
            updates.lastOnchainSync = new Date().toISOString();
            const newMeta = { ...meta, ...updates };
            await db.update(verifiedBots)
              .set({ metadata: newMeta })
              .where(eq(verifiedBots.id, agent.id));
            updated++;
            console.log(`[onchain-sync] Updated agent ${agent.publicKey.slice(0, 12)}... (token #${tokenId})`);
          }

          synced++;
        } catch (err: any) {
          errors++;
          console.error(`[onchain-sync] Error syncing agent ${agent.publicKey?.slice(0, 12)}:`, err.message);
        }
      }));

      if (i + BATCH_SIZE < agents.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    try {
      const nameless = await db.select({
        id: verifiedBots.id,
        publicKey: verifiedBots.publicKey,
        deviceId: verifiedBots.deviceId,
      })
        .from(verifiedBots)
        .where(sql`(${verifiedBots.deviceId} IS NULL OR ${verifiedBots.deviceId} = '') AND ${verifiedBots.hidden} IS NOT TRUE`);

      if (nameless.length > 0) {
        const pools = await db.select({
          agentPublicKey: trackedPools.agentPublicKey,
          tokenSymbol: trackedPools.tokenSymbol,
          tokenName: trackedPools.tokenName,
        })
          .from(trackedPools)
          .where(sql`${trackedPools.agentPublicKey} IS NOT NULL`);

        const poolMap = new Map<string, string>();
        for (const p of pools) {
          if (p.agentPublicKey && p.tokenSymbol && !poolMap.has(p.agentPublicKey)) {
            poolMap.set(p.agentPublicKey, p.tokenSymbol);
          }
        }

        let named = 0;
        for (const agent of nameless) {
          const fallbackName = poolMap.get(agent.publicKey);
          if (fallbackName) {
            await db.update(verifiedBots)
              .set({ deviceId: fallbackName })
              .where(eq(verifiedBots.id, agent.id));
            named++;
            console.log(`[onchain-sync] Auto-named agent ${agent.publicKey.slice(0, 12)}... → "${fallbackName}"`);
          }
        }
        if (named > 0) {
          console.log(`[onchain-sync] Auto-named ${named} agents from token symbols`);
          updated += named;
        }
      }
    } catch (nameErr: any) {
      console.error("[onchain-sync] Name backfill error:", nameErr.message);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[onchain-sync] Complete in ${duration}s: synced=${synced}, updated=${updated}, errors=${errors}`);
    return { synced, updated, errors };
  } finally {
    isSyncing = false;
  }
}

export function startOnchainSync() {
  console.log("[onchain-sync] Starting periodic ERC-8004 sync (every 6h)");

  setTimeout(() => {
    syncAllAgents().catch(err => console.error("[onchain-sync] Initial sync failed:", err.message));
  }, 30_000);

  syncTimer = setInterval(() => {
    syncAllAgents().catch(err => console.error("[onchain-sync] Periodic sync failed:", err.message));
  }, SYNC_INTERVAL);
}

export { syncAllAgents };
