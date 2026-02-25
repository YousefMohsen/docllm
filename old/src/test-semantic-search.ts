import dotenv from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";
import { createEmbeddings, toErrorMessage, vectorLiteral } from "./utils/embeddings";

dotenv.config();

async function main() {
  const prisma = new PrismaClient();
  try {
    const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");

    const model = process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
    const query = process.argv.slice(2).join(" ").trim() || "agreement";

    const chunkCount = await prisma.documentChunk.count();
    console.log(`document_chunks=${chunkCount}`);

    const [vec] = await createEmbeddings({ apiKey, model, inputs: [query] });
    const vecLit = vectorLiteral(vec!);
    console.log(`vecLitChars=${vecLit.length}`);

    const sanity = (await prisma.$queryRaw<
      Array<{ fileId: number; dataset: string; filename: string }>
    >(Prisma.sql`
      SELECT f.id AS "fileId", f.dataset AS "dataset", f.filename AS "filename"
      FROM document_chunks dc
      JOIN files f ON f.id = dc.file_id
      WHERE dc.embedding IS NOT NULL
      LIMIT 5
    `)) as Array<{ fileId: number; dataset: string; filename: string }>;
    console.log(`sanityRows=${sanity.length}`);

    // If binding a vector literal as a parameter doesn't work in your environment,
    // inline it as raw SQL (safe here because vecLit is machine-generated).
    const vecInline = Prisma.raw(`'${vecLit.replace(/'/g, "''")}'::vector`);

    const probes = Number(process.env.IVFFLAT_PROBES || 50);
    const [rowsSub, rows] = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = ${probes}`);

      const rowsSub = (await tx.$queryRaw<Array<{ fileId: number; filename: string }>>(Prisma.sql`
        SELECT f.id AS "fileId", f.filename AS "filename"
        FROM document_chunks dc
        JOIN files f ON f.id = dc.file_id
        WHERE dc.embedding IS NOT NULL
        ORDER BY dc.embedding <=> (SELECT embedding FROM document_chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 1)
        LIMIT 5
      `)) as Array<{ fileId: number; filename: string }>;

      const rows = (await tx.$queryRaw<
        Array<{
          fileId: number;
          dataset: string;
          filename: string;
          similarityText: string;
          excerpt: string;
        }>
      >(Prisma.sql`
        SELECT
          f.id AS "fileId",
          f.dataset AS "dataset",
          f.filename AS "filename",
          (1 - (dc.embedding <=> ${vecInline}))::float8::text AS "similarityText",
          LEFT(dc.chunk_text, 250) AS "excerpt"
        FROM document_chunks dc
        JOIN files f ON f.id = dc.file_id
        WHERE dc.embedding IS NOT NULL
        ORDER BY dc.embedding <=> ${vecInline}
        LIMIT 5
      `)) as Array<{ fileId: number; dataset: string; filename: string; similarityText: string; excerpt: string }>;

      return [rowsSub, rows] as const;
    });

    console.log(`subselectRows=${rowsSub.length}`);

    console.log(`query=${JSON.stringify(query)}`);
    console.log(`rows=${rows.length}`);
    for (const r of rows) {
      console.log(`- [${r.fileId}] ${r.dataset}/${r.filename} sim=${r.similarityText}: ${r.excerpt}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(toErrorMessage(err));
  process.exitCode = 1;
});

