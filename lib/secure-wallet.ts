import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db } from '../server/db.js';
import { agentWallets, verifiedBots } from '../shared/schema.js';
import { eq, sql } from 'drizzle-orm';

const GAS_AMOUNT_CELO = process.env.GAS_SUBSIDY_CELO || '1';
const rawGasKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
const SELFCLAW_GAS_PRIVATE_KEY = rawGasKey && !rawGasKey.startsWith('0x') ? `0x${rawGasKey}` : rawGasKey;

const publicClient = createPublicClient({
  chain: celo,
  transport: http()
});

export interface WalletCreationResult {
  success: boolean;
  address?: string;
  publicKey?: string;
  error?: string;
  alreadyExists?: boolean;
}

export async function createAgentWallet(humanId: string, agentPublicKey: string, walletAddress: string): Promise<WalletCreationResult> {
  try {
    const verified = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId))
      .limit(1);
    
    if (verified.length === 0) {
      return {
        success: false,
        error: 'Only verified agents can register wallets'
      };
    }
    
    if (verified[0].publicKey !== agentPublicKey) {
      return {
        success: false,
        error: 'Agent public key does not match the verified agent for this humanId'
      };
    }
    
    const existing = await db.select()
      .from(agentWallets)
      .where(eq(agentWallets.humanId, humanId))
      .limit(1);
    
    if (existing.length > 0) {
      return {
        success: true,
        address: existing[0].address,
        publicKey: existing[0].publicKey,
        alreadyExists: true
      };
    }

    const addressRegex = /^0x[0-9a-fA-F]{40}$/;
    if (!addressRegex.test(walletAddress)) {
      return {
        success: false,
        error: 'Invalid wallet address format. Must be a valid Ethereum/Celo address (0x + 40 hex characters)'
      };
    }

    await db.insert(agentWallets).values({
      humanId,
      publicKey: agentPublicKey,
      address: walletAddress,
    });

    console.log(`[secure-wallet] Registered wallet ${walletAddress} for humanId ${humanId.substring(0, 16)}...`);

    return {
      success: true,
      address: walletAddress,
      publicKey: agentPublicKey,
    };
  } catch (error: any) {
    console.error('[secure-wallet] Wallet registration error:', error);
    return {
      success: false,
      error: error.message || 'Failed to register wallet'
    };
  }
}

export interface WalletSwitchResult {
  success: boolean;
  address?: string;
  previousAddress?: string;
  error?: string;
}

export async function switchWallet(
  humanId: string,
  agentPublicKey: string,
  newAddress: string
): Promise<WalletSwitchResult> {
  try {
    const verified = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId))
      .limit(1);

    if (verified.length === 0) {
      return { success: false, error: 'Only verified agents can switch wallets' };
    }

    if (verified[0].publicKey !== agentPublicKey) {
      return { success: false, error: 'Agent public key does not match the verified agent for this humanId' };
    }

    const existing = await db.select()
      .from(agentWallets)
      .where(eq(agentWallets.humanId, humanId))
      .limit(1);

    if (existing.length === 0) {
      return { success: false, error: 'No wallet found. Register a wallet first.' };
    }

    const addressRegex = /^0x[0-9a-fA-F]{40}$/;
    if (!addressRegex.test(newAddress)) {
      return { success: false, error: 'Invalid wallet address format' };
    }

    const previousAddress = existing[0].address;

    if (previousAddress === newAddress) {
      return { success: false, error: 'New address is the same as the current one' };
    }

    await db.update(agentWallets)
      .set({
        address: newAddress,
        updatedAt: new Date(),
      })
      .where(eq(agentWallets.humanId, humanId));

    console.log(`[secure-wallet] Updated wallet for humanId ${humanId.substring(0, 16)}... from ${previousAddress} to ${newAddress}`);
    return {
      success: true,
      address: newAddress,
      previousAddress,
    };
  } catch (error: any) {
    console.error('[secure-wallet] Switch wallet error:', error);
    return { success: false, error: error.message || 'Failed to switch wallet' };
  }
}

export async function getAgentWalletByHumanId(humanId: string): Promise<{
  address?: string;
  publicKey?: string;
  gasReceived?: boolean;
  balance?: { celo: string; };
} | null> {
  try {
    const wallets = await db.select()
      .from(agentWallets)
      .where(eq(agentWallets.humanId, humanId))
      .limit(1);
    
    if (wallets.length === 0) {
      return null;
    }
    
    const wallet = wallets[0];
    
    const celoBalance = await publicClient.getBalance({ address: wallet.address as `0x${string}` });
    
    return {
      address: wallet.address,
      publicKey: wallet.publicKey,
      gasReceived: wallet.gasReceived || false,
      balance: {
        celo: formatUnits(celoBalance, 18)
      }
    };
  } catch (error) {
    console.error('[secure-wallet] Get wallet error:', error);
    return null;
  }
}

export interface GasSubsidyResult {
  success: boolean;
  txHash?: string;
  amountCelo?: string;
  error?: string;
  alreadyReceived?: boolean;
}

