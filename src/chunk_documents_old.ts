export {};
import { Command } from "commander";
import process from "node:process";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

type ChunkOptions = {
  reprocess?: boolean;
  fileId?: number;
  pathPrefix?: string;
};

type ChunkSummary = {
  totalFiles: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
};

type TextChunk = {
  text: string;
  tokenCount: number;
};

const DEFAULT_CHUNK_SIZE_TOKENS = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 120; // ~15% overlap
const DEFAULT_FILE_BATCH_SIZE = 10;

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

// Heuristic token estimation for MVP. Replace with real tokenizer later.
function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.ceil(words * 1.3));
}

function splitRecursive(text: string, chunkSizeTokens: number, level: number = 0): string[] {
  const raw = text.trim();
  if (!raw) return [];
  if (estimateTokens(raw) <= chunkSizeTokens) return [raw];

  const splitters: Array<(input: string) => string[]> = [
    (input) => input.split(/\n{2,}/g),
    (input) => input.split(/\n/g),
    (input) => input.split(/(?<=[.!?])\s+/g),
    (input) => input.split(/\s+/g)
  ];

  if (level >= splitters.length) {
    const words = raw.split(/\s+/).filter(Boolean);
    const sizeWords = Math.max(50, Math.round(chunkSizeTokens / 1.3));
    const parts: string[] = [];
    for (let i = 0; i < words.length; i += sizeWords) {
      parts.push(words.slice(i, i + sizeWords).join(" "));
    }
    return parts.filter(Boolean);
  }

  const splitter = splitters[level];
  if (!splitter) return splitRecursive(raw, chunkSizeTokens, level + 1);

  const parts = splitter(raw).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return splitRecursive(raw, chunkSizeTokens, level + 1);

  const out: string[] = [];
  for (const part of parts) {
    if (estimateTokens(part) <= chunkSizeTokens) {
      out.push(part);
      continue;
    }
    out.push(...splitRecursive(part, chunkSizeTokens, level + 1));
  }
  return out.filter(Boolean);
}

function lastNWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return text.trim();
  return words.slice(words.length - n).join(" ");
}

function chunkTextRecursive(args: {
  text: string;
  chunkSizeTokens: number;
  overlapTokens: number;
}): TextChunk[] {
  const chunkSizeTokens = Math.max(100, args.chunkSizeTokens);
  const overlapTokens = Math.max(0, Math.min(chunkSizeTokens - 1, args.overlapTokens));
  const units = splitRecursive(args.text, chunkSizeTokens);
  if (units.length === 0) return [];

  const overlapWords = Math.max(0, Math.round(overlapTokens / 1.3));
  const chunks: TextChunk[] = [];
  let current = "";
  let carryover = "";

  function flush() {
    const text = current.trim();
    if (!text) return;
    chunks.push({ text, tokenCount: estimateTokens(text) });
    carryover = overlapWords > 0 ? lastNWords(text, overlapWords) : "";
    current = "";
  }

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : carryover ? `${carryover}\n\n${unit}` : unit;
    if (estimateTokens(candidate) <= chunkSizeTokens) {
      current = candidate;
      continue;
    }

    if (!current) {
      chunks.push({ text: unit, tokenCount: estimateTokens(unit) });
      carryover = overlapWords > 0 ? lastNWords(unit, overlapWords) : "";
      continue;
    }

    flush();
    current = carryover ? `${carryover}\n\n${unit}` : unit;
  }

  flush();
  return chunks;
}

