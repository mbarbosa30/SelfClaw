export type SupportedChain = 'celo' | 'base';

export interface ChainContracts {
  staking: `0x${string}` | null;
  escrow: `0x${string}` | null;
  rewards: `0x${string}` | null;
  governance: `0x${string}` | null;
}

export interface UniswapV4Config {
  poolManager: `0x${string}`;
  positionManager: `0x${string}`;
  universalRouter: `0x${string}`;
  stateView: `0x${string}`;
  permit2: `0x${string}`;
  wrappedNative: `0x${string}`;
}

export interface ChainConfig {
  key: SupportedChain;
  name: string;
  chainId: number;
  viemChain: any;
  rpcPrimary: string;
  rpcFallback: string;
  explorerUrl: string;
  explorerName: string;
  nativeCurrency: string;
  selfclawToken: `0x${string}`;
  contracts: ChainContracts;
  uniswapV4: UniswapV4Config | null;
}

export const CHAIN_CONFIGS: Record<SupportedChain, ChainConfig> = {
  celo: {
    key: 'celo',
    name: 'Celo Mainnet',
    chainId: 42220,
    viemChain: null as any,
    rpcPrimary: 'https://forno.celo.org',
    rpcFallback: 'https://rpc.ankr.com/celo',
    explorerUrl: 'https://celoscan.io',
    explorerName: 'Celoscan',
    nativeCurrency: 'CELO',
    selfclawToken: '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb',
    contracts: {
      staking: null,
      escrow: null,
      rewards: null,
      governance: null,
    },
    uniswapV4: {
      poolManager: '0x288dc841A52FCA2707c6947B3A777c5E56cd87BC',
      positionManager: '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9',
      universalRouter: '0xcb695bc5d3aa22cad1e6df07801b061a05a0233a',
      stateView: '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      wrappedNative: '0x471EcE3750Da237f93B8E339c536989b8978a438',
    },
  },
  base: {
    key: 'base',
    name: 'Base Mainnet',
    chainId: 8453,
    viemChain: null as any,
    rpcPrimary: 'https://mainnet.base.org',
    rpcFallback: 'https://base.meowrpc.com',
    explorerUrl: 'https://basescan.org',
    explorerName: 'Basescan',
    nativeCurrency: 'ETH',
    selfclawToken: '0x9ae5f51d81ff510bf961218f833f79d57bfbab07',
    contracts: {
      staking: null,
      escrow: null,
      rewards: null,
      governance: null,
    },
    uniswapV4: {
      poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
      positionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
      universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
      stateView: '0xA3c0c9b65baD0b08107B3fB283b6bBaefaB15889',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      wrappedNative: '0x4200000000000000000000000000000000000006',
    },
  },
};

let _viem: any = null;
let _viemAccounts: any = null;

const _viemReady: Promise<void> = (async () => {
  try {
    const [viemMod, chainsMod, accountsMod] = await Promise.all([
      import('viem'),
      import('viem/chains'),
      import('viem/accounts'),
    ]);
    _viem = viemMod;
    _viemAccounts = accountsMod;
    CHAIN_CONFIGS.celo.viemChain = chainsMod.celo;
    CHAIN_CONFIGS.base.viemChain = chainsMod.base;
  } catch (e) {
    console.error('[chains] Failed to load viem:', e);
  }

  try {
    const { getDeployedAddress } = await import('./contract-deployer.js');
    const stakingAddr = getDeployedAddress('SelfClawStaking');
    if (stakingAddr) CHAIN_CONFIGS.celo.contracts.staking = stakingAddr as `0x${string}`;
    const escrowAddr = getDeployedAddress('SelfClawEscrow');
    if (escrowAddr) CHAIN_CONFIGS.celo.contracts.escrow = escrowAddr as `0x${string}`;
    const rewardsAddr = getDeployedAddress('SelfClawRewards');
    if (rewardsAddr) CHAIN_CONFIGS.celo.contracts.rewards = rewardsAddr as `0x${string}`;
    const govAddr = getDeployedAddress('SelfClawGovernance');
    if (govAddr) CHAIN_CONFIGS.base.contracts.governance = govAddr as `0x${string}`;
  } catch {}
})();

export async function ensureViem(): Promise<void> {
  await _viemReady;
}

const clientCache: Record<string, any> = {};

export function getChainConfig(chain: SupportedChain = 'celo'): ChainConfig {
  const config = CHAIN_CONFIGS[chain];
  if (!config) throw new Error(`Unsupported chain: ${chain}. Supported: ${getSupportedChains().join(', ')}`);
  return config;
}

export function getPublicClient(chain: SupportedChain = 'celo'): any {
  if (clientCache[chain]) return clientCache[chain];
  if (!_viem) throw new Error('viem not loaded yet — call ensureViem() first');
  const config = getChainConfig(chain);
  const client = _viem.createPublicClient({
    chain: config.viemChain,
    transport: _viem.fallback([
      _viem.http(config.rpcPrimary, { timeout: 15_000, retryCount: 1 }),
      _viem.http(config.rpcFallback, { timeout: 15_000, retryCount: 1 }),
    ]),
  });
  clientCache[chain] = client;
  return client;
}

export function getWalletClient(chain: SupportedChain = 'celo'): any {
  if (!_viem || !_viemAccounts) throw new Error('viem not loaded yet — call ensureViem() first');
  const rawKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
  if (!rawKey) throw new Error('CELO_PRIVATE_KEY not set');
  const pk = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  const account = _viemAccounts.privateKeyToAccount(pk as `0x${string}`);
  const config = getChainConfig(chain);
  return _viem.createWalletClient({
    account,
    chain: config.viemChain,
    transport: _viem.fallback([
      _viem.http(config.rpcPrimary, { timeout: 30_000, retryCount: 2 }),
      _viem.http(config.rpcFallback, { timeout: 30_000, retryCount: 2 }),
    ]),
  });
}

export function getPlatformAddress(): string {
  if (!_viemAccounts) throw new Error('viem not loaded yet — call ensureViem() first');
  const rawKey = process.env.SELFCLAW_SPONSOR_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY;
  if (!rawKey) throw new Error('CELO_PRIVATE_KEY not set');
  const pk = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  return _viemAccounts.privateKeyToAccount(pk as `0x${string}`).address;
}

export function getExplorerUrl(chain: SupportedChain, type: 'tx' | 'address' | 'token', hash: string): string {
  const config = getChainConfig(chain);
  return `${config.explorerUrl}/${type}/${hash}`;
}

export function getSupportedChains(): SupportedChain[] {
  return Object.keys(CHAIN_CONFIGS) as SupportedChain[];
}

export function isValidChain(chain: string): chain is SupportedChain {
  return chain in CHAIN_CONFIGS;
}
