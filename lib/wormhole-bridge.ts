import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, encodeFunctionData, pad, toHex, hexToBytes } from 'viem';
import { base, celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const SELFCLAW_TOKEN_BASE = '0x9ae5f51d81ff510bf961218f833f79d57bfbab07' as `0x${string}`;

const TOKEN_BRIDGE_BASE = '0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627' as `0x${string}`;
const TOKEN_BRIDGE_CELO = '0x796Dff6D74F3E27060B71255Fe517BFb23C93eed' as `0x${string}`;

const WORMHOLE_CHAIN_ID_BASE = 30;
const WORMHOLE_CHAIN_ID_CELO = 14;

const BASE_RPC = 'https://mainnet.base.org';
const CELO_RPC = 'https://forno.celo.org';

const rawPrivateKey = process.env.CELO_PRIVATE_KEY;
const PRIVATE_KEY = rawPrivateKey && !rawPrivateKey.startsWith('0x') ? `0x${rawPrivateKey}` : rawPrivateKey;

const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC),
});

const celoClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC),
});

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const TOKEN_BRIDGE_ABI = [
  {
    name: 'attestToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'nonce', type: 'uint32' },
    ],
    outputs: [{ name: 'sequence', type: 'uint64' }],
  },
  {
    name: 'createWrapped',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'encodedVm', type: 'bytes' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'transferTokens',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'recipientChain', type: 'uint16' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'arbiterFee', type: 'uint256' },
      { name: 'nonce', type: 'uint32' },
    ],
    outputs: [{ name: 'sequence', type: 'uint64' }],
  },
  {
    name: 'completeTransfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'encodedVm', type: 'bytes' }],
    outputs: [],
  },
  {
    name: 'wrappedAsset',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenChainId', type: 'uint16' },
      { name: 'tokenAddress', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'isWrappedAsset',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface BridgeResult {
  success: boolean;
  txHash?: string;
  sourceTxHash?: string;
  destTxHash?: string;
  wrappedAddress?: string;
  sequence?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface BridgeStatus {
  selfclawAttested: boolean;
  selfclawWrappedAddress: string | null;
  sponsorWalletAddress: string | null;
  configured: boolean;
  error?: string;
}

export interface WalletBalances {
  sponsorAddress: string;
  base: {
    native: string;
    selfclaw: string;
  };
  celo: {
    native: string;
    wrappedSelfclaw: string | null;
  };
  error?: string;
}

function getAccount() {
  if (!PRIVATE_KEY) {
    throw new Error('CELO_PRIVATE_KEY environment variable is not set');
  }
  return privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
}

function getBaseWalletClient() {
  const account = getAccount();
  return createWalletClient({
    account,
    chain: base,
    transport: http(BASE_RPC),
  });
}

function getCeloWalletClient() {
  const account = getAccount();
  return createWalletClient({
    account,
    chain: celo,
    transport: http(CELO_RPC),
  });
}

function addressToBytes32(address: string): `0x${string}` {
  return pad(address as `0x${string}`, { size: 32 });
}

function generateNonce(): number {
  return Math.floor(Math.random() * 2147483647);
}

export async function fetchVaaForTx(txHash: string): Promise<{ vaaBytes: string | null; status?: string; error?: string }> {
  try {
    const operationsUrl = `https://api.wormholescan.io/api/v1/operations?txHash=${encodeURIComponent(txHash)}`;
    const opsResponse = await fetch(operationsUrl);
    if (!opsResponse.ok) {
      if (opsResponse.status === 404) {
        return { vaaBytes: null, status: 'not_found' };
      }
      if (opsResponse.status === 429) {
        return { vaaBytes: null, status: 'rate_limited', error: 'Rate limited by Wormholescan, will retry' };
      }
      return { vaaBytes: null, status: 'api_error', error: `Wormholescan returned ${opsResponse.status}` };
    }
    const opsData = await opsResponse.json() as any;

    const operations = opsData.operations || opsData;
    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      return { vaaBytes: null, status: 'pending' };
    }

    const op = operations[0];

    function decodeVaaRaw(raw: string): string {
      if (raw.startsWith('0x')) return raw;
      return '0x' + Buffer.from(raw, 'base64').toString('hex');
    }

    if (op.vaa?.raw) {
      return { vaaBytes: decodeVaaRaw(op.vaa.raw), status: 'complete' };
    }

    const emitterChain = op.emitterChain
      || op.sourceChain?.chainId
      || op.content?.standarizedProperties?.fromChain
      || op.content?.standardizedProperties?.fromChain;
    const emitterAddress = op.emitterAddress
      || op.content?.standarizedProperties?.emitterAddress
      || op.content?.standardizedProperties?.emitterAddress;
    const sequence = op.sequence
      || (op.id ? op.id.split('/')[2] : null);

    if (!emitterChain || !emitterAddress || !sequence) {
      return { vaaBytes: null, status: 'pending' };
    }

    const vaaUrl = `https://api.wormholescan.io/api/v1/vaas/${emitterChain}/${emitterAddress}/${sequence}`;
    const vaaResponse = await fetch(vaaUrl);
    if (!vaaResponse.ok) {
      return { vaaBytes: null, status: 'pending' };
    }
    const vaaData = await vaaResponse.json() as any;

    const vaaRaw = vaaData.data?.vaa || vaaData.vaa;
    if (!vaaRaw) {
      return { vaaBytes: null, status: 'pending' };
    }

    return { vaaBytes: decodeVaaRaw(vaaRaw), status: 'complete' };
  } catch (error: any) {
    console.error('[wormhole-bridge] fetchVaaForTx error:', error);
    return { vaaBytes: null, status: 'error', error: error.message };
  }
}

export async function attestToken(tokenAddress: string): Promise<BridgeResult> {
  try {
    if (!PRIVATE_KEY) {
      return { success: false, error: 'CELO_PRIVATE_KEY not configured' };
    }

    const walletClient = getBaseWalletClient();
    const account = getAccount();
    const nonce = generateNonce();

    console.log(`[wormhole-bridge] Attesting token ${tokenAddress} on Base TokenBridge...`);

    const txHash = await walletClient.writeContract({
      address: TOKEN_BRIDGE_BASE,
      abi: TOKEN_BRIDGE_ABI,
      functionName: 'attestToken',
      args: [tokenAddress as `0x${string}`, nonce],
      account,
    });

    console.log(`[wormhole-bridge] Attestation tx submitted: ${txHash}`);

    const receipt = await baseClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'Attestation transaction reverted', txHash };
    }

    console.log(`[wormhole-bridge] Attestation confirmed in block ${receipt.blockNumber}`);

    return {
      success: true,
      txHash,
      data: {
        blockNumber: receipt.blockNumber.toString(),
        nonce,
        note: 'Attestation submitted. Wait ~15 minutes for Wormhole guardians to sign the VAA, then call completeAttestation() on Celo side.',
      },
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] attestToken error:', error);
    return {
      success: false,
      error: error.message || 'Failed to attest token',
    };
  }
}

