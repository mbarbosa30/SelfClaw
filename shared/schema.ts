import { sql } from "drizzle-orm";
import { 
  pgTable, 
  varchar, 
  text, 
  timestamp, 
  jsonb, 
  index, 
  integer,
  boolean,
  decimal
} from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  linkedinUrl: varchar("linkedin_url"),
  twitterUsername: varchar("twitter_username"),
  githubUsername: varchar("github_username"),
  birthdate: varchar("birthdate"),
  timezone: varchar("timezone"),
  profession: varchar("profession"),
  goals: text("goals"),
  communicationStyle: varchar("communication_style"),
  profileComplete: boolean("profile_complete").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  name: varchar("name").notNull(),
  description: text("description"),
  registryTokenId: varchar("registry_token_id"),
  ownerAddress: varchar("owner_address"),
  tbaAddress: varchar("tba_address"),
  walletIndex: integer("wallet_index"),
  credits: decimal("credits", { precision: 18, scale: 6 }).default("0"),
  configJson: jsonb("config_json"),
  status: varchar("status").default("pending"),
  registrationFileUrl: varchar("registration_file_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const agentConfigs = pgTable("agent_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  openclawConfig: jsonb("openclaw_config"),
  skillsEnabled: jsonb("skills_enabled"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const payments = pgTable("payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").references(() => agents.id),
  direction: varchar("direction").notNull(),
  amount: decimal("amount", { precision: 18, scale: 6 }).notNull(),
  token: varchar("token").default("USDC"),
  network: varchar("network").default("celo"),
  txHash: varchar("tx_hash"),
  counterpartyAddress: varchar("counterparty_address"),
  counterpartyAgentId: varchar("counterparty_agent_id"),
  status: varchar("status").default("pending"),
  endpoint: varchar("endpoint"),
  nonce: varchar("nonce"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const reputations = pgTable("reputations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  raterAgentId: varchar("rater_agent_id"),
  raterAddress: varchar("rater_address"),
  score: integer("score").notNull(),
  comment: text("comment"),
  txHash: varchar("tx_hash"),
  paymentId: varchar("payment_id").references(() => payments.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const validations = pgTable("validations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  validatorAddress: varchar("validator_address"),
  result: boolean("result"),
  evidenceUri: varchar("evidence_uri"),
  txHash: varchar("tx_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type User = typeof users.$inferSelect;
export type UpsertUser = typeof users.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;
export type Reputation = typeof reputations.$inferSelect;
export type Validation = typeof validations.$inferSelect;

export const agentSecrets = pgTable("agent_secrets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  serviceName: varchar("service_name").notNull(),
  apiKey: text("api_key").notNull(),
  baseUrl: text("base_url"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  uniqueAgentService: sql`UNIQUE(${table.agentId}, ${table.serviceName})`
}));

export type AgentSecret = typeof agentSecrets.$inferSelect;
export type InsertAgentSecret = typeof agentSecrets.$inferInsert;

export const agentSkills = pgTable("agent_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  name: varchar("name").notNull(),
  description: text("description"),
  category: varchar("category").default("general"),
  priceCredits: varchar("price_credits").default("0.01"),
  endpoint: text("endpoint"),
  isActive: boolean("is_active").default(true),
  usageCount: integer("usage_count").default(0),
  totalEarned: varchar("total_earned").default("0"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type AgentSkill = typeof agentSkills.$inferSelect;
export type InsertAgentSkill = typeof agentSkills.$inferInsert;

export const agentGoals = pgTable("agent_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  goal: text("goal").notNull(),
  priority: integer("priority").default(1),
  status: varchar("status").default("active"),
  progress: integer("progress").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type AgentGoal = typeof agentGoals.$inferSelect;
export type InsertAgentGoal = typeof agentGoals.$inferInsert;

export const agentScheduledTasks = pgTable("agent_scheduled_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  name: varchar("name").notNull(),
  description: text("description"),
  cronExpression: varchar("cron_expression").notNull(),
  taskType: varchar("task_type").default("goal_check"),
  taskData: jsonb("task_data"),
  isActive: boolean("is_active").default(true),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  lastResult: jsonb("last_result"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AgentScheduledTask = typeof agentScheduledTasks.$inferSelect;
export type InsertAgentScheduledTask = typeof agentScheduledTasks.$inferInsert;

export const agentMemory = pgTable("agent_memory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  memoryType: varchar("memory_type").default("fact"),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  importance: integer("importance").default(5),
  createdAt: timestamp("created_at").defaultNow(),
  lastAccessedAt: timestamp("last_accessed_at"),
});

export type AgentMemory = typeof agentMemory.$inferSelect;
export type InsertAgentMemory = typeof agentMemory.$inferInsert;

export const agentToolExecutions = pgTable("agent_tool_executions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => agents.id),
  toolName: varchar("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  status: varchar("status").default("pending"),
  creditsCost: decimal("credits_cost", { precision: 18, scale: 6 }).default("0"),
  errorMessage: text("error_message"),
  executionTimeMs: integer("execution_time_ms"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AgentToolExecution = typeof agentToolExecutions.$inferSelect;
export type InsertAgentToolExecution = typeof agentToolExecutions.$inferInsert;

export const activityFeed = pgTable("activity_feed", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  agentId: varchar("agent_id").references(() => agents.id),
  activityType: varchar("activity_type").notNull(),
  title: varchar("title").notNull(),
  description: text("description"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ActivityFeedEntry = typeof activityFeed.$inferSelect;
export type InsertActivityFeedEntry = typeof activityFeed.$inferInsert;

export const verificationSessions = pgTable("verification_sessions", {
  id: varchar("id").primaryKey(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  agentKeyHash: varchar("agent_key_hash", { length: 16 }).notNull(),
  challenge: text("challenge").notNull(),
  challengeExpiry: timestamp("challenge_expiry").notNull(),
  signatureVerified: boolean("signature_verified").default(false),
  status: varchar("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type VerificationSession = typeof verificationSessions.$inferSelect;
export type InsertVerificationSession = typeof verificationSessions.$inferInsert;

export const verifiedBots = pgTable("verified_bots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  publicKey: text("public_key").notNull().unique(),
  deviceId: varchar("device_id"),
  selfId: varchar("self_id"),
  humanId: varchar("human_id"),
  verificationLevel: varchar("verification_level"),
  metadata: jsonb("metadata"),
  verifiedAt: timestamp("verified_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type VerifiedBot = typeof verifiedBots.$inferSelect;
export type InsertVerifiedBot = typeof verifiedBots.$inferInsert;

export * from "./models/chat";
