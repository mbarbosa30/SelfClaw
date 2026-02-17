import { sql } from "drizzle-orm";
import { 
  pgTable, 
  varchar, 
  text, 
  timestamp, 
  jsonb, 
  index, 
  integer,
  serial,
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
  humanId: varchar("human_id").unique(),
  walletAddress: varchar("wallet_address").unique(),
  authMethod: varchar("auth_method").default("passport"),
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

export const verificationSessions = pgTable("verification_sessions", {
  id: varchar("id").primaryKey(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  agentKeyHash: varchar("agent_key_hash", { length: 16 }).notNull(),
  challenge: text("challenge").notNull(),
  challengeExpiry: timestamp("challenge_expiry").notNull(),
  signatureVerified: boolean("signature_verified").default(false),
  status: varchar("status").default("pending"),
  humanId: varchar("human_id"),
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
  hidden: boolean("hidden").default(false),
  apiKey: varchar("api_key").unique(),
  verifiedAt: timestamp("verified_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type VerifiedBot = typeof verifiedBots.$inferSelect;
export type InsertVerifiedBot = typeof verifiedBots.$inferInsert;

export const agentWallets = pgTable("agent_wallets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  publicKey: varchar("public_key").notNull().unique(),
  address: varchar("address").notNull().unique(),
  gasReceived: boolean("gas_received").default(false),
  gasTxHash: varchar("gas_tx_hash"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type AgentWallet = typeof agentWallets.$inferSelect;
export type InsertAgentWallet = typeof agentWallets.$inferInsert;

export const sponsoredAgents = pgTable("sponsored_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentId: varchar("agent_id"),
  publicKey: varchar("public_key"),
  tokenAddress: varchar("token_address"),
  tokenSymbol: varchar("token_symbol"),
  poolAddress: varchar("pool_address"),
  v4PositionTokenId: varchar("v4_position_token_id"),
  poolVersion: varchar("pool_version").default("v3"),
  sponsoredAmountCelo: varchar("sponsored_amount_celo").notNull(),
  sponsorTxHash: varchar("sponsor_tx_hash"),
  status: varchar("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type SponsoredAgent = typeof sponsoredAgents.$inferSelect;
export type InsertSponsoredAgent = typeof sponsoredAgents.$inferInsert;

export const sponsorshipRequests = pgTable("sponsorship_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  publicKey: varchar("public_key"),
  miniclawId: varchar("miniclaw_id"),
  tokenAddress: varchar("token_address").notNull(),
  tokenSymbol: varchar("token_symbol").default("TOKEN"),
  tokenAmount: varchar("token_amount").notNull(),
  selfclawAmount: varchar("selfclaw_amount"),
  v4PoolId: varchar("v4_pool_id"),
  positionTokenId: varchar("position_token_id"),
  txHash: varchar("tx_hash"),
  status: varchar("status").default("pending").notNull(),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),
  source: varchar("source").default("api"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("IDX_sponsorship_requests_human_id").on(table.humanId),
  index("IDX_sponsorship_requests_status").on(table.status),
]);

export type SponsorshipRequest = typeof sponsorshipRequests.$inferSelect;
export type InsertSponsorshipRequest = typeof sponsorshipRequests.$inferInsert;

export const trackedPools = pgTable("tracked_pools", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  poolAddress: varchar("pool_address").notNull().unique(),
  tokenAddress: varchar("token_address").notNull(),
  tokenSymbol: varchar("token_symbol").notNull(),
  tokenName: varchar("token_name"),
  pairedWith: varchar("paired_with").default("CELO"),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: varchar("agent_public_key"),
  feeTier: integer("fee_tier").default(3000),
  v4PositionTokenId: varchar("v4_position_token_id"),
  poolVersion: varchar("pool_version").default("v3"),
  v4PoolId: varchar("v4_pool_id"),
  initialCeloLiquidity: varchar("initial_celo_liquidity"),
  initialTokenLiquidity: varchar("initial_token_liquidity"),
  currentPriceCelo: varchar("current_price_celo"),
  priceChange24h: decimal("price_change_24h", { precision: 10, scale: 4 }),
  volume24h: varchar("volume_24h"),
  totalVolume: varchar("total_volume"),
  marketCapCelo: varchar("market_cap_celo"),
  hiddenFromRegistry: boolean("hidden_from_registry").default(false),
  displayNameOverride: varchar("display_name_override"),
  displaySymbolOverride: varchar("display_symbol_override"),
  adminNotes: text("admin_notes"),
  lastUpdated: timestamp("last_updated").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TrackedPool = typeof trackedPools.$inferSelect;
export type InsertTrackedPool = typeof trackedPools.$inferInsert;

export const agentActivity = pgTable("agent_activity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: varchar("event_type").notNull(),
  humanId: varchar("human_id"),
  agentPublicKey: text("agent_public_key"),
  agentName: varchar("agent_name"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_activity_event_type").on(table.eventType),
  index("IDX_activity_created_at").on(table.createdAt),
]);

export type AgentActivity = typeof agentActivity.$inferSelect;
export type InsertAgentActivity = typeof agentActivity.$inferInsert;

export const bridgeTransactions = pgTable("bridge_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type").notNull(),
  sourceTxHash: varchar("source_tx_hash").notNull(),
  destTxHash: varchar("dest_tx_hash"),
  tokenAddress: varchar("token_address").notNull(),
  amount: varchar("amount").notNull(),
  status: varchar("status").notNull().default("submitted"),
  vaaBytes: text("vaa_bytes"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("IDX_bridge_status").on(table.status),
  index("IDX_bridge_created_at").on(table.createdAt),
]);

export type BridgeTransaction = typeof bridgeTransactions.$inferSelect;
export type InsertBridgeTransaction = typeof bridgeTransactions.$inferInsert;

export const tokenPlans = pgTable("token_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  purpose: text("purpose").notNull(),
  supplyReasoning: text("supply_reasoning").notNull(),
  allocation: jsonb("allocation").notNull(),
  utility: jsonb("utility").notNull(),
  economicModel: text("economic_model").notNull(),
  tokenAddress: varchar("token_address"),
  status: varchar("status").default("draft"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("IDX_token_plan_human_id").on(table.humanId),
]);

export type TokenPlan = typeof tokenPlans.$inferSelect;
export type InsertTokenPlan = typeof tokenPlans.$inferInsert;

export const revenueEvents = pgTable("revenue_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  amount: varchar("amount").notNull(),
  token: varchar("token").notNull(),
  tokenAddress: varchar("token_address"),
  source: varchar("source").notNull(),
  description: text("description"),
  txHash: varchar("tx_hash"),
  chain: varchar("chain").default("celo"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_revenue_human_id").on(table.humanId),
  index("IDX_revenue_created_at").on(table.createdAt),
]);

export type RevenueEvent = typeof revenueEvents.$inferSelect;
export type InsertRevenueEvent = typeof revenueEvents.$inferInsert;

export const agentServices = pgTable("agent_services", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  name: varchar("name").notNull(),
  description: text("description").notNull(),
  price: varchar("price"),
  currency: varchar("currency").default("SELFCLAW"),
  endpoint: varchar("endpoint"),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("IDX_services_human_id").on(table.humanId),
]);

export type AgentService = typeof agentServices.$inferSelect;
export type InsertAgentService = typeof agentServices.$inferInsert;

export const costEvents = pgTable("cost_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key"),
  agentName: varchar("agent_name"),
  costType: varchar("cost_type").notNull(),
  amount: varchar("amount").notNull(),
  currency: varchar("currency").default("USD"),
  description: text("description"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_cost_human_id").on(table.humanId),
  index("IDX_cost_type").on(table.costType),
  index("IDX_cost_created_at").on(table.createdAt),
]);

export type CostEvent = typeof costEvents.$inferSelect;
export type InsertCostEvent = typeof costEvents.$inferInsert;

export const sandboxTestRuns = pgTable("sandbox_test_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentName: varchar("agent_name").notNull(),
  agentPublicKey: text("agent_public_key"),
  tokenName: varchar("token_name"),
  tokenSymbol: varchar("token_symbol"),
  tokenSupply: varchar("token_supply"),
  tokenAddress: varchar("token_address"),
  walletAddress: varchar("wallet_address"),
  v4PoolId: varchar("v4_pool_id"),
  positionTokenId: varchar("position_token_id"),
  selfclawAmount: varchar("selfclaw_amount"),
  status: varchar("status").default("started"),
  steps: jsonb("steps"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type SandboxTestRun = typeof sandboxTestRuns.$inferSelect;
export type InsertSandboxTestRun = typeof sandboxTestRuns.$inferInsert;

export const tokenPriceSnapshots = pgTable("token_price_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tokenAddress: varchar("token_address").notNull(),
  tokenSymbol: varchar("token_symbol").notNull(),
  poolId: varchar("pool_id").notNull(),
  priceUsd: decimal("price_usd", { precision: 24, scale: 12 }),
  priceCelo: decimal("price_celo", { precision: 24, scale: 12 }),
  priceSelfclaw: decimal("price_selfclaw", { precision: 24, scale: 12 }),
  marketCapUsd: decimal("market_cap_usd", { precision: 24, scale: 2 }),
  totalSupply: varchar("total_supply"),
  liquidity: varchar("liquidity"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_price_snapshots_token").on(table.tokenAddress),
  index("idx_price_snapshots_created").on(table.createdAt),
]);

export type TokenPriceSnapshot = typeof tokenPriceSnapshots.$inferSelect;
export type InsertTokenPriceSnapshot = typeof tokenPriceSnapshots.$inferInsert;

export const hostedAgents = pgTable("hosted_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id"),
  walletAddress: varchar("wallet_address"),
  publicKey: text("public_key").notNull().unique(),
  name: varchar("name").notNull(),
  emoji: varchar("emoji").default("🤖"),
  description: text("description"),
  status: varchar("status").default("active"),
  enabledSkills: jsonb("enabled_skills").default([]),
  skillConfigs: jsonb("skill_configs").default({}),
  interests: jsonb("interests").default([]),
  topicsToWatch: jsonb("topics_to_watch").default([]),
  socialHandles: jsonb("social_handles").default({}),
  personalContext: text("personal_context"),
  soulDocument: text("soul_document"),
  soulUpdatedAt: timestamp("soul_updated_at"),
  autoApproveThreshold: decimal("auto_approve_threshold", { precision: 18, scale: 6 }).default("0"),
  llmTokensUsedToday: integer("llm_tokens_used_today").default(0),
  llmTokensLimit: integer("llm_tokens_limit").default(50000),
  apiCallsToday: integer("api_calls_today").default(0),
  apiCallsLimit: integer("api_calls_limit").default(100),
  installedMarketSkills: jsonb("installed_market_skills").default([]),
  metadata: jsonb("metadata").default({}),
  lastActiveAt: timestamp("last_active_at"),
  lastResetAt: timestamp("last_reset_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_hosted_agents_human_id").on(table.humanId),
  index("idx_hosted_agents_status").on(table.status),
]);

export type HostedAgent = typeof hostedAgents.$inferSelect;
export type InsertHostedAgent = typeof hostedAgents.$inferInsert;

export const agentTaskQueue = pgTable("agent_task_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hostedAgentId: varchar("hosted_agent_id").notNull(),
  skillId: varchar("skill_id").notNull(),
  taskType: varchar("task_type").notNull(),
  status: varchar("status").default("pending"),
  priority: integer("priority").default(0),
  payload: jsonb("payload"),
  result: jsonb("result"),
  error: text("error"),
  requiresApproval: boolean("requires_approval").default(false),
  approvedAt: timestamp("approved_at"),
  approvedBy: varchar("approved_by"),
  scheduledFor: timestamp("scheduled_for").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_task_queue_agent").on(table.hostedAgentId),
  index("idx_task_queue_status").on(table.status),
  index("idx_task_queue_scheduled").on(table.scheduledFor),
]);

export type AgentTask = typeof agentTaskQueue.$inferSelect;
export type InsertAgentTask = typeof agentTaskQueue.$inferInsert;

export const marketplaceSkills = pgTable("marketplace_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  creatorHumanId: varchar("creator_human_id").notNull(),
  creatorAgentId: varchar("creator_agent_id"),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull().unique(),
  description: text("description").notNull(),
  longDescription: text("long_description"),
  icon: varchar("icon").default("🔧"),
  category: varchar("category").notNull().default("utility"),
  tags: jsonb("tags").default([]),
  priceSelfclaw: decimal("price_selfclaw", { precision: 18, scale: 6 }).default("0"),
  isFree: boolean("is_free").default(true),
  scheduleInterval: integer("schedule_interval").default(3600000),
  handlerPrompt: text("handler_prompt").notNull(),
  inputSchema: jsonb("input_schema").default({}),
  outputFormat: varchar("output_format").default("text"),
  installCount: integer("install_count").default(0),
  rating: decimal("rating", { precision: 3, scale: 2 }).default("0"),
  ratingCount: integer("rating_count").default(0),
  status: varchar("status").default("active"),
  version: varchar("version").default("1.0.0"),
  revenueEarned: decimal("revenue_earned", { precision: 18, scale: 6 }).default("0"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_market_skills_creator").on(table.creatorHumanId),
  index("idx_market_skills_category").on(table.category),
  index("idx_market_skills_slug").on(table.slug),
  index("idx_market_skills_status").on(table.status),
]);

export type MarketplaceSkill = typeof marketplaceSkills.$inferSelect;
export type InsertMarketplaceSkill = typeof marketplaceSkills.$inferInsert;

export const skillInstalls = pgTable("skill_installs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  marketSkillId: varchar("market_skill_id").notNull(),
  installerHumanId: varchar("installer_human_id").notNull(),
  hostedAgentId: varchar("hosted_agent_id").notNull(),
  pricePaid: decimal("price_paid", { precision: 18, scale: 6 }).default("0"),
  rating: integer("rating"),
  review: text("review"),
  installedAt: timestamp("installed_at").defaultNow(),
}, (table) => [
  index("idx_skill_installs_skill").on(table.marketSkillId),
  index("idx_skill_installs_agent").on(table.hostedAgentId),
]);

export type SkillInstall = typeof skillInstalls.$inferSelect;
export type InsertSkillInstall = typeof skillInstalls.$inferInsert;

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title"),
  agentId: varchar("agent_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_conversations_agent_id").on(table.agentId),
]);

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_messages_conversation_id").on(table.conversationId),
]);

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

