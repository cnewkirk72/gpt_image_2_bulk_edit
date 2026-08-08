import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp, logStartupWarnings } from "./app.js";
import { registerTools } from "./tools.js";
import { initStorage, outputDirDescription } from "./storage.js";

async function runHttp(): Promise<void> {
  logStartupWarnings();
  await initStorage();
  const app = createApp();
  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(
      `gpt-image-2-mcp-server listening on :${port} (MCP at POST /mcp, storage: ${outputDirDescription()})`
    );
  });
}

async function runStdio(): Promise<void> {
  await initStorage();
  const server = new McpServer({ name: "gpt-image-2-mcp-server", version: "1.1.0" });
  registerTools(server);
  await server.connect(new StdioServerTransport());
  console.error("gpt-image-2-mcp-server running on stdio");
}

const mode = process.env.TRANSPORT || "http";
(mode === "stdio" ? runStdio() : runHttp()).catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
