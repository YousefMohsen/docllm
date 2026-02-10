import { Command } from "commander";
import process from "node:process";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

type EntityType = "PERSON" | "LOCATION" | "ORGANIZATION";

type ExtractedEntity = {
  text: string;
  type: EntityType;
  context?: string;
  position?: number;
};

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function parseBooleanFlag(v: string | boolean | undefined): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function parseEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function chunkTextByMaxChars(fullText: string, maxChars: number): Array<{ offset: number; text: string }> {
  if (fullText.length <= maxChars) return [{ offset: 0, text: fullText }];

  const chunks: Array<{ offset: number; text: string }> = [];
  let start = 0;

  while (start < fullText.length) {
    let end = Math.min(start + maxChars, fullText.length);
    if (end < fullText.length) {
      const boundary = fullText.lastIndexOf("\n\n", end);
      // avoid tiny remainder chunks
      if (boundary > start + Math.min(1000, Math.floor(maxChars * 0.25))) {
        end = boundary + 2; // include the delimiter
      }
    }
    chunks.push({ offset: start, text: fullText.slice(start, end) });
    start = end;
  }

  return chunks;
}

function buildContextSnippet(fullText: string, position: number, entityLen: number): string {
  const before = 100;
  const after = 100;
  const start = Math.max(0, position - before);
  const end = Math.min(fullText.length, position + Math.max(entityLen, 1) + after);
  return fullText.slice(start, end);
}

const SYSTEM_PROMPT = `You are an expert at extracting named entities from documents.

Extract all people (PERSON), locations (LOCATION), and organizations (ORGANIZATION) mentioned in the provided text.

Return your response as a JSON object with this exact structure:
{
  "entities": [
    {
      "text": "John Smith",
      "type": "PERSON",
      "context": "...text before...John Smith...text after...",
      "position": 145
    }
  ]
}

Rules:
- Extract the entity exactly as it appears in the text
- Include surrounding context (about 100 characters)
- Provide the character position where the entity appears in the provided text
- Only use these types: PERSON, LOCATION, ORGANIZATION
- If no entities found, return { "entities": [] }
- Do not include pronouns or generic terms`;