export const agentMemories = pgTable("agent_memories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  category: varchar("category").notNull(),
  fact: text("fact").notNull(),
  confidence: decimal("confidence", { precision: 3, scale: 2 }).default("0.8"),
  sourceConversationId: integer("source_conversation_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_agent_memories_agent_id").on(table.agentId),
  index("idx_agent_memories_category").on(table.category),
]);

export type AgentMemory = typeof agentMemories.$inferSelect;
export type InsertAgentMemory = typeof agentMemories.$inferInsert;

export const conversationSummaries = pgTable("conversation_summaries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: integer("conversation_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  summary: text("summary").notNull(),
  messageStartId: integer("message_start_id"),
  messageEndId: integer("message_end_id"),
  messageCount: integer("message_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_conv_summaries_agent_id").on(table.agentId),
  index("idx_conv_summaries_conv_id").on(table.conversationId),
]);

export type ConversationSummary = typeof conversationSummaries.$inferSelect;
export type InsertConversationSummary = typeof conversationSummaries.$inferInsert;

export type User = typeof users.$inferSelect;
export type UpsertUser = typeof users.$inferInsert;

export const marketSkills = pgTable("market_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  name: varchar("name").notNull(),
  description: text("description").notNull(),
  category: varchar("category").notNull(),
  price: varchar("price"),
  priceToken: varchar("price_token").default("CELO"),
  isFree: boolean("is_free").default(false),
  endpoint: varchar("endpoint"),
  sampleOutput: text("sample_output"),
  ratingSum: integer("rating_sum").default(0),
  ratingCount: integer("rating_count").default(0),
  purchaseCount: integer("purchase_count").default(0),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("IDX_skills_human_id").on(table.humanId),
  index("IDX_skills_category").on(table.category),
  index("IDX_skills_agent_pk").on(table.agentPublicKey),
]);

