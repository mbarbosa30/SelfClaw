// ERC-8004 Service Layer
// Handles agent identity registration, reputation, and attestations

import { ethers } from "ethers";
import { ERC8004_CONFIG, generateRegistrationFile, type ERC8004RegistrationFile, type ERC8004Endpoint } from "./erc8004-config.js";

// Simplified ABI for ERC-8004 Identity Registry
const IDENTITY_REGISTRY_ABI = [
  "function register(string agentURI) external returns (uint256)",
  "function setAgentURI(uint256 agentId, string agentURI) external",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature) external",
  "function getAgentWallet(uint256 agentId) external view returns (address)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function totalSupply() external view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];

// Simplified ABI for ERC-8004 Reputation Registry
const REPUTATION_REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, uint256 score, uint8 decimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external",
  "function readAllFeedback(uint256 agentId) external view returns (tuple(address rater, uint256 score, uint8 decimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash, uint256 timestamp)[])",
  "function getSummary(uint256 agentId) external view returns (tuple(uint256 totalFeedback, uint256 averageScore, uint256 lastUpdated))"
];

export class ERC8004Service {
  private provider: ethers.JsonRpcProvider;
  private wallet?: ethers.Wallet;
  
  constructor() {
    const config = ERC8004_CONFIG.active;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    
    // Use platform wallet for transactions if available
    if (process.env.CELO_PRIVATE_KEY) {
      this.wallet = new ethers.Wallet(process.env.CELO_PRIVATE_KEY, this.provider);
    }
  }
  
  // Check if ERC-8004 contracts are deployed and ready
  isReady(): boolean {
    return ERC8004_CONFIG.isDeployed;
  }
  
  // Get the config for frontend display
  getConfig() {
    return {
      ...ERC8004_CONFIG.active,
      isDeployed: ERC8004_CONFIG.isDeployed,
    };
  }
  
  generateRegistration(
    name: string,
    description: string,
    walletAddress?: string,
    a2aEndpoint?: string,
    webEndpoint?: string,
    imageUrl?: string,
    isVerified: boolean = false,
    agentId?: string,
  ): ERC8004RegistrationFile {
    return generateRegistrationFile(name, description, walletAddress, a2aEndpoint, webEndpoint, imageUrl, isVerified, agentId);
  }
  
  // Register an agent onchain (mint NFT)
  async registerAgent(agentURI: string, signerPrivateKey?: string): Promise<{ tokenId: string; txHash: string } | null> {
    if (!this.isReady()) {
      console.log("[erc8004] Contracts not deployed yet");
      return null;
    }
    
    const config = ERC8004_CONFIG.active;
    const signer = signerPrivateKey 
      ? new ethers.Wallet(signerPrivateKey, this.provider)
      : this.wallet;
    
    if (!signer) {
      throw new Error("No signer available for registration");
    }
    
    const registry = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, signer);
    
