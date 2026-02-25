import { PrismaClient } from "@prisma/client";
import { z } from "zod";

export function registerListDatasetsTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "list_datasets",
    {
      title: "List Datasets",
      description: "List available datasets and file counts.",
      inputSchema: {},
      outputSchema: {
        datasets: z.array(
          z.object({
            name: z.string(),
            fileCount: z.number().int().nonnegative()
          })
        )
      }
    },
    async () => {
      try {
        const rows = await prisma.file.groupBy({
          by: ["dataset"],
          _count: { _all: true },
          orderBy: { dataset: "asc" }
        });

        const output = {
          datasets: rows.map((r) => ({ name: r.dataset, fileCount: r._count._all }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[list_datasets] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to list datasets. Check server logs for details." }]
        };
      }
    }
  );
}