export async function completeAttestation(vaaBytes: string): Promise<BridgeResult> {
  try {
    if (!PRIVATE_KEY) {
      return { success: false, error: 'CELO_PRIVATE_KEY not configured' };
    }

    const walletClient = getCeloWalletClient();
    const account = getAccount();

    console.log(`[wormhole-bridge] Completing attestation on Celo TokenBridge...`);

    const txHash = await walletClient.writeContract({
      address: TOKEN_BRIDGE_CELO,
      abi: TOKEN_BRIDGE_ABI,
      functionName: 'createWrapped',
      args: [vaaBytes as `0x${string}`],
      account,
    });

    console.log(`[wormhole-bridge] createWrapped tx submitted: ${txHash}`);

    const receipt = await celoClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'createWrapped transaction reverted', txHash };
    }

    const wrappedAddress = await getWrappedTokenAddress(SELFCLAW_TOKEN_BASE);

    console.log(`[wormhole-bridge] Attestation complete. Wrapped address: ${wrappedAddress.wrappedAddress}`);

    return {
      success: true,
      txHash,
      wrappedAddress: wrappedAddress.wrappedAddress || undefined,
      data: {
        blockNumber: receipt.blockNumber.toString(),
      },
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] completeAttestation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to complete attestation',
    };
  }
}

