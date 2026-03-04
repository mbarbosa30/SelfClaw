import { parseAbi, encodeFunctionData, parseUnits, keccak256, toHex } from 'viem';
import { getDeployedAddress, getDeployedAbi } from './contract-deployer.js';
import { getPublicClient, getWalletClient as getChainWalletClient, type SupportedChain } from './chains.js';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

function getContractConfig(): { address: `0x${string}`; abi: any[] } | null {
  const address = getDeployedAddress('SelfClawEscrow');
  const abi = getDeployedAbi('SelfClawEscrow');
  if (!address || !abi) return null;
  return { address: address as `0x${string}`, abi };
}

export function purchaseIdToBytes32(purchaseId: string): `0x${string}` {
  return keccak256(toHex(purchaseId));
}

export interface EscrowResult {
  success: boolean;
  escrowId?: string;
  txHash?: string;
  error?: string;
}

export async function createOnchainEscrow(
  sellerAddress: string,
  amount: string,
  tokenAddress: string,
  purchaseId: string,
  chain: SupportedChain = 'celo',
): Promise<EscrowResult> {
  if (chain !== 'celo') return { success: false, error: `Escrow contract is not deployed on ${chain}. Only Celo is supported.` };
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Escrow contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const amountWei = parseUnits(amount, 18);
    const purchaseIdBytes = purchaseIdToBytes32(purchaseId);

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
      functionName: 'createEscrow',
      args: [sellerAddress as `0x${string}`, amountWei, tokenAddress as `0x${string}`, purchaseIdBytes],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Escrow creation failed on-chain' };
    }

    const escrowCreatedLog = receipt.logs.find(log =>
      log.address.toLowerCase() === config.address.toLowerCase() && log.topics.length >= 3
    );
    const escrowId = escrowCreatedLog?.topics[1] ? BigInt(escrowCreatedLog.topics[1]).toString() : undefined;

    console.log(`[escrow-contract] Escrow created on ${chain}: id=${escrowId}, amount=${amount}, purchase=${purchaseId}, tx=${txHash}`);
    return { success: true, escrowId, txHash };
  } catch (error: any) {
    console.error(`[escrow-contract] Create escrow failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function releaseOnchainEscrow(escrowId: number, chain: SupportedChain = 'celo'): Promise<EscrowResult> {
  if (chain !== 'celo') return { success: false, error: `Escrow contract is not deployed on ${chain}. Only Celo is supported.` };
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Escrow contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'releaseEscrow',
      args: [BigInt(escrowId)],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Escrow release failed on-chain' };
    }

    console.log(`[escrow-contract] Escrow ${escrowId} released on ${chain}, tx=${txHash}`);
    return { success: true, escrowId: escrowId.toString(), txHash };
  } catch (error: any) {
    console.error(`[escrow-contract] Release failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function refundOnchainEscrow(escrowId: number, chain: SupportedChain = 'celo'): Promise<EscrowResult> {
  if (chain !== 'celo') return { success: false, error: `Escrow contract is not deployed on ${chain}. Only Celo is supported.` };
  const config = getContractConfig();
  if (!config) return { success: false, error: 'Escrow contract not deployed' };

  try {
    const publicClient = getPublicClient(chain);
    const walletClient = getChainWalletClient(chain);
    const txHash = await walletClient.writeContract({
      address: config.address,
      abi: config.abi,
      functionName: 'refundEscrow',
      args: [BigInt(escrowId)],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      return { success: false, error: 'Escrow refund failed on-chain' };
    }

    console.log(`[escrow-contract] Escrow ${escrowId} refunded on ${chain}, tx=${txHash}`);
    return { success: true, escrowId: escrowId.toString(), txHash };
  } catch (error: any) {
    console.error(`[escrow-contract] Refund failed:`, error.message);
    return { success: false, error: error.message };
  }
}

export function createEscrowUnsignedTx(
  sellerAddress: string,
  amount: string,
  tokenAddress: string,
  purchaseId: string,
): { approveTx: any; escrowTx: any } | null {
  const config = getContractConfig();
  if (!config) return null;

  const amountWei = parseUnits(amount, 18);
  const purchaseIdBytes = purchaseIdToBytes32(purchaseId);

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [config.address, amountWei],
  });

  const escrowData = encodeFunctionData({
    abi: config.abi,
    functionName: 'createEscrow',
    args: [sellerAddress as `0x${string}`, amountWei, tokenAddress as `0x${string}`, purchaseIdBytes],
  });

  return {
    approveTx: { to: tokenAddress, data: approveData },
    escrowTx: { to: config.address, data: escrowData },
  };
}

export function isEscrowContractDeployed(): boolean {
  return !!getDeployedAddress('SelfClawEscrow');
}

export function getEscrowContractAddress(): string | null {
  return getDeployedAddress('SelfClawEscrow');
}
