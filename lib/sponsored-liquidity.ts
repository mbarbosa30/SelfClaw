import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db } from '../server/db.js';
import { sponsoredAgents, verifiedBots } from '../shared/schema.js';
import { eq, sql } from 'drizzle-orm';

const publicClient = createPublicClient({
  chain: celo,
  transport: http()
});

const SPONSORED_LIQUIDITY_AMOUNT = process.env.SPONSORED_LIQUIDITY_CELO || '5';
const SELFCLAW_SPONSOR_PRIVATE_KEY = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;

const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;
const USDC_ADDRESS = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as `0x${string}`;

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

export interface SponsorshipConfig {
  amountCelo: string;
  enabled: boolean;
  remainingBudget: string;
}

export interface SponsorshipResult {
  success: boolean;
  txHash?: string;
  amountCelo?: string;
  error?: string;
  alreadySponsored?: boolean;
}

export async function getSponsorshipConfig(): Promise<SponsorshipConfig> {
  const amountCelo = SPONSORED_LIQUIDITY_AMOUNT;
  
  if (!SELFCLAW_SPONSOR_PRIVATE_KEY) {
    return {
      amountCelo,
      enabled: false,
      remainingBudget: '0'
    };
  }
  
  try {
    const account = privateKeyToAccount(SELFCLAW_SPONSOR_PRIVATE_KEY as `0x${string}`);
    const balance = await publicClient.getBalance({ address: account.address });
    const formattedBalance = formatUnits(balance, 18);
    
    return {
      amountCelo,
      enabled: parseFloat(formattedBalance) >= parseFloat(amountCelo),
      remainingBudget: formattedBalance
    };
  } catch (error) {
    console.error('[sponsored-liquidity] Error getting config:', error);
    return {
      amountCelo,
      enabled: false,
      remainingBudget: '0'
    };
  }
}

export async function checkSponsorshipEligibility(humanId: string): Promise<{
  eligible: boolean;
  reason?: string;
}> {
  try {
    const existing = await db.select()
      .from(sponsoredAgents)
      .where(eq(sponsoredAgents.humanId, humanId))
      .limit(1);
    
    if (existing.length > 0) {
      return {
        eligible: false,
        reason: 'This human identity has already received sponsored liquidity'
      };
    }
    
    const verified = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId))
      .limit(1);
    
    if (verified.length === 0) {
      return {
        eligible: false,
        reason: 'No verified agent found for this human identity'
      };
    }
    
    const config = await getSponsorshipConfig();
    if (!config.enabled) {
      return {
        eligible: false,
        reason: 'Sponsorship program is currently unavailable'
      };
    }
    
    return { eligible: true };
  } catch (error: any) {
    console.error('[sponsored-liquidity] Eligibility check error:', error);
    return {
      eligible: false,
      reason: error.message || 'Error checking eligibility'
    };
  }
}

export async function reserveSponsorship(
  humanId: string,
  agentId: string,
  publicKey?: string
): Promise<SponsorshipResult> {
  try {
    const eligibility = await checkSponsorshipEligibility(humanId);
    if (!eligibility.eligible) {
      return {
        success: false,
        error: eligibility.reason,
        alreadySponsored: eligibility.reason?.includes('already received')
      };
    }
    
    const config = await getSponsorshipConfig();
    
    await db.insert(sponsoredAgents).values({
      humanId,
      agentId,
      publicKey,
      sponsoredAmountCelo: config.amountCelo,
      status: 'reserved'
    });
    
    console.log(`[sponsored-liquidity] Reserved ${config.amountCelo} CELO for humanId ${humanId}`);
    
    return {
      success: true,
      amountCelo: config.amountCelo
    };
  } catch (error: any) {
    console.error('[sponsored-liquidity] Reserve error:', error);
    return {
      success: false,
      error: error.message || 'Failed to reserve sponsorship'
    };
  }
}