    try {
      const tx = await registry.register(agentURI);
      const receipt = await tx.wait();
      
      // Extract tokenId from Transfer event
      const transferEvent = receipt.logs.find((log: any) => {
        try {
          const parsed = registry.interface.parseLog(log);
          return parsed?.name === "Transfer";
        } catch {
          return false;
        }
      });
      
      let tokenId = "0";
      if (transferEvent) {
        const parsed = registry.interface.parseLog(transferEvent);
        tokenId = parsed?.args?.tokenId?.toString() || "0";
      }
      
      return {
        tokenId,
        txHash: receipt.hash,
      };
    } catch (error: any) {
      console.error("[erc8004] Registration failed:", error.message);
      throw error;
    }
  }
  
  async setAgentURI(agentId: string, newURI: string, signerPrivateKey?: string): Promise<{ txHash: string } | null> {
    if (!this.isReady()) {
      console.log("[erc8004] Contracts not deployed yet");
      return null;
    }
    
    const config = ERC8004_CONFIG.active;
    const signer = signerPrivateKey 
      ? new ethers.Wallet(signerPrivateKey, this.provider)
      : this.wallet;
    
    if (!signer) {
      throw new Error("No signer available for URI update");
    }
    
    const registry = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, signer);
    
    try {
      const tx = await registry.setAgentURI(agentId, newURI);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    } catch (error: any) {
      console.error("[erc8004] setAgentURI failed:", error.message);
      throw error;
    }
  }
  
  async setAgentWallet(
    agentId: string,
    walletAddress: string,
    walletPrivateKey: string,
    signerPrivateKey?: string,
  ): Promise<{ txHash: string } | null> {
    if (!this.isReady()) {
      console.log("[erc8004] Contracts not deployed yet");
      return null;
    }

    const config = ERC8004_CONFIG.active;
    const signer = signerPrivateKey
      ? new ethers.Wallet(signerPrivateKey, this.provider)
      : this.wallet;

    if (!signer) {
      throw new Error("No signer available for setAgentWallet");
    }

    const registry = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, signer);

    try {
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const walletSigner = new ethers.Wallet(walletPrivateKey);
      const domain = {
        name: "ERC8004IdentityRegistry",
        version: "1",
        chainId: config.chainId,
        verifyingContract: config.identityRegistry,
      };
      const types = {
        SetAgentWallet: [
          { name: "agentId", type: "uint256" },
          { name: "newWallet", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = {
        agentId: BigInt(agentId),
        newWallet: walletAddress,
        deadline: BigInt(deadline),
      };

      const signature = await walletSigner.signTypedData(domain, types, value);

      console.log(`[erc8004] Setting agent wallet: agentId=${agentId}, wallet=${walletAddress}`);
      const tx = await registry.setAgentWallet(agentId, walletAddress, deadline, signature);
      const receipt = await tx.wait();
      console.log(`[erc8004] setAgentWallet tx: ${receipt.hash}`);
      return { txHash: receipt.hash };
    } catch (error: any) {
      console.error("[erc8004] setAgentWallet failed:", error.message);
      throw error;
    }
  }

  async getAgentWallet(agentId: string): Promise<string | null> {
    if (!this.isReady()) {
      return null;
    }

    const config = ERC8004_CONFIG.active;
    const registry = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, this.provider);

    try {
      const wallet = await registry.getAgentWallet(agentId);
      return wallet === ethers.ZeroAddress ? null : wallet;
    } catch (error: any) {
      console.error("[erc8004] getAgentWallet failed:", error.message);
      return null;
    }
  }

  // Get agent identity by token ID
  async getAgentIdentity(tokenId: string): Promise<{ owner: string; uri: string } | null> {
    if (!this.isReady()) {
      return null;
    }
    
    const config = ERC8004_CONFIG.active;
    const registry = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, this.provider);
    
    try {
      const [owner, uri] = await Promise.all([
        registry.ownerOf(tokenId),
        registry.tokenURI(tokenId),
      ]);
      
      return { owner, uri };
    } catch (error: any) {
      console.error("[erc8004] Failed to get agent identity:", error.message);
      return null;
    }
  }
  
  // Submit SelfClaw verification attestation to reputation registry
  async submitVerificationAttestation(
    agentTokenId: string,
    signerPrivateKey?: string
  ): Promise<{ txHash: string } | null> {
    if (!this.isReady()) {
      console.log("[erc8004] Contracts not deployed yet");
      return null;
    }
    
    const config = ERC8004_CONFIG.active;
    const signer = signerPrivateKey
      ? new ethers.Wallet(signerPrivateKey, this.provider)
      : this.wallet;
    
    if (!signer) {
      throw new Error("No signer available for attestation");
    }
    
    const reputation = new ethers.Contract(config.resolver, REPUTATION_REGISTRY_ABI, signer);
    
    try {
      // Submit feedback with selfclaw-verified tag and perfect score
      const feedbackData = JSON.stringify({
        type: "selfclaw-verified",
        verifiedAt: new Date().toISOString(),
        method: "passport-zk-proof",
      });
      const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(feedbackData));
      
      const tx = await reputation.giveFeedback(
        agentTokenId,
        100,                      // score: 100 (verified)
        0,                        // decimals
        "selfclaw-verified",      // tag1: verification type
        "passport",               // tag2: verification method
        "https://selfclaw.ai",   // endpoint
        "",                       // feedbackURI (could be IPFS)
        feedbackHash              // hash of feedback data
      );
      
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    } catch (error: any) {
      console.error("[erc8004] Attestation failed:", error.message);
      throw error;
    }
  }
  
  async getReputationSummary(agentTokenId: string): Promise<{ totalFeedback: number; averageScore: number; lastUpdated: number } | null> {
    if (!this.isReady()) {
      return null;
    }
    
    const config = ERC8004_CONFIG.active;
    const reputation = new ethers.Contract(config.resolver, REPUTATION_REGISTRY_ABI, this.provider);
    
    try {
      const summary = await reputation.getSummary(agentTokenId);
      return {
        totalFeedback: Number(summary.totalFeedback),
        averageScore: Number(summary.averageScore),
        lastUpdated: Number(summary.lastUpdated),
      };
    } catch (error: any) {
      console.error("[erc8004] Failed to get reputation:", error.message);
      return null;
    }
  }
  
  async readAllFeedback(agentTokenId: string): Promise<Array<{
    rater: string;
    score: number;
    decimals: number;
    tag1: string;
    tag2: string;
    endpoint: string;
    feedbackURI: string;
    feedbackHash: string;
    timestamp: number;
  }> | null> {
    if (!this.isReady()) {
      return null;
    }
    
    const config = ERC8004_CONFIG.active;
    const reputation = new ethers.Contract(config.resolver, REPUTATION_REGISTRY_ABI, this.provider);
    
    try {
      const feedback = await reputation.readAllFeedback(agentTokenId);
      return feedback.map((f: any) => ({
        rater: f.rater,
        score: Number(f.score),
        decimals: Number(f.decimals),
        tag1: f.tag1,
        tag2: f.tag2,
        endpoint: f.endpoint,
        feedbackURI: f.feedbackURI,
        feedbackHash: f.feedbackHash,
        timestamp: Number(f.timestamp),
      }));
    } catch (error: any) {
      console.error("[erc8004] Failed to read feedback:", error.message);
      return null;
    }
  }
  
  getReputationRegistryAddress(): string {
    return ERC8004_CONFIG.active.resolver;
  }
  
  // Get explorer URL for a token
  getExplorerUrl(tokenId: string): string {
    const config = ERC8004_CONFIG.active;
    return `${config.explorer}/token/${config.identityRegistry}?a=${tokenId}`;
  }
  
  // Get explorer URL for a transaction
  getTxExplorerUrl(txHash: string): string {
    const config = ERC8004_CONFIG.active;
    return `${config.explorer}/tx/${txHash}`;
  }
}

// Singleton instance
export const erc8004Service = new ERC8004Service();