export type MarketSkill = typeof marketSkills.$inferSelect;
export type InsertMarketSkill = typeof marketSkills.$inferInsert;

export const skillPurchases = pgTable("skill_purchases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  skillId: varchar("skill_id").notNull(),
  buyerHumanId: varchar("buyer_human_id").notNull(),
  buyerPublicKey: text("buyer_public_key").notNull(),
  sellerHumanId: varchar("seller_human_id").notNull(),
  sellerPublicKey: text("seller_public_key").notNull(),
  price: varchar("price"),
  priceToken: varchar("price_token"),
  txHash: varchar("tx_hash"),
  status: varchar("status").default("pending"),
  rating: integer("rating"),
  review: text("review"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_purchases_skill_id").on(table.skillId),
  index("IDX_purchases_buyer").on(table.buyerPublicKey),
  index("IDX_purchases_seller").on(table.sellerPublicKey),
]);

export type SkillPurchase = typeof skillPurchases.$inferSelect;
export type InsertSkillPurchase = typeof skillPurchases.$inferInsert;

export const agentRequests = pgTable("agent_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requesterHumanId: varchar("requester_human_id").notNull(),
  requesterPublicKey: text("requester_public_key").notNull(),
  requesterName: varchar("requester_name"),
  providerHumanId: varchar("provider_human_id").notNull(),
  providerPublicKey: text("provider_public_key").notNull(),
  providerName: varchar("provider_name"),
  skillId: varchar("skill_id"),
  description: text("description").notNull(),
  paymentAmount: varchar("payment_amount"),
  paymentToken: varchar("payment_token"),
  txHash: varchar("tx_hash"),
  status: varchar("status").default("pending"),
  result: text("result"),
  rating: integer("rating"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_requests_requester").on(table.requesterPublicKey),
  index("IDX_requests_provider").on(table.providerPublicKey),
  index("IDX_requests_status").on(table.status),
]);

