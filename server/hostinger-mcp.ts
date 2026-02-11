import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client | null = null;
let connectionError: string | null = null;
let connectingPromise: Promise<Client> | null = null;

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

async function createClient(): Promise<Client> {
  const apiToken = process.env.HOSTINGER_API_TOKEN;
  if (!apiToken) {
    throw new Error("HOSTINGER_API_TOKEN secret is not set");
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["hostinger-api-mcp@latest"],
    env: {
      ...process.env as Record<string, string>,
      API_TOKEN: apiToken,
    },
  });

  const client = new Client(
    { name: "selfclaw-explorer", version: "1.0.0" },
    { capabilities: {} }
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () =>
          reject(new Error("MCP connection timed out after " + (CONNECT_TIMEOUT_MS / 1000) + "s"))
        );
      }),
    ]);
    console.log("[hostinger-mcp] Connected to Hostinger MCP server");
    return client;
  } catch (err) {
    try { await transport.close(); } catch {}
    try { await client.close(); } catch {}
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getHostingerClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    try {
      mcpClient = await createClient();
      connectionError = null;
      return mcpClient;
    } catch (err: any) {
      connectionError = err.message;
      mcpClient = null;
      console.error("[hostinger-mcp] Failed to connect:", err.message);
      throw err;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

export async function listTools() {
  const client = await getHostingerClient();
  try {
    const result = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, "listTools");
    return result.tools;
  } catch (err: any) {
    console.warn("[hostinger-mcp] listTools failed, resetting connection:", err.message);
    mcpClient = null;
    connectionError = err.message;
    const client2 = await getHostingerClient();
    const result = await withTimeout(client2.listTools(), CALL_TIMEOUT_MS, "listTools");
    return result.tools;
  }
}

export async function callTool(name: string, args: Record<string, any> = {}) {
  const client = await getHostingerClient();
  try {
    const result = await withTimeout(
      client.callTool({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      `callTool(${name})`
    );
    return result;
  } catch (err: any) {
    console.warn("[hostinger-mcp] callTool failed, resetting connection:", err.message);
    mcpClient = null;
    connectionError = err.message;
    const client2 = await getHostingerClient();
    const result = await withTimeout(
      client2.callTool({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      `callTool(${name})`
    );
    return result;
  }
}

export function getConnectionStatus() {
  return {
    connected: mcpClient !== null,
    error: connectionError,
  };
}
