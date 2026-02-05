import { db } from "./db.js";
import { agents, agentGoals, agentMemory, agentScheduledTasks, agentToolExecutions, agentSecrets, agentTokens, liquidityPositions, verifiedBots } from "../shared/schema.js";
import { eq, desc, and } from "drizzle-orm";
import OpenAI from "openai";
import { readGmailMessages } from "./gmail-oauth.js";
import { deriveAgentWalletAddress } from "../lib/agent-wallet.js";
import {
  CELO_TOKENS,
  getAllTokenBalances,
  getSwapQuote,
  executeSwap,
  getAaveReserveData,
  supplyToAave,
  withdrawFromAave,
  transferWithFeeAbstraction,
  getBridgeOptions,
  getStablecoinInfo
} from "../lib/celo-defi.js";
import {
  deployERC20Token,
  transferToken,
  getTokenBalance,
  getMultipleTokenBalances,
  getTokenInfo
} from "../lib/token-factory.js";
import {
  createLiquidityPool,
  addLiquidity,
  removeLiquidity,
  getPositionInfo,
  collectFees,
  FEE_TIERS,
  type FeeTierKey
} from "../lib/uniswap-liquidity.js";
import {
  executeSponsoredLiquidity
} from "../lib/sponsored-liquidity.js";

export interface AgentContext {
  agentId: string;
  name: string;
  systemPrompt: string;
  goals: string[];
  memories: string[];
  tools: ToolDefinition[];
  credits: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  output: any;
  error?: string;
  creditsCost: number;
}

const TOOL_COSTS: Record<string, number> = {
  web_fetch: 0.001,
  web_search: 0.002,
  remember: 0.0001,
  recall: 0.0001,
  invoke_skill: 0.001,
  code_execute: 0.005,
  read_emails: 0.002,
  get_wallet_balances: 0.0005,
  get_swap_quote: 0.001,
  swap_tokens: 0.005,
  check_defi_rates: 0.001,
  aave_supply: 0.005,
  aave_withdraw: 0.005,
  get_bridge_options: 0.0005,
  transfer_tokens: 0.003,
  get_stablecoin_info: 0.0001,
  deploy_token: 0.05,
  transfer_custom_token: 0.003,
  get_custom_token_balance: 0.0005,
  list_my_tokens: 0.0001,
  create_liquidity_pool: 0.02,
  add_liquidity: 0.01,
  remove_liquidity: 0.01,
  get_liquidity_positions: 0.0005,
  collect_fees: 0.005,
};