async function callOpenAiExtractEntities(args: {
  apiKey: string;
  model: string;
  text: string;
}): Promise<ExtractedEntity[]> {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Extract entities from this document:\n\n${args.text}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0
    })
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI API error ${resp.status}: ${raw}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI response was not valid JSON: ${raw.slice(0, 500)}`);
  }

  const content: unknown = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`OpenAI response missing message content: ${raw.slice(0, 500)}`);
  }

  let json: any;
  try {
    json = JSON.parse(content);
  } catch {
    // Best-effort: sometimes content may already be array-ish text; attempt to recover.
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      json = JSON.parse(trimmed);
    } else {
      throw new Error(`Model content was not valid JSON: ${content.slice(0, 500)}`);
    }
  }

  const entitiesMaybe = Array.isArray(json) ? json : json?.entities;
  if (!Array.isArray(entitiesMaybe)) return [];

  const out: ExtractedEntity[] = [];
  for (const e of entitiesMaybe) {
    const text = typeof e?.text === "string" ? e.text : "";
    const type = e?.type as EntityType;
    const context = typeof e?.context === "string" ? e.context : undefined;
    const position = typeof e?.position === "number" ? e.position : undefined;
    if (!text.trim()) continue;
    if (type !== "PERSON" && type !== "LOCATION" && type !== "ORGANIZATION") continue;
    out.push({ text, type, context, position });
  }
  return out;
}

async function callOpenAiExtractEntitiesWithRetry(args: {
  apiKey: string;
  model: string;
  text: string;
  maxAttempts: number;
}): Promise<ExtractedEntity[]> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    try {
      return await callOpenAiExtractEntities({ apiKey: args.apiKey, model: args.model, text: args.text });
    } catch (err) {
      lastErr = err;
      const backoffMs = 400 * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function main() {
  const program = new Command();
  program
    .name("extract-entities")
    .description("Extract named entities from processed files and store them in Postgres via Prisma.")
    .option("--reprocess [value]", "Re-extract for all files (use --reprocess=1)", "0")
    .option("--file-id <id>", "Extract entities for a specific file id")
    .option("--dataset <name>", "Extract entities only for a specific dataset");

  program.parse(process.argv);
  const opts = program.opts<{ reprocess: string | boolean; fileId?: string; dataset?: string }>();

  const reprocess = parseBooleanFlag(opts.reprocess);
  const fileId = opts.fileId ? Number(opts.fileId) : undefined;
  const dataset = opts.dataset?.trim() ? opts.dataset.trim() : undefined;

  const model = process.env.EXTRACTION_MODEL ?? "gpt-4o-mini";
  const delayMs = parseEnvNumber("EXTRACTION_DELAY_MS", 200);
  const batchSize = parseEnvNumber("EXTRACTION_BATCH_SIZE", 10);
  const maxChars = parseEnvNumber("EXTRACTION_MAX_CHARS", 100000);

  const prisma = new PrismaClient();
  const startedAt = Date.now();

  const stats = {
    totalFiles: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalEntities: 0,
    totalMentions: 0
  };

  console.log("Starting entity extraction...");
  console.log(`Mode: ${reprocess ? "reprocess all" : "extract from unprocessed only"}`);
  if (fileId != null && Number.isFinite(fileId)) console.log(`Filter: fileId=${fileId}`);
  if (dataset) console.log(`Filter: dataset=${dataset}`);
  console.log(`Model: ${model}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Delay: ${delayMs}ms`);
  console.log(`Chunk max chars: ${maxChars}`);

  try {
    if (fileId != null && !Number.isFinite(fileId)) {
      throw new Error(`Invalid --file-id value: ${opts.fileId}`);
    }

    const baseWhere: any = { status: "processed" };
    if (dataset) baseWhere.dataset = dataset;
    if (!reprocess && fileId == null) baseWhere.entitiesExtracted = false;
    if (fileId != null) baseWhere.id = fileId;

    stats.totalFiles = await prisma.file.count({ where: baseWhere });
    console.log(`Found ${stats.totalFiles} file(s) to process\n`);

    if (stats.totalFiles === 0) {
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY in environment (.env).");
    }

    let cursor: { id: number } | undefined = undefined;
    let seen = 0;

    while (true) {
      const files: Array<{
        id: number;
        dataset: string;
        filename: string;
        filepath: string;
        fullText: string | null;
        entitiesExtracted: boolean;
      }> = await prisma.file.findMany({
        where: baseWhere,
        orderBy: { id: "asc" },
        take: fileId != null ? 1 : batchSize,
        ...(cursor ? { cursor, skip: 1 } : {}),
        select: {
          id: true,
          dataset: true,
          filename: true,
          filepath: true,
          fullText: true,
          entitiesExtracted: true
        }
      });

      if (files.length === 0) break;

      for (const f of files) {
        seen++;
        const label = `[${seen}/${stats.totalFiles}] ${f.filepath}`;
        console.log(label);

        if (!reprocess && f.entitiesExtracted) {
          stats.skipped++;
          console.log("  ⚠ Skipping: entities already extracted\n");
          continue;
        }

        const fullText = (f.fullText ?? "").trim();
        if (!fullText) {
          stats.skipped++;
          console.log("  ⚠ Skipping: no text content\n");
          continue;
        }
        if (fullText.length < 50) {
          stats.skipped++;
          console.log("  ⚠ Skipping: text too short\n");
          continue;
        }

        try {
          const chunks = chunkTextByMaxChars(fullText, maxChars);
          const mentions: Array<{
            entityText: string;
            entityType: EntityType;
            normalizedText: string;
            mentionPosition: number | null;
            contextSnippet: string;
          }> = [];

          for (const [chunkIndex, c] of chunks.entries()) {
            if (chunks.length > 1) {
              console.log(`  - chunk ${chunkIndex + 1}/${chunks.length} (offset=${c.offset})`);
            }

            const extracted = await callOpenAiExtractEntitiesWithRetry({
              apiKey,
              model,
              text: c.text,
              maxAttempts: 3
            });
            stats.totalEntities += extracted.length;

            for (const e of extracted) {
              const entityText = e.text.trim();
              if (!entityText) continue;

              let posInChunk =
                typeof e.position === "number" && Number.isFinite(e.position) && e.position >= 0
                  ? Math.floor(e.position)
                  : null;

              if (posInChunk == null) {
                const idx = c.text.indexOf(entityText);
                posInChunk = idx >= 0 ? idx : null;
              }

              const globalPos = posInChunk != null ? c.offset + posInChunk : null;
              const contextSnippet =
                globalPos != null ? buildContextSnippet(fullText, globalPos, entityText.length) : (e.context ?? "");

              mentions.push({
                entityText,
                entityType: e.type,
                normalizedText: normalizeText(entityText),
                mentionPosition: globalPos,
                contextSnippet
              });
            }

            if (delayMs > 0) await sleep(delayMs);
          }

          // Deduplicate mentions by (type, normalizedText, mentionPosition).
          const uniq: typeof mentions = [];
          const seenKeys = new Set<string>();
          for (const m of mentions) {
            const key = `${m.entityType}|${m.normalizedText}|${m.mentionPosition ?? -1}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            uniq.push(m);
          }

          const byType = uniq.reduce(
            (acc, m) => {
              acc[m.entityType] = (acc[m.entityType] ?? 0) + 1;
              return acc;
            },
            {} as Record<EntityType, number>
          );

          await prisma.$transaction(async (tx) => {
            if (reprocess) {
              await tx.entityMention.deleteMany({ where: { fileId: f.id } });
            }

            for (const m of uniq) {
              const entity = await tx.entity.upsert({
                where: {
                  normalizedText_entityType: {
                    normalizedText: m.normalizedText,
                    entityType: m.entityType
                  }
                },
                create: {
                  entityText: m.entityText,
                  entityType: m.entityType,
                  normalizedText: m.normalizedText
                },
                update: {}
              });

              await tx.entityMention.create({
                data: {
                  fileId: f.id,
                  entityId: entity.id,
                  pageNumber: null,
                  contextSnippet: m.contextSnippet,
                  mentionPosition: m.mentionPosition,
                  confidence: 1.0
                }
              });
            }

            await tx.file.update({
              where: { id: f.id },
              data: {
                entitiesExtracted: true,
                entitiesExtractedAt: new Date()
              }
            });
          });

          stats.processed++;
          stats.totalMentions += uniq.length;
          console.log(
            `  ✓ Extracted ${uniq.length} mention(s) (${byType.PERSON ?? 0} PERSON, ${byType.LOCATION ?? 0} LOCATION, ${byType.ORGANIZATION ?? 0} ORGANIZATION)\n`
          );
        } catch (err) {
          stats.failed++;
          console.error(`  ✗ Failed: ${toErrorMessage(err)}\n`);
        }
      }

      if (fileId != null) break;
      cursor = { id: files[files.length - 1]!.id };
    }
  } finally {
    await prisma.$disconnect();
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log("Summary:");
  console.log("========");
  console.log(`Total files: ${stats.totalFiles}`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Total entities extracted (raw): ${stats.totalEntities}`);
  console.log(`Total mentions created: ${stats.totalMentions}`);
  console.log(`Time elapsed: ${elapsedSec}s`);

  process.exitCode = stats.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(toErrorMessage(err));
  process.exitCode = 1;
});

