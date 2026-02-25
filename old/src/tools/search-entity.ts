import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const EntityTypeSchema = z.enum(["PERSON", "LOCATION", "ORGANIZATION"]);

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

export function registerSearchByEntityTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "search_by_entity",
    {
      title: "Search by Entity",
      description: "Find files mentioning a specific extracted entity.",
      inputSchema: {
        entityText: z.string().min(1),
        entityType: EntityTypeSchema.optional(),
        limit: z.number().int().positive().max(200).optional()
      },
      outputSchema: {
        entity: z.object({
          id: z.number().int().positive(),
          entityText: z.string(),
          entityType: z.string()
        }),
        files: z.array(
          z.object({
            id: z.number().int().positive(),
            filename: z.string(),
            dataset: z.string(),
            filepath: z.string(),
            contextSnippet: z.string(),
            pageNumber: z.number().int().nullable()
          })
        ),
        totalMentions: z.number().int().nonnegative()
      }
    },
    async (input: { entityText: string; entityType?: string; limit?: number }) => {
      try {
        const limit = Math.max(1, Math.min(200, input.limit ?? 10));
        const entityText = input.entityText.trim();
        const normalizedText = normalizeText(entityText);
        const entityType = input.entityType?.trim() ? input.entityType.trim() : undefined;

        let entity:
          | { id: number; entityText: string; entityType: string }
          | null = null;

        if (entityType) {
          const found = await prisma.entity.findFirst({
            where: { normalizedText, entityType },
            orderBy: { id: "asc" },
            select: { id: true, entityText: true, entityType: true }
          });
          entity = found ?? null;
        } else {
          const rows = (await prisma.$queryRaw<
            Array<{ id: number; entityText: string; entityType: string }>
          >(Prisma.sql`
            SELECT
              e.id,
              e.entity_text AS "entityText",
              e.entity_type AS "entityType"
            FROM entities e
            LEFT JOIN entity_mentions em ON em.entity_id = e.id
            WHERE e.normalized_text = ${normalizedText}
            GROUP BY e.id
            ORDER BY COUNT(em.id) DESC, e.id ASC
            LIMIT 1
          `)) as Array<{ id: number; entityText: string; entityType: string }>;
          entity = rows[0] ?? null;
        }

        if (!entity) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: entityType
                  ? `Entity not found: "${entityText}" (type=${entityType})`
                  : `Entity not found: "${entityText}"`
              }
            ]
          };
        }

        const totalMentions = await prisma.entityMention.count({ where: { entityId: entity.id } });

        const take = Math.min(5000, Math.max(1000, limit * 50));
        const mentions = await prisma.entityMention.findMany({
          where: { entityId: entity.id },
          orderBy: { id: "asc" },
          take,
          include: {
            file: {
              select: { id: true, filename: true, dataset: true, filepath: true }
            }
          }
        });

        const seenFileIds = new Set<number>();
        const files: Array<{
          id: number;
          filename: string;
          dataset: string;
          filepath: string;
          contextSnippet: string;
          pageNumber: number | null;
        }> = [];

        for (const m of mentions) {
          if (seenFileIds.has(m.fileId)) continue;
          seenFileIds.add(m.fileId);
          files.push({
            id: m.file.id,
            filename: m.file.filename,
            dataset: m.file.dataset,
            filepath: m.file.filepath,
            contextSnippet: m.contextSnippet,
            pageNumber: m.pageNumber ?? null
          });
          if (files.length >= limit) break;
        }

        const output = {
          entity,
          files,
          totalMentions
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[search_by_entity] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Entity search failed. Check server logs for details." }]
        };
      }
    }
  );
}