export const AVAILABLE_TOOLS: ToolDefinition[] = [
  {
    name: "web_fetch",
    description: "Fetch content from a URL and return the text content",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "remember",
    description: "Store a fact or piece of information in long-term memory",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The information to remember" },
        importance: { type: "number", description: "Importance score 1-10" },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: "Search and retrieve information from long-term memory",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for in memory" },
      },
      required: ["query"],
    },
  },
  {
    name: "invoke_skill",
    description: "Call another agent's skill and pay for it with credits",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill ID to invoke" },
        input: { type: "object", description: "Input data for the skill" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "update_goal_progress",
    description: "Update progress on one of your goals",
    parameters: {
      type: "object",
      properties: {
        goalId: { type: "string", description: "The goal ID to update" },
        progress: { type: "number", description: "Progress percentage (0-100)" },
        note: { type: "string", description: "Optional progress note" },
        completed: { type: "boolean", description: "Mark goal as completed" },
      },
      required: ["goalId", "progress"],
    },
  },
  {
    name: "read_emails",
    description: "Read the user's recent emails from their connected Gmail account. Use this to learn about the user's communication style, priorities, and current activities.",
    parameters: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Number of emails to fetch (max 10)" },
        query: { type: "string", description: "Optional Gmail search query (e.g., 'is:unread', 'from:boss@company.com')" },
      },
      required: [],
    },
  },
  {
    name: "get_wallet_balances",
    description: "Get all token balances in your Celo wallet including CELO, USDC, USDT, cUSD, cEUR, and cREAL. Use this to check your available funds.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_swap_quote",
    description: "Get a price quote for swapping tokens on Celo using Uniswap V3. Supports CELO, USDC, USDT, cUSD, cEUR, cREAL.",
    parameters: {
      type: "object",
      properties: {
        tokenIn: { type: "string", description: "Token symbol to swap from (e.g., 'USDC', 'CELO', 'cUSD')" },
        tokenOut: { type: "string", description: "Token symbol to swap to" },
        amountIn: { type: "string", description: "Amount to swap (e.g., '10.5')" },
      },
      required: ["tokenIn", "tokenOut", "amountIn"],
    },
  },
  {
    name: "swap_tokens",
    description: "Execute a token swap on Celo using Uniswap V3. Gas fees can be paid with stablecoins (fee abstraction).",
    parameters: {
      type: "object",
      properties: {
        tokenIn: { type: "string", description: "Token symbol to swap from" },
        tokenOut: { type: "string", description: "Token symbol to swap to" },
        amountIn: { type: "string", description: "Amount to swap" },
        slippagePercent: { type: "number", description: "Max slippage percentage (default 0.5)" },
      },
      required: ["tokenIn", "tokenOut", "amountIn"],
    },
  },
  {
    name: "check_defi_rates",
    description: "Check current lending/borrowing rates on Aave for Celo tokens. Returns supply APY, borrow APY, and utilization.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token symbol to check rates for (e.g., 'USDC', 'cUSD')" },
      },
      required: ["token"],
    },
  },
  {
    name: "aave_supply",
    description: "Supply tokens to Aave on Celo to earn yield. Gas fees paid with stablecoins.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token symbol to supply (e.g., 'USDC')" },
        amount: { type: "string", description: "Amount to supply" },
      },
      required: ["token", "amount"],
    },
  },
  {
    name: "aave_withdraw",
    description: "Withdraw tokens from Aave on Celo. Returns principal plus earned yield.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token symbol to withdraw" },
        amount: { type: "string", description: "Amount to withdraw" },
      },
      required: ["token", "amount"],
    },
  },
  {
    name: "get_bridge_options",
    description: "Get available bridging options to move assets between Celo and other chains (Ethereum, Polygon, Arbitrum, etc.)",
    parameters: {
      type: "object",
      properties: {
        sourceChain: { type: "string", description: "Source blockchain (e.g., 'Ethereum', 'Celo')" },
        destinationChain: { type: "string", description: "Destination blockchain" },
        token: { type: "string", description: "Token to bridge (e.g., 'USDC')" },
      },
      required: ["sourceChain", "destinationChain", "token"],
    },
  },
  {
    name: "transfer_tokens",
    description: "Transfer tokens to another address on Celo. Gas fees paid with stablecoins (fee abstraction).",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token symbol to transfer (e.g., 'USDC', 'cUSD')" },
        toAddress: { type: "string", description: "Recipient wallet address" },
        amount: { type: "string", description: "Amount to transfer" },
      },
      required: ["token", "toAddress", "amount"],
    },
  },
  {
    name: "get_stablecoin_info",
    description: "Learn about stablecoins on Celo - understand the difference between Mento stables (cUSD, cEUR, cREAL) and bridged stables (USDC, USDT).",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Stablecoin symbol (e.g., 'cUSD', 'USDC')" },
      },
      required: ["token"],
    },
  },
  {
    name: "deploy_token",
    description: "Deploy your own ERC20 token on Celo. Your token can be used to grant access to skills, represent value, or trade with other verified agents. Only SelfClaw-verified agents can deploy tokens.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The full name of your token (e.g., 'MyAgent Coin')" },
        symbol: { type: "string", description: "The ticker symbol (e.g., 'MAC')" },
        initialSupply: { type: "string", description: "Initial supply to mint (e.g., '1000000')" },
      },
      required: ["name", "symbol", "initialSupply"],
    },
  },
  {
    name: "transfer_custom_token",
    description: "Transfer your custom ERC20 tokens to another agent's wallet. Only works between SelfClaw-verified agents.",
    parameters: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "The contract address of the token to transfer" },
        toAgentId: { type: "string", description: "The ID of the recipient agent" },
        amount: { type: "string", description: "Amount to transfer" },
      },
      required: ["tokenAddress", "toAgentId", "amount"],
    },
  },
  {
    name: "get_custom_token_balance",
    description: "Check your balance of a specific ERC20 token by its contract address.",
    parameters: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "The contract address of the token" },
      },
      required: ["tokenAddress"],
    },
  },
  {
    name: "list_my_tokens",
    description: "List all tokens you have created. Shows contract addresses, symbols, and supplies.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "create_liquidity_pool",
    description: "Create a Uniswap V3 liquidity pool for your token paired with another token (USDC, cUSD, CELO, etc). You decide the initial price, fee tier, and how much liquidity to provide.",
    parameters: {
      type: "object",
      properties: {
        token0Address: { type: "string", description: "First token address (your token or any ERC20)" },
        token1Address: { type: "string", description: "Second token address (USDC, cUSD, CELO, etc)" },
        feeTier: { type: "string", enum: ["0.01", "0.05", "0.3", "1"], description: "Fee tier percentage: 0.01%, 0.05%, 0.3%, or 1%" },
        initialPrice: { type: "number", description: "Initial price of token0 in terms of token1 (e.g., 0.001 means 1 token0 = 0.001 token1)" },
        amount0: { type: "string", description: "Amount of token0 to deposit" },
        amount1: { type: "string", description: "Amount of token1 to deposit" },
        priceRangeLower: { type: "number", description: "Lower bound of price range (e.g., 0.0005)" },
        priceRangeUpper: { type: "number", description: "Upper bound of price range (e.g., 0.002)" },
      },
      required: ["token0Address", "token1Address", "feeTier", "initialPrice", "amount0", "amount1", "priceRangeLower", "priceRangeUpper"],
    },
  },
  {
    name: "add_liquidity",
    description: "Add more liquidity to an existing Uniswap V3 position.",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string", description: "The NFT token ID of the position" },
        amount0: { type: "string", description: "Amount of token0 to add" },
        amount1: { type: "string", description: "Amount of token1 to add" },
        token0Address: { type: "string", description: "Address of token0" },
        token1Address: { type: "string", description: "Address of token1" },
      },
      required: ["positionId", "amount0", "amount1", "token0Address", "token1Address"],
    },
  },
  {
    name: "remove_liquidity",
    description: "Remove liquidity from a Uniswap V3 position and collect any earned fees.",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string", description: "The NFT token ID of the position" },
        percentage: { type: "number", description: "Percentage of liquidity to remove (1-100)" },
      },
      required: ["positionId", "percentage"],
    },
  },
  {
    name: "get_liquidity_positions",
    description: "List all your Uniswap V3 liquidity positions with current status and earned fees.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "collect_fees",
    description: "Collect earned trading fees from a Uniswap V3 position without removing liquidity.",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string", description: "The NFT token ID of the position" },
      },
      required: ["positionId"],
    },
  },
];

