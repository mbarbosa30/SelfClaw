// ERC-8004 Configuration for Celo
// Official mainnet contracts: https://docs.celo.org/build-on-celo/build-with-ai/8004#celo-mainnet

export const ERC8004_CONFIG = {
  // Celo Mainnet - LIVE
  mainnet: {
    chainId: 42220,
    rpcUrl: "https://forno.celo.org",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    resolver: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    explorer: "https://celoscan.io",
  },
  
  // Celo Alfajores Testnet
  testnet: {
    chainId: 44787,
    rpcUrl: "https://alfajores-forno.celo-testnet.org",
    identityRegistry: "0x0000000000000000000000000000000000000000", // Not deployed yet
    resolver: "0x0000000000000000000000000000000000000000", // Not deployed yet
    explorer: "https://alfajores.celoscan.io",
  },
  
  // Use mainnet by default, can be overridden via env
  get active() {
    const network = process.env.ERC8004_NETWORK || "mainnet";
    return network === "testnet" ? this.testnet : this.mainnet;
  },
  
  // Check if contracts are deployed
  get isDeployed() {
    const active = this.active;
    return active.identityRegistry !== "0x0000000000000000000000000000000000000000";
  }
};

// ERC-8004 Agent Registration File structure
export interface ERC8004Endpoint {
  type: "a2a" | "mcp" | "wallet" | "ens" | "did";
  url?: string;
  address?: string;
  chainId?: number;
}

export interface ERC8004RegistrationFile {
  type: "Agent";
  name: string;
  description: string;
  image?: string;
  endpoints: ERC8004Endpoint[];
  supportedTrust: string[];
}

// Generate a registration file for an agent
export function generateRegistrationFile(
  name: string,
  description: string,
  walletAddress?: string,
  a2aEndpoint?: string,
  imageUrl?: string,
  isVerified: boolean = false
): ERC8004RegistrationFile {
  const endpoints: ERC8004Endpoint[] = [];
  
  // Add wallet endpoint if provided
  if (walletAddress) {
    endpoints.push({
      type: "wallet",
      address: walletAddress,
      chainId: ERC8004_CONFIG.active.chainId,
    });
  }
  
  // Add A2A endpoint if provided
  if (a2aEndpoint) {
    endpoints.push({
      type: "a2a",
      url: a2aEndpoint,
    });
  }
  
  // Build supportedTrust array
  const supportedTrust = ["reputation"];
  if (isVerified) {
    supportedTrust.push("selfclaw-verified");
  }
  
  return {
    type: "Agent",
    name,
    description: description || `AI Agent: ${name}`,
    image: imageUrl,
    endpoints,
    supportedTrust,
  };
}
