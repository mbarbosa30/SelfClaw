import { parseAbi, encodeFunctionData, parseUnits } from 'viem';
import { getDeployedAddress, getDeployedAbi } from './contract-deployer.js';
import { getPublicClient, getWalletClient as getChainWalletClient, type SupportedChain } from './chains.js';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

function getContractConfig(): { address: `0x${string}`; abi: any[] } | null {
  const address = getDeployedAddress('SelfClawStaking');
  const abi = getDeployedAbi('SelfClawStaking');
  if (!address || !abi) return null;
  return { address: address as `0x${string}`, abi };
}

export interface StakeResult {
  success: boolean;
  stakeId?: string;
  txHash?: string;
  error?: string;
}

export interface ResolveResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export async function createStakeUnsignedTx(
  outputHash: string,
  amount: string,
  tokenAddress: string,
): Promise<{ approveTx: any; stakeTx: any } | null> {
  const config = getContractConfig();
  if (!config) return null;

  const amountWei = parseUnits(amount, 18);
  const outputHashBytes = outputHash.startsWith('0x')
    ? outputHash as `0x${string}`
    : `0x${outputHash.padStart(64, '0')}` as `0x${string}`;

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [config.address, amountWei],
  });

  const stakeData = encodeFunctionData({
    abi: config.abi,
    functionName: 'createStake',
    args: [outputHashBytes, amountWei, tokenAddress as `0x${string}`],
  });

  return {
    approveTx: { to: tokenAddress, data: approveData },
    stakeTx: { to: config.address, data: stakeData },
  };
}

export async function depositStakePlatform(
  outputHash: string,
  amount: string,
  tokenAddress: string,
  chain: SupportedChain = 'celo',
): Promise<StakeResult> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Staking contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const amountWei = parseUnits(amount, 18);
    const outputHashBytes = outputHash.startsWith('0x')
      ? outputHash as `0x${string}`
      : `0x${outputHash.padStart(64, '0')}` as `0x${string}`;

    const currentAllowance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [walletClient.account!.address, config.address],
    });

    if (currentAllowance < amountWei) {
      const approveTx = await walletClient.writeContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [config.address, amountWei],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 30_000 });
    }

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'createStake',
      args: [outputHashBytes, amountWei, tokenAddress as `0x${string}`],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Stake transaction failed on-chain' };
    }

    const stakeCreatedLog = receipt.logs.find(log => log.topics[0] === '0x' + 'b6e3239e521a6c66920ae634f8e921a37e6991d520ac44d52f8516397f41b684');
    const stakeId = stakeCreatedLog?.topics[1] ? BigInt(stakeCreatedLog.topics[1]).toString() : undefined;

    console.log(`[staking-contract] Stake deposited on ${chain}: id=${stakeId}, amount=${amount}, tx=${txHash}`);
    return { success: true, stakeId, txHash };
  } catch (error: any) {
    console.error(`[staking-contract] Deposit failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function resolveStakeOnchain(
  contractStakeId: number,
  resolution: 'neutral' | 'validated' | 'slashed',
  chain: SupportedChain = 'celo',
): Promise<ResolveResult> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Staking contract not deployed' };

  const resolutionMap = { neutral: 1, validated: 2, slashed: 3 };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'resolveStake',
      args: [BigInt(contractStakeId), resolutionMap[resolution]],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Resolution transaction failed on-chain' };
    }

    console.log(`[staking-contract] Stake ${contractStakeId} resolved as ${resolution} on ${chain}, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[staking-contract] Resolution failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function fundStakingRewardPool(
  tokenAddress: string,
  amount: string,
  chain: SupportedChain = 'celo',
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Staking contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const amountWei = parseUnits(amount, 18);

    const approveTx = await walletClient.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [config.address, amountWei],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 30_000 });

    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'fundRewardPool',
      args: [tokenAddress as `0x${string}`, amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Fund reward pool failed on-chain' };
    }

    console.log(`[staking-contract] Reward pool funded on ${chain}: ${amount} tokens, tx=${txHash}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error(`[staking-contract] Fund pool failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function getRewardPoolBalance(tokenAddress: string, chain: SupportedChain = 'celo'): Promise<string> {
  const config = getContractConfig();
  if (!config) return '0';

  try {
    const publicClient = getPublicClient(chain);
    const balance = await publicClient.readContract({
      address: config.address,
      abi: config.abi,
      functionName: 'getRewardPoolBalance',
      args: [tokenAddress as `0x${string}`],
    });
    const { formatUnits } = await import('viem');
    return formatUnits(balance as bigint, 18);
  } catch {
    return '0';
  }
}

export function isStakingContractDeployed(): boolean {
  return !!getDeployedAddress('SelfClawStaking');
}