export async function buildAgentContext(agentId: string): Promise<AgentContext | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;

  const goals = await db
    .select()
    .from(agentGoals)
    .where(and(eq(agentGoals.agentId, agentId), eq(agentGoals.status, "active")))
    .orderBy(desc(agentGoals.priority));

  const memories = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agentId))
    .orderBy(desc(agentMemory.importance))
    .limit(20);

  const config = agent.configJson as { systemPrompt?: string; model?: string } | null;

  const systemPrompt = buildSystemPrompt(agent.name, config?.systemPrompt, goals, memories);

  return {
    agentId,
    name: agent.name,
    systemPrompt,
    goals: goals.map((g) => `[${g.id}] ${g.goal} (Priority: ${g.priority}, Progress: ${g.progress || "Not started"})`),
    memories: memories.map((m) => m.content),
    tools: AVAILABLE_TOOLS,
    credits: parseFloat(agent.credits || "0"),
  };
}

function buildSystemPrompt(
  agentName: string,
  customPrompt: string | undefined,
  goals: { id: string; goal: string; priority: number | null; progress: string | null }[],
  memories: { content: string }[]
): string {
  let prompt = `You are ${agentName}, an autonomous AI agent running on ClawPit.

`;

  if (customPrompt) {
    prompt += `## Custom Instructions\n${customPrompt}\n\n`;
  }

  if (goals.length > 0) {
    prompt += `## Your Active Goals\n`;
    goals.forEach((g, i) => {
      prompt += `${i + 1}. ${g.goal} (Priority: ${g.priority || 1})\n`;
      if (g.progress) prompt += `   Progress: ${g.progress}\n`;
    });
    prompt += `\n`;
  }

  if (memories.length > 0) {
    prompt += `## Things You Remember\n`;
    memories.slice(0, 10).forEach((m) => {
      prompt += `- ${m.content}\n`;
    });
    prompt += `\n`;
  }

  prompt += `## Available Tools
You can use tools to accomplish your goals:

### Core Tools
- web_fetch: Retrieve content from URLs
- remember: Store important information
- recall: Search your memory
- invoke_skill: Pay to use another agent's skill
- update_goal_progress: Track progress on your goals

### Celo DeFi Tools (Fee Abstraction Enabled)
Your wallet supports paying gas fees with stablecoins instead of CELO!

- get_wallet_balances: Check all your token balances (CELO, USDC, USDT, cUSD, cEUR, cREAL)
- get_swap_quote: Get price quotes for token swaps on Uniswap V3
- swap_tokens: Execute token swaps (gas paid in stablecoins)
- check_defi_rates: Check Aave lending/borrowing APY rates
- aave_supply: Supply tokens to Aave to earn yield
- aave_withdraw: Withdraw tokens + yield from Aave
- get_bridge_options: Find bridges for cross-chain transfers
- transfer_tokens: Send tokens to any address (gas paid in stablecoins)
- get_stablecoin_info: Learn about Mento vs bridged stablecoins

### Agent Token Tools
Create and trade your own tokens with other verified agents!

- deploy_token: Create your own ERC20 token on Celo (you decide name, symbol, supply)
- transfer_custom_token: Send your tokens to other verified agents
- get_custom_token_balance: Check balance of any custom token
- list_my_tokens: View all tokens you've created

### Liquidity Pool Tools
Create Uniswap V3 liquidity pools for your tokens! You decide the price, fee tier, and liquidity amount.

- create_liquidity_pool: Create a pool pairing your token with USDC/cUSD/CELO (set initial price, fee tier 0.01%/0.05%/0.3%/1%)
- add_liquidity: Add more liquidity to an existing position
- remove_liquidity: Withdraw liquidity and collect earned fees
- get_liquidity_positions: List all your active positions
- collect_fees: Collect trading fees without removing liquidity

### Stablecoin Types on Celo
- Mento (decentralized): cUSD, cEUR, cREAL - native to Celo, backed by Celo Reserve
- Bridged: USDC, USDT - bridged from Ethereum

## Economic Context
You have a credit balance. Each action costs credits:
- AI requests: 0.01 credits
- Web fetch: 0.001 credits
- DeFi operations: 0.001-0.005 credits
- Skills: Variable (set by skill owner)

You also have a Celo wallet with real tokens. Use DeFi tools wisely to grow your on-chain assets.
When credits run low, prioritize earning through your skills or completing goals efficiently.
`;

  return prompt;
}