export async function bridgeTokens(tokenAddress: string, amount: string): Promise<BridgeResult> {
  try {
    if (!PRIVATE_KEY) {
      return { success: false, error: 'CELO_PRIVATE_KEY not configured' };
    }

    const account = getAccount();
    const walletClient = getBaseWalletClient();

    let decimals: number;
    try {
      decimals = await baseClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      });
    } catch {
      decimals = 18;
    }

    const parsedAmount = parseUnits(amount, decimals);
    const recipientBytes32 = addressToBytes32(account.address);
    const nonce = generateNonce();

    console.log(`[wormhole-bridge] Bridging ${amount} tokens (${tokenAddress}) from Base to Celo...`);

    const currentAllowance = await baseClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, TOKEN_BRIDGE_BASE],
    });

    if (currentAllowance < parsedAmount) {
      console.log(`[wormhole-bridge] Approving TokenBridge to spend tokens...`);
      const approveTx = await walletClient.writeContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TOKEN_BRIDGE_BASE, parsedAmount],
        account,
      });
      await baseClient.waitForTransactionReceipt({ hash: approveTx });
      console.log(`[wormhole-bridge] Approval confirmed: ${approveTx}`);
    }

    const txHash = await walletClient.writeContract({
      address: TOKEN_BRIDGE_BASE,
      abi: TOKEN_BRIDGE_ABI,
      functionName: 'transferTokens',
      args: [
        tokenAddress as `0x${string}`,
        parsedAmount,
        WORMHOLE_CHAIN_ID_CELO,
        recipientBytes32,
        BigInt(0),
        nonce,
      ],
      account,
    });

    console.log(`[wormhole-bridge] Transfer tx submitted: ${txHash}`);

    const receipt = await baseClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'Transfer transaction reverted', sourceTxHash: txHash };
    }

    console.log(`[wormhole-bridge] Transfer confirmed in block ${receipt.blockNumber}`);

    return {
      success: true,
      sourceTxHash: txHash,
      data: {
        amount,
        tokenAddress,
        decimals,
        nonce,
        recipientChain: WORMHOLE_CHAIN_ID_CELO,
        recipient: account.address,
        blockNumber: receipt.blockNumber.toString(),
        note: 'Transfer submitted on Base. Wait ~15 minutes for Wormhole guardians to produce a VAA. Then use the VAA to call completeTransfer on Celo to mint wrapped tokens.',
      },
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] bridgeTokens error:', error);
    return {
      success: false,
      error: error.message || 'Failed to bridge tokens',
    };
  }
}

export async function completeTransfer(vaaBytes: string): Promise<BridgeResult> {
  try {
    if (!PRIVATE_KEY) {
      return { success: false, error: 'CELO_PRIVATE_KEY not configured' };
    }

    const walletClient = getCeloWalletClient();
    const account = getAccount();

    console.log(`[wormhole-bridge] Completing transfer on Celo TokenBridge...`);

    const txHash = await walletClient.writeContract({
      address: TOKEN_BRIDGE_CELO,
      abi: TOKEN_BRIDGE_ABI,
      functionName: 'completeTransfer',
      args: [vaaBytes as `0x${string}`],
      account,
    });

    console.log(`[wormhole-bridge] completeTransfer tx submitted: ${txHash}`);

    const receipt = await celoClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'completeTransfer transaction reverted', txHash };
    }

    console.log(`[wormhole-bridge] Transfer completed on Celo in block ${receipt.blockNumber}`);

    return {
      success: true,
      destTxHash: txHash,
      data: {
        blockNumber: receipt.blockNumber.toString(),
      },
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] completeTransfer error:', error);
    return {
      success: false,
      error: error.message || 'Failed to complete transfer on Celo',
    };
  }
}

