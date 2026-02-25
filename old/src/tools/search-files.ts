import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { fullTextSearch } from "../utils/search";

const SearchTypeSchema = z.enum(["plain", "phrase", "websearch"]);

export function registerSearchFilesTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description: "Full-text search across all processed documents (ranked when Postgres FTS is enabled).",
      inputSchema: {
        query: z.string().min(1),
        dataset: z.string().min(1).optional(),
        searchType: SearchTypeSchema.optional(),
        limit: z.number().int().positive().max(200).optional()
      },
      outputSchema: {
        files: z.array(
          z.object({
            id: z.number().int().positive(),
            filename: z.string(),
            dataset: z.string(),
            excerpt: z.string().nullable().optional()
          })
        ),
        totalResults: z.number().int().nonnegative()
      }
    },
    async (input: { query: string; dataset?: string; searchType?: "plain" | "phrase" | "websearch"; limit?: number }) => {
      try {
        const { files, totalResults } = await fullTextSearch(prisma, input);
        const output = { files, totalResults };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[search_files] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Search failed. Check server logs for details." }]
        };
      }
    }
  );
}

