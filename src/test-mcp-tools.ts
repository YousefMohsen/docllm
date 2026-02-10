import dotenv from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";
import { fullTextSearch } from "./utils/search";

dotenv.config();

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log("== list_datasets ==");
    const datasets = await prisma.file.groupBy({
      by: ["dataset"],
      _count: { _all: true },
      orderBy: { dataset: "asc" }
    });
    for (const d of datasets) console.log(`- ${d.dataset}: ${d._count._all}`);

    console.log("\n== list_entities (top 10) ==");
    const topEntities = (await prisma.$queryRaw<
      Array<{ id: number; entityText: string; entityType: string; mentionCount: number }>
    >(Prisma.sql`
      SELECT
        e.id,
        e.entity_text AS "entityText",
        e.entity_type AS "entityType",
        COUNT(em.id)::int AS "mentionCount"
      FROM entities e
      LEFT JOIN entity_mentions em ON em.entity_id = e.id
      GROUP BY e.id
      ORDER BY "mentionCount" DESC, e.id ASC
      LIMIT 10
    `)) as Array<{ id: number; entityText: string; entityType: string; mentionCount: number }>;
    for (const e of topEntities) console.log(`- [${e.id}] ${e.entityType} ${e.entityText} (${e.mentionCount})`);

    console.log("\n== search_files ==");
    const search = await fullTextSearch(prisma, { query: "agreement", limit: 5, searchType: "plain" });
    console.log(`totalResults=${search.totalResults}`);
    for (const r of search.files) console.log(`- [${r.id}] ${r.dataset}/${r.filename}`);

    console.log("\n== get_file_content (sample) ==");
    const sampleFile = await prisma.file.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    if (!sampleFile) {
      console.log("(no files found)");
      return;
    }
    const file = await prisma.file.findUnique({
      where: { id: sampleFile.id },
      include: { entityMentions: { include: { entity: true } } }
    });
    if (!file) throw new Error("Invariant: sample file missing");
    console.log(`fileId=${file.id} dataset=${file.dataset} filepath=${file.filepath} pageCount=${file.pageCount}`);
    console.log(`fullTextChars=${(file.fullText ?? "").length}`);
    console.log(`mentions=${file.entityMentions.length}`);

    console.log("\n== search_by_entity (sample) ==");
    const sampleEntity = await prisma.entity.findFirst({ orderBy: { id: "asc" } });
    if (!sampleEntity) {
      console.log("(no entities found)");
      return;
    }
    const mentionCount = await prisma.entityMention.count({ where: { entityId: sampleEntity.id } });
    const firstMentions = await prisma.entityMention.findMany({
      where: { entityId: sampleEntity.id },
      take: 3,
      orderBy: { id: "asc" },
      include: { file: { select: { id: true, dataset: true, filename: true } } }
    });
    console.log(
      `entity=[${sampleEntity.id}] ${sampleEntity.entityType} ${sampleEntity.entityText} totalMentions=${mentionCount}`
    );
    for (const m of firstMentions) console.log(`- fileId=${m.file.id} ${m.file.dataset}/${m.file.filename}`);

    console.log("\n== find_entity_connections (sample two entities) ==");
    if (topEntities.length >= 2) {
      const ids = [topEntities[0]!.id, topEntities[1]!.id];
      const fileIdRows = (await prisma.$queryRaw<Array<{ fileId: number }>>(Prisma.sql`
        SELECT em.file_id AS "fileId"
        FROM entity_mentions em
        WHERE em.entity_id IN (${Prisma.join(ids)})
        GROUP BY em.file_id
        HAVING COUNT(DISTINCT em.entity_id) = 2
        ORDER BY em.file_id DESC
        LIMIT 5
      `)) as Array<{ fileId: number }>;
      console.log(`commonFilesSample=${fileIdRows.length}`);
      for (const r of fileIdRows) console.log(`- fileId=${r.fileId}`);
    } else {
      console.log("(not enough entities)");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