export async function runChunkDocuments(options: ChunkOptions = {}): Promise<ChunkSummary> {
  const prisma = new PrismaClient();
  const reprocess = Boolean(options.reprocess);
  const chunkSizeTokens = parseEnvNumber("CHUNK_SIZE_TOKENS", DEFAULT_CHUNK_SIZE_TOKENS);
  const overlapTokens = parseEnvNumber("CHUNK_OVERLAP_TOKENS", DEFAULT_CHUNK_OVERLAP_TOKENS);
  const fileBatchSize = parseEnvNumber("CHUNK_FILE_BATCH_SIZE", DEFAULT_FILE_BATCH_SIZE);

  const summary: ChunkSummary = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0
  };

  console.log(`Mode: ${reprocess ? "reprocess" : "incremental"}`);
  console.log(`Config: chunkSizeTokens=${chunkSizeTokens}, overlapTokens=${overlapTokens}`);

  try {
    const baseWhere: {
      fullText: { not: string };
      id?: number;
      path?: { startsWith: string };
    } = {
      fullText: { not: "" }
    };

    if (options.fileId != null && Number.isFinite(options.fileId)) {
      baseWhere.id = options.fileId;
    }
    if (options.pathPrefix && options.pathPrefix.trim()) {
      baseWhere.path = { startsWith: options.pathPrefix.trim() };
    }

    summary.totalFiles = await prisma.file.count({ where: baseWhere });
    console.log(`Found ${summary.totalFiles} file(s) to evaluate.`);

    let lastId = 0;
    while (true) {
      const where: {
        fullText: { not: string };
        id?: number | { gt: number };
        path?: { startsWith: string };
      } = { ...baseWhere };
      if (options.fileId == null) where.id = { gt: lastId };

      const files = await prisma.file.findMany({
        where,
        orderBy: { id: "asc" },
        take: options.fileId == null ? fileBatchSize : 1,
        select: {
          id: true,
          path: true,
          fullText: true
        }
      });

      if (files.length === 0) break;
      lastId = files[files.length - 1]!.id;

      for (const [idx, file] of files.entries()) {
        const fullText = file.fullText.trim();
        const label = `[${idx + 1}/${files.length}] ${file.path}`;

        if (!fullText) {
          summary.skipped++;
          console.log(`${label} - skipped (empty fullText)`);
          continue;
        }

        try {
          if (reprocess) {
            await prisma.documentChunk.deleteMany({ where: { fileId: file.id } });
          } else {
            const existing = await prisma.documentChunk.count({ where: { fileId: file.id } });
            if (existing > 0) {
              summary.skipped++;
              console.log(`${label} - skipped (${existing} chunks already exist)`);
              continue;
            }
          }

          const chunks = chunkTextRecursive({
            text: fullText,
            chunkSizeTokens,
            overlapTokens
          });

          if (chunks.length === 0) {
            summary.skipped++;
            console.log(`${label} - skipped (chunker produced 0 chunks)`);
            continue;
          }

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            await prisma.documentChunk.create({
              data: {
                fileId: file.id,
                chunkIndex: i,
                content: chunk.text,
                tokenCount: chunk.tokenCount,
                pageNumber: null
              }
            });
          }

          summary.processed++;
          summary.totalChunks += chunks.length;
          console.log(`${label} - processed (${chunks.length} chunks)`);
        } catch (err) {
          summary.failed++;
          console.error(`${label} - failed\n${toErrorMessage(err)}`);
        }
      }

      if (options.fileId != null) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: totalFiles=${summary.totalFiles}, processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}, totalChunks=${summary.totalChunks}`
  );

  return summary;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("chunk_documents")
    .description("Split File.fullText into DocumentChunk rows.")
    .option("--reprocess [value]", "Delete existing chunks and rebuild them", "0")
    .option("--file-id <id>", "Only process one file id")
    .option("--path-prefix <prefix>", "Only process files whose path starts with prefix");

  program.parse(process.argv);
  const opts = program.opts<{
    reprocess: string | boolean;
    fileId?: string;
    pathPrefix?: string;
  }>();

  const summary = await runChunkDocuments({
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

import { Command } from "commander";
import process from "node:process";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

type ChunkOptions = {
  reprocess?: boolean;
  fileId?: number;
  pathPrefix?: string;
};

type ChunkSummary = {
  totalFiles: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
};

type TextChunk = {
  text: string;
  tokenCount: number;
};

const DEFAULT_CHUNK_SIZE_TOKENS = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 120; // ~15% overlap
const DEFAULT_FILE_BATCH_SIZE = 10;

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

// Heuristic token estimation for MVP. Replace with real tokenizer later.
function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.ceil(words * 1.3));
}

function splitRecursive(text: string, chunkSizeTokens: number, level: number = 0): string[] {
  const raw = text.trim();
  if (!raw) return [];
  if (estimateTokens(raw) <= chunkSizeTokens) return [raw];

  const splitters: Array<(input: string) => string[]> = [
    (input) => input.split(/\n{2,}/g),
    (input) => input.split(/\n/g),
    (input) => input.split(/(?<=[.!?])\s+/g),
    (input) => input.split(/\s+/g)
  ];

  if (level >= splitters.length) {
    const words = raw.split(/\s+/).filter(Boolean);
    const sizeWords = Math.max(50, Math.round(chunkSizeTokens / 1.3));
    const parts: string[] = [];
    for (let i = 0; i < words.length; i += sizeWords) {
      parts.push(words.slice(i, i + sizeWords).join(" "));
    }
    return parts.filter(Boolean);
  }

  const splitter = splitters[level];
  if (!splitter) return splitRecursive(raw, chunkSizeTokens, level + 1);

  const parts = splitter(raw).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return splitRecursive(raw, chunkSizeTokens, level + 1);

  const out: string[] = [];
  for (const part of parts) {
    if (estimateTokens(part) <= chunkSizeTokens) {
      out.push(part);
      continue;
    }
    out.push(...splitRecursive(part, chunkSizeTokens, level + 1));
  }
  return out.filter(Boolean);
}

function lastNWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return text.trim();
  return words.slice(words.length - n).join(" ");
}

function chunkTextRecursive(args: {
  text: string;
  chunkSizeTokens: number;
  overlapTokens: number;
}): TextChunk[] {
  const chunkSizeTokens = Math.max(100, args.chunkSizeTokens);
  const overlapTokens = Math.max(0, Math.min(chunkSizeTokens - 1, args.overlapTokens));
  const units = splitRecursive(args.text, chunkSizeTokens);
  if (units.length === 0) return [];

  const overlapWords = Math.max(0, Math.round(overlapTokens / 1.3));
  const chunks: TextChunk[] = [];
  let current = "";
  let carryover = "";

  function flush() {
    const text = current.trim();
    if (!text) return;
    chunks.push({ text, tokenCount: estimateTokens(text) });
    carryover = overlapWords > 0 ? lastNWords(text, overlapWords) : "";
    current = "";
  }

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : carryover ? `${carryover}\n\n${unit}` : unit;
    if (estimateTokens(candidate) <= chunkSizeTokens) {
      current = candidate;
      continue;
    }

    if (!current) {
      chunks.push({ text: unit, tokenCount: estimateTokens(unit) });
      carryover = overlapWords > 0 ? lastNWords(unit, overlapWords) : "";
      continue;
    }

    flush();
    current = carryover ? `${carryover}\n\n${unit}` : unit;
  }

  flush();
  return chunks;
}

export async function runChunkDocuments(options: ChunkOptions = {}): Promise<ChunkSummary> {
  const prisma = new PrismaClient();
  const reprocess = Boolean(options.reprocess);
  const chunkSizeTokens = parseEnvNumber("CHUNK_SIZE_TOKENS", DEFAULT_CHUNK_SIZE_TOKENS);
  const overlapTokens = parseEnvNumber("CHUNK_OVERLAP_TOKENS", DEFAULT_CHUNK_OVERLAP_TOKENS);
  const fileBatchSize = parseEnvNumber("CHUNK_FILE_BATCH_SIZE", DEFAULT_FILE_BATCH_SIZE);

  const summary: ChunkSummary = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0
  };

  console.log(`Mode: ${reprocess ? "reprocess" : "incremental"}`);
  console.log(`Config: chunkSizeTokens=${chunkSizeTokens}, overlapTokens=${overlapTokens}`);

  try {
    const baseWhere: {
      fullText: { not: string };
      id?: number;
      path?: { startsWith: string };
    } = {
      fullText: { not: "" }
    };

    if (options.fileId != null && Number.isFinite(options.fileId)) {
      baseWhere.id = options.fileId;
    }
    if (options.pathPrefix && options.pathPrefix.trim()) {
      baseWhere.path = { startsWith: options.pathPrefix.trim() };
    }

    summary.totalFiles = await prisma.file.count({ where: baseWhere });
    console.log(`Found ${summary.totalFiles} file(s) to evaluate.`);

    let lastId = 0;
    while (true) {
      const where: {
        fullText: { not: string };
        id?: number | { gt: number };
        path?: { startsWith: string };
      } = { ...baseWhere };
      if (options.fileId == null) where.id = { gt: lastId };

      const files = await prisma.file.findMany({
        where,
        orderBy: { id: "asc" },
        take: options.fileId == null ? fileBatchSize : 1,
        select: {
          id: true,
          path: true,
          fullText: true
        }
      });

      if (files.length === 0) break;
      lastId = files[files.length - 1]!.id;

      for (const [idx, file] of files.entries()) {
        const fullText = file.fullText.trim();
        const label = `[${idx + 1}/${files.length}] ${file.path}`;

        if (!fullText) {
          summary.skipped++;
          console.log(`${label} - skipped (empty fullText)`);
          continue;
        }

        try {
          if (reprocess) {
            await prisma.documentChunk.deleteMany({ where: { fileId: file.id } });
          } else {
            const existing = await prisma.documentChunk.count({ where: { fileId: file.id } });
            if (existing > 0) {
              summary.skipped++;
              console.log(`${label} - skipped (${existing} chunks already exist)`);
              continue;
            }
          }

          const chunks = chunkTextRecursive({
            text: fullText,
            chunkSizeTokens,
            overlapTokens
          });

          if (chunks.length === 0) {
            summary.skipped++;
            console.log(`${label} - skipped (chunker produced 0 chunks)`);
            continue;
          }

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            await prisma.documentChunk.create({
              data: {
                fileId: file.id,
                chunkIndex: i,
                content: chunk.text,
                tokenCount: chunk.tokenCount,
                pageNumber: null
              }
            });
          }

          summary.processed++;
          summary.totalChunks += chunks.length;
          console.log(`${label} - processed (${chunks.length} chunks)`);
        } catch (err) {
          summary.failed++;
          console.error(`${label} - failed\n${toErrorMessage(err)}`);
        }
      }

      if (options.fileId != null) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: totalFiles=${summary.totalFiles}, processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}, totalChunks=${summary.totalChunks}`
  );

  return summary;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("chunk_documents")
    .description("Split File.fullText into DocumentChunk rows.")
    .option("--reprocess [value]", "Delete existing chunks and rebuild them", "0")
    .option("--file-id <id>", "Only process one file id")
    .option("--path-prefix <prefix>", "Only process files whose path starts with prefix");

  program.parse(process.argv);
  const opts = program.opts<{
    reprocess: string | boolean;
    fileId?: string;
    pathPrefix?: string;
  }>();

  const summary = await runChunkDocuments({
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

import { Command } from "commander";
import process from "node:process";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

type ChunkOptions = {
  reprocess?: boolean;
  fileId?: number;
  pathPrefix?: string;
};

type ChunkSummary = {
  totalFiles: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
};

type TextChunk = {
  text: string;
  tokenCount: number;
};

const DEFAULT_CHUNK_SIZE_TOKENS = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 120; // ~15% overlap
const DEFAULT_FILE_BATCH_SIZE = 10;

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

// Heuristic token estimation for MVP. Replace with real tokenizer later.
function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.ceil(words * 1.3));
}

