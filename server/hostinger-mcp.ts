import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client | null = null;
let connectionError: string | null = null;

export async function getHostingerClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

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

  try {
    await client.connect(transport);
    mcpClient = client;
    connectionError = null;
    console.log("[hostinger-mcp] Connected to Hostinger MCP server");
    return client;
  } catch (err: any) {
    connectionError = err.message;
    console.error("[hostinger-mcp] Failed to connect:", err.message);
    throw err;
  }
}

export async function listTools() {
  const client = await getHostingerClient();
  const result = await client.listTools();
  return result.tools;
}

export async function callTool(name: string, args: Record<string, any> = {}) {
  const client = await getHostingerClient();
  const result = await client.callTool({ name, arguments: args });
  return result;
}

export function getConnectionStatus() {
  return {
    connected: mcpClient !== null,
    error: connectionError,
  };
}
