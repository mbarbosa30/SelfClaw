// Self.xyz Passport Authentication
// Replaces Replit Auth with Self.xyz passport verification for login

import { Router, Request, Response, Express, RequestHandler } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from "@selfxyz/core";
import { SelfAppBuilder } from "@selfxyz/qrcode";
import crypto from "crypto";
import { verifyMessage } from "viem";
import { db } from "./db.js";
import { users, type UpsertUser } from "../shared/schema.js";
import { eq, sql } from "drizzle-orm";

const router = Router();

// Self.xyz Configuration for Authentication
const SELF_AUTH_SCOPE = "selfclaw-verify";
const SELF_STAGING = process.env.SELFCLAW_STAGING === "true";
function getCanonicalDomain(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (!domains) return "localhost:5000";
  const parts = domains.split(",").map(d => d.trim()).filter(Boolean);
  const custom = parts.find(d => d.endsWith(".ai") || d.endsWith(".com") || d.endsWith(".app"));
  return custom || parts[parts.length - 1] || domains;
}
const SELF_ENDPOINT = process.env.SELFCLAW_AUTH_CALLBACK_URL
  || `https://${getCanonicalDomain()}/api/auth/self/callback`;

console.log(`[self-auth] Callback endpoint: ${SELF_ENDPOINT}`);
console.log(`[self-auth] Staging mode: ${SELF_STAGING}`);

// Self.xyz Backend Verifier for Auth
const selfAuthVerifier = new SelfBackendVerifier(
  SELF_AUTH_SCOPE,
  SELF_ENDPOINT,
  SELF_STAGING,
  AllIds,
  new DefaultConfigStore({
    minimumAge: 18,
    excludedCountries: [],
    ofac: false,
  }),
  "uuid"
);

// Session configuration
export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: sessionTtl,
    },
  });
}

// Store pending auth sessions
interface AuthSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  humanId?: string;
  verified: boolean;
}

const pendingAuthSessions = new Map<string, AuthSession>();

// Cleanup expired sessions
setInterval(() => {
  const now = new Date();
  for (const [id, session] of pendingAuthSessions.entries()) {
    if (session.expiresAt < now) {
      pendingAuthSessions.delete(id);
    }
  }
}, 60 * 1000);

// Store pending wallet challenges for MiniPay auth
interface WalletChallenge {
  challenge: string;
  createdAt: Date;
  expiresAt: Date;
}

const pendingWalletChallenges = new Map<string, WalletChallenge>();

setInterval(() => {
  const now = new Date();
  for (const [nonce, challenge] of pendingWalletChallenges.entries()) {
    if (challenge.expiresAt < now) {
      pendingWalletChallenges.delete(nonce);
    }
  }
}, 60 * 1000);

// Generate humanId from nullifier — stable per passport + scope
function generateHumanId(nullifier: string): string {
  return crypto.createHash("sha256")
    .update(nullifier)
    .digest("hex")
    .substring(0, 16);
}

