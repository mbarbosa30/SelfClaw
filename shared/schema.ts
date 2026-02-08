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
  humanId: varchar("human_id").unique(),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
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

export const agentWallets = pgTable("agent_wallets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  humanId: varchar("human_id").notNull().unique(),
  publicKey: varchar("public_key").notNull(),
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
  humanId: varchar("human_id").notNull().unique(),
  publicKey: varchar("public_key"),
  tokenAddress: varchar("token_address"),
  tokenSymbol: varchar("token_symbol"),
  poolAddress: varchar("pool_address"),
  sponsoredAmountCelo: varchar("sponsored_amount_celo").notNull(),
  sponsorTxHash: varchar("sponsor_tx_hash"),
  status: varchar("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type SponsoredAgent = typeof sponsoredAgents.$inferSelect;
export type InsertSponsoredAgent = typeof sponsoredAgents.$inferInsert;

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
  initialCeloLiquidity: varchar("initial_celo_liquidity"),
  initialTokenLiquidity: varchar("initial_token_liquidity"),
  currentPriceCelo: varchar("current_price_celo"),
  priceChange24h: decimal("price_change_24h", { precision: 10, scale: 4 }),
  volume24h: varchar("volume_24h"),
  totalVolume: varchar("total_volume"),
  marketCapCelo: varchar("market_cap_celo"),
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

export type User = typeof users.$inferSelect;
export type UpsertUser = typeof users.$inferInsert;