export async function executeTool(
  agentId: string,
  toolName: string,
  input: Record<string, any>
): Promise<ToolResult> {
  const startTime = Date.now();
  const creditsCost = TOOL_COSTS[toolName] || 0.001;

  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) {
      return { success: false, output: null, error: "Agent not found", creditsCost: 0 };
    }

    const currentCredits = parseFloat(agent.credits || "0");
    if (currentCredits < creditsCost) {
      return { success: false, output: null, error: "Insufficient credits", creditsCost: 0 };
    }

    let result: any;

    switch (toolName) {
      case "web_fetch":
        result = await toolWebFetch(input.url);
        break;
      case "remember":
        result = await toolRemember(agentId, input.content, input.importance);
        break;
      case "recall":
        result = await toolRecall(agentId, input.query);
        break;
      case "update_goal_progress":
        result = await toolUpdateGoalProgress(agentId, input.goalId, input.progress, input.completed);
        break;
      case "invoke_skill":
        result = await toolInvokeSkill(agentId, input.skillId, input.input);
        break;
      case "read_emails":
        result = await toolReadEmails(agentId, input.maxResults, input.query);
        break;
      case "get_wallet_balances":
        result = await toolGetWalletBalances(agentId);
        break;
      case "get_swap_quote":
        result = await toolGetSwapQuote(input.tokenIn, input.tokenOut, input.amountIn);
        break;
      case "swap_tokens":
        result = await toolSwapTokens(agentId, input.tokenIn, input.tokenOut, input.amountIn, input.slippagePercent);
        break;
      case "check_defi_rates":
        result = await toolCheckDefiRates(input.token);
        break;
      case "aave_supply":
        result = await toolAaveSupply(agentId, input.token, input.amount);
        break;
      case "aave_withdraw":
        result = await toolAaveWithdraw(agentId, input.token, input.amount);
        break;
      case "get_bridge_options":
        result = await toolGetBridgeOptions(input.sourceChain, input.destinationChain, input.token);
        break;
      case "transfer_tokens":
        result = await toolTransferTokens(agentId, input.token, input.toAddress, input.amount);
        break;
      case "get_stablecoin_info":
        result = await toolGetStablecoinInfo(input.token);
        break;
      case "deploy_token":
        result = await toolDeployToken(agentId, input.name, input.symbol, input.initialSupply);
        break;
      case "transfer_custom_token":
        result = await toolTransferCustomToken(agentId, input.tokenAddress, input.toAgentId, input.amount);
        break;
      case "get_custom_token_balance":
        result = await toolGetCustomTokenBalance(agentId, input.tokenAddress);
        break;
      case "list_my_tokens":
        result = await toolListMyTokens(agentId);
        break;
      case "create_liquidity_pool":
        result = await toolCreateLiquidityPool(
          agentId,
          input.token0Address,
          input.token1Address,
          input.feeTier,
          input.initialPrice,
          input.amount0,
          input.amount1,
          input.priceRangeLower,
          input.priceRangeUpper
        );
        break;
      case "add_liquidity":
        result = await toolAddLiquidity(
          agentId,
          input.positionId,
          input.amount0,
          input.amount1,
          input.token0Address,
          input.token1Address
        );
        break;
      case "remove_liquidity":
        result = await toolRemoveLiquidity(agentId, input.positionId, input.percentage);
        break;
      case "get_liquidity_positions":
        result = await toolGetLiquidityPositions(agentId);
        break;
      case "collect_fees":
        result = await toolCollectFees(agentId, input.positionId);
        break;
      default:
        return { success: false, output: null, error: `Unknown tool: ${toolName}`, creditsCost: 0 };
    }

    const newCredits = (currentCredits - creditsCost).toFixed(6);
    await db.update(agents).set({ credits: newCredits }).where(eq(agents.id, agentId));

    await db.insert(agentToolExecutions).values({
      agentId,
      toolName,
      input,
      output: result,
      status: "completed",
      creditsCost: creditsCost.toString(),
      executionTimeMs: Date.now() - startTime,
    });

    return { success: true, output: result, creditsCost };
  } catch (error: any) {
    await db.insert(agentToolExecutions).values({
      agentId,
      toolName,
      input,
      status: "failed",
      errorMessage: error.message,
      executionTimeMs: Date.now() - startTime,
    });

    return { success: false, output: null, error: error.message, creditsCost: 0 };
  }
}

async function toolWebFetch(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "ClawPit-Agent/1.0" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();
  return text.slice(0, 10000);
}

async function toolRemember(agentId: string, content: string, importance?: number): Promise<{ saved: boolean }> {
  await db.insert(agentMemory).values({
    agentId,
    content,
    importance: importance || 5,
    memoryType: "fact",
  });
  return { saved: true };
}

async function toolRecall(agentId: string, query: string): Promise<{ memories: string[] }> {
  const memories = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agentId))
    .orderBy(desc(agentMemory.importance))
    .limit(10);

  const queryLower = query.toLowerCase();
  const relevant = memories.filter((m) => m.content.toLowerCase().includes(queryLower));

  return { memories: relevant.length > 0 ? relevant.map((m) => m.content) : memories.slice(0, 5).map((m) => m.content) };
}

async function toolUpdateGoalProgress(
  agentId: string,
  goalId: string,
  progress: number,
  completed?: boolean
): Promise<{ updated: boolean }> {
  const progressValue = Math.min(100, Math.max(0, Math.round(progress)));
  const updates: any = { progress: progressValue };
  if (completed || progressValue >= 100) {
    updates.status = "completed";
    updates.completedAt = new Date();
  }

  await db
    .update(agentGoals)
    .set(updates)
    .where(and(eq(agentGoals.id, goalId), eq(agentGoals.agentId, agentId)));

  return { updated: true, progress: progressValue };
}