export type AgentRequest = typeof agentRequests.$inferSelect;
export type InsertAgentRequest = typeof agentRequests.$inferInsert;

export const reputationStakes = pgTable("reputation_stakes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  agentName: varchar("agent_name"),
  outputHash: varchar("output_hash").notNull(),
  outputType: varchar("output_type").notNull(),
  description: text("description"),
  stakeAmount: varchar("stake_amount").notNull(),
  stakeToken: varchar("stake_token").notNull(),
  status: varchar("status").default("active"),
  resolution: varchar("resolution"),
  slashedAmount: varchar("slashed_amount"),
  rewardAmount: varchar("reward_amount"),
  reviewCount: integer("review_count").default(0),
  avgScore: decimal("avg_score", { precision: 3, scale: 2 }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_stakes_agent_pk").on(table.agentPublicKey),
  index("IDX_stakes_status").on(table.status),
]);

export type ReputationStake = typeof reputationStakes.$inferSelect;
export type InsertReputationStake = typeof reputationStakes.$inferInsert;

export const stakeReviews = pgTable("stake_reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stakeId: varchar("stake_id").notNull(),
  reviewerHumanId: varchar("reviewer_human_id").notNull(),
  reviewerPublicKey: text("reviewer_public_key").notNull(),
  score: integer("score").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_reviews_stake_id").on(table.stakeId),
  index("IDX_reviews_reviewer").on(table.reviewerPublicKey),
]);

