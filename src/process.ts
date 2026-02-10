import { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import pdfParse from "pdf-parse";
import dotenv from "dotenv";

dotenv.config();

type DiscoveredFile = {
  absPath: string;
  filepath: string; // stored in DB; relative to documents root (POSIX-like)
  legacyFilepathAbs: string; // backward-compat: older runs stored absolute paths
  dataset: string;
  filename: string;
};

type Counters = {
  processed: number;
  failed: number;
  skipped: number;
};

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function isPdfFile(p: string): boolean {
  return path.extname(p).toLowerCase() === ".pdf";
}

async function sha256File(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function discoverPdfFiles(documentsRoot: string): Promise<DiscoveredFile[]> {
  const rootAbs = path.resolve(documentsRoot);
  const out: DiscoveredFile[] = [];

  async function walk(dirAbs: string) {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const ent of entries) {
      const entAbs = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        await walk(entAbs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!isPdfFile(ent.name)) continue;

      const relFromRoot = path.relative(rootAbs, entAbs);
      const filepath = relFromRoot.split(path.sep).join(path.posix.sep);
      const [datasetMaybe] = relFromRoot.split(path.sep);
      const dataset = datasetMaybe && datasetMaybe !== "" ? datasetMaybe : "unknown";

      out.push({
        absPath: entAbs,
        filepath,
        legacyFilepathAbs: entAbs,
        dataset,
        filename: ent.name
      });
    }
  }

  await walk(rootAbs);
  out.sort((a, b) => a.filepath.localeCompare(b.filepath));
  return out;
}

async function extractPdfTextAndPages(absPath: string): Promise<{ fullText: string; pageCount: number }> {
  const data = await fs.readFile(absPath);
  const parsed = await pdfParse(data);
  return {
    fullText: (parsed.text ?? "").trim(),
    pageCount: parsed.numpages ?? 0
  };
}

async function main() {
  const program = new Command();
  program
    .name("process")
    .description("Process PDFs in DOCUMENTS_PATH and store metadata in Postgres via Prisma.")
    .option("--reprocess [value]", "Reprocess all files regardless of DB state (use --reprocess=1)", "0");

  program.parse(process.argv);
  const opts = program.opts<{ reprocess: string | boolean }>();

  const reprocess =
    opts.reprocess === true ||
    opts.reprocess === "1" ||
    opts.reprocess === "true" ||
    opts.reprocess === "yes";

  const documentsPath = process.env.DOCUMENTS_PATH ?? "./documents";
  const documentsRootAbs = path.resolve(documentsPath);

  const prisma = new PrismaClient();
  const counters: Counters = { processed: 0, failed: 0, skipped: 0 };

  console.log(`Documents root: ${documentsRootAbs}`);
  console.log(`Mode: ${reprocess ? "reprocess all" : "process new/changed only"}`);

  try {
    const files = await discoverPdfFiles(documentsRootAbs);
    console.log(`Discovered ${files.length} PDF(s).`);

    for (const [i, f] of files.entries()) {
      const label = `[${i + 1}/${files.length}] ${f.dataset}/${f.filename}`;
      console.log(`${label} - scanning`);

      try {
        const stat = await fs.stat(f.absPath);
        const sizeBytes = BigInt(stat.size);
        const createdAt = stat.birthtime;
        const modifiedAt = stat.mtime;

        const contentHash = await sha256File(f.absPath);

        if (!reprocess) {
          const existingRel = await prisma.file.findUnique({
            where: { filepath: f.filepath },
            select: { id: true, contentHash: true, status: true }
          });

          const existingAbs = existingRel
            ? null
            : await prisma.file.findUnique({
                where: { filepath: f.legacyFilepathAbs },
                select: { id: true, contentHash: true, status: true, filepath: true }
              });

          // If we found a legacy absolute-path row, migrate it to the new relative filepath
          // so future runs consistently skip correctly.
          if (existingAbs && existingAbs.filepath !== f.filepath) {
            await prisma.file.update({
              where: { id: existingAbs.id },
              data: { filepath: f.filepath, dataset: f.dataset, filename: f.filename }
            });
          }

          const existing = existingRel ?? existingAbs;

          if (existing && existing.contentHash === contentHash && existing.status === "processed") {
            counters.skipped++;
            console.log(`${label} - skipped (unchanged)`);
            continue;
          }
        }

        console.log(`${label} - extracting text`);
        const { fullText, pageCount } = await extractPdfTextAndPages(f.absPath);

        await prisma.file.upsert({
          where: { filepath: f.filepath },
          create: {
            filename: f.filename,
            filepath: f.filepath,
            dataset: f.dataset,
            fileType: "pdf",
            sizeBytes,
            pageCount,
            contentHash,
            fullText,
            createdAt,
            modifiedAt,
            processedAt: new Date(),
            status: "processed",
            errorMessage: null
          },
          update: {
            filename: f.filename,
            dataset: f.dataset,
            fileType: "pdf",
            sizeBytes,
            pageCount,
            contentHash,
            fullText,
            createdAt,
            modifiedAt,
            processedAt: new Date(),
            status: "processed",
            errorMessage: null
          }
        });

        counters.processed++;
        console.log(`${label} - processed (${pageCount} page(s))`);
      } catch (err) {
        counters.failed++;
        const errorMessage = toErrorMessage(err);
        console.error(`${label} - failed\n${errorMessage}`);

        // Best-effort: record failure in DB if possible.
        try {
          const stat = await fs.stat(f.absPath);
          const sizeBytes = BigInt(stat.size);
          const createdAt = stat.birthtime;
          const modifiedAt = stat.mtime;
          const contentHash = await sha256File(f.absPath);

          await prisma.file.upsert({
            where: { filepath: f.filepath },
            create: {
              filename: f.filename,
              filepath: f.filepath,
              dataset: f.dataset,
              fileType: "pdf",
              sizeBytes,
              pageCount: 0,
              contentHash,
              fullText: null,
              createdAt,
              modifiedAt,
              processedAt: new Date(),
              status: "failed",
              errorMessage
            },
            update: {
              filename: f.filename,
              dataset: f.dataset,
              fileType: "pdf",
              sizeBytes,
              pageCount: 0,
              contentHash,
              fullText: null,
              createdAt,
              modifiedAt,
              processedAt: new Date(),
              status: "failed",
              errorMessage
            }
          });
        } catch (dbErr) {
          console.error(`(also failed to write failure status) ${toErrorMessage(dbErr)}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nSummary: processed=${counters.processed}, failed=${counters.failed}, skipped=${counters.skipped}`
  );
  process.exitCode = counters.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(toErrorMessage(err));
  process.exitCode = 1;
});

