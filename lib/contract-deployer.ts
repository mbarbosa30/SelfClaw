import { createPublicClient, createWalletClient, http, fallback, encodeDeployData, getContractAddress } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';

const CELO_RPC_PRIMARY = 'https://forno.celo.org';
const CELO_RPC_FALLBACK = 'https://rpc.ankr.com/celo';
const DEPLOYMENTS_PATH = path.join(process.cwd(), 'contracts', 'deployments.json');

const publicClient = createPublicClient({
  chain: celo,
  transport: fallback([
    http(CELO_RPC_PRIMARY, { timeout: 30_000, retryCount: 2 }),
    http(CELO_RPC_FALLBACK, { timeout: 30_000, retryCount: 2 }),
  ]),
});

function getWalletClient() {
  const rawKey = process.env.CELO_PRIVATE_KEY;
  if (!rawKey) throw new Error('CELO_PRIVATE_KEY not set');
  const pk = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({
    account,
    chain: celo,
    transport: fallback([
      http(CELO_RPC_PRIMARY, { timeout: 30_000, retryCount: 2 }),
      http(CELO_RPC_FALLBACK, { timeout: 30_000, retryCount: 2 }),
    ]),
  });
}

export function getPlatformAddress(): string {
  const rawKey = process.env.CELO_PRIVATE_KEY;
  if (!rawKey) throw new Error('CELO_PRIVATE_KEY not set');
  const pk = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  return privateKeyToAccount(pk as `0x${string}`).address;
}

export interface CompiledContract {
  abi: any[];
  bytecode: string;
  contractName: string;
}

export function compileSolidity(contractPath: string): CompiledContract {
  const solc = require('solc');
  const source = fs.readFileSync(contractPath, 'utf8');
  const contractName = path.basename(contractPath, '.sol');

  const input = {
    language: 'Solidity',
    sources: {
      [contractName + '.sol']: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object'] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter((e: any) => e.severity === 'error');
    if (errors.length > 0) {
      throw new Error(`Compilation errors:\n${errors.map((e: any) => e.formattedMessage).join('\n')}`);
    }
  }

  const compiled = output.contracts[contractName + '.sol'][contractName];
  if (!compiled) {
    throw new Error(`Contract ${contractName} not found in compilation output`);
  }

  return {
    abi: compiled.abi,
    bytecode: '0x' + compiled.evm.bytecode.object,
    contractName,
  };
}

export async function deployContract(
  compiled: CompiledContract,
  constructorArgs: any[],
): Promise<{ address: string; txHash: string; explorerUrl: string }> {
  const walletClient = getWalletClient();

  const txHash = await walletClient.deployContract({
    abi: compiled.abi,
    bytecode: compiled.bytecode as `0x${string}`,
    args: constructorArgs,
  });

  console.log(`[deployer] Deploying ${compiled.contractName}... tx: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  if (receipt.status !== 'success') {
    throw new Error(`Deployment failed for ${compiled.contractName}: tx ${txHash}`);
  }

  const address = receipt.contractAddress;
  if (!address) {
    throw new Error(`No contract address in receipt for ${compiled.contractName}`);
  }

  const explorerUrl = `https://celoscan.io/address/${address}`;
  console.log(`[deployer] ${compiled.contractName} deployed at ${address}`);
  console.log(`[deployer] Explorer: ${explorerUrl}`);

  return { address, txHash, explorerUrl };
}

export interface Deployments {
  chainId: number;
  deployedAt: string;
  contracts: Record<string, {
    address: string;
    txHash: string;
    explorerUrl: string;
    abi: any[];
  }>;
}

export function loadDeployments(): Deployments | null {
  try {
    if (!fs.existsSync(DEPLOYMENTS_PATH)) return null;
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveDeployments(deployments: Deployments): void {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
}

export function getDeployedAddress(contractName: string): string | null {
  const deployments = loadDeployments();
  if (!deployments) return null;
  return deployments.contracts[contractName]?.address || null;
}

export function getDeployedAbi(contractName: string): any[] | null {
  const deployments = loadDeployments();
  if (!deployments) return null;
  return deployments.contracts[contractName]?.abi || null;
}

export { publicClient };