async function toolInvokeSkill(
  callerAgentId: string,
  skillId: string,
  input: Record<string, any>
): Promise<any> {
  const { agentSkills } = await import("../shared/schema.js");

  const [skill] = await db.select().from(agentSkills).where(eq(agentSkills.id, skillId));
  if (!skill || !skill.isActive) {
    throw new Error("Skill not found or inactive");
  }

  const price = parseFloat(skill.priceCredits || "0");
  const [callerAgent] = await db.select().from(agents).where(eq(agents.id, callerAgentId));
  
  if (!callerAgent || parseFloat(callerAgent.credits || "0") < price) {
    throw new Error("Insufficient credits for skill");
  }

  const platformFee = price * 0.03;
  const ownerEarning = price - platformFee;

  const newCallerCredits = (parseFloat(callerAgent.credits || "0") - price).toFixed(6);
  await db.update(agents).set({ credits: newCallerCredits }).where(eq(agents.id, callerAgentId));

  const [ownerAgent] = await db.select().from(agents).where(eq(agents.id, skill.agentId));
  if (ownerAgent) {
    const newOwnerCredits = (parseFloat(ownerAgent.credits || "0") + ownerEarning).toFixed(6);
    await db.update(agents).set({ credits: newOwnerCredits }).where(eq(agents.id, skill.agentId));
  }

  const { payments } = await import("../shared/schema.js");
  await db.insert(payments).values({
    agentId: callerAgentId,
    direction: "outgoing",
    amount: price.toString(),
    counterpartyAgentId: skill.agentId,
    status: "completed",
    endpoint: `/skills/${skillId}`,
  });

  await db
    .update(agentSkills)
    .set({
      usageCount: (skill.usageCount || 0) + 1,
      totalEarned: (parseFloat(skill.totalEarned || "0") + ownerEarning).toFixed(6),
    })
    .where(eq(agentSkills.id, skillId));

  return { 
    success: true, 
    skillName: skill.name,
    message: `Skill "${skill.name}" invoked successfully. Cost: ${price} credits.`,
  };
}

async function toolReadEmails(
  agentId: string,
  maxResults?: number,
  query?: string
): Promise<{ emails: any[]; message: string }> {
  try {
    const emails = await readGmailMessages(agentId, maxResults || 5, query);
    return {
      emails,
      message: `Retrieved ${emails.length} emails from user's Gmail.`
    };
  } catch (error: any) {
    if (error.message.includes("not connected")) {
      return {
        emails: [],
        message: "Gmail is not connected for this agent. The user needs to connect their Gmail account in the Config tab."
      };
    }
    throw error;
  }
}

async function toolGetWalletBalances(agentId: string): Promise<any> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    throw new Error("Platform wallet not configured");
  }
  
  const walletAddress = deriveAgentWalletAddress(platformKey, agentId);
  const balances = await getAllTokenBalances(walletAddress as `0x${string}`);
  
  return {
    address: walletAddress,
    balances,
    supportedTokens: Object.keys(CELO_TOKENS),
    message: "Fee abstraction enabled - gas fees can be paid with stablecoins (USDC, cUSD, etc.)"
  };
}

async function toolGetSwapQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: string
): Promise<any> {
  const quote = await getSwapQuote(tokenIn, tokenOut, amountIn);
  return {
    ...quote,
    tokenIn,
    tokenOut,
    amountIn,
    exchange: "Uniswap V3 on Celo",
    message: `Swap ${amountIn} ${tokenIn} for ~${quote.amountOut} ${tokenOut}`
  };
}

async function toolSwapTokens(
  agentId: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippagePercent?: number
): Promise<any> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    throw new Error("Platform wallet not configured");
  }
  
  const result = await executeSwap(
    platformKey,
    agentId,
    tokenIn,
    tokenOut,
    amountIn,
    slippagePercent || 0.5,
    true
  );
  
  return {
    success: true,
    transactionHash: result.hash,
    amountIn,
    tokenIn,
    amountOut: result.amountOut,
    tokenOut,
    gasToken: result.gasToken,
    message: `Swapped ${amountIn} ${tokenIn} for ${result.amountOut} ${tokenOut}. Gas paid in ${result.gasToken}.`,
    explorerUrl: `https://celoscan.io/tx/${result.hash}`
  };
}

async function toolCheckDefiRates(token: string): Promise<any> {
  const rates = await getAaveReserveData(token);
  const tokenInfo = getStablecoinInfo(token);
  
  return {
    token,
    tokenType: tokenInfo.type,
    protocol: "Aave V3",
    ...rates,
    message: `${token} on Aave: Supply APY ${rates.supplyAPY}, Borrow APY ${rates.borrowAPY}`
  };
}

async function toolAaveSupply(
  agentId: string,
  token: string,
  amount: string
): Promise<any> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    throw new Error("Platform wallet not configured");
  }
  
  const result = await supplyToAave(platformKey, agentId, token, amount, true);
  
  return {
    success: true,
    transactionHash: result.hash,
    token,
    amount: result.amount,
    protocol: "Aave V3",
    gasToken: result.gasToken,
    message: `Supplied ${amount} ${token} to Aave. Gas paid in ${result.gasToken}.`,
    explorerUrl: `https://celoscan.io/tx/${result.hash}`
  };
}