function splitRecursive(text: string, chunkSizeTokens: number, level: number = 0): string[] {
  const raw = text.trim();
  if (!raw) return [];
  if (estimateTokens(raw) <= chunkSizeTokens) return [raw];

  const splitters: Array<(input: string) => string[]> = [
    (input) => input.split(/\n{2,}/g),
    (input) => input.split(/\n/g),
    (input) => input.split(/(?<=[.!?])\s+/g),
    (input) => input.split(/\s+/g)
  ];

  if (level >= splitters.length) {
    const words = raw.split(/\s+/).filter(Boolean);
    const sizeWords = Math.max(50, Math.round(chunkSizeTokens / 1.3));
    const parts: string[] = [];
    for (let i = 0; i < words.length; i += sizeWords) {
      parts.push(words.slice(i, i + sizeWords).join(" "));
    }
    return parts.filter(Boolean);
  }

  const splitter = splitters[level];
  if (!splitter) return splitRecursive(raw, chunkSizeTokens, level + 1);

  const parts = splitter(raw).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return splitRecursive(raw, chunkSizeTokens, level + 1);

  const out: string[] = [];
  for (const part of parts) {
    if (estimateTokens(part) <= chunkSizeTokens) {
      out.push(part);
      continue;
    }
    out.push(...splitRecursive(part, chunkSizeTokens, level + 1));
  }
  return out.filter(Boolean);
}

function lastNWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return text.trim();
  return words.slice(words.length - n).join(" ");
}

function chunkTextRecursive(args: {
  text: string;
  chunkSizeTokens: number;
  overlapTokens: number;
}): TextChunk[] {
  const chunkSizeTokens = Math.max(100, args.chunkSizeTokens);
  const overlapTokens = Math.max(0, Math.min(chunkSizeTokens - 1, args.overlapTokens));
  const units = splitRecursive(args.text, chunkSizeTokens);
  if (units.length === 0) return [];

  const overlapWords = Math.max(0, Math.round(overlapTokens / 1.3));
  const chunks: TextChunk[] = [];
  let current = "";
  let carryover = "";

  function flush() {
    const text = current.trim();
    if (!text) return;
    chunks.push({ text, tokenCount: estimateTokens(text) });
    carryover = overlapWords > 0 ? lastNWords(text, overlapWords) : "";
    current = "";
  }

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : carryover ? `${carryover}\n\n${unit}` : unit;
    if (estimateTokens(candidate) <= chunkSizeTokens) {
      current = candidate;
      continue;
    }

    if (!current) {
      chunks.push({ text: unit, tokenCount: estimateTokens(unit) });
      carryover = overlapWords > 0 ? lastNWords(unit, overlapWords) : "";
      continue;
    }

    flush();
    current = carryover ? `${carryover}\n\n${unit}` : unit;
  }

  flush();
  return chunks;
}

