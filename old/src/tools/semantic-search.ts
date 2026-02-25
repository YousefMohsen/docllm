import process from "node:process";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createEmbeddings, parseEnvNumber, toErrorMessage, vectorLiteral } from "../utils/embeddings";

export function registerSemanticSearchTool(server: any, prisma: PrismaClient) {
  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description: "Semantic (embedding) search over document chunks using pgvector.",
      inputSchema: {
        query: z.string().min(1),
        topK: z.number().int().positive().max(50).optional(),
        dataset: z.string().min(1).optional(),
        minSimilarity: z.number().min(0).max(1).optional()
      },
      outputSchema: {
        results: z.array(
          z.object({
            fileId: z.number().int().positive(),
            filename: z.string(),
            dataset: z.string(),
            filepath: z.string(),
            chunkId: z.number().int().positive(),
            chunkIndex: z.number().int().nonnegative(),
            pageNumber: z.number().int().nullable(),
            similarity: z.number(),
            excerpt: z.string()
          })
        )
      }
    },
    async (input: { query: string; topK?: number; dataset?: string; minSimilarity?: number }) => {
      try {
        const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
        if (!apiKey) throw new Error("OPENAI_API_KEY is required for semantic_search");

        const model = process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
        const queryText = input.query.trim();
        const topK = Math.max(1, Math.min(50, input.topK ?? 5));
        const dataset = input.dataset?.trim() ? input.dataset.trim() : undefined;
        const minSimilarity = Math.max(0, Math.min(1, input.minSimilarity ?? 0));

        const [vec] = await createEmbeddings({ apiKey, model, inputs: [queryText] });
        const vecLit = vectorLiteral(vec!);
        const datasetSql = dataset ? Prisma.sql`AND f.dataset = ${dataset}` : Prisma.empty;
        const simFilterSql =
          minSimilarity > 0
            ? Prisma.sql`AND (1 - (dc.embedding <=> ${vecLit}::vector)) >= ${minSimilarity}`
            : Prisma.empty;

        // ivfflat is approximate. If probes is too low, Postgres may return fewer than topK rows
        // (or even zero) on small/fragmented datasets. Raise probes for interactive search.
        const envProbes = parseEnvNumber("IVFFLAT_PROBES", 0);
        const probes =
          envProbes > 0 ? Math.max(1, Math.min(200, envProbes)) : Math.max(10, Math.min(200, topK * 10));

        const rows = (await prisma.$transaction(async (tx) => {
          // Postgres doesn't accept a bind parameter for SET; inline the numeric value.
          await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = ${probes}`);
          return tx.$queryRaw<
            Array<{
              fileId: number;
              filename: string;
              dataset: string;
              filepath: string;
              chunkId: number;
              chunkIndex: number;
              pageNumber: number | null;
              similarity: number;
              chunkText: string;
            }>
          >(Prisma.sql`
            SELECT
              f.id AS "fileId",
              f.filename AS "filename",
              f.dataset AS "dataset",
              f.filepath AS "filepath",
              dc.id AS "chunkId",
              dc.chunk_index AS "chunkIndex",
              dc.page_number AS "pageNumber",
              (1 - (dc.embedding <=> ${vecLit}::vector))::float8 AS "similarity",
              dc.chunk_text AS "chunkText"
            FROM document_chunks dc
            JOIN files f ON f.id = dc.file_id
            WHERE dc.embedding IS NOT NULL
              ${datasetSql}
              ${simFilterSql}
            ORDER BY dc.embedding <=> ${vecLit}::vector
            LIMIT ${topK}
          `);
        })) as Array<{
          fileId: number;
          filename: string;
          dataset: string;
          filepath: string;
          chunkId: number;
          chunkIndex: number;
          pageNumber: number | null;
          similarity: number;
          chunkText: string;
        }>;

        const results = rows.map((r) => ({
          fileId: r.fileId,
          filename: r.filename,
          dataset: r.dataset,
          filepath: r.filepath,
          chunkId: r.chunkId,
          chunkIndex: r.chunkIndex,
          pageNumber: r.pageNumber,
          similarity: r.similarity,
          excerpt: (r.chunkText ?? "").slice(0, 700)
        }));

        const output = { results };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (err) {
        console.error("[semantic_search] error:", err);
        return {
          isError: true,
          content: [{ type: "text", text: `Semantic search failed: ${toErrorMessage(err)}` }]
        };
      }
    }
  );
}

