import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { db } from '../server/db.js';
import { agentWallets, verifiedBots } from '../shared/schema.js';
import { eq, sql } from 'drizzle-orm';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const GAS_AMOUNT_CELO = process.env.GAS_SUBSIDY_CELO || '1';
const SELFCLAW_GAS_PRIVATE_KEY = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;

function getWalletEncryptionSecret(): string {
  const secret = process.env.WALLET_ENCRYPTION_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('WALLET_ENCRYPTION_SECRET or SESSION_SECRET must be configured for secure wallet operations');
  }
  if (secret.length < 32) {
    throw new Error('WALLET_ENCRYPTION_SECRET must be at least 32 characters');
  }
  return secret;
}

const publicClient = createPublicClient({
  chain: celo,
  transport: http()
});

function deriveEncryptionKey(humanId: string, salt: string): Buffer {
  const secret = getWalletEncryptionSecret();
  const combinedSecret = `${humanId}:${secret}`;
  return scryptSync(combinedSecret, salt, 32);
}

function encryptPrivateKey(privateKey: string, humanId: string): { encrypted: string; salt: string } {
  const salt = randomBytes(32).toString('hex');
  const key = deriveEncryptionKey(humanId, salt);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return {
    encrypted: `${iv.toString('hex')}:${authTag}:${encrypted}`,
    salt
  };
}

function decryptPrivateKey(encryptedData: string, humanId: string, salt: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
  const key = deriveEncryptionKey(humanId, salt);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

export interface WalletCreationResult {
  success: boolean;
  address?: string;
  publicKey?: string;
  error?: string;
  alreadyExists?: boolean;
}

export async function createAgentWallet(humanId: string, agentPublicKey: string): Promise<WalletCreationResult> {
  try {
    const verified = await db.select()
      .from(verifiedBots)
      .where(eq(verifiedBots.humanId, humanId))
      .limit(1);
    
    if (verified.length === 0) {
      return {
        success: false,
        error: 'Only verified agents can create wallets'
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
    
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    
    const { encrypted, salt } = encryptPrivateKey(privateKey, humanId);
    
    await db.insert(agentWallets).values({
      humanId,
      publicKey: agentPublicKey,
      address: account.address,
      encryptedPrivateKey: encrypted,
      salt
    });
    
    console.log(`[secure-wallet] Created wallet ${account.address} for humanId ${humanId.substring(0, 16)}...`);
    
    return {
      success: true,
      address: account.address,
      publicKey: agentPublicKey
    };
  } catch (error: any) {
    console.error('[secure-wallet] Wallet creation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create wallet'
    };
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

export async function recoverWalletClient(humanId: string): Promise<{
  walletClient: ReturnType<typeof createWalletClient>;
  address: string;
  account: ReturnType<typeof privateKeyToAccount>;
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
    const privateKey = decryptPrivateKey(wallet.encryptedPrivateKey, humanId, wallet.salt);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    
    const walletClient = createWalletClient({
      account,
      chain: celo,
      transport: http()
    });
    
    return {
      walletClient,
      address: wallet.address,
      account
    };
  } catch (error) {
    console.error('[secure-wallet] Recover wallet error:', error);
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
        error: 'No wallet found for this humanId. Create a wallet first.'
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