export async function runChunkDocuments(options: ChunkOptions = {}): Promise<ChunkSummary> {
  const prisma = new PrismaClient();
  const reprocess = Boolean(options.reprocess);
  const chunkSizeTokens = parseEnvNumber("CHUNK_SIZE_TOKENS", DEFAULT_CHUNK_SIZE_TOKENS);
  const overlapTokens = parseEnvNumber("CHUNK_OVERLAP_TOKENS", DEFAULT_CHUNK_OVERLAP_TOKENS);
  const fileBatchSize = parseEnvNumber("CHUNK_FILE_BATCH_SIZE", DEFAULT_FILE_BATCH_SIZE);

  const summary: ChunkSummary = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0
  };

  console.log(`Mode: ${reprocess ? "reprocess" : "incremental"}`);
  console.log(`Config: chunkSizeTokens=${chunkSizeTokens}, overlapTokens=${overlapTokens}`);

  try {
    const baseWhere: {
      fullText: { not: string };
      id?: number;
      path?: { startsWith: string };
    } = {
      fullText: { not: "" }
    };

    if (options.fileId != null && Number.isFinite(options.fileId)) {
      baseWhere.id = options.fileId;
    }
    if (options.pathPrefix && options.pathPrefix.trim()) {
      baseWhere.path = { startsWith: options.pathPrefix.trim() };
    }

    summary.totalFiles = await prisma.file.count({ where: baseWhere });
    console.log(`Found ${summary.totalFiles} file(s) to evaluate.`);

    let lastId = 0;
    while (true) {
      const where: {
        fullText: { not: string };
        id?: number | { gt: number };
        path?: { startsWith: string };
      } = { ...baseWhere };
      if (options.fileId == null) where.id = { gt: lastId };

      const files = await prisma.file.findMany({
        where,
        orderBy: { id: "asc" },
        take: options.fileId == null ? fileBatchSize : 1,
        select: {
          id: true,
          path: true,
          fullText: true
        }
      });

      if (files.length === 0) break;
      lastId = files[files.length - 1]!.id;

      for (const [idx, file] of files.entries()) {
        const fullText = file.fullText.trim();
        const label = `[${idx + 1}/${files.length}] ${file.path}`;

        if (!fullText) {
          summary.skipped++;
          console.log(`${label} - skipped (empty fullText)`);
          continue;
        }

        try {
          if (reprocess) {
            await prisma.documentChunk.deleteMany({ where: { fileId: file.id } });
          } else {
            const existing = await prisma.documentChunk.count({ where: { fileId: file.id } });
            if (existing > 0) {
              summary.skipped++;
              console.log(`${label} - skipped (${existing} chunks already exist)`);
              continue;
            }
          }

          const chunks = chunkTextRecursive({
            text: fullText,
            chunkSizeTokens,
            overlapTokens
          });

          if (chunks.length === 0) {
            summary.skipped++;
            console.log(`${label} - skipped (chunker produced 0 chunks)`);
            continue;
          }

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            await prisma.documentChunk.create({
              data: {
                fileId: file.id,
                chunkIndex: i,
                content: chunk.text,
                tokenCount: chunk.tokenCount,
                pageNumber: null
              }
            });
          }

          summary.processed++;
          summary.totalChunks += chunks.length;
          console.log(`${label} - processed (${chunks.length} chunks)`);
        } catch (err) {
          summary.failed++;
          console.error(`${label} - failed\n${toErrorMessage(err)}`);
        }
      }

      if (options.fileId != null) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: totalFiles=${summary.totalFiles}, processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}, totalChunks=${summary.totalChunks}`
  );

  return summary;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("chunk_documents")
    .description("Split File.fullText into DocumentChunk rows.")
    .option("--reprocess [value]", "Delete existing chunks and rebuild them", "0")
    .option("--file-id <id>", "Only process one file id")
    .option("--path-prefix <prefix>", "Only process files whose path starts with prefix");

  program.parse(process.argv);
  const opts = program.opts<{
    reprocess: string | boolean;
    fileId?: string;
    pathPrefix?: string;
  }>();

  const summary = await runChunkDocuments({
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

import { Command } from "commander";
import process from "node:process";
import dotenv from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";

dotenv.config();

type ChunkOptions = {
  reprocess?: boolean;
  fileId?: number;
  pathPrefix?: string;
  skipEmbeddings?: boolean;
};

type ChunkSummary = {
  totalFiles: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
};

type TextChunk = {
  text: string;
  tokenCount: number;
};

const DEFAULT_CHUNK_SIZE_TOKENS = 800;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 120; // ~15% overlap
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_BATCH_SIZE = 50;
const DEFAULT_EMBEDDING_DELAY_MS = 100;
const DEFAULT_FILE_BATCH_SIZE = 10;

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

// Heuristic token estimation for MVP. Replace with real tokenizer later.
function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.ceil(words * 1.3));
}

function splitRecursive(text: string, chunkSizeTokens: number, level: number = 0): string[] {
  const raw = text.trim();
  if (!raw) return [];
  if (estimateTokens(raw) <= chunkSizeTokens) return [raw];

  const splitters: Array<(input: string) => string[]> = [
    (input) => input.split(/\n{2,}/g),
    (input) => input.split(/\n/g),
    (input) => input.split(/(?<=[.!?])\s+/g),
    (input) => input.split(/\s+/g)
  ];

  if (level >= splitters.length) {
    const words = raw.split(/\s+/).filter(Boolean);
    const sizeWords = Math.max(50, Math.round(chunkSizeTokens / 1.3));
    const parts: string[] = [];
    for (let i = 0; i < words.length; i += sizeWords) {
      parts.push(words.slice(i, i + sizeWords).join(" "));
    }
    return parts.filter(Boolean);
  }

  const splitter = splitters[level];
  if (!splitter) {
    return splitRecursive(raw, chunkSizeTokens, level + 1);
  }

  const parts = splitter(raw).map((p) => p.trim()).filter(Boolean);
  
  if (parts.length <= 1) {
    return splitRecursive(raw, chunkSizeTokens, level + 1);
  }

  const out: string[] = [];
  for (const part of parts) {
    if (estimateTokens(part) <= chunkSizeTokens) {
      out.push(part);
      continue;
    }
    out.push(...splitRecursive(part, chunkSizeTokens, level + 1));
  }
  return out.filter(Boolean);
}

function lastNWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return text.trim();
  return words.slice(words.length - n).join(" ");
}

function chunkTextRecursive(args: {
  text: string;
  chunkSizeTokens: number;
  overlapTokens: number;
}): TextChunk[] {
  const chunkSizeTokens = Math.max(100, args.chunkSizeTokens);
  const overlapTokens = Math.max(0, Math.min(chunkSizeTokens - 1, args.overlapTokens));
  const units = splitRecursive(args.text, chunkSizeTokens);
  if (units.length === 0) return [];

  const overlapWords = Math.max(0, Math.round(overlapTokens / 1.3));
  const chunks: TextChunk[] = [];

  let current = "";
  let carryover = "";

  function flush() {
    const text = current.trim();
    if (!text) return;
    chunks.push({ text, tokenCount: estimateTokens(text) });
    carryover = overlapWords > 0 ? lastNWords(text, overlapWords) : "";
    current = "";
  }

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : carryover ? `${carryover}\n\n${unit}` : unit;
    if (estimateTokens(candidate) <= chunkSizeTokens) {
      current = candidate;
      continue;
    }

    if (!current) {
      chunks.push({ text: unit, tokenCount: estimateTokens(unit) });
      carryover = overlapWords > 0 ? lastNWords(unit, overlapWords) : "";
      continue;
    }

    flush();
    current = carryover ? `${carryover}\n\n${unit}` : unit;
  }

  flush();
  return chunks;
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

export async function runChunkDocuments(options: ChunkOptions = {}): Promise<ChunkSummary> {
  const prisma = new PrismaClient();
  const reprocess = Boolean(options.reprocess);
  const skipEmbeddings = Boolean(options.skipEmbeddings);

  const chunkSizeTokens = parseEnvNumber("CHUNK_SIZE_TOKENS", DEFAULT_CHUNK_SIZE_TOKENS);
  const overlapTokens = parseEnvNumber("CHUNK_OVERLAP_TOKENS", DEFAULT_CHUNK_OVERLAP_TOKENS);
  const embeddingModel = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const embeddingBatchSize = parseEnvNumber("EMBEDDING_BATCH_SIZE", DEFAULT_EMBEDDING_BATCH_SIZE);
  const embeddingDelayMs = parseEnvNumber("EMBEDDING_DELAY_MS", DEFAULT_EMBEDDING_DELAY_MS);
  const fileBatchSize = parseEnvNumber("CHUNK_FILE_BATCH_SIZE", DEFAULT_FILE_BATCH_SIZE);

  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!skipEmbeddings && !apiKey) {
    throw new Error("OPENAI_API_KEY is required unless --skip-embeddings=1");
  }

  const summary: ChunkSummary = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0
  };

  console.log(`Mode: ${reprocess ? "reprocess" : "incremental"}`);
  console.log(
    `Config: chunkSizeTokens=${chunkSizeTokens}, overlapTokens=${overlapTokens}, embeddingModel=${embeddingModel}, skipEmbeddings=${skipEmbeddings}`
  );

  try {
    const baseWhere: Prisma.FileWhereInput = {
      fullText: { not: "" }
    };

    if (options.fileId != null && Number.isFinite(options.fileId)) {
      baseWhere.id = options.fileId;
    }
    if (options.pathPrefix && options.pathPrefix.trim()) {
      baseWhere.path = { startsWith: options.pathPrefix.trim() };
    }

    summary.totalFiles = await prisma.file.count({ where: baseWhere });
    console.log(`Found ${summary.totalFiles} file(s) to evaluate.`);

    let lastId = 0;
    while (true) {
      const where: Prisma.FileWhereInput = { ...baseWhere };
      if (options.fileId == null) where.id = { gt: lastId };

      const files = await prisma.file.findMany({
        where,
        orderBy: { id: "asc" },
        take: options.fileId == null ? fileBatchSize : 1,
        select: {
          id: true,
          path: true,
          fullText: true
        }
      });

      if (files.length === 0) break;
      lastId = files[files.length - 1]!.id;

      for (const [idx, file] of files.entries()) {
        const fullText = file.fullText.trim();
        const label = `[${idx + 1}/${files.length}] ${file.path}`;

        if (!fullText) {
          summary.skipped++;
          console.log(`${label} - skipped (empty fullText)`);
          continue;
        }

        try {
          if (reprocess) {
            await prisma.documentChunk.deleteMany({ where: { fileId: file.id } });
          } else {
            const existing = await prisma.documentChunk.count({ where: { fileId: file.id } });
            if (existing > 0) {
              summary.skipped++;
              console.log(`${label} - skipped (${existing} chunks already exist)`);
              continue;
            }
          }

          const chunks = chunkTextRecursive({
            text: fullText,
            chunkSizeTokens,
            overlapTokens
          });

          if (chunks.length === 0) {
            summary.skipped++;
            console.log(`${label} - skipped (chunker produced 0 chunks)`);
            continue;
          }

          const createdRows: Array<{ id: number; content: string }> = [];
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const created = await prisma.documentChunk.create({
              data: {
                fileId: file.id,
                chunkIndex: i,
                content: chunk.text,
                tokenCount: chunk.tokenCount,
                pageNumber: null
              },
              select: { id: true, content: true }
            });
            createdRows.push(created);
          }

          if (!skipEmbeddings) {
            for (let i = 0; i < createdRows.length; i += embeddingBatchSize) {
              const batch = createdRows.slice(i, i + embeddingBatchSize);
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

              if (embeddingDelayMs > 0) await sleep(embeddingDelayMs);
            }
          }

          summary.processed++;
          summary.totalChunks += createdRows.length;
          console.log(`${label} - processed (${createdRows.length} chunks)`);
        } catch (err) {
          summary.failed++;
          console.error(`${label} - failed\n${toErrorMessage(err)}`);
        }
      }

      if (options.fileId != null) break;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: totalFiles=${summary.totalFiles}, processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}, totalChunks=${summary.totalChunks}`
  );

  return summary;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("chunk_documents")
    .description("Split File.fullText into DocumentChunk rows and generate embeddings.")
    .option("--reprocess [value]", "Delete existing chunks and rebuild them", "0")
    .option("--file-id <id>", "Only process one file id")
    .option("--path-prefix <prefix>", "Only process files whose path starts with prefix")
    .option("--skip-embeddings [value]", "Create chunks without calling embeddings API", "0");

  program.parse(process.argv);
  const opts = program.opts<{
    reprocess: string | boolean;
    fileId?: string;
    pathPrefix?: string;
    skipEmbeddings: string | boolean;
  }>();

  const summary = await runChunkDocuments({
    reprocess: parseBooleanFlag(opts.reprocess),
    fileId: opts.fileId ? Number(opts.fileId) : undefined,
    pathPrefix: opts.pathPrefix?.trim(),
    skipEmbeddings: parseBooleanFlag(opts.skipEmbeddings)
  });

  if (summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(toErrorMessage(err));
    process.exitCode = 1;
  });
}

