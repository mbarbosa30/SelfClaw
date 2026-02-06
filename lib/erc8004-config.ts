// ERC-8004 Configuration for Celo
// Official mainnet contracts: https://docs.celo.org/build-on-celo/build-with-ai/8004#celo-mainnet
// Spec: https://eips.ethereum.org/EIPS/eip-8004

export const ERC8004_CONFIG = {
  mainnet: {
    chainId: 42220,
    rpcUrl: "https://forno.celo.org",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    resolver: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    explorer: "https://celoscan.io",
  },
  
  testnet: {
    chainId: 44787,
    rpcUrl: "https://alfajores-forno.celo-testnet.org",
    identityRegistry: "0x0000000000000000000000000000000000000000",
    resolver: "0x0000000000000000000000000000000000000000",
    explorer: "https://alfajores.celoscan.io",
  },
  
  get active() {
    const network = process.env.ERC8004_NETWORK || "mainnet";
    return network === "testnet" ? this.testnet : this.mainnet;
  },
  
  get isDeployed() {
    const active = this.active;
    return active.identityRegistry !== "0x0000000000000000000000000000000000000000";
  }
};

export interface ERC8004Service {
  name: string;
  endpoint: string;
  version?: string;
  capabilities?: Record<string, any>;
}

export interface ERC8004Registration {
  agentRegistry: string;
  agentId: string;
  supportedTrust?: string[];
}

export interface ERC8004RegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: ERC8004Service[];
  registrations: ERC8004Registration[];
  supportedTrust: string[];
  agentWallet?: string;
}

export function generateRegistrationFile(
  name: string,
  description: string,
  walletAddress?: string,
  a2aEndpoint?: string,
  webEndpoint?: string,
  imageUrl?: string,
  isVerified: boolean = false,
  agentId?: string,
): ERC8004RegistrationFile {
  const services: ERC8004Service[] = [];
  
  if (walletAddress) {
    services.push({
      name: "evm-wallet",
      endpoint: `eip155:${ERC8004_CONFIG.active.chainId}:${walletAddress}`,
      version: "v1",
    });
  }
  
  if (a2aEndpoint) {
    services.push({
      name: "A2A",
      endpoint: a2aEndpoint,
    });
  }

  if (webEndpoint) {
    services.push({
      name: "web",
      endpoint: webEndpoint,
    });
  }
  
  const supportedTrust = ["reputation"];
  if (isVerified) {
    supportedTrust.push("validation");
  }

  const registrations: ERC8004Registration[] = [];
  if (agentId) {
    registrations.push({
      agentRegistry: `eip155:${ERC8004_CONFIG.active.chainId}:${ERC8004_CONFIG.active.identityRegistry}`,
      agentId,
      supportedTrust,
    });
  }
  
  const reg: ERC8004RegistrationFile = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description: description || `AI Agent: ${name}`,
    services,
    registrations,
    supportedTrust,
  };

  if (imageUrl) {
    reg.image = imageUrl;
  }

  if (walletAddress) {
    reg.agentWallet = walletAddress;
  }
  
  return reg;
}