export type StakeReview = typeof stakeReviews.$inferSelect;
export type InsertStakeReview = typeof stakeReviews.$inferInsert;

export const reputationEvents = pgTable("reputation_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentPublicKey: varchar("agent_public_key").notNull(),
  humanId: varchar("human_id").notNull(),
  erc8004TokenId: varchar("erc8004_token_id"),
  eventType: varchar("event_type").notNull(),
  eventData: jsonb("event_data").default({}),
  reputationScoreAfter: integer("reputation_score_after"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_rep_events_agent_pk").on(table.agentPublicKey),
  index("IDX_rep_events_type").on(table.eventType),
]);

export type ReputationEvent = typeof reputationEvents.$inferSelect;
export type InsertReputationEvent = typeof reputationEvents.$inferInsert;

export const reputationBadges = pgTable("reputation_badges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  badgeType: varchar("badge_type").notNull(),
  badgeName: varchar("badge_name").notNull(),
  description: text("description"),
  earnedAt: timestamp("earned_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => [
  index("IDX_badges_agent_pk").on(table.agentPublicKey),
]);

export const agentPosts = pgTable("agent_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentPublicKey: text("agent_public_key").notNull(),
  humanId: varchar("human_id").notNull(),
  agentName: varchar("agent_name"),
  category: varchar("category").notNull().default("update"),
  title: varchar("title"),
  content: text("content").notNull(),
  likesCount: integer("likes_count").default(0),
  commentsCount: integer("comments_count").default(0),
  pinned: boolean("pinned").default(false),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_posts_agent_pk").on(table.agentPublicKey),
  index("IDX_posts_category").on(table.category),
  index("IDX_posts_created").on(table.createdAt),
]);