export async function executeSponsoredLiquidity(
  humanId: string,
  tokenAddress: string,
  tokenSymbol: string,
  agentWalletAddress: string,
  agentId?: string
): Promise<SponsorshipResult> {
  try {
    const verified = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId))
      .limit(1);
    
    if (verified.length === 0) {
      return {
        success: false,
        error: 'Only verified agents can receive sponsored liquidity'
      };
    }
    
    const config = await getSponsorshipConfig();
    if (!config.enabled) {
      return {
        success: false,
        error: 'Sponsorship program is currently unavailable'
      };
    }
    
    let sponsorshipId: number;
    let amountCelo: string;
    
    let lockResult: { success: boolean; id?: number; amount?: string; status?: string };
    
    try {
      lockResult = await db.transaction(async (tx) => {
        const lockedRow: any[] = await tx.execute(sql`
          SELECT id, sponsored_amount_celo, status FROM sponsored_agents 
          WHERE human_id = ${humanId} 
          FOR UPDATE NOWAIT
        `);
        
        if (lockedRow && lockedRow.length > 0) {
          const row = lockedRow[0];
          if (row.status === 'completed' || row.status === 'in_progress') {
            return { success: false, status: row.status };
          }
          
          await tx.execute(sql`
            UPDATE sponsored_agents 
            SET status = 'in_progress', 
                token_address = ${tokenAddress}, 
                token_symbol = ${tokenSymbol}, 
                agent_id = ${agentId || null}
            WHERE id = ${row.id}
          `);
          
          return { success: true, id: row.id, amount: row.sponsored_amount_celo };
        }
        
        const insertResult: any[] = await tx.execute(sql`
          INSERT INTO sponsored_agents (human_id, agent_id, token_address, token_symbol, sponsored_amount_celo, status)
          VALUES (${humanId}, ${agentId || null}, ${tokenAddress}, ${tokenSymbol}, ${config.amountCelo}, 'in_progress')
          ON CONFLICT (human_id) DO NOTHING
          RETURNING id, sponsored_amount_celo
        `);
        
        if (insertResult && insertResult.length > 0) {
          return { success: true, id: insertResult[0].id, amount: insertResult[0].sponsored_amount_celo };
        }
        
        return { success: false, status: 'conflict' };
      });
    } catch (txError: any) {
      if (txError.code === '55P03') {
        return {
          success: false,
          error: 'Sponsorship transfer already in progress',
          alreadySponsored: true
        };
      }
      throw txError;
    }
    
    if (!lockResult.success) {
      if (lockResult.status === 'completed') {
        return {
          success: false,
          error: 'This human identity has already received sponsored liquidity',
          alreadySponsored: true
        };
      }
      
      return {
        success: false,
        error: 'Sponsorship already in progress or completed',
        alreadySponsored: true
      };
    }
    
    sponsorshipId = lockResult.id;
    amountCelo = lockResult.amount;
    
    if (!SELFCLAW_SPONSOR_PRIVATE_KEY) {
      await db.update(sponsoredAgents)
        .set({ status: 'failed' })
        .where(eq(sponsoredAgents.id, sponsorshipId));
      return {
        success: false,
        error: 'Sponsor wallet not configured'
      };
    }
    
    try {
      const account = privateKeyToAccount(SELFCLAW_SPONSOR_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: celo,
        transport: http()
      });
      
      const amountWei = parseUnits(amountCelo, 18);
      
      const txHash = await walletClient.sendTransaction({
        to: agentWalletAddress as `0x${string}`,
        value: amountWei
      });
      
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      
      await db.update(sponsoredAgents)
        .set({
          tokenAddress,
          tokenSymbol,
          sponsorTxHash: txHash,
          status: 'completed',
          completedAt: new Date()
        })
        .where(eq(sponsoredAgents.id, sponsorshipId));
      
      console.log(`[sponsored-liquidity] Sent ${amountCelo} CELO to ${agentWalletAddress} (tx: ${txHash})`);
      
      return {
        success: true,
        txHash,
        amountCelo
      };
    } catch (txError: any) {
      console.error('[sponsored-liquidity] Transaction error:', txError);
      
      await db.update(sponsoredAgents)
        .set({ status: 'failed' })
        .where(eq(sponsoredAgents.id, sponsorshipId));
      
      return {
        success: false,
        error: txError.message || 'Failed to send sponsored CELO'
      };
    }
  } catch (error: any) {
    console.error('[sponsored-liquidity] Execute error:', error);
    
    return {
      success: false,
      error: error.message || 'Failed to execute sponsored liquidity'
    };
  }
}

export async function getSponsorshipStatus(humanId: string): Promise<{
  sponsored: boolean;
  status?: string;
  amountCelo?: string;
  tokenSymbol?: string;
  txHash?: string;
}> {
  try {
    const sponsorships = await db.select()
      .from(sponsoredAgents)
      .where(eq(sponsoredAgents.humanId, humanId))
      .limit(1);
    
    if (sponsorships.length === 0) {
      return { sponsored: false };
    }
    
    const s = sponsorships[0];
    return {
      sponsored: true,
      status: s.status || undefined,
      amountCelo: s.sponsoredAmountCelo,
      tokenSymbol: s.tokenSymbol || undefined,
      txHash: s.sponsorTxHash || undefined
    };
  } catch (error) {
    console.error('[sponsored-liquidity] Status check error:', error);
    return { sponsored: false };
  }
}

export async function getSponsorWalletInfo(): Promise<{
  address: string;
  balanceCelo: string;
  sponsorAmountPerAgent: string;
  canSponsor: boolean;
  totalSponsored: number;
}> {
  try {
    if (!SELFCLAW_SPONSOR_PRIVATE_KEY) {
      return {
        address: 'Not configured',
        balanceCelo: '0',
        sponsorAmountPerAgent: SPONSORED_LIQUIDITY_AMOUNT,
        canSponsor: false,
        totalSponsored: 0
      };
    }
    
    const account = privateKeyToAccount(SELFCLAW_SPONSOR_PRIVATE_KEY as `0x${string}`);
    const balance = await publicClient.getBalance({ address: account.address });
    const formattedBalance = formatUnits(balance, 18);
    
    const completedCount = await db.select({ count: sql<number>`count(*)` })
      .from(sponsoredAgents)
      .where(eq(sponsoredAgents.status, 'completed'));
    
    return {
      address: account.address,
      balanceCelo: formattedBalance,
      sponsorAmountPerAgent: SPONSORED_LIQUIDITY_AMOUNT,
      canSponsor: parseFloat(formattedBalance) >= parseFloat(SPONSORED_LIQUIDITY_AMOUNT),
      totalSponsored: Number(completedCount[0]?.count || 0)
    };
  } catch (error) {
    console.error('[sponsored-liquidity] Wallet info error:', error);
    return {
      address: 'Error',
      balanceCelo: '0',
      sponsorAmountPerAgent: SPONSORED_LIQUIDITY_AMOUNT,
      canSponsor: false,
      totalSponsored: 0
    };
  }
}