async function toolAaveWithdraw(
  agentId: string,
  token: string,
  amount: string
): Promise<any> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    throw new Error("Platform wallet not configured");
  }
  
  const result = await withdrawFromAave(platformKey, agentId, token, amount, true);
  
  return {
    success: true,
    transactionHash: result.hash,
    token,
    amount: result.amount,
    protocol: "Aave V3",
    gasToken: result.gasToken,
    message: `Withdrew ${amount} ${token} from Aave. Gas paid in ${result.gasToken}.`,
    explorerUrl: `https://celoscan.io/tx/${result.hash}`
  };
}

async function toolGetBridgeOptions(
  sourceChain: string,
  destinationChain: string,
  token: string
): Promise<any> {
  const options = getBridgeOptions(sourceChain, destinationChain, token);
  
  if (options.length === 0) {
    return {
      sourceChain,
      destinationChain,
      token,
      options: [],
      message: `No bridge options found for ${token} from ${sourceChain} to ${destinationChain}`
    };
  }
  
  return {
    sourceChain,
    destinationChain,
    token,
    options,
    message: `Found ${options.length} bridge options for ${token} from ${sourceChain} to ${destinationChain}`
  };
}

async function toolTransferTokens(
  agentId: string,
  token: string,
  toAddress: string,
  amount: string
): Promise<any> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    throw new Error("Platform wallet not configured");
  }
  
  const result = await transferWithFeeAbstraction(platformKey, agentId, token, toAddress, amount);
  
  return {
    success: true,
    transactionHash: result.hash,
    token,
    amount: result.amount,
    toAddress,
    gasToken: result.gasToken,
    message: `Transferred ${amount} ${token} to ${toAddress}. Gas paid in ${result.gasToken}.`,
    explorerUrl: `https://celoscan.io/tx/${result.hash}`
  };
}

async function toolGetStablecoinInfo(token: string): Promise<any> {
  const info = getStablecoinInfo(token);
  const tokenData = CELO_TOKENS[token as keyof typeof CELO_TOKENS];
  
  return {
    token,
    type: info.type,
    description: info.description,
    address: tokenData?.address || 'Native',
    decimals: tokenData?.decimals || 18,
    fullName: tokenData?.name || token,
    mentoStablecoins: ['cUSD', 'cEUR', 'cREAL'],
    bridgedStablecoins: ['USDC', 'USDT'],
    feeAbstractionSupported: ['USDC', 'USDT', 'cUSD', 'cEUR'].includes(token),
    message: info.description
  };
}

export async function getAgentOpenAIClient(agentId: string): Promise<OpenAI | null> {
  const secrets = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, agentId));
  const openaiSecret = secrets.find((s) => s.serviceName === "OPENAI_API_KEY" && s.isActive);

  if (openaiSecret) {
    return new OpenAI({
      apiKey: openaiSecret.apiKey,
      baseURL: openaiSecret.baseUrl || undefined,
    });
  }

  if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }

  return null;
}

export async function runAgentTurn(
  agentId: string,
  userMessage: string,
  conversationHistory: { role: string; content: string }[] = []
): Promise<{ response: string; toolsUsed: string[]; creditsCost: number }> {
  const context = await buildAgentContext(agentId);
  if (!context) {
    throw new Error("Agent not found");
  }

  const openai = await getAgentOpenAIClient(agentId);
  if (!openai) {
    throw new Error("No AI provider configured");
  }

  const messages: any[] = [
    { role: "system", content: context.systemPrompt },
    ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const tools = context.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  let totalCreditsCost = 0.01;
  const toolsUsed: string[] = [];
  let maxIterations = 5;

  while (maxIterations > 0) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (agent) {
        const newCredits = (parseFloat(agent.credits || "0") - 0.01).toFixed(6);
        await db.update(agents).set({ credits: newCredits }).where(eq(agents.id, agentId));
      }

      return {
        response: assistantMessage.content || "",
        toolsUsed,
        creditsCost: totalCreditsCost,
      };
    }

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;
      const toolName = (toolCall as any).function.name;
      const toolInput = JSON.parse((toolCall as any).function.arguments);

      toolsUsed.push(toolName);
      const result = await executeTool(agentId, toolName, toolInput);
      totalCreditsCost += result.creditsCost;

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.success ? result.output : { error: result.error }),
      });
    }

    maxIterations--;
  }

  return {
    response: "Maximum iterations reached while processing tools.",
    toolsUsed,
    creditsCost: totalCreditsCost,
  };
}

async function isAgentVerified(agentId: string): Promise<boolean> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return false;
  
  const walletAddress = deriveAgentWalletAddress(process.env.CELO_PRIVATE_KEY || "", agentId);
  const [verified] = await db.select().from(verifiedBots).where(eq(verifiedBots.publicKey, walletAddress)).limit(1);
  
  return !!verified;
}

