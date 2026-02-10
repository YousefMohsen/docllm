import { Command } from "commander";
import dotenv from "dotenv";
import process from "node:process";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  chunkTextByParagraphs,
  createEmbeddings,
  parseBooleanFlag,
  parseEnvNumber,
  sleep,
  toErrorMessage,
  vectorLiteral
} from "./utils/embeddings";

dotenv.config();

async function main() {
  const program = new Command();
  program
    .name("create-embeddings")
    .description("Chunk processed files and store pgvector embeddings for semantic search.")
    .option("--reprocess [value]", "Re-chunk/re-embed for all files (use --reprocess=1)", "0")
    .option("--file-id <id>", "Process a specific file id")
    .option("--dataset <name>", "Process only a specific dataset");

  program.parse(process.argv);
  const opts = program.opts<{ reprocess: string | boolean; fileId?: string; dataset?: string }>();

  const reprocess = parseBooleanFlag(opts.reprocess);
  const fileId = opts.fileId ? Number(opts.fileId) : undefined;
  const dataset = opts.dataset?.trim() ? opts.dataset.trim() : undefined;

  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const embeddingModel = process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  const chunkSizeTokens = parseEnvNumber("CHUNK_SIZE_TOKENS", 700);
  const overlapTokens = parseEnvNumber("CHUNK_OVERLAP_TOKENS", 100);
  const embeddingBatchSize = parseEnvNumber("EMBEDDING_BATCH_SIZE", 50);
  const delayMs = parseEnvNumber("EMBEDDING_DELAY_MS", 100);
  const fileBatchSize = parseEnvNumber("EMBEDDING_FILE_BATCH_SIZE", 5);

  const prisma = new PrismaClient();
  const startedAt = Date.now();

  const stats = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0
  };

  console.log("Starting embeddings creation...");
  console.log(`Mode: ${reprocess ? "reprocess" : "incremental"}`);
  if (fileId != null && Number.isFinite(fileId)) console.log(`Filter: fileId=${fileId}`);
  if (dataset) console.log(`Filter: dataset=${dataset}`);
  console.log(
    `Config: model=${embeddingModel} chunkSizeTokens=${chunkSizeTokens} overlapTokens=${overlapTokens} embeddingBatchSize=${embeddingBatchSize} delayMs=${delayMs} fileBatchSize=${fileBatchSize}`
  );

  const baseWhere: any = {
    status: "processed"
  };
  if (dataset) baseWhere.dataset = dataset;
  if (fileId != null && Number.isFinite(fileId)) baseWhere.id = fileId;
  if (!reprocess && fileId == null) {
    baseWhere.chunksCreated = false;
  }

  stats.totalFiles = await prisma.file.count({ where: baseWhere });
  console.log(`Found ${stats.totalFiles} files to process`);

  let lastId = 0;
  while (true) {
    const where: any = { ...baseWhere };
    if (fileId == null) {
      where.id = { gt: lastId };
    }

    const files = await prisma.file.findMany({
      where,
      orderBy: { id: "asc" },
      take: fileId != null ? 1 : fileBatchSize,
      select: {
        id: true,
        dataset: true,
        filename: true,
        filepath: true,
        fullText: true
      }
    });

    if (files.length === 0) break;
    lastId = files[files.length - 1]!.id;

    for (const f of files) {
      const label = `${f.dataset}/${f.filename}`;
      console.log(`\n[file ${stats.processed + stats.skipped + stats.failed + 1}/${stats.totalFiles}] ${label}`);

      const fullText = (f.fullText ?? "").trim();
      if (!fullText) {
        console.log("  ⚠ Skipping: no fullText");
        stats.skipped++;
        continue;
      }
      if (fullText.length < 50) {
        console.log("  ⚠ Skipping: fullText too short");
        stats.skipped++;
        continue;
      }

      try {
        if (reprocess) {
          await prisma.$transaction([
            prisma.documentChunk.deleteMany({ where: { fileId: f.id } }),
            prisma.file.update({
              where: { id: f.id },
              data: { chunksCreated: false, chunksCreatedAt: null }
            })
          ]);
        } else {
          // If chunks already exist, skip.
          const existing = await prisma.documentChunk.count({ where: { fileId: f.id } });
          if (existing > 0) {
            console.log(`  ↷ Skipping: ${existing} chunks already exist`);
            stats.skipped++;
            continue;
          }
        }

        const chunks = chunkTextByParagraphs({
          text: fullText,
          chunkSizeTokens,
          overlapTokens
        });

        if (chunks.length === 0) {
          console.log("  ⚠ Skipping: chunker produced 0 chunks");
          stats.skipped++;
          continue;
        }

        console.log(`  - chunks: ${chunks.length}`);

        // Create chunk rows first (embedding is stored via raw SQL).
        const chunkRows: Array<{ id: number; chunkText: string }> = [];
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i]!;
          const row = await prisma.documentChunk.create({
            data: {
              fileId: f.id,
              chunkIndex: i,
              chunkText: c.text,
              pageNumber: null,
              tokenCount: c.tokenCount
            },
            select: { id: true, chunkText: true }
          });
          chunkRows.push(row);
        }

        // Embed + update in batches.
        for (let i = 0; i < chunkRows.length; i += embeddingBatchSize) {
          const slice = chunkRows.slice(i, i + embeddingBatchSize);
          const inputs = slice.map((r) => r.chunkText);
          const vectors = await createEmbeddings({ apiKey, model: embeddingModel, inputs });

          for (let j = 0; j < slice.length; j++) {
            const id = slice[j]!.id;
            const vec = vectorLiteral(vectors[j]!);
            await prisma.$executeRaw(
              Prisma.sql`UPDATE document_chunks SET embedding = ${vec}::vector WHERE id = ${id}`
            );
          }

          if (delayMs > 0) await sleep(delayMs);
        }

        await prisma.file.update({
          where: { id: f.id },
          data: { chunksCreated: true, chunksCreatedAt: new Date() }
        });

        stats.processed++;
        stats.totalChunks += chunkRows.length;
        console.log(`  ✓ stored ${chunkRows.length} chunks + embeddings`);
      } catch (err) {
        stats.failed++;
        console.log(`  ✗ failed: ${toErrorMessage(err).split("\n")[0]}`);
        // Best-effort: mark file as not-complete; keep chunks for debugging.
        try {
          await prisma.file.update({ where: { id: f.id }, data: { chunksCreated: false, chunksCreatedAt: null } });
        } catch {
          // ignore
        }
      }
    }

    // In --file-id mode, we've processed the single file; don't loop forever.
    if (fileId != null) break;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\nSummary");
  console.log("=======");
  console.log(`Total files: ${stats.totalFiles}`);
  console.log(`Processed:   ${stats.processed}`);
  console.log(`Skipped:     ${stats.skipped}`);
  console.log(`Failed:      ${stats.failed}`);
  console.log(`Total chunks: ${stats.totalChunks}`);
  console.log(`Time:        ${elapsed}s`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal:", toErrorMessage(err));
  process.exitCode = 1;
});