export async function getWrappedTokenAddress(tokenAddress: string): Promise<BridgeResult> {
  try {
    const tokenBytes32 = addressToBytes32(tokenAddress);

    const wrappedAddress = await celoClient.readContract({
      address: TOKEN_BRIDGE_CELO,
      abi: TOKEN_BRIDGE_ABI,
      functionName: 'wrappedAsset',
      args: [WORMHOLE_CHAIN_ID_BASE, tokenBytes32],
    });

    const isAttested = wrappedAddress !== '0x0000000000000000000000000000000000000000';

    return {
      success: true,
      wrappedAddress: isAttested ? wrappedAddress : undefined,
      data: {
        isAttested,
        sourceChain: 'Base',
        sourceChainId: WORMHOLE_CHAIN_ID_BASE,
        tokenAddress,
      },
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] getWrappedTokenAddress error:', error);
    return {
      success: false,
      error: error.message || 'Failed to get wrapped token address',
    };
  }
}

export async function getBridgeStatus(): Promise<BridgeStatus> {
  try {
    const configured = !!PRIVATE_KEY;
    let sponsorWalletAddress: string | null = null;

    if (configured) {
      try {
        const account = getAccount();
        sponsorWalletAddress = account.address;
      } catch {
        sponsorWalletAddress = null;
      }
    }

    const selfclawResult = await getWrappedTokenAddress(SELFCLAW_TOKEN_BASE);

    return {
      selfclawAttested: !!selfclawResult.data?.isAttested,
      selfclawWrappedAddress: selfclawResult.wrappedAddress || null,
      sponsorWalletAddress,
      configured,
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] getBridgeStatus error:', error);
    return {
      selfclawAttested: false,
      selfclawWrappedAddress: null,
      sponsorWalletAddress: null,
      configured: !!PRIVATE_KEY,
      error: error.message || 'Failed to get bridge status',
    };
  }
}

export async function getWalletBalances(): Promise<WalletBalances> {
  const defaultBalances: WalletBalances = {
    sponsorAddress: '',
    base: { native: '0', selfclaw: '0' },
    celo: { native: '0', wrappedSelfclaw: null },
  };

  try {
    if (!PRIVATE_KEY) {
      return { ...defaultBalances, error: 'CELO_PRIVATE_KEY not configured' };
    }

    const account = getAccount();
    const address = account.address;

    const [baseNative, celoNative, selfclawBalance] = await Promise.all([
      baseClient.getBalance({ address }).catch((e: any) => {
        console.error('[wormhole-bridge] Base native balance error:', e.message);
        return BigInt(0);
      }),
      celoClient.getBalance({ address }).catch((e: any) => {
        console.error('[wormhole-bridge] Celo native balance error:', e.message);
        return BigInt(0);
      }),
      baseClient.readContract({
        address: SELFCLAW_TOKEN_BASE,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      }).catch((e: any) => {
        console.error('[wormhole-bridge] SELFCLAW balance error:', e.message);
        return BigInt(0);
      }),
    ]);

    const status = await getBridgeStatus();

    let wrappedSelfclawBalance: string | null = null;

    if (status.selfclawWrappedAddress) {
      try {
        const bal = await celoClient.readContract({
          address: status.selfclawWrappedAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        });
        wrappedSelfclawBalance = formatUnits(bal, 18);
      } catch {
        wrappedSelfclawBalance = '0';
      }
    }

    return {
      sponsorAddress: address,
      base: {
        native: formatUnits(baseNative, 18),
        selfclaw: formatUnits(selfclawBalance, 18),
      },
      celo: {
        native: formatUnits(celoNative, 18),
        wrappedSelfclaw: wrappedSelfclawBalance,
      },
    };
  } catch (error: any) {
    console.error('[wormhole-bridge] getWalletBalances error:', error);
    return { ...defaultBalances, error: error.message || 'Failed to get wallet balances' };
  }
}
