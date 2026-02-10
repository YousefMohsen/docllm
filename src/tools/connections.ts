import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const EntityTypeSchema = z.enum(["PERSON", "LOCATION", "ORGANIZATION"]);

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

export function registerFindEntityConnectionsTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "find_entity_connections",
    {
      title: "Find Entity Connections",
      description: "Find files where multiple entities appear together.",
      inputSchema: {
        entities: z.array(z.string().min(1)).min(2),
        entityType: EntityTypeSchema.optional()
      },
      outputSchema: {
        commonFiles: z.array(
          z.object({
            id: z.number().int().positive(),
            filename: z.string(),
            dataset: z.string(),
            entities: z.array(
              z.object({
                text: z.string(),
                mentions: z.number().int().nonnegative()
              })
            )
          })
        ),
        totalFiles: z.number().int().nonnegative()
      }
    },
    async (input: { entities: string[]; entityType?: string }) => {
      try {
        const entityType = input.entityType?.trim() ? input.entityType.trim() : undefined;

        const normalized = Array.from(
          new Set(
            input.entities
              .map((t) => t.trim())
              .filter(Boolean)
              .map(normalizeText)
          )
        );

        if (normalized.length < 2) {
          return {
            isError: true,
            content: [{ type: "text", text: "Provide at least 2 distinct entity strings." }]
          };
        }

        const entities = await prisma.entity.findMany({
          where: {
            normalizedText: { in: normalized },
            ...(entityType ? { entityType } : {})
          },
          select: { id: true, entityText: true, entityType: true, normalizedText: true }
        });

        const foundSet = new Set(entities.map((e) => e.normalizedText));
        const missing = normalized.filter((n) => !foundSet.has(n));
        if (missing.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Some entities were not found${entityType ? ` (type=${entityType})` : ""}: ${missing.join(
                  ", "
                )}`
              }
            ]
          };
        }

        const entityIds = entities.map((e) => e.id);
        const n = entityIds.length;

        const fileIdRows = (await prisma.$queryRaw<Array<{ fileId: number }>>(Prisma.sql`
          SELECT em.file_id AS "fileId"
          FROM entity_mentions em
          WHERE em.entity_id IN (${Prisma.join(entityIds)})
          GROUP BY em.file_id
          HAVING COUNT(DISTINCT em.entity_id) = ${n}
          ORDER BY em.file_id DESC
          LIMIT 200
        `)) as Array<{ fileId: number }>;

        const fileIds = fileIdRows.map((r) => r.fileId);
        if (fileIds.length === 0) {
          const output = { commonFiles: [], totalFiles: 0 };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output
          };
        }

        const counts = (await prisma.$queryRaw<
          Array<{ id: number; filename: string; dataset: string; entityId: number; mentions: number }>
        >(Prisma.sql`
          SELECT
            f.id,
            f.filename,
            f.dataset,
            em.entity_id AS "entityId",
            COUNT(em.id)::int AS "mentions"
          FROM files f
          JOIN entity_mentions em ON em.file_id = f.id
          WHERE f.id IN (${Prisma.join(fileIds)})
            AND em.entity_id IN (${Prisma.join(entityIds)})
          GROUP BY f.id, f.filename, f.dataset, em.entity_id
          ORDER BY f.id DESC
        `)) as Array<{ id: number; filename: string; dataset: string; entityId: number; mentions: number }>;

        const entityTextById = new Map<number, string>(entities.map((e) => [e.id, e.entityText]));
        const fileMap = new Map<
          number,
          { id: number; filename: string; dataset: string; entities: Array<{ text: string; mentions: number }> }
        >();

        for (const row of counts) {
          const current =
            fileMap.get(row.id) ??
            (() => {
              const init = { id: row.id, filename: row.filename, dataset: row.dataset, entities: [] as any[] };
              fileMap.set(row.id, init);
              return init;
            })();

          current.entities.push({
            text: entityTextById.get(row.entityId) ?? String(row.entityId),
            mentions: row.mentions
          });
        }

        // Ensure the entity list for each file follows the input order.
        const inputOrder = new Map<string, number>(normalized.map((n, i) => [n, i]));

        for (const f of fileMap.values()) {
          f.entities.sort((a, b) => {
            const na = normalizeText(a.text);
            const nb = normalizeText(b.text);
            return (inputOrder.get(na) ?? 999) - (inputOrder.get(nb) ?? 999);
          });
        }

        const commonFiles = Array.from(fileMap.values()).sort((a, b) => b.id - a.id);
        const output = { commonFiles, totalFiles: commonFiles.length };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[find_entity_connections] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to find entity connections. Check server logs for details." }]
        };
      }
    }
  );
}