// Start login flow - returns QR code data
router.post("/start", (req: any, res: Response) => {
  try {
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store pending auth session
    pendingAuthSessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date(),
      expiresAt,
      verified: false,
    });

    // Bind session ID to browser session for CSRF protection
    req.session.pendingAuthSessionId = sessionId;

    // Build Self app config for login
    const selfApp = new SelfAppBuilder({
      version: 2,
      appName: "SelfClaw Login",
      logoBase64: "https://selfclaw.ai/favicon.png",
      scope: SELF_AUTH_SCOPE,
      endpoint: SELF_ENDPOINT,
      endpointType: SELF_STAGING ? "staging_https" : "https",
      userId: sessionId,
      userIdType: "uuid",
      userDefinedData: sessionId.padEnd(128, '0'), // Pad for Self.xyz requirements
      disclosures: {
        minimumAge: 18,
        excludedCountries: [],
        ofac: false,
      },
    }).build();

    res.json({
      success: true,
      sessionId,
      selfApp,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error: any) {
    console.error("[self-auth] Start login error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Check login status (polling endpoint)
router.get("/status/:sessionId", (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const authSession = pendingAuthSessions.get(sessionId);

  if (!authSession) {
    return res.json({ status: "not_found" });
  }

  if (authSession.expiresAt < new Date()) {
    pendingAuthSessions.delete(sessionId as string);
    return res.json({ status: "expired" });
  }

  if (authSession.verified && authSession.humanId) {
    return res.json({
      status: "verified",
      humanId: authSession.humanId,
    });
  }

  res.json({ status: "pending" });
});

// Complete login - called after polling shows verified
router.post("/complete", async (req: any, res: Response) => {
  try {
    const { sessionId } = req.body;

    // CSRF protection: require sessionId to be present AND match browser session
    if (!req.session.pendingAuthSessionId) {
      console.log("[self-auth] CSRF check failed - no pending session in browser");
      return res.status(403).json({ error: "No pending login session - please start login again" });
    }
    if (req.session.pendingAuthSessionId !== sessionId) {
      console.log("[self-auth] CSRF check failed - session mismatch");
      return res.status(403).json({ error: "Session mismatch - possible replay attack" });
    }

    const authSession = pendingAuthSessions.get(sessionId);

    if (!authSession || !authSession.verified || !authSession.humanId) {
      return res.status(400).json({ error: "Invalid or unverified session" });
    }

    // Find or create user by humanId
    let [user] = await db.select().from(users).where(eq(users.humanId, authSession.humanId)).limit(1);

    if (!user) {
      // Create new user with humanId
      const newUser: UpsertUser = {
        humanId: authSession.humanId,
        profileComplete: false,
      };
      [user] = await db.insert(users).values(newUser).returning();
      console.log("[self-auth] Created new user:", user.id, "humanId:", authSession.humanId);
    } else {
      console.log("[self-auth] Found existing user:", user.id, "humanId:", authSession.humanId);
    }

    // Clean up pending auth session from server memory
    pendingAuthSessions.delete(sessionId);

    // Regenerate session to prevent session fixation
    const humanId = authSession.humanId;
    const userObj = user;
    req.session.regenerate((err: any) => {
      if (err) {
        console.error("[self-auth] Session regeneration failed:", err);
        return res.status(500).json({ error: "Session error" });
      }

      // Set session with authenticated user
      req.session.userId = userObj.id;
      req.session.humanId = humanId;
      req.session.isAuthenticated = true;

      res.json({
        success: true,
        user: {
          id: userObj.id,
          humanId: userObj.humanId,
          firstName: userObj.firstName,
          lastName: userObj.lastName,
          profileComplete: userObj.profileComplete,
        },
      });
    });
  } catch (error: any) {
    console.error("[self-auth] Complete login error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Self.xyz callback - receives proof after QR scan
async function handleAuthCallback(req: Request, res: Response) {
  console.log("[self-auth] === AUTH CALLBACK RECEIVED ===");
  console.log("[self-auth] Body keys:", Object.keys(req.body || {}));

  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body;

    if (!proof || !publicSignals || !attestationId || !userContextData) {
      console.log("[self-auth] Missing fields");
      return res.status(200).json({ status: "error", result: false, reason: "Missing required data" });
    }

    // Verify the proof
    let result;
    try {
      result = await selfAuthVerifier.verify(attestationId, proof, publicSignals, userContextData);
      console.log("[self-auth] Verification result:", JSON.stringify(result.isValidDetails));
    } catch (verifyError: any) {
      console.error("[self-auth] Verify error:", verifyError.message);
      return res.status(200).json({ status: "error", result: false, reason: "Verification failed" });
    }

    if (!result.isValidDetails.isValid) {
      console.log("[self-auth] Proof invalid");
      return res.status(200).json({ status: "error", result: false, reason: "Invalid proof" });
    }

    // Get session ID from userData
    const sessionId = result.userData?.userIdentifier;
    if (!sessionId) {
      console.log("[self-auth] No session ID in proof");
      return res.status(200).json({ status: "error", result: false, reason: "Missing session ID" });
    }

    // Find pending auth session
    const authSession = pendingAuthSessions.get(sessionId);
    if (!authSession) {
      console.log("[self-auth] Auth session not found:", sessionId);
      return res.status(200).json({ status: "error", result: false, reason: "Session not found" });
    }

    if (authSession.expiresAt < new Date()) {
      pendingAuthSessions.delete(sessionId);
      return res.status(200).json({ status: "error", result: false, reason: "Session expired" });
    }

    // Generate humanId from nullifier (stable per passport + scope)
    const nullifier = result.discloseOutput?.nullifier;
    if (!nullifier) {
      console.error("[self-auth] No nullifier in discloseOutput");
      return res.status(200).json({ status: "error", result: false, reason: "Missing nullifier" });
    }
    console.log("[self-auth] Nullifier:", nullifier.substring(0, 16) + "...");
    const humanId = generateHumanId(nullifier);

    // Update auth session
    authSession.verified = true;
    authSession.humanId = humanId;
    pendingAuthSessions.set(sessionId, authSession);

    console.log("[self-auth] === AUTH SUCCESS === humanId:", humanId);
    res.status(200).json({ status: "success", result: true });
  } catch (error: any) {
    console.error("[self-auth] Callback error:", error);
    res.status(200).json({ status: "error", result: false, reason: error.message });
  }
}

router.post("/callback", handleAuthCallback);
router.post("/callback/", handleAuthCallback);

// GET for testing callback endpoint
router.get("/callback", (req: Request, res: Response) => {
  res.json({ status: "ok", message: "Self auth callback. Use POST with proof." });
});

// === MiniPay Wallet Authentication ===

// Generate a nonce challenge for wallet signature
router.post("/wallet/challenge", (req: any, res: Response) => {
  try {
    const nonce = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const challenge = `Sign in to SelfClaw\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

    pendingWalletChallenges.set(nonce, {
      challenge,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    res.json({ challenge, nonce });
  } catch (error: any) {
    console.error("[self-auth] Wallet challenge error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Verify signed message and create session
router.post("/wallet/verify", async (req: any, res: Response) => {
  try {
    const { address, signature, nonce } = req.body;

    if (!address || !signature || !nonce) {
      return res.status(400).json({ error: "Missing address, signature, or nonce" });
    }

    const walletChallenge = pendingWalletChallenges.get(nonce);
    if (!walletChallenge) {
      return res.status(400).json({ error: "Invalid or expired nonce" });
    }

    if (walletChallenge.expiresAt < new Date()) {
      pendingWalletChallenges.delete(nonce);
      return res.status(400).json({ error: "Challenge expired" });
    }

    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message: walletChallenge.challenge,
      signature: signature as `0x${string}`,
    });

    if (!valid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    pendingWalletChallenges.delete(nonce);

    const normalizedAddress = address.toLowerCase();

    let [user] = await db.select().from(users).where(eq(users.walletAddress, normalizedAddress)).limit(1);

    if (!user) {
      const newUser: UpsertUser = {
        walletAddress: normalizedAddress,
        humanId: normalizedAddress,
        authMethod: "minipay",
        profileComplete: false,
      };
      [user] = await db.insert(users).values(newUser).returning();
      console.log("[self-auth] Created new wallet user:", user.id, "address:", normalizedAddress);
    } else {
      console.log("[self-auth] Found existing wallet user:", user.id, "address:", normalizedAddress);
    }

    req.session.regenerate((err: any) => {
      if (err) {
        console.error("[self-auth] Session regeneration failed:", err);
        return res.status(500).json({ error: "Session error" });
      }

      req.session.userId = user.id;
      req.session.humanId = normalizedAddress;
      req.session.isAuthenticated = true;
      req.session.walletAddress = normalizedAddress;

      res.json({
        success: true,
        user: {
          id: user.id,
          humanId: user.humanId,
          walletAddress: user.walletAddress,
          authMethod: user.authMethod,
          firstName: user.firstName,
          lastName: user.lastName,
          profileComplete: user.profileComplete,
        },
      });
    });
  } catch (error: any) {
    console.error("[self-auth] Wallet verify error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === MiniPay Direct Connect (no signing — MiniPay doesn't support personal_sign) ===
// Security model: MiniPay runs dApps in a trusted WebView where eth_requestAccounts
// is the standard auth method. We add a server-side challenge token to ensure the
// request originates from our frontend (not a raw API call), plus strict rate limiting.
const minipayRateLimit = new Map<string, { count: number; resetAt: number }>();
const minipayTokens = new Map<string, { createdAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of minipayRateLimit.entries()) {
    if (entry.resetAt < now) {
      minipayRateLimit.delete(ip);
    }
  }
  for (const [token, data] of minipayTokens.entries()) {
    if (now - data.createdAt > 60 * 1000) {
      minipayTokens.delete(token);
    }
  }
}, 60 * 1000);

router.post("/wallet/minipay-token", (_req: any, res: Response) => {
  const token = crypto.randomUUID();
  minipayTokens.set(token, { createdAt: Date.now() });
  res.json({ token });
});

router.post("/wallet/minipay-connect", async (req: any, res: Response) => {
  try {
    const { address, token } = req.body;

    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "Missing address" });
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Missing auth token" });
    }

    const tokenData = minipayTokens.get(token);
    if (!tokenData) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    minipayTokens.delete(token);

    if (Date.now() - tokenData.createdAt > 60 * 1000) {
      return res.status(400).json({ error: "Token expired" });
    }

    const now = Date.now();
    const clientIp = (req.ip || req.headers['x-forwarded-for'] || 'unknown') as string;
    const rateEntry = minipayRateLimit.get(clientIp);
    if (rateEntry) {
      if (rateEntry.resetAt < now) {
        minipayRateLimit.set(clientIp, { count: 1, resetAt: now + 60 * 1000 });
      } else if (rateEntry.count >= 10) {
        return res.status(429).json({ error: "Too many attempts. Try again later." });
      } else {
        rateEntry.count++;
      }
    } else {
      minipayRateLimit.set(clientIp, { count: 1, resetAt: now + 60 * 1000 });
    }

    const normalizedAddress = address.toLowerCase();

    let [user] = await db.select().from(users).where(eq(users.walletAddress, normalizedAddress)).limit(1);

    if (!user) {
      const newUser: UpsertUser = {
        walletAddress: normalizedAddress,
        humanId: normalizedAddress,
        authMethod: "minipay",
        profileComplete: false,
      };
      [user] = await db.insert(users).values(newUser).returning();
      console.log("[self-auth] Created new MiniPay user:", user.id, "address:", normalizedAddress);
    } else {
      if (user.authMethod !== "minipay") {
        await db.update(users).set({ authMethod: "minipay" }).where(eq(users.id, user.id));
      }
      console.log("[self-auth] Found existing MiniPay user:", user.id, "address:", normalizedAddress);
    }

    req.session.regenerate((err: any) => {
      if (err) {
        console.error("[self-auth] Session regeneration failed:", err);
        return res.status(500).json({ error: "Session error" });
      }

      req.session.userId = user.id;
      req.session.humanId = normalizedAddress;
      req.session.isAuthenticated = true;
      req.session.walletAddress = normalizedAddress;

      res.json({
        success: true,
        user: {
          id: user.id,
          humanId: user.humanId,
          walletAddress: user.walletAddress,
          authMethod: user.authMethod || "minipay",
          firstName: user.firstName,
          lastName: user.lastName,
          profileComplete: user.profileComplete,
        },
      });
    });
  } catch (error: any) {
    console.error("[self-auth] MiniPay connect error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Logout
router.post("/logout", (req: any, res: Response) => {
  req.session.destroy((err: any) => {
    if (err) {
      return res.status(500).json({ error: "Failed to logout" });
    }
    res.json({ success: true });
  });
});

// Get current user
router.get("/me", async (req: any, res: Response) => {
  if (!req.session?.isAuthenticated || !req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId)).limit(1);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      id: user.id,
      humanId: user.humanId,
      walletAddress: user.walletAddress,
      authMethod: user.authMethod,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
      profileComplete: user.profileComplete,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Setup Self.xyz auth on Express app
export async function setupSelfAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());

  // Mount auth routes
  app.use("/api/auth/self", router);

  console.log("[self-auth] Self.xyz authentication routes registered");
}

// Middleware to check if user is authenticated
export const isAuthenticated: RequestHandler = (req: any, res, next) => {
  // Support both Self.xyz auth (session-based) and legacy Replit auth
  if (req.session?.isAuthenticated && req.session?.userId) {
    // Self.xyz auth - populate req.user for compatibility
    req.user = {
      claims: {
        sub: req.session.userId,
      },
      humanId: req.session.humanId,
    };
    return next();
  }

  // Check for legacy Replit auth
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims?.sub) {
    return next();
  }

  res.status(401).json({ message: "Unauthorized" });
};

// Register additional auth routes for compatibility
export function registerAuthRoutes(app: Express) {
  // Compatibility endpoint for frontend
  app.get("/api/auth/user", async (req: any, res: Response) => {
    // Check Self.xyz session
    if (req.session?.isAuthenticated && req.session?.userId) {
      try {
        const [user] = await db.select().from(users).where(eq(users.id, req.session.userId)).limit(1);
        if (user) {
          return res.json({
            id: user.id,
            humanId: user.humanId,
            walletAddress: user.walletAddress,
            authMethod: user.authMethod,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            profileImageUrl: user.profileImageUrl,
            profileComplete: user.profileComplete,
          });
        }
      } catch (e) {
        console.error("[self-auth] Error fetching user:", e);
      }
    }

    // Check legacy Replit auth
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims) {
      try {
        const [user] = await db.select().from(users).where(eq(users.id, req.user.claims.sub)).limit(1);
        if (user) {
          return res.json({
            id: user.id,
            humanId: user.humanId,
            walletAddress: user.walletAddress,
            authMethod: user.authMethod,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            profileImageUrl: user.profileImageUrl,
            profileComplete: user.profileComplete,
          });
        }
      } catch (e) {
        console.error("[self-auth] Error fetching Replit user:", e);
      }
    }

    res.status(401).json({ error: "Not authenticated" });
  });

  // Legacy logout endpoint
  app.get("/api/logout", (req: any, res: Response) => {
    req.session?.destroy?.(() => {});
    res.redirect("/");
  });

  console.log("[self-auth] Additional auth routes registered");
}

export default router;
