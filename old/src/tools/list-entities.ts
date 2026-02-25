import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const EntityTypeSchema = z.enum(["PERSON", "LOCATION", "ORGANIZATION"]);

export function registerListEntitiesTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "list_entities",
    {
      title: "List Entities",
      description: "Browse extracted entities, optionally filtered by type and text.",
      inputSchema: {
        entityType: EntityTypeSchema.optional(),
        limit: z.number().int().positive().max(500).optional(),
        search: z.string().min(1).optional()
      },
      outputSchema: {
        entities: z.array(
          z.object({
            id: z.number().int().positive(),
            entityText: z.string(),
            entityType: z.string(),
            mentionCount: z.number().int().nonnegative()
          })
        ),
        total: z.number().int().nonnegative()
      }
    },
    async (input: { entityType?: string; limit?: number; search?: string }) => {
      try {
        const limit = Math.max(1, Math.min(500, input.limit ?? 50));
        const entityType = input.entityType?.trim() ? input.entityType.trim() : undefined;
        const search = input.search?.trim() ? input.search.trim() : undefined;

        const where: any = {};
        if (entityType) where.entityType = entityType;
        if (search) {
          where.OR = [
            { entityText: { contains: search, mode: "insensitive" } },
            { normalizedText: { contains: search.toLowerCase() } }
          ];
        }

        const total = await prisma.entity.count({ where });

        const rows = (await prisma.$queryRaw<
          Array<{ id: number; entityText: string; entityType: string; mentionCount: number }>
        >(Prisma.sql`
          SELECT
            e.id,
            e.entity_text AS "entityText",
            e.entity_type AS "entityType",
            COUNT(em.id)::int AS "mentionCount"
          FROM entities e
          LEFT JOIN entity_mentions em ON em.entity_id = e.id
          WHERE 1=1
            ${entityType ? Prisma.sql`AND e.entity_type = ${entityType}` : Prisma.empty}
            ${
              search
                ? Prisma.sql`AND (e.entity_text ILIKE ${"%" + search + "%"} OR e.normalized_text ILIKE ${"%" + search.toLowerCase() + "%"})`
                : Prisma.empty
            }
          GROUP BY e.id
          ORDER BY "mentionCount" DESC, e.entity_text ASC
          LIMIT ${limit}
        `)) as Array<{ id: number; entityText: string; entityType: string; mentionCount: number }>;

        const output = { entities: rows, total };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[list_entities] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to list entities. Check server logs for details." }]
        };
      }
    }
  );
}

