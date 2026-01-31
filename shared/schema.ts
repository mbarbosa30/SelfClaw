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
