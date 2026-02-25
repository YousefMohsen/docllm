import { Command } from "commander";
import process from "node:process";
import dotenv from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";

dotenv.config();

type EmbedOptions = {
  reprocess?: boolean;
  fileId?: number;
  pathPrefix?: string;
};

type EmbedSummary = {
  totalChunks: number;
  embedded: number;
  failed: number;
};

type ChunkRow = {
  id: number;
  content: string;
};

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_BATCH_SIZE = 50;
const DEFAULT_EMBEDDING_DELAY_MS = 100;
const DEFAULT_CHUNK_SCAN_BATCH_SIZE = 500;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function parseBooleanFlag(v: string | boolean | undefined): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function parseEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vectorLiteral(embedding: number[]): string {
  const parts = embedding.map((n) => (Number.isFinite(n) ? String(n) : "0"));
  return `[${parts.join(",")}]`;
}

async function createEmbeddings(args: {
  apiKey: string;
  model: string;
  inputs: string[];
}): Promise<number[][]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      input: args.inputs
    })
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI embeddings error ${resp.status}: ${raw}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI embeddings response was not valid JSON: ${raw.slice(0, 500)}`);
  }

  const data = (parsed as { data?: Array<{ embedding?: number[] }> })?.data;
  if (!Array.isArray(data)) {
    throw new Error(`OpenAI embeddings response missing data[]: ${raw.slice(0, 500)}`);
  }

  const vectors: number[][] = [];
  for (const row of data) {
    if (!Array.isArray(row?.embedding)) {
      throw new Error(`OpenAI embeddings row missing embedding[]: ${raw.slice(0, 500)}`);
    }
    vectors.push(row.embedding);
  }

  if (vectors.length !== args.inputs.length) {
    throw new Error(`Embedding count mismatch: got ${vectors.length}, expected ${args.inputs.length}`);
  }

  return vectors;
}

function buildBaseConditions(options: EmbedOptions, reprocess: boolean): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (!reprocess) {
    conditions.push(Prisma.sql`dc.embedding IS NULL`);
  }
  if (options.fileId != null && Number.isFinite(options.fileId)) {
    conditions.push(Prisma.sql`dc.file_id = ${options.fileId}`);
  }
  if (options.pathPrefix && options.pathPrefix.trim()) {
    conditions.push(Prisma.sql`f.path LIKE ${`${options.pathPrefix.trim()}%`}`);
  }
  return conditions;
}

export async function runCreateChunkEmbeddings(options: EmbedOptions = {}): Promise<EmbedSummary> {
  const prisma = new PrismaClient();
  const reprocess = Boolean(options.reprocess);

  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const embeddingModel = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const embeddingBatchSize = parseEnvNumber("EMBEDDING_BATCH_SIZE", DEFAULT_EMBEDDING_BATCH_SIZE);
  const embeddingDelayMs = parseEnvNumber("EMBEDDING_DELAY_MS", DEFAULT_EMBEDDING_DELAY_MS);
  const chunkScanBatchSize = parseEnvNumber("EMBED_CHUNK_SCAN_BATCH_SIZE", DEFAULT_CHUNK_SCAN_BATCH_SIZE);

  const summary: EmbedSummary = {
    totalChunks: 0,
    embedded: 0,
    failed: 0
  };

  console.log(`Mode: ${reprocess ? "reprocess" : "missing-only"}`);
  console.log(
    `Config: embeddingModel=${embeddingModel}, embeddingBatchSize=${embeddingBatchSize}, embeddingDelayMs=${embeddingDelayMs}, chunkScanBatchSize=${chunkScanBatchSize}`
  );

  try {
    const baseConditions = buildBaseConditions(options, reprocess);
    const countWhere =
      baseConditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(baseConditions, " AND ")}`
        : Prisma.empty;

    const countRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS count
        FROM document_chunks dc
        JOIN files f ON f.id = dc.file_id
        ${countWhere}
      `
    );
    summary.totalChunks = Number(countRows[0]?.count ?? 0n);
    console.log(`Found ${summary.totalChunks} chunk(s) to embed.`);

    let lastId = 0;
    while (true) {
      const scanConditions = [...baseConditions, Prisma.sql`dc.id > ${lastId}`];
      const rows = await prisma.$queryRaw<ChunkRow[]>(
        Prisma.sql`
          SELECT dc.id, dc.content
          FROM document_chunks dc
          JOIN files f ON f.id = dc.file_id
          WHERE ${Prisma.join(scanConditions, " AND ")}
          ORDER BY dc.id ASC
          LIMIT ${chunkScanBatchSize}
        `
      );

      if (rows.length === 0) break;
      lastId = rows[rows.length - 1]!.id;

      for (let i = 0; i < rows.length; i += embeddingBatchSize) {
        const batch = rows.slice(i, i + embeddingBatchSize);
        try {
          const vectors = await createEmbeddings({
            apiKey,
            model: embeddingModel,
            inputs: batch.map((row) => row.content)
          });

          for (let j = 0; j < batch.length; j++) {
            const row = batch[j]!;
            const vec = vectorLiteral(vectors[j]!);
            await prisma.$executeRaw(
              Prisma.sql`UPDATE document_chunks SET embedding = ${vec}::vector WHERE id = ${row.id}`
            );
          }

          summary.embedded += batch.length;
          console.log(`Embedded ${summary.embedded}/${summary.totalChunks} chunks`);
          if (embeddingDelayMs > 0) await sleep(embeddingDelayMs);
        } catch (err) {
          summary.failed += batch.length;
          console.error(`Batch failed (${batch.length} chunks): ${toErrorMessage(err)}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: totalChunks=${summary.totalChunks}, embedded=${summary.embedded}, failed=${summary.failed}`
  );
  return summary;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("create_chunk_embeddings")
    .description("Generate and store embeddings for existing document chunks.")
    .option("--reprocess [value]", "Re-embed all chunks, including already embedded rows", "0")
    .option("--file-id <id>", "Only process chunks for one file id")
    .option("--path-prefix <prefix>", "Only process chunks for files whose path starts with prefix");

  program.parse(process.argv);
  const opts = program.opts<{
    reprocess: string | boolean;
    fileId?: string;
    pathPrefix?: string;
  }>();

  const summary = await runCreateChunkEmbeddings({
    reprocess: parseBooleanFlag(opts.reprocess),
    fileId: opts.fileId ? Number(opts.fileId) : undefined,
    pathPrefix: opts.pathPrefix?.trim()
  });

  if (summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(toErrorMessage(err));
    process.exitCode = 1;
  });
}

