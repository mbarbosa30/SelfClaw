// ERC-8004 Configuration for Celo
// Official mainnet contracts: https://docs.celo.org/build-on-celo/build-with-ai/8004#celo-mainnet
// Spec: https://eips.ethereum.org/EIPS/eip-8004
// Metadata format aligned with: https://github.com/celo-org/agent-skills/tree/main/skills/8004

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

export interface ERC8004Endpoint {
  type: "a2a" | "mcp" | "wallet" | "web";
  url?: string;
  address?: string;
  chainId?: number;
}

export interface ERC8004RegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  endpoints: ERC8004Endpoint[];
  supportedTrust: string[];
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
  const endpoints: ERC8004Endpoint[] = [];
  
  if (walletAddress) {
    endpoints.push({
      type: "wallet",
      address: walletAddress,
      chainId: ERC8004_CONFIG.active.chainId,
    });
  }
  
  if (a2aEndpoint) {
    endpoints.push({
      type: "a2a",
      url: a2aEndpoint,
    });
  }

  if (webEndpoint) {
    endpoints.push({
      type: "web",
      url: webEndpoint,
    });
  }
  
  const supportedTrust = ["reputation"];
  if (isVerified) {
    supportedTrust.push("validation");
  }
  
  const reg: ERC8004RegistrationFile = {
    type: "Agent",
    name,
    description: description || `AI Agent: ${name}`,
    endpoints,
    supportedTrust,
  };

  if (imageUrl) {
    reg.image = imageUrl;
  }
  
  return reg;
}