async function toolDeployToken(
  agentId: string,
  name: string,
  symbol: string,
  initialSupply: string
): Promise<{ success: boolean; tokenAddress?: string; txHash?: string; error?: string; sponsoredLiquidity?: { amountCelo?: string; txHash?: string } }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }
  
  const isVerified = await isAgentVerified(agentId);
  if (!isVerified) {
    return { success: false, error: "Only SelfClaw-verified agents can deploy tokens. Complete passport verification first." };
  }
  
  if (!name || name.length < 1 || name.length > 64) {
    return { success: false, error: "Token name must be 1-64 characters" };
  }
  if (!symbol || symbol.length < 1 || symbol.length > 10) {
    return { success: false, error: "Token symbol must be 1-10 characters" };
  }
  if (!initialSupply || parseFloat(initialSupply) <= 0) {
    return { success: false, error: "Initial supply must be positive" };
  }
  
  const result = await deployERC20Token(platformKey, agentId, name, symbol, initialSupply);
  
  if (result.success && result.tokenAddress) {
    await db.insert(agentTokens).values({
      agentId,
      contractAddress: result.tokenAddress,
      name,
      symbol,
      initialSupply,
      deployTxHash: result.txHash || null,
    });
    
    let sponsorshipResult = null;
    try {
      const agent = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      if (agent.length > 0 && agent[0].userId) {
        const { users } = await import("../shared/schema.js");
        const user = await db.select().from(users).where(eq(users.id, agent[0].userId)).limit(1);
        if (user.length > 0 && user[0].humanId) {
          const humanId = user[0].humanId;
          const agentWallet = deriveAgentWalletAddress(platformKey, agentId);
          sponsorshipResult = await executeSponsoredLiquidity(
            humanId,
            result.tokenAddress,
            symbol,
            agentWallet,
            agentId
          );
          if (sponsorshipResult.success) {
            console.log(`[deploy_token] Sponsored liquidity sent: ${sponsorshipResult.amountCelo} CELO to ${agentWallet}`);
          } else if (!sponsorshipResult.alreadySponsored) {
            console.log(`[deploy_token] Sponsorship not available: ${sponsorshipResult.error}`);
          }
        }
      }
    } catch (sponsorError) {
      console.error("[deploy_token] Sponsored liquidity error:", sponsorError);
    }
    
    return {
      success: true,
      tokenAddress: result.tokenAddress,
      txHash: result.txHash,
      sponsoredLiquidity: sponsorshipResult?.success ? {
        amountCelo: sponsorshipResult.amountCelo,
        txHash: sponsorshipResult.txHash
      } : undefined
    };
  }
  
  return { success: false, error: result.error };
}

async function toolTransferCustomToken(
  agentId: string,
  tokenAddress: string,
  toAgentId: string,
  amount: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }
  
  const senderVerified = await isAgentVerified(agentId);
  if (!senderVerified) {
    return { success: false, error: "Only SelfClaw-verified agents can transfer tokens. Complete passport verification first." };
  }
  
  if (!tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    return { success: false, error: "Invalid token address format" };
  }
  if (!amount || parseFloat(amount) <= 0) {
    return { success: false, error: "Transfer amount must be positive" };
  }
  
  const [recipientAgent] = await db.select().from(agents).where(eq(agents.id, toAgentId)).limit(1);
  if (!recipientAgent) {
    return { success: false, error: "Recipient agent not found" };
  }
  
  const recipientVerified = await isAgentVerified(toAgentId);
  if (!recipientVerified) {
    return { success: false, error: "Recipient agent must be SelfClaw-verified to receive tokens" };
  }
  
  const recipientWallet = deriveAgentWalletAddress(platformKey, toAgentId);
  
  const result = await transferToken(platformKey, agentId, tokenAddress, recipientWallet, amount);
  
  if (result.success) {
    return { success: true, txHash: result.txHash };
  }
  
  return { success: false, error: result.error };
}

async function toolGetCustomTokenBalance(
  agentId: string,
  tokenAddress: string
): Promise<{ success: boolean; balance?: any; error?: string }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }
  
  const walletAddress = deriveAgentWalletAddress(platformKey, agentId);
  const balance = await getTokenBalance(tokenAddress, walletAddress);
  
  if (balance) {
    return { success: true, balance };
  }
  
  return { success: false, error: "Failed to get token balance" };
}

async function toolListMyTokens(agentId: string): Promise<{ tokens: any[] }> {
  const tokens = await db.select().from(agentTokens).where(eq(agentTokens.agentId, agentId));
  
  return {
    tokens: tokens.map((t) => ({
      contractAddress: t.contractAddress,
      name: t.name,
      symbol: t.symbol,
      initialSupply: t.initialSupply,
      deployTxHash: t.deployTxHash,
      createdAt: t.createdAt,
    })),
  };
}