export type AgentPost = typeof agentPosts.$inferSelect;
export type InsertAgentPost = typeof agentPosts.$inferInsert;

export const postComments = pgTable("post_comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: varchar("post_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  humanId: varchar("human_id").notNull(),
  agentName: varchar("agent_name"),
  content: text("content").notNull(),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_comments_post").on(table.postId),
]);

export type PostComment = typeof postComments.$inferSelect;
export type InsertPostComment = typeof postComments.$inferInsert;

export const postLikes = pgTable("post_likes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: varchar("post_id").notNull(),
  agentPublicKey: text("agent_public_key").notNull(),
  humanId: varchar("human_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_likes_post").on(table.postId),
  index("IDX_likes_agent_post").on(table.agentPublicKey, table.postId),
]);

export type PostLike = typeof postLikes.$inferSelect;
export type InsertPostLike = typeof postLikes.$inferInsert;

export const feedDigestLog = pgTable("feed_digest_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentPublicKey: varchar("agent_public_key").notNull(),
  ranAt: timestamp("ran_at").defaultNow(),
  postsSeen: integer("posts_seen").default(0),
  actionsTaken: integer("actions_taken").default(0),
  actionsJson: jsonb("actions_json").default(sql`'[]'::jsonb`),
}, (table) => [
  index("idx_digest_log_ran").on(table.ranAt),
]);

export type FeedDigestLog = typeof feedDigestLog.$inferSelect;
export type InsertFeedDigestLog = typeof feedDigestLog.$inferInsert;

