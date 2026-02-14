import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData, encodePacked, encodeAbiParameters, parseAbiParameters, maxUint256 } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db } from '../server/db.js';
import { sponsoredAgents, verifiedBots } from '../shared/schema.js';
import { eq, sql } from 'drizzle-orm';

const publicClient = createPublicClient({
  chain: celo,
  transport: http(undefined, { timeout: 15_000, retryCount: 1 })
});

const SPONSORED_LIQUIDITY_AMOUNT = process.env.SPONSORED_LIQUIDITY_CELO || '100';
const rawSponsorKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
const SELFCLAW_SPONSOR_PRIVATE_KEY = rawSponsorKey && !rawSponsorKey.startsWith('0x') ? `0x${rawSponsorKey}` : rawSponsorKey;

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
      .where(eq(sponsoredAgents.humanId, humanId));
    
    const MAX_SPONSORSHIPS_PER_HUMAN = 3;
    if (existing.length >= MAX_SPONSORSHIPS_PER_HUMAN) {
      return {
        eligible: false,
        reason: `This human identity has reached the maximum of ${MAX_SPONSORSHIPS_PER_HUMAN} sponsorships (${existing.length}/${MAX_SPONSORSHIPS_PER_HUMAN})`
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
    
    let sponsorshipId: string;
    let amountCelo: string;
    
    let lockResult: { success: boolean; id?: string; amount?: string; status?: string };
    
    try {
      lockResult = await db.transaction(async (tx) => {
        const lockedResult = await tx.execute(sql`
          SELECT id, sponsored_amount_celo, status, token_address FROM sponsored_agents 
          WHERE human_id = ${humanId} AND token_address = ${tokenAddress}
          FOR UPDATE NOWAIT
        `);
        const lockedRow = (lockedResult as any).rows || [];
        
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
        
        const insertRes = await tx.execute(sql`
          INSERT INTO sponsored_agents (human_id, agent_id, token_address, token_symbol, sponsored_amount_celo, status)
          VALUES (${humanId}, ${agentId || null}, ${tokenAddress}, ${tokenSymbol}, ${config.amountCelo}, 'in_progress')
          RETURNING id, sponsored_amount_celo
        `);
        const insertResult = (insertRes as any).rows || [];
        
        if (insertResult && insertResult.length > 0) {
          return { success: true, id: insertResult[0].id, amount: insertResult[0].sponsored_amount_celo };
        }
        
        return { success: false, status: 'insert_failed' };
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
    
    sponsorshipId = lockResult.id!;
    amountCelo = lockResult.amount!;
    
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

const UNISWAP_V4_POSITION_MANAGER = '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9' as `0x${string}`;
const POOL_MANAGER = '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC' as `0x${string}`;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`;
const WRAPPED_CELO = '0x471EcE3750Da237f93B8E339c536989b8978a438' as `0x${string}`;

const POOL_MANAGER_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'sqrtPriceX96', type: 'uint160' },
    ],
    outputs: [{ name: 'tick', type: 'int24' }],
  },
] as const;

const V4_POSITION_MANAGER_ABI = [
  {
    name: 'modifyLiquidities',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'unlockData', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export interface SponsoredLPRequest {
  humanId: string;
  agentId: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: string;
  initialPriceInCelo: string;
}

export interface SponsoredLPResult {
  success: boolean;
  poolAddress?: string;
  positionId?: string;
  tokenAmount?: string;
  celoAmount?: string;
  txHash?: string;
  error?: string;
  alreadySponsored?: boolean;
}

function priceToSqrtPriceX96(price: number): bigint {
  const sqrtPrice = Math.sqrt(price);
  const sqrtPriceX96 = sqrtPrice * (2 ** 96);
  return BigInt(Math.floor(sqrtPriceX96));
}

function getTickSpacing(fee: number): number {
  if (fee === 100) return 1;
  if (fee === 500) return 10;
  if (fee === 3000) return 60;
  if (fee === 10000) return 200;
  return 60;
}

function alignTickToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('Square root of negative number');
  if (value === 0n) return 0n;
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export async function createSponsoredLP(request: SponsoredLPRequest): Promise<SponsoredLPResult> {
  const { humanId, agentId, tokenAddress, tokenSymbol, tokenAmount, initialPriceInCelo } = request;
  
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
    
    if (!SELFCLAW_SPONSOR_PRIVATE_KEY) {
      return {
        success: false,
        error: 'Sponsor wallet not configured'
      };
    }
    
    let sponsorshipId: string;
    let lockResult: { success: boolean; id?: string; status?: string };
    
    try {
      lockResult = await db.transaction(async (tx) => {
        const lockedResult = await tx.execute(sql`
          SELECT id, status FROM sponsored_agents 
          WHERE human_id = ${humanId} AND token_address = ${tokenAddress}
          FOR UPDATE NOWAIT
        `);
        const lockedRow = (lockedResult as any).rows || [];
        
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
          
          return { success: true, id: row.id };
        }
        
        const insertRes = await tx.execute(sql`
          INSERT INTO sponsored_agents (human_id, agent_id, token_address, token_symbol, sponsored_amount_celo, status)
          VALUES (${humanId}, ${agentId || null}, ${tokenAddress}, ${tokenSymbol}, ${config.amountCelo}, 'in_progress')
          RETURNING id
        `);
        const insertResult = (insertRes as any).rows || [];
        
        if (insertResult && insertResult.length > 0) {
          return { success: true, id: insertResult[0].id };
        }
        
        return { success: false, status: 'insert_failed' };
      });
    } catch (txError: any) {
      if (txError.code === '55P03') {
        return {
          success: false,
          error: 'Sponsorship creation already in progress',
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
    
    sponsorshipId = lockResult.id!;
    
    const account = privateKeyToAccount(SELFCLAW_SPONSOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: celo,
      transport: http()
    });
    
    const tokenAddr = tokenAddress as `0x${string}`;
    const tokenBalance = await publicClient.readContract({
      address: tokenAddr,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address]
    });
    
    const requiredTokens = parseUnits(tokenAmount, 18);
    if (tokenBalance < requiredTokens) {
      await db.execute(sql`UPDATE sponsored_agents SET status = 'pending' WHERE id = ${sponsorshipId}`);
      return {
        success: false,
        error: `Insufficient tokens received. Expected ${tokenAmount}, got ${formatUnits(tokenBalance, 18)}. Send tokens to ${account.address} first.`
      };
    }
    
    const celoAmount = config.amountCelo;
    const celoWei = parseUnits(celoAmount, 18);
    
    const price = parseFloat(initialPriceInCelo);
    let addr0 = tokenAddr;
    let addr1 = WRAPPED_CELO;
    let amt0 = requiredTokens;
    let amt1 = celoWei;
    let adjustedPrice = price;
    
    if (addr0.toLowerCase() > addr1.toLowerCase()) {
      [addr0, addr1] = [addr1, addr0];
      [amt0, amt1] = [amt1, amt0];
      adjustedPrice = 1 / price;
    }
    
    const fee = 3000;
    const tickSpacing = getTickSpacing(fee);
    const sqrtPriceX96 = priceToSqrtPriceX96(adjustedPrice);
    
    try {
      const poolKey = {
        currency0: addr0,
        currency1: addr1,
        fee,
        tickSpacing,
        hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      };

      const initData = encodeFunctionData({
        abi: POOL_MANAGER_ABI,
        functionName: 'initialize',
        args: [poolKey, sqrtPriceX96]
      });

      const createPoolHash = await walletClient.sendTransaction({
        to: POOL_MANAGER,
        data: initData,
        value: 0n
      });
      await publicClient.waitForTransactionReceipt({ hash: createPoolHash });

      const approvePermit2Data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [PERMIT2, maxUint256]
      });

      const approvePermit2Hash = await walletClient.sendTransaction({
        to: tokenAddr,
        data: approvePermit2Data
      });
      await publicClient.waitForTransactionReceipt({ hash: approvePermit2Hash });

      const maxUint160 = (2n ** 160n) - 1n;
      const permit2Expiration = Math.floor(Date.now() / 1000) + 86400 * 30;
      const permit2ApproveData = encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [tokenAddr, UNISWAP_V4_POSITION_MANAGER, maxUint160, permit2Expiration]
      });

      const permit2ApproveHash = await walletClient.sendTransaction({
        to: PERMIT2,
        data: permit2ApproveData
      });
      await publicClient.waitForTransactionReceipt({ hash: permit2ApproveHash });

      const currentTick = priceToTick(adjustedPrice);
      const tickRange = 6000;
      const tickLower = alignTickToSpacing(currentTick - tickRange, tickSpacing);
      const tickUpper = alignTickToSpacing(currentTick + tickRange, tickSpacing);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const liquidity = bigintSqrt(amt0 * amt1);

      const actions = encodePacked(
        ['uint8', 'uint8'],
        [0x02, 0x0d]
      );

      const mintParams = encodeAbiParameters(
        parseAbiParameters('(address, address, uint24, int24, address), int24, int24, uint256, uint128, uint128, address, bytes'),
        [
          [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
          tickLower,
          tickUpper,
          liquidity,
          amt0,
          amt1,
          account.address,
          '0x',
        ]
      );

      const settlePairParams = encodeAbiParameters(
        parseAbiParameters('address, address'),
        [addr0, addr1]
      );

      const unlockData = encodeAbiParameters(
        parseAbiParameters('bytes, bytes[]'),
        [actions, [mintParams, settlePairParams]]
      );

      const celoValue = addr0 === WRAPPED_CELO ? amt0 : (addr1 === WRAPPED_CELO ? amt1 : 0n);

      const mintHash = await walletClient.sendTransaction({
        to: UNISWAP_V4_POSITION_MANAGER,
        data: encodeFunctionData({
          abi: V4_POSITION_MANAGER_ABI,
          functionName: 'modifyLiquidities',
          args: [unlockData, deadline]
        }),
        value: celoValue
      });
      
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
      
      await db.execute(sql`
        UPDATE sponsored_agents 
        SET status = 'completed', 
            sponsor_tx_hash = ${mintHash}, 
            completed_at = NOW()
        WHERE id = ${sponsorshipId}
      `);
      
      console.log(`[sponsored-liquidity] Created LP for ${tokenSymbol}: ${tokenAmount} tokens + ${celoAmount} CELO (tx: ${mintHash})`);
      
      return {
        success: true,
        tokenAmount,
        celoAmount,
        txHash: mintHash
      };
    } catch (lpError: any) {
      console.error('[sponsored-liquidity] LP creation error:', lpError);
      
      await db.execute(sql`UPDATE sponsored_agents SET status = 'failed' WHERE id = ${sponsorshipId}`);
      
      return {
        success: false,
        error: lpError.message || 'Failed to create liquidity pool'
      };
    }
  } catch (error: any) {
    console.error('[sponsored-liquidity] LP creation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create sponsored liquidity pool'
    };
  }
}