async function toolCreateLiquidityPool(
  agentId: string,
  token0Address: string,
  token1Address: string,
  feeTier: string,
  initialPrice: number,
  amount0: string,
  amount1: string,
  priceRangeLower: number,
  priceRangeUpper: number
): Promise<{ success: boolean; positionId?: string; txHash?: string; error?: string }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }

  const isVerified = await isAgentVerified(agentId);
  if (!isVerified) {
    return { success: false, error: "Only SelfClaw-verified agents can create liquidity pools." };
  }

  if (!FEE_TIERS[feeTier as FeeTierKey]) {
    return { success: false, error: "Invalid fee tier. Use 0.01, 0.05, 0.3, or 1" };
  }

  if (initialPrice <= 0 || priceRangeLower <= 0 || priceRangeUpper <= 0) {
    return { success: false, error: "All prices must be positive" };
  }

  if (priceRangeLower >= priceRangeUpper) {
    return { success: false, error: "Price range lower must be less than upper" };
  }

  const result = await createLiquidityPool(
    platformKey,
    agentId,
    token0Address,
    token1Address,
    feeTier as FeeTierKey,
    initialPrice,
    amount0,
    amount1,
    priceRangeLower,
    priceRangeUpper
  );

  if (result.success && result.positionId) {
    const info0 = await getTokenInfo(token0Address);
    const info1 = await getTokenInfo(token1Address);

    await db.insert(liquidityPositions).values({
      agentId,
      positionId: result.positionId,
      token0Address,
      token1Address,
      token0Symbol: info0?.symbol || 'TOKEN0',
      token1Symbol: info1?.symbol || 'TOKEN1',
      feeTier: FEE_TIERS[feeTier as FeeTierKey],
      tickLower: Math.floor(Math.log(priceRangeLower) / Math.log(1.0001)),
      tickUpper: Math.floor(Math.log(priceRangeUpper) / Math.log(1.0001)),
      liquidity: result.liquidity || '0',
      token0Amount: amount0,
      token1Amount: amount1,
      mintTxHash: result.txHash || null,
    });

    return {
      success: true,
      positionId: result.positionId,
      txHash: result.txHash,
    };
  }

  return { success: false, error: result.error };
}

async function toolAddLiquidity(
  agentId: string,
  positionId: string,
  amount0: string,
  amount1: string,
  token0Address: string,
  token1Address: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }

  const isVerified = await isAgentVerified(agentId);
  if (!isVerified) {
    return { success: false, error: "Only SelfClaw-verified agents can add liquidity." };
  }

  const [position] = await db.select().from(liquidityPositions)
    .where(and(eq(liquidityPositions.agentId, agentId), eq(liquidityPositions.positionId, positionId)))
    .limit(1);

  if (!position) {
    return { success: false, error: "Position not found or not owned by this agent" };
  }

  const result = await addLiquidity(platformKey, agentId, positionId, amount0, amount1, token0Address, token1Address);

  if (result.success) {
    return { success: true, txHash: result.txHash };
  }

  return { success: false, error: result.error };
}

async function toolRemoveLiquidity(
  agentId: string,
  positionId: string,
  percentage: number
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }

  const isVerified = await isAgentVerified(agentId);
  if (!isVerified) {
    return { success: false, error: "Only SelfClaw-verified agents can remove liquidity." };
  }

  if (percentage < 1 || percentage > 100) {
    return { success: false, error: "Percentage must be between 1 and 100" };
  }

  const [position] = await db.select().from(liquidityPositions)
    .where(and(eq(liquidityPositions.agentId, agentId), eq(liquidityPositions.positionId, positionId)))
    .limit(1);

  if (!position) {
    return { success: false, error: "Position not found or not owned by this agent" };
  }

  const result = await removeLiquidity(platformKey, agentId, positionId, percentage);

  if (result.success) {
    if (percentage === 100) {
      await db.update(liquidityPositions)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(liquidityPositions.id, position.id));
    }
    return { success: true, txHash: result.txHash };
  }

  return { success: false, error: result.error };
}

async function toolGetLiquidityPositions(agentId: string): Promise<{ positions: any[] }> {
  const positions = await db.select().from(liquidityPositions)
    .where(and(eq(liquidityPositions.agentId, agentId), eq(liquidityPositions.active, true)));

  const enrichedPositions = await Promise.all(
    positions.map(async (pos) => {
      const onChainInfo = await getPositionInfo(pos.positionId);
      return {
        positionId: pos.positionId,
        token0Symbol: pos.token0Symbol,
        token1Symbol: pos.token1Symbol,
        token0Address: pos.token0Address,
        token1Address: pos.token1Address,
        feeTier: (pos.feeTier / 10000).toFixed(2),
        liquidity: onChainInfo?.liquidity || pos.liquidity,
        feesOwed0: onChainInfo?.tokensOwed0 || '0',
        feesOwed1: onChainInfo?.tokensOwed1 || '0',
        createdAt: pos.createdAt,
      };
    })
  );

  return { positions: enrichedPositions };
}

async function toolCollectFees(
  agentId: string,
  positionId: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const platformKey = process.env.CELO_PRIVATE_KEY;
  if (!platformKey) {
    return { success: false, error: "Platform wallet not configured" };
  }

  const isVerified = await isAgentVerified(agentId);
  if (!isVerified) {
    return { success: false, error: "Only SelfClaw-verified agents can collect fees." };
  }

  const [position] = await db.select().from(liquidityPositions)
    .where(and(eq(liquidityPositions.agentId, agentId), eq(liquidityPositions.positionId, positionId)))
    .limit(1);

  if (!position) {
    return { success: false, error: "Position not found or not owned by this agent" };
  }

  const result = await collectFees(platformKey, agentId, positionId);

  if (result.success) {
    return { success: true, txHash: result.txHash };
  }

  return { success: false, error: result.error };
}
