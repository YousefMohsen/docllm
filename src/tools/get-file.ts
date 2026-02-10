import { PrismaClient } from "@prisma/client";
import { z } from "zod";

export function registerGetFileContentTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "get_file_content",
    {
      title: "Get File Content",
      description: "Retrieve full text and entity summary for a specific file.",
      inputSchema: {
        fileId: z.number().int().positive()
      },
      outputSchema: {
        id: z.number().int().positive(),
        filename: z.string(),
        dataset: z.string(),
        filepath: z.string(),
        fullText: z.string().nullable(),
        pageCount: z.number().int().nonnegative(),
        entities: z.array(
          z.object({
            entityText: z.string(),
            entityType: z.string(),
            mentions: z.number().int().nonnegative()
          })
        )
      }
    },
    async (input: { fileId: number }) => {
      try {
        const file = await prisma.file.findUnique({
          where: { id: input.fileId },
          include: {
            entityMentions: {
              include: { entity: true }
            }
          }
        });

        if (!file) {
          return {
            isError: true,
            content: [{ type: "text", text: `File not found: fileId=${input.fileId}` }]
          };
        }

        const counts = new Map<number, { entityText: string; entityType: string; mentions: number }>();
        for (const m of file.entityMentions) {
          const prev = counts.get(m.entityId);
          if (prev) {
            prev.mentions++;
          } else {
            counts.set(m.entityId, {
              entityText: m.entity.entityText,
              entityType: m.entity.entityType,
              mentions: 1
            });
          }
        }

        const entities = Array.from(counts.values()).sort((a, b) => {
          if (b.mentions !== a.mentions) return b.mentions - a.mentions;
          return a.entityText.localeCompare(b.entityText);
        });

        const output = {
          id: file.id,
          filename: file.filename,
          dataset: file.dataset,
          filepath: file.filepath,
          fullText: file.fullText ?? null,
          pageCount: file.pageCount,
          entities
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[get_file_content] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to fetch file content. Check server logs for details." }]
        };
      }
    }
  );
}

