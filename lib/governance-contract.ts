import { createPublicClient, createWalletClient, http, fallback, parseAbi, parseUnits, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getDeployedAddress, getDeployedAbi } from './contract-deployer.js';

const BASE_RPC_PRIMARY = 'https://mainnet.base.org';
const BASE_RPC_FALLBACK = 'https://base.meowrpc.com';

const SELFCLAW_TOKEN_BASE = '0x9ae5f51d81ff510bf961218f833f79d57bfbab07';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

const publicClient = createPublicClient({
  chain: base,
  transport: fallback([
    http(BASE_RPC_PRIMARY, { timeout: 15_000, retryCount: 1 }),
    http(BASE_RPC_FALLBACK, { timeout: 15_000, retryCount: 1 }),
  ]),
});

function getWalletClient() {
  const rawKey = process.env.CELO_PRIVATE_KEY;
  if (!rawKey) throw new Error('CELO_PRIVATE_KEY not set');
  const pk = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({
    account,
    chain: base,
    transport: fallback([
      http(BASE_RPC_PRIMARY, { timeout: 15_000, retryCount: 1 }),
      http(BASE_RPC_FALLBACK, { timeout: 15_000, retryCount: 1 }),
    ]),
  });
}

function getContractConfig(): { address: `0x${string}`; abi: any[] } | null {
  const address = getDeployedAddress('SelfClawGovernance');
  const abi = getDeployedAbi('SelfClawGovernance');
  if (!address || !abi) return null;
  return { address: address as `0x${string}`, abi };
}

export function isGovernanceContractDeployed(): boolean {
  return !!getDeployedAddress('SelfClawGovernance');
}

export function getGovernanceTokenAddress(): string {
  return SELFCLAW_TOKEN_BASE;
}

export interface StakeResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export async function stakeTokens(amount: string): Promise<StakeResult> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Governance contract not deployed' };

  try {
    const walletClient = getWalletClient();
    const amountWei = parseUnits(amount, 18);

    const currentAllowance = await publicClient.readContract({
      address: SELFCLAW_TOKEN_BASE as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [walletClient.account!.address, config.address],
    });

    if ((currentAllowance as bigint) < amountWei) {
      const approveTx = await walletClient.writeContract({
        address: SELFCLAW_TOKEN_BASE as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [config.address, amountWei],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 30_000 });
    }

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'stake',
      args: [amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Stake transaction failed on-chain' };
    }

    console.log(`[governance] Staked ${amount} SELFCLAW, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[governance] Stake failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function requestUnstake(amount: string): Promise<StakeResult> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Governance contract not deployed' };

  try {
    const walletClient = getWalletClient();
    const amountWei = parseUnits(amount, 18);

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'requestUnstake',
      args: [amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Unstake request failed on-chain' };
    }

    console.log(`[governance] Unstake requested for ${amount} SELFCLAW, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[governance] Unstake request failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function unstakeTokens(amount: string): Promise<StakeResult> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Governance contract not deployed' };

  try {
    const walletClient = getWalletClient();
    const amountWei = parseUnits(amount, 18);

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'unstake',
      args: [amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Unstake failed on-chain' };
    }

    console.log(`[governance] Unstaked ${amount} SELFCLAW, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[governance] Unstake failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function getStakedBalance(address: string): Promise<{
  amount: string;
  stakedAt: number;
  unstakeRequestedAt: number;
  unstakeAmount: string;
}> {
  const config = getContractConfig();
  if (!config) return { amount: '0', stakedAt: 0, unstakeRequestedAt: 0, unstakeAmount: '0' };

  try {
    const result = await publicClient.readContract({
      address: config.address,
      abi: config.abi,
      functionName: 'getStake',
      args: [address as `0x${string}`],
    }) as [bigint, bigint, bigint, bigint];

    return {
      amount: formatUnits(result[0], 18),
      stakedAt: Number(result[1]),
      unstakeRequestedAt: Number(result[2]),
      unstakeAmount: formatUnits(result[3], 18),
    };
  } catch {
    return { amount: '0', stakedAt: 0, unstakeRequestedAt: 0, unstakeAmount: '0' };
  }
}

export async function getVotingPower(address: string): Promise<string> {
  const config = getContractConfig();
  if (!config) return '0';

  try {
    const power = await publicClient.readContract({
      address: config.address,
      abi: config.abi,
      functionName: 'getVotingPower',
      args: [address as `0x${string}`],
    }) as bigint;

    return formatUnits(power, 18);
  } catch {
    return '0';
  }
}

export async function createProposalOnchain(
  title: string,
  description: string,
  votingPeriodDays: number,
): Promise<{ success: boolean; proposalId?: string; txHash?: string; error?: string }> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Governance contract not deployed' };

  try {
    const walletClient = getWalletClient();
    const votingPeriod = BigInt(votingPeriodDays * 86400);

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'createProposal',
      args: [title, description, votingPeriod],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Proposal creation failed on-chain' };
    }

    const proposalLog = receipt.logs.find(log => log.topics.length >= 2);
    const proposalId = proposalLog?.topics[1] ? BigInt(proposalLog.topics[1]).toString() : undefined;

    console.log(`[governance] Proposal created: id=${proposalId}, tx=${txHash}`);
    return { success: true, proposalId, txHash };
  } catch (error: any) {
    console.error(`[governance] Proposal creation failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function voteOnchain(
  proposalId: number,
  support: boolean,
): Promise<StakeResult> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Governance contract not deployed' };

  try {
    const walletClient = getWalletClient();

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'vote',
      args: [BigInt(proposalId), support],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Vote failed on-chain' };
    }

    console.log(`[governance] Vote cast: proposal=${proposalId}, support=${support}, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[governance] Vote failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function getTotalStaked(): Promise<string> {
  const config = getContractConfig();
  if (!config) return '0';

  try {
    const total = await publicClient.readContract({
      address: config.address,
      abi: config.abi,
      functionName: 'totalStaked',
    }) as bigint;

    return formatUnits(total, 18);
  } catch {
    return '0';
  }
}
