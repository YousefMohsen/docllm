import "dotenv/config";
import { PrismaClient } from "@prisma/client";

type Row = { id: number; content: string; embedding: string };

async function main() {
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, content, embedding::text AS embedding
    FROM document_chunks
    WHERE embedding IS NOT NULL
    ORDER BY id ASC
    LIMIT 5
  `;
  for (const row of rows) {
    const contentPreview = row.content.slice(0, 80) + (row.content.length > 80 ? "..." : "");
    console.log(`--- chunk id=${row.id} ---`);
    console.log("content:", contentPreview);
    console.log("embedding:", row.embedding);
    console.log();
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
