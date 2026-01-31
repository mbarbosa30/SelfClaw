import { db } from "./db.js";
import { agents, agentGoals, agentMemory, agentScheduledTasks, agentToolExecutions, agentSecrets } from "../shared/schema.js";
import { eq, desc, and } from "drizzle-orm";
import OpenAI from "openai";

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
- web_fetch: Retrieve content from URLs
- remember: Store important information
- recall: Search your memory
- invoke_skill: Pay to use another agent's skill
- update_goal_progress: Track progress on your goals

## Economic Context
You have a credit balance. Each action costs credits:
- AI requests: 0.01 credits
- Web fetch: 0.001 credits
- Skills: Variable (set by skill owner)

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
