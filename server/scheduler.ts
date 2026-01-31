import { db } from "./db.js";
import { agents, agentScheduledTasks, agentGoals, agentSkills } from "../shared/schema.js";
import { eq, lte, and, isNull, or } from "drizzle-orm";
import { runAgentTurn } from "./agent-runtime.js";
import CronParser from "cron-parser";

const MINIMUM_CREDITS_TO_RUN = 0.05;

function getNextRunTime(cron: string, fromTime: Date = new Date()): Date {
  try {
    const interval = CronParser.CronExpressionParser.parse(cron, { currentDate: fromTime });
    return interval.next().toDate();
  } catch {
    const next = new Date(fromTime);
    next.setHours(next.getHours() + 1);
    return next;
  }
}

export async function processScheduledTasks(): Promise<{ processed: number; errors: string[] }> {
  const now = new Date();
  const errors: string[] = [];
  let processed = 0;

  try {
    const dueTasks = await db
      .select()
      .from(agentScheduledTasks)
      .where(
        and(
          eq(agentScheduledTasks.isActive, true),
          or(
            isNull(agentScheduledTasks.nextRunAt),
            lte(agentScheduledTasks.nextRunAt, now)
          )
        )
      );

    for (const task of dueTasks) {
      try {
        const [agent] = await db.select().from(agents).where(eq(agents.id, task.agentId));
        
        if (!agent) {
          console.log(`[scheduler] Agent ${task.agentId} not found, skipping task ${task.id}`);
          continue;
        }

        const credits = parseFloat(agent.credits || "0");
        if (credits < MINIMUM_CREDITS_TO_RUN) {
          console.log(`[scheduler] Agent ${agent.name} has insufficient credits (${credits}), archiving...`);
          await db.update(agents).set({ status: "archived" }).where(eq(agents.id, agent.id));
          continue;
        }

        console.log(`[scheduler] Running task "${task.name}" for agent "${agent.name}"`);

        let result: any;
        const taskData = task.taskData as { prompt?: string; skillId?: string } | null;
        
        switch (task.taskType) {
          case "goal_check":
            result = await runGoalCheckTask(agent.id, agent.name);
            break;
          case "web_research":
            result = await runWebResearchTask(agent.id, task.description || "Research and gather information relevant to your goals.");
            break;
          case "skill_execution":
            result = await runSkillExecutionTask(agent.id, taskData?.skillId);
            break;
          case "custom_prompt":
          case "custom":
            result = await runCustomPromptTask(agent.id, taskData?.prompt || task.description || "Check on your goals and take any necessary actions.");
            break;
          default:
            result = await runCustomPromptTask(agent.id, task.description || "Execute your scheduled task.");
        }

        const nextRun = getNextRunTime(task.cronExpression);
        
        await db
          .update(agentScheduledTasks)
          .set({
            lastRunAt: now,
            nextRunAt: nextRun,
            lastResult: result,
          })
          .where(eq(agentScheduledTasks.id, task.id));

        processed++;
      } catch (taskError: any) {
        errors.push(`Task ${task.id}: ${taskError.message}`);
        console.error(`[scheduler] Error running task ${task.id}:`, taskError.message);
      }
    }
  } catch (error: any) {
    errors.push(`Scheduler error: ${error.message}`);
    console.error("[scheduler] Error processing tasks:", error.message);
  }

  return { processed, errors };
}

async function runGoalCheckTask(agentId: string, agentName: string): Promise<any> {
  const goals = await db
    .select()
    .from(agentGoals)
    .where(and(eq(agentGoals.agentId, agentId), eq(agentGoals.status, "active")));

  if (goals.length === 0) {
    return { message: "No active goals to check", skipped: true };
  }

  const goalsSummary = goals.map((g) => `- ${g.goal} (Progress: ${g.progress || "Not started"})`).join("\n");
  
  const prompt = `It's time for your scheduled goal check. Here are your current goals:\n\n${goalsSummary}\n\nReview your goals and take any actions you can to make progress. Use your available tools if needed. Update your goal progress as you work.`;

  try {
    const result = await runAgentTurn(agentId, prompt);
    return {
      success: true,
      response: result.response,
      toolsUsed: result.toolsUsed,
      creditsCost: result.creditsCost,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function runCustomPromptTask(agentId: string, prompt: string): Promise<any> {
  try {
    const result = await runAgentTurn(agentId, prompt);
    return {
      success: true,
      response: result.response,
      toolsUsed: result.toolsUsed,
      creditsCost: result.creditsCost,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function runWebResearchTask(agentId: string, topic: string): Promise<any> {
  const prompt = `You have a scheduled web research task. Research topic: "${topic}". Use your web_fetch tool to gather relevant information. Summarize your findings and store important facts using the remember tool.`;

  try {
    const result = await runAgentTurn(agentId, prompt);
    return {
      success: true,
      taskType: "web_research",
      response: result.response,
      toolsUsed: result.toolsUsed,
      creditsCost: result.creditsCost,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function runSkillExecutionTask(agentId: string, skillId?: string): Promise<any> {
  if (!skillId) {
    return { success: false, error: "No skillId provided for skill_execution task" };
  }

  const [skill] = await db.select().from(agentSkills).where(eq(agentSkills.id, skillId));
  if (!skill) {
    return { success: false, error: `Skill ${skillId} not found` };
  }

  const prompt = `You have a scheduled task to execute the skill: "${skill.name}". Description: ${skill.description}. Execute this skill now and report the results.`;

  try {
    const result = await runAgentTurn(agentId, prompt);
    return {
      success: true,
      taskType: "skill_execution",
      skillId,
      skillName: skill.name,
      response: result.response,
      toolsUsed: result.toolsUsed,
      creditsCost: result.creditsCost,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function archiveInactiveAgents(): Promise<number> {
  const [lowCreditAgents] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.status, "active"), lte(agents.credits, "0")));

  let archivedCount = 0;

  if (lowCreditAgents) {
    await db.update(agents).set({ status: "archived" }).where(eq(agents.id, lowCreditAgents.id));
    archivedCount = 1;
  }

  return archivedCount;
}

let schedulerInterval: NodeJS.Timeout | null = null;

export function startScheduler(intervalMs: number = 60000): void {
  if (schedulerInterval) {
    console.log("[scheduler] Scheduler already running");
    return;
  }

  console.log(`[scheduler] Starting scheduler (interval: ${intervalMs}ms)`);
  
  processScheduledTasks().then((result) => {
    console.log(`[scheduler] Initial run: processed ${result.processed} tasks`);
  });

  schedulerInterval = setInterval(async () => {
    const result = await processScheduledTasks();
    if (result.processed > 0 || result.errors.length > 0) {
      console.log(`[scheduler] Processed ${result.processed} tasks, ${result.errors.length} errors`);
    }
  }, intervalMs);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[scheduler] Scheduler stopped");
  }
}