export const activityFeed = pgTable("activity_feed", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  agentId: varchar("agent_id"),
  activityType: varchar("activity_type").notNull(),
  title: varchar("title").notNull(),
  description: text("description"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agentConfigs = pgTable("agent_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  openclawConfig: jsonb("openclaw_config"),
  skillsEnabled: jsonb("skills_enabled"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const agentGoals = pgTable("agent_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  goal: text("goal").notNull(),
  priority: integer("priority").default(1),
  status: varchar("status").default("active"),
  progress: integer("progress").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const agentMemory = pgTable("agent_memory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  memoryType: varchar("memory_type").default("fact"),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  importance: integer("importance").default(5),
  createdAt: timestamp("created_at").defaultNow(),
  lastAccessedAt: timestamp("last_accessed_at"),
});

export const agentScheduledTasks = pgTable("agent_scheduled_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
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

export const agentSecrets = pgTable("agent_secrets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  serviceName: varchar("service_name").notNull(),
  apiKey: text("api_key").notNull(),
  baseUrl: text("base_url"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const agentSkills = pgTable("agent_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
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

export const agentTokens = pgTable("agent_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  contractAddress: varchar("contract_address").notNull().unique(),
  name: varchar("name").notNull(),
  symbol: varchar("symbol").notNull(),
  decimals: integer("decimals").default(18),
  initialSupply: varchar("initial_supply").notNull(),
  deployTxHash: varchar("deploy_tx_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agentToolExecutions = pgTable("agent_tool_executions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  toolName: varchar("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  status: varchar("status").default("pending"),
  creditsCost: decimal("credits_cost", { precision: 18, scale: 6 }).default("0"),
  errorMessage: text("error_message"),
  executionTimeMs: integer("execution_time_ms"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: varchar("name").notNull(),
  description: text("description"),
  registryTokenId: varchar("registry_token_id"),
  ownerAddress: varchar("owner_address"),
  tbaAddress: varchar("tba_address"),
  configJson: jsonb("config_json"),
  status: varchar("status").default("pending"),
  registrationFileUrl: varchar("registration_file_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  walletIndex: integer("wallet_index"),
  credits: decimal("credits", { precision: 18, scale: 6 }).default("0"),
  erc8004TokenId: varchar("erc8004_token_id"),
  erc8004RegistrationJson: jsonb("erc8004_registration_json"),
  erc8004Minted: boolean("erc8004_minted").default(false),
});

export const liquidityPositions = pgTable("liquidity_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  positionId: varchar("position_id").notNull(),
  token0Address: varchar("token0_address").notNull(),
  token1Address: varchar("token1_address").notNull(),
  token0Symbol: varchar("token0_symbol").notNull(),
  token1Symbol: varchar("token1_symbol").notNull(),
  feeTier: integer("fee_tier").notNull(),
  tickLower: integer("tick_lower").notNull(),
  tickUpper: integer("tick_upper").notNull(),
  liquidity: varchar("liquidity").notNull(),
  token0Amount: varchar("token0_amount"),
  token1Amount: varchar("token1_amount"),
  mintTxHash: varchar("mint_tx_hash"),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const payments = pgTable("payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id"),
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
  agentId: varchar("agent_id").notNull(),
  raterAgentId: varchar("rater_agent_id"),
  raterAddress: varchar("rater_address"),
  score: integer("score").notNull(),
  comment: text("comment"),
  txHash: varchar("tx_hash"),
  paymentId: varchar("payment_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const validations = pgTable("validations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  validatorAddress: varchar("validator_address"),
  result: boolean("result"),
  evidenceUri: varchar("evidence_uri"),
  txHash: varchar("tx_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const platformUpdates = pgTable("platform_updates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title").notNull(),
  content: text("content").notNull(),
  type: varchar("type").notNull().default("feature"),
  severity: varchar("severity").default("info"),
  actionRequired: boolean("action_required").default(false),
  actionLabel: varchar("action_label"),
  actionEndpoint: varchar("action_endpoint"),
  targetAudience: varchar("target_audience").default("all"),
  version: varchar("version"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_platform_updates_type").on(table.type),
  index("idx_platform_updates_created").on(table.createdAt),
]);

export type PlatformUpdate = typeof platformUpdates.$inferSelect;
export type InsertPlatformUpdate = typeof platformUpdates.$inferInsert;

export const updateReads = pgTable("update_reads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  updateId: varchar("update_id").notNull(),
  readerId: varchar("reader_id").notNull(),
  readerType: varchar("reader_type").notNull().default("human"),
  readAt: timestamp("read_at").defaultNow(),
}, (table) => [
  index("idx_update_reads_reader").on(table.readerId),
  index("idx_update_reads_update").on(table.updateId),
]);
