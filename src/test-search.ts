import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { fullTextSearch } from "./utils/search";

dotenv.config();

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function main() {
  const prisma = new PrismaClient();

  const tests: Array<{ label: string; query: string; searchType?: "plain" | "phrase" | "websearch" }> = [
    { label: "single word", query: "Epstein", searchType: "plain" },
    { label: "multiple words", query: "work release", searchType: "plain" },
    { label: "phrase", query: "work release letter", searchType: "phrase" },
    { label: "boolean (websearch)", query: "Epstein AND letter", searchType: "websearch" },
    { label: "stemming", query: "releasing", searchType: "plain" }
  ];

  try {
    for (const t of tests) {
      console.log(`\n=== ${t.label} ===`);
      console.log(`query=${JSON.stringify(t.query)} searchType=${t.searchType ?? "plain"}`);

      const t0 = nowMs();
      const fts = await fullTextSearch(prisma, { query: t.query, searchType: t.searchType, limit: 5 });
      const t1 = nowMs();

      const t2 = nowMs();
      const basicCount = await prisma.file.count({
        where: { fullText: { contains: t.query, mode: "insensitive" } }
      });
      const basicRows = await prisma.file.findMany({
        where: { fullText: { contains: t.query, mode: "insensitive" } },
        take: 5,
        orderBy: { id: "desc" },
        select: { id: true, dataset: true, filename: true }
      });
      const t3 = nowMs();

      console.log(`FTS:   ${fts.totalResults} result(s) in ${t1 - t0}ms`);
      console.log(
        `BASIC: ${basicCount} result(s) in ${t3 - t2}ms (substring contains; will be slower on large corpora)`
      );

      console.log("Top FTS hits:");
      for (const r of fts.files) {
        console.log(`- [${r.id}] ${r.dataset}/${r.filename}`);
      }

      console.log("Top BASIC hits:");
      for (const r of basicRows) {
        console.log(`- [${r.id}] ${r.dataset}/${r.filename}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

