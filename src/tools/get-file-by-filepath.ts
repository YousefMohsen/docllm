import { PrismaClient } from "@prisma/client";
import { z } from "zod";

function normalizeFilepath(input: string): string {
  // Stored in DB as a POSIX-like path relative to DOCUMENTS_PATH, e.g. "dataset-8/EFTA00014122.pdf"
  let fp = input.trim();
  if (fp.endsWith(":")) fp = fp.slice(0, -1).trim();
  fp = fp.replaceAll("\\", "/");
  if (fp.startsWith("./")) fp = fp.slice(2);
  while (fp.startsWith("/")) fp = fp.slice(1);
  return fp;
}

export function registerGetFileByFilepathTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "get_file_by_filepath",
    {
      title: "Get File By Filepath",
      description:
        'Retrieve full text and entity summary for a specific file, looked up by its stored filepath (e.g. "dataset-8/EFTA00014122.pdf").',
      inputSchema: {
        filepath: z.string().min(1)
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
    async (input: { filepath: string }) => {
      const normalized = normalizeFilepath(input.filepath);

      try {
        const file = await prisma.file.findUnique({
          where: { filepath: normalized },
          include: {
            entityMentions: {
              include: { entity: true }
            }
          }
        });

        if (!file) {
          return {
            isError: true,
            content: [{ type: "text", text: `File not found: filepath=${JSON.stringify(normalized)}` }]
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
        console.error("[get_file_by_filepath] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to fetch file by filepath. Check server logs for details." }]
        };
      }
    }
  );
}

