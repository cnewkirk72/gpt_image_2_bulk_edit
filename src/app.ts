import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { resolveServedFile, usingBlob } from "./storage.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: "gpt-image-2-mcp-server", version: "1.1.0" });
  registerTools(server);
  return server;
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return next(); // auth disabled (see README warning)
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${token}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "80mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "gpt-image-2-mcp-server",
      storage: usingBlob() ? "vercel-blob" : "disk",
      openai_key_configured: Boolean(process.env.OPENAI_API_KEY),
      auth_enabled: Boolean(process.env.MCP_AUTH_TOKEN || process.env.MCP_PATH_SECRET),
    });
  });

  // Disk mode only: serve generated images (filenames are unguessable UUIDs).
  app.get("/files/:name", (req, res) => {
    if (usingBlob()) return void res.status(404).send("Not found (blob storage mode)");
    const full = resolveServedFile(req.params.name);
    if (!full) return void res.status(404).send("Not found");
    res.sendFile(full, (err) => {
      if (err && !res.headersSent) res.status(404).send("Not found");
    });
  });

  // Primary MCP endpoint: bearer-token auth (custom connector "request header" auth).
  app.post("/mcp", bearerAuth, handleMcp);

  // Fallback for clients that can't send auth headers: secret embedded in the path.
  // Enable by setting MCP_PATH_SECRET, then use https://host/mcp/<secret> as the connector URL.
  app.post("/mcp/:secret", (req, res) => {
    const secret = process.env.MCP_PATH_SECRET;
    if (!secret || req.params.secret !== secret) {
      return void res.status(401).json({ error: "Unauthorized" });
    }
    void handleMcp(req, res);
  });

  // Stateless mode: no server-initiated streams / session lookups.
  const notAllowed = (_req: Request, res: Response): void =>
    void res.status(405).json({ error: "Method not allowed" });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.get("/mcp/:secret", notAllowed);
  app.delete("/mcp/:secret", notAllowed);

  return app;
}

export function logStartupWarnings(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error("WARNING: OPENAI_API_KEY is not set — image tools will return errors until it is.");
  }
  if (!process.env.MCP_AUTH_TOKEN && !process.env.MCP_PATH_SECRET) {
    console.error(
      "WARNING: no MCP_AUTH_TOKEN or MCP_PATH_SECRET — the /mcp endpoint is PUBLIC and anyone with the URL can spend your OpenAI credits."
    );
  }
}