export async function sendGasSubsidy(humanId: string): Promise<GasSubsidyResult> {
  try {
    const wallets = await db.select()
      .from(agentWallets)
      .where(eq(agentWallets.humanId, humanId))
      .limit(1);
    
    if (wallets.length === 0) {
      return {
        success: false,
        error: 'No wallet found for this humanId. Register a wallet first.'
      };
    }
    
    const wallet = wallets[0];
    
    if (wallet.gasReceived) {
      return {
        success: false,
        error: 'Gas subsidy already received',
        alreadyReceived: true
      };
    }
    
    if (wallet.gasTxHash) {
      return {
        success: true,
        txHash: wallet.gasTxHash,
        amountCelo: GAS_AMOUNT_CELO,
        alreadyReceived: true
      };
    }
    
    if (!SELFCLAW_GAS_PRIVATE_KEY) {
      return {
        success: false,
        error: 'Gas subsidy wallet not configured'
      };
    }
    
    const pendingMarker = `pending-${Date.now()}`;
    
    try {
      const claimResult = await db.execute(sql`
        UPDATE agent_wallets 
        SET gas_tx_hash = ${pendingMarker}, updated_at = NOW()
        WHERE human_id = ${humanId} 
          AND gas_received = false 
          AND gas_tx_hash IS NULL
        RETURNING id
      `);
      
      const claimedRows = (claimResult as any).rows || [];
      if (claimedRows.length === 0) {
        const current = await db.select()
          .from(agentWallets)
          .where(eq(agentWallets.humanId, humanId))
          .limit(1);
        
        if (current.length > 0 && current[0].gasTxHash && !current[0].gasTxHash.startsWith('pending-')) {
          return {
            success: true,
            txHash: current[0].gasTxHash,
            amountCelo: GAS_AMOUNT_CELO,
            alreadyReceived: true
          };
        }
        
        return {
          success: false,
          error: 'Gas subsidy already in progress or received',
          alreadyReceived: true
        };
      }
    } catch (claimError: any) {
      console.error('[secure-wallet] Gas claim error:', claimError);
      return {
        success: false,
        error: 'Failed to claim gas subsidy slot'
      };
    }
    
    try {
      const sponsorAccount = privateKeyToAccount(SELFCLAW_GAS_PRIVATE_KEY as `0x${string}`);
      const sponsorWallet = createWalletClient({
        account: sponsorAccount,
        chain: celo,
        transport: http()
      });
      
      const amountWei = parseUnits(GAS_AMOUNT_CELO, 18);
      
      const txHash = await sponsorWallet.sendTransaction({
        to: wallet.address as `0x${string}`,
        value: amountWei
      });
      
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      
      await db.execute(sql`
        UPDATE agent_wallets 
        SET gas_tx_hash = ${txHash}, gas_received = true, updated_at = NOW() 
        WHERE human_id = ${humanId}
      `);
      
      console.log(`[secure-wallet] Sent ${GAS_AMOUNT_CELO} CELO gas to ${wallet.address} (tx: ${txHash})`);
      
      return {
        success: true,
        txHash,
        amountCelo: GAS_AMOUNT_CELO
      };
    } catch (txError: any) {
      await db.execute(sql`
        UPDATE agent_wallets 
        SET gas_tx_hash = NULL, updated_at = NOW() 
        WHERE human_id = ${humanId} AND gas_tx_hash LIKE 'pending-%'
      `);
      
      console.error('[secure-wallet] Gas transfer error:', txError);
      return {
        success: false,
        error: txError.message || 'Failed to send gas'
      };
    }
  } catch (error: any) {
    console.error('[secure-wallet] Gas subsidy error:', error);
    
    if (error.code === '55P03') {
      return {
        success: false,
        error: 'Gas subsidy request in progress',
        alreadyReceived: true
      };
    }
    
    return {
      success: false,
      error: error.message || 'Failed to process gas subsidy'
    };
  }
}

export async function getGasWalletInfo(): Promise<{
  address: string;
  balanceCelo: string;
  gasAmountPerAgent: string;
  canSubsidize: boolean;
  totalSubsidized: number;
}> {
  try {
    if (!SELFCLAW_GAS_PRIVATE_KEY) {
      return {
        address: 'Not configured',
        balanceCelo: '0',
        gasAmountPerAgent: GAS_AMOUNT_CELO,
        canSubsidize: false,
        totalSubsidized: 0
      };
    }
    
    const account = privateKeyToAccount(SELFCLAW_GAS_PRIVATE_KEY as `0x${string}`);
    const balance = await publicClient.getBalance({ address: account.address });
    const formattedBalance = formatUnits(balance, 18);
    
    const subsidizedCount = await db.select({ count: sql<number>`count(*)` })
      .from(agentWallets)
      .where(eq(agentWallets.gasReceived, true));
    
    return {
      address: account.address,
      balanceCelo: formattedBalance,
      gasAmountPerAgent: GAS_AMOUNT_CELO,
      canSubsidize: parseFloat(formattedBalance) >= parseFloat(GAS_AMOUNT_CELO),
      totalSubsidized: Number(subsidizedCount[0]?.count || 0)
    };
  } catch (error) {
    console.error('[secure-wallet] Gas wallet info error:', error);
    return {
      address: 'Error',
      balanceCelo: '0',
      gasAmountPerAgent: GAS_AMOUNT_CELO,
      canSubsidize: false,
      totalSubsidized: 0
    };
  }
}
