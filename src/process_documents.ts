import { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { PDFParse } from "pdf-parse";
import { PrismaClient } from "@prisma/client";

dotenv.config();

type DiscoveredDocument = {
  absolutePath: string;
  relativePath: string;
  filename: string;
};

type ProcessOptions = {
  documentsPath?: string;
  reprocess?: boolean;
};

type ProcessSummary = {
  discovered: number;
  processed: number;
  skipped: number;
  failed: number;
};

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".eml"]);

function parseBooleanFlag(v: string | boolean | undefined): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

function isSupportedDocument(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function discoverDocuments(documentsRoot: string): Promise<DiscoveredDocument[]> {
  const rootAbs = path.resolve(documentsRoot);
  const results: DiscoveredDocument[] = [];

  async function walk(dirAbs: string): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSupportedDocument(absPath)) continue;

      const rel = toPosixPath(path.relative(rootAbs, absPath));
      results.push({
        absolutePath: absPath,
        relativePath: rel,
        filename: entry.name
      });
    }
  }

  await walk(rootAbs);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

function sha256Bytes(input: Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function detectFileTypeFromText(fullText: string): "EMAIL" | "OTHER" {
  const headerWindow = fullText.slice(0, 4000);
  const hasFrom = /^From:/im.test(headerWindow);
  const hasTo = /^To:/im.test(headerWindow);
  const hasSubject = /^Subject:/im.test(headerWindow);
  const hasDateOrSent = /^Date:/im.test(headerWindow) || /^Sent:/im.test(headerWindow);

  return hasFrom && hasTo && hasSubject && hasDateOrSent ? "EMAIL" : "OTHER";
}

async function extractTextAndPageCount(filePath: string, bytes: Buffer): Promise<{ fullText: string; pageCount: number | null }> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const parser = new PDFParse({ data: bytes });

    try {

// const images = await parser.getImage();
// const info = await parser.getInfo();
// const table = await parser.();
// console.log("\n\nimages", JSON.stringify(images, null, 2));
// console.log("\n\ninfo", info);
// console.log("\n\ntable", JSON.stringify(table, null, 2));


      const parsed = await parser.getText();
     // console.log("\n\nparsed", parsed);
      return {
        fullText: (parsed.text ?? "").trim(),
        pageCount: parsed.total ?? null
      };
    } finally {
      await parser.destroy();
    }
  }

  return {
    fullText: bytes.toString("utf8").trim(),
    pageCount: null
  };
}

export async function runProcessDocuments(options: ProcessOptions = {}): Promise<ProcessSummary> {
  const prisma = new PrismaClient();
  const documentsPath = options.documentsPath ?? process.env.DOCUMENTS_PATH ?? "./documents";
  const documentsRootAbs = path.resolve(documentsPath);
  const reprocess = Boolean(options.reprocess);

  const summary: ProcessSummary = {
    discovered: 0,
    processed: 0,
    skipped: 0,
    failed: 0
  };

  console.log(`Documents root: ${documentsRootAbs}`);
  console.log(`Mode: ${reprocess ? "reprocess" : "skip existing files"}`);

  try {
    const docs = await discoverDocuments(documentsRootAbs);
    summary.discovered = docs.length;
    console.log(`Discovered ${docs.length} supported document(s).`);

    for (const [index, doc] of docs.entries()) {
      const label = `[${index + 1}/${docs.length}] ${doc.relativePath}`;
      try {
        const existing = await prisma.file.findUnique({
          where: { path: doc.relativePath },
          select: { id: true }
        });

        if (existing && !reprocess) {
          summary.skipped++;
          console.log(`${label} - skipped (already in DB)`);
          continue;
        }

        const stat = await fs.stat(doc.absolutePath);
        const rawBytes = await fs.readFile(doc.absolutePath);
        const contentHash = sha256Bytes(rawBytes);
        const { fullText, pageCount } = await extractTextAndPageCount(doc.absolutePath, rawBytes);
        const fileType = detectFileTypeFromText(fullText);

        await prisma.file.upsert({
          where: { path: doc.relativePath },
          create: {
            path: doc.relativePath,
            type: fileType,
            fullText,
            size: BigInt(stat.size),
            pageCount,
            summary: null,
            contentHash
          },
          update: {
            type: fileType,
            fullText,
            size: BigInt(stat.size),
            pageCount,
            summary: null,
            contentHash
          }
        });

        summary.processed++;
        console.log(`${label} - processed`);
      } catch (err) {
        summary.failed++;
        console.error(`${label} - failed\n${toErrorMessage(err)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: discovered=${summary.discovered}, processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}`
  );

  return summary;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("process_documents")
    .description("Scan local documents and store extracted text in the File table.")
    .option("--reprocess [value]", "Process files even if they already exist in DB", "0")
    .option("--documents-path <path>", "Override DOCUMENTS_PATH env var");

  program.parse(process.argv);
  const opts = program.opts<{ reprocess: string | boolean; documentsPath?: string }>();

  const summary = await runProcessDocuments({
    documentsPath: opts.documentsPath,
    reprocess: parseBooleanFlag(opts.reprocess)
  });

  if (summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(toErrorMessage(err));
    process.exitCode = 1;
  });
}

