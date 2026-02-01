import { Router, Request, Response } from "express";
import { createHmac } from "crypto";
import { db } from "./db.js";
import { agents, agentSecrets, type InsertAgentSecret } from "../shared/schema.js";
import { eq, and } from "drizzle-orm";

const router = Router();

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");

function getRedirectUri(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0];
  return `https://${domain}/api/gmail/callback`;
}

function getStateSecret(): string {
  return process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "clawpit-gmail-state";
}

function signState(data: object): string {
  const payload = JSON.stringify(data);
  const signature = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return Buffer.from(JSON.stringify({ payload, signature })).toString("base64url");
}

function verifyState(state: string): { agentId: string; userId: string } | null {
  try {
    const { payload, signature } = JSON.parse(Buffer.from(state, "base64url").toString());
    const expectedSig = createHmac("sha256", getStateSecret())
      .update(payload)
      .digest("hex")
      .slice(0, 16);
    if (signature !== expectedSig) {
      return null;
    }
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

router.get("/authorize/:agentId", async (req: any, res: Response) => {
  try {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.agentId));
    if (!agent || agent.userId !== userId) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: "Google OAuth not configured. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." });
    }

    const state = signState({ agentId: agent.id, userId });

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", getRedirectUri());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GMAIL_SCOPES);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  } catch (error: any) {
    console.error("[gmail] Authorization error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/callback", async (req: any, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect("/?gmail_error=" + encodeURIComponent(error as string));
    }

    if (!code || !state) {
      return res.redirect("/?gmail_error=missing_params");
    }

    const stateData = verifyState(state as string);
    if (!stateData) {
      return res.redirect("/?gmail_error=invalid_state");
    }

    const { agentId, userId } = stateData;

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent || agent.userId !== userId) {
      return res.redirect("/?gmail_error=agent_not_found");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.redirect("/?gmail_error=oauth_not_configured");
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getRedirectUri(),
        grant_type: "authorization_code"
      })
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      console.error("[gmail] Token error:", tokens);
      return res.redirect("/?gmail_error=" + encodeURIComponent(tokens.error));
    }

    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const userInfo = await userInfoResponse.json();

    const tokenData = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      email: userInfo.email
    });

    const existing = await db.select().from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.serviceName, "gmail")));

    if (existing.length > 0) {
      await db.update(agentSecrets)
        .set({ apiKey: tokenData, isActive: true, updatedAt: new Date() })
        .where(eq(agentSecrets.id, existing[0].id));
    } else {
      const newSecret: InsertAgentSecret = {
        agentId,
        serviceName: "gmail",
        apiKey: tokenData,
        isActive: true
      };
      await db.insert(agentSecrets).values(newSecret);
    }

    console.log(`[gmail] Connected ${userInfo.email} to agent ${agentId}`);
    res.redirect("/?gmail_connected=" + encodeURIComponent(userInfo.email));
  } catch (error: any) {
    console.error("[gmail] Callback error:", error);
    res.redirect("/?gmail_error=" + encodeURIComponent(error.message));
  }
});

router.get("/status/:agentId", async (req: any, res: Response) => {
  try {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.agentId));
    if (!agent || agent.userId !== userId) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const [secret] = await db.select().from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.serviceName, "gmail"), eq(agentSecrets.isActive, true)));

    if (!secret) {
      return res.json({ connected: false });
    }

    try {
      const tokenData = JSON.parse(secret.apiKey);
      return res.json({ connected: true, email: tokenData.email });
    } catch {
      return res.json({ connected: false });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/disconnect/:agentId", async (req: any, res: Response) => {
  try {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.agentId));
    if (!agent || agent.userId !== userId) {
      return res.status(404).json({ error: "Agent not found" });
    }

    await db.update(agentSecrets)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.serviceName, "gmail")));

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export async function refreshGmailToken(agentId: string): Promise<string | null> {
  const [secret] = await db.select().from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.serviceName, "gmail"), eq(agentSecrets.isActive, true)));

  if (!secret) return null;

  try {
    const tokenData = JSON.parse(secret.apiKey);
    
    if (Date.now() < tokenData.expires_at - 60000) {
      return tokenData.access_token;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret || !tokenData.refresh_token) {
      return null;
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenData.refresh_token,
        grant_type: "refresh_token"
      })
    });

    const tokens = await response.json();

    if (tokens.error) {
      console.error("[gmail] Refresh error:", tokens);
      return null;
    }

    const updatedData = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      email: tokenData.email
    });

    await db.update(agentSecrets)
      .set({ apiKey: updatedData, updatedAt: new Date() })
      .where(eq(agentSecrets.id, secret.id));

    return tokens.access_token;
  } catch (error) {
    console.error("[gmail] Token refresh error:", error);
    return null;
  }
}

export async function readGmailMessages(agentId: string, maxResults: number = 10, query?: string): Promise<any[]> {
  const accessToken = await refreshGmailToken(agentId);
  if (!accessToken) {
    throw new Error("Gmail not connected or token refresh failed");
  }

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(maxResults));
  if (query) {
    listUrl.searchParams.set("q", query);
  }

  const listResponse = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const listData = await listResponse.json();

  if (listData.error) {
    throw new Error(listData.error.message || "Failed to list messages");
  }

  if (!listData.messages || listData.messages.length === 0) {
    return [];
  }

  const messages = await Promise.all(
    listData.messages.slice(0, Math.min(maxResults, 10)).map(async (msg: any) => {
      const msgResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await msgResponse.json();

      const headers: Record<string, string> = {};
      msgData.payload?.headers?.forEach((h: any) => {
        headers[h.name.toLowerCase()] = h.value;
      });

      return {
        id: msg.id,
        threadId: msg.threadId,
        from: headers.from || "",
        to: headers.to || "",
        subject: headers.subject || "(no subject)",
        date: headers.date || "",
        snippet: msgData.snippet || ""
      };
    })
  );

  return messages;
}

export default router;
