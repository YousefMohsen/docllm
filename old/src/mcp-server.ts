import dotenv from "dotenv";
import process from "node:process";
import { getPrisma, disconnectPrisma } from "./db";
import { registerSearchByEntityTool } from "./tools/search-entity";
import { registerSearchFilesTool } from "./tools/search-files";
import { registerGetFileContentTool } from "./tools/get-file";
import { registerGetFileByFilepathTool } from "./tools/get-file-by-filepath";
import { registerFindEntityConnectionsTool } from "./tools/connections";
import { registerListDatasetsTool } from "./tools/list-datasets";
import { registerListEntitiesTool } from "./tools/list-entities";
import { registerSemanticSearchTool } from "./tools/semantic-search";

dotenv.config();

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

async function main() {
  const serverName = process.env.MCP_SERVER_NAME?.trim() || "document-search";
  const prisma = getPrisma();

  // @modelcontextprotocol/sdk is ESM-first; load it in a CJS-friendly way.
  const [{ McpServer }, { StdioServerTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js")
  ]);

  const server = new McpServer({
    name: serverName,
    version: "0.1.0"
  });

  registerSearchByEntityTool(server, prisma);
  registerSearchFilesTool(server, prisma);
  registerGetFileContentTool(server, prisma);
  registerGetFileByFilepathTool(server, prisma);
  registerFindEntityConnectionsTool(server, prisma);
  registerListDatasetsTool(server, prisma);
  registerListEntitiesTool(server, prisma);
  registerSemanticSearchTool(server, prisma);

  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    try {
      await disconnectPrisma();
    } finally {
      process.exit(0);
    }
  });
  process.on("SIGTERM", async () => {
    try {
      await disconnectPrisma();
    } finally {
      process.exit(0);
    }
  });

  await server.connect(transport);
  console.error(`[mcp] ${serverName} connected over stdio`);
}

main().catch(async (err) => {
  console.error(`[mcp] fatal: ${toErrorMessage(err)}`);
  try {
    await disconnectPrisma();
  } finally {
    process.exitCode = 1;
  }
});

