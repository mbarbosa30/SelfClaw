import { parseAbi, parseUnits, formatUnits, keccak256, toHex } from 'viem';
import { getDeployedAddress, getDeployedAbi } from './contract-deployer.js';
import { getPublicClient, getWalletClient as getChainWalletClient, getChainConfig, type SupportedChain } from './chains.js';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

function getContractConfig(): { address: `0x${string}`; abi: any[] } | null {
  const address = getDeployedAddress('SelfClawRewards');
  const abi = getDeployedAbi('SelfClawRewards');
  if (!address || !abi) return null;
  return { address: address as `0x${string}`, abi };
}

export function referralIdToBytes32(referralId: string): `0x${string}` {
  return keccak256(toHex(referralId));
}

export interface RewardResult {
  success: boolean;
  txHash?: string;
  queued?: boolean;
  error?: string;
}

export async function distributeReferralReward(
  recipientAddress: string,
  amount: string,
  referralId: string,
  chain: SupportedChain = 'celo',
): Promise<RewardResult> {
  if (chain !== 'celo') return { success: false, error: `Rewards contract is not deployed on ${chain}. Only Celo is supported.` };
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Rewards contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const amountWei = parseUnits(amount, 18);
    const refIdBytes = referralIdToBytes32(referralId);

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'distributeReward',
      args: [recipientAddress as `0x${string}`, amountWei, refIdBytes],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Reward distribution failed on-chain' };
    }

    const queuedEvent = receipt.logs.find(log => {
      const queuedTopic = '0x' + 'a2e524e2fdf0b7b9a0f44e8fa543fe5bcb2c4aef5ad1f80cb25e8835d0abeb8c';
      return log.topics[0] === queuedTopic;
    });

    console.log(`[rewards-contract] Reward distributed on ${chain}: referral=${referralId}, recipient=${recipientAddress}, amount=${amount}, tx=${txHash}`);
    return { success: true, txHash, queued: !!queuedEvent };
  } catch (error: any) {
    console.error(`[rewards-contract] Distribution failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function claimPendingReward(referralId: string, chain: SupportedChain = 'celo'): Promise<RewardResult> {
  if (chain !== 'celo') return { success: false, error: `Rewards contract is not deployed on ${chain}. Only Celo is supported.` };
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Rewards contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const refIdBytes = referralIdToBytes32(referralId);

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'claimReward',
      args: [refIdBytes],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Claim failed on-chain' };
    }

    console.log(`[rewards-contract] Reward claimed on ${chain}: referral=${referralId}, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[rewards-contract] Claim failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function fundRewardsPool(amount: string, chain: SupportedChain = 'celo'): Promise<{ success: boolean; txHash?: string; error?: string }> {
  if (chain !== 'celo') return { success: false, error: `Rewards contract is not deployed on ${chain}. Only Celo is supported.` };
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Rewards contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const selfclawToken = getChainConfig(chain).selfclawToken;
    const amountWei = parseUnits(amount, 18);

    const approveTx = await walletClient.writeContract({
      address: selfclawToken,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [config.address, amountWei],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 30_000 });

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'fundPool',
      args: [amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Fund pool failed on-chain' };
    }

    console.log(`[rewards-contract] Pool funded on ${chain}: ${amount} SELFCLAW, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[rewards-contract] Fund pool failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function getRewardsPoolBalance(chain: SupportedChain = 'celo'): Promise<string> {
  if (chain !== 'celo') return '0';
  const config = getContractConfig();
  if (!config) return '0';

  try {
    const publicClient = getPublicClient(chain);
    const balance = await publicClient.readContract({
      address: config.address,
      abi: config.abi,
      functionName: 'getPoolBalance',
    });
    return formatUnits(balance as bigint, 18);
  } catch {
    return '0';
  }
}

export async function isRewardDistributed(referralId: string, chain: SupportedChain = 'celo'): Promise<boolean> {
  if (chain !== 'celo') return false;
  const config = getContractConfig();
  if (!config) return false;

  try {
    const publicClient = getPublicClient(chain);
    return await publicClient.readContract({
      address: config.address,
      abi: config.abi,
      functionName: 'isDistributed',
      args: [referralIdToBytes32(referralId)],
    }) as boolean;
  } catch {
    return false;
  }
}

export function isRewardsContractDeployed(): boolean {
  return !!getDeployedAddress('SelfClawRewards');
}
