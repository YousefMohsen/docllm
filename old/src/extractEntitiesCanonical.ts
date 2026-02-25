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

type MentionRow = {
  mentionText: string;
  entityType: EntityType;
  mentionNormalized: string;
  mentionPosition: number | null;
  contextSnippet: string;
};

type AliasCandidate = {
  aliasId: number;
  canonicalEntityId: number;
  reason: "exact_alias" | "key_fingerprint";
  score: number;
};

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      if (boundary > start + Math.min(1000, Math.floor(maxChars * 0.25))) {
        end = boundary + 2;
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

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

function normalizeMention(text: string): string {
  const lowered = text.toLowerCase();
  const noHonorifics = lowered.replace(
    /\b(mr|mrs|ms|dr|prof|sir|madam|miss|mister|professor|judge|hon|honorable)\.?\s+/g,
    " "
  );
  const lettersAndDigits = noHonorifics.replace(/[^a-z0-9\s]/g, " ");
  return lettersAndDigits.replace(/\s+/g, " ").trim();
}

function tokensOf(text: string): string[] {
  return normalizeMention(text)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildKeyFingerprints(entityType: EntityType, text: string): string[] {
  const norm = normalizeMention(text);
  if (!norm) return [];

  const set = new Set<string>([norm]);
  if (entityType === "PERSON" || entityType === "ORGANIZATION") {
    const tokens = norm.split(" ").filter(Boolean);
    const last = tokens[tokens.length - 1] ?? "";
    if (last.length >= 4) set.add(last);
  }
  return Array.from(set);
}

function keyFingerprint(text: string): string | null {
  const norm = normalizeMention(text);
  if (!norm) return null;
  const parts = norm.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1] ?? "";
  if (last.length < 4) return null;
  return last;
}

async function getOrCreateLegacyEntityId(args: {
  tx: PrismaClient;
  entityType: EntityType;
  canonicalText: string;
  canonicalNormalized: string;
}): Promise<number> {
  const found = await args.tx.entity.findFirst({
    where: {
      entityType: args.entityType,
      normalizedText: args.canonicalNormalized
    },
    select: { id: true }
  });
  if (found) return found.id;

  const created = await args.tx.entity.create({
    data: {
      entityText: args.canonicalText,
      entityType: args.entityType,
      normalizedText: args.canonicalNormalized,
      canonicalText: args.canonicalText,
      aliases: [args.canonicalText],
      aliasFingerprints: buildKeyFingerprints(args.entityType, args.canonicalText),
      meta: {}
    },
    select: { id: true }
  });
  return created.id;
}

async function upsertAlias(args: {
  tx: PrismaClient;
  entityType: EntityType;
  canonicalEntityId: number;
  aliasText: string;
  aliasNormalized: string;
}): Promise<number> {
  const existing = await args.tx.entityAlias.findFirst({
    where: {
      canonicalEntityId: args.canonicalEntityId,
      aliasNormalized: args.aliasNormalized
    },
    select: { id: true }
  });
  if (existing) return existing.id;

  const created = await args.tx.entityAlias.create({
    data: {
      entityType: args.entityType,
      canonicalEntityId: args.canonicalEntityId,
      aliasText: args.aliasText,
      aliasNormalized: args.aliasNormalized
    },
    select: { id: true }
  });
  return created.id;
}

async function findAliasCandidates(args: {
  tx: PrismaClient;
  mentionText: string;
  mentionNormalized: string;
  entityType: EntityType;
}): Promise<AliasCandidate[]> {
  const out: AliasCandidate[] = [];
  const seen = new Set<string>();

  const exact = await args.tx.entityAlias.findMany({
    where: {
      entityType: args.entityType,
      aliasNormalized: args.mentionNormalized
    },
    select: { id: true, canonicalEntityId: true },
    take: 20
  });
  for (const row of exact) {
    const key = `${row.canonicalEntityId}|exact`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      aliasId: row.id,
      canonicalEntityId: row.canonicalEntityId,
      reason: "exact_alias",
      score: 1.0
    });
  }

  if (args.entityType === "PERSON" || args.entityType === "ORGANIZATION") {
    const key = keyFingerprint(args.mentionText);
    if (key && key !== args.mentionNormalized) {
      const keyRows = await args.tx.entityAlias.findMany({
        where: {
          entityType: args.entityType,
          aliasNormalized: key
        },
        select: { id: true, canonicalEntityId: true },
        take: 20
      });
      for (const row of keyRows) {
        const dedupe = `${row.canonicalEntityId}|key`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({
          aliasId: row.id,
          canonicalEntityId: row.canonicalEntityId,
          reason: "key_fingerprint",
          score: 0.6
        });
      }
    }
  }

  return out;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI response was not valid JSON: ${raw.slice(0, 500)}`);
  }

  const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`OpenAI response missing message content: ${raw.slice(0, 500)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      json = JSON.parse(trimmed);
    } else {
      throw new Error(`Model content was not valid JSON: ${content.slice(0, 500)}`);
    }
  }

  const entitiesMaybe = Array.isArray(json) ? json : (json as { entities?: unknown })?.entities;
  if (!Array.isArray(entitiesMaybe)) return [];

  const out: ExtractedEntity[] = [];
  for (const e of entitiesMaybe) {
    const obj = e as { text?: unknown; type?: unknown; context?: unknown; position?: unknown };
    const text = typeof obj.text === "string" ? obj.text : "";
    const type = obj.type;
    const context = typeof obj.context === "string" ? obj.context : undefined;
    const position = typeof obj.position === "number" ? obj.position : undefined;
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
    .name("extract-entities-canonical")
    .description("Extract entities and merge aliases into canonical entity rows.")
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
    totalMentions: 0,
    mergedMentions: 0,
    newEntities: 0
  };

  console.log("Starting canonical entity extraction...");
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

    const baseWhere: { status: string; dataset?: string; entitiesExtracted?: boolean; id?: number } = { status: "processed" };
    if (dataset) baseWhere.dataset = dataset;
    if (!reprocess && fileId == null) baseWhere.entitiesExtracted = false;
    if (fileId != null) baseWhere.id = fileId;

    stats.totalFiles = await prisma.file.count({ where: baseWhere });
    console.log(`Found ${stats.totalFiles} file(s) to process\n`);
    if (stats.totalFiles === 0) return;

    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY in environment (.env).");

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
          const mentions: MentionRow[] = [];

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
              const mentionText = e.text.trim();
              if (!mentionText) continue;

              let posInChunk =
                typeof e.position === "number" && Number.isFinite(e.position) && e.position >= 0
                  ? Math.floor(e.position)
                  : null;

              if (posInChunk == null) {
                const idx = c.text.indexOf(mentionText);
                posInChunk = idx >= 0 ? idx : null;
              }

              const globalPos = posInChunk != null ? c.offset + posInChunk : null;
              const contextSnippet =
                globalPos != null ? buildContextSnippet(fullText, globalPos, mentionText.length) : (e.context ?? "");
              const mentionNormalized = normalizeMention(mentionText);
              if (!mentionNormalized) continue;

              mentions.push({
                mentionText,
                entityType: e.type,
                mentionNormalized,
                mentionPosition: globalPos,
                contextSnippet
              });
            }

            if (delayMs > 0) await sleep(delayMs);
          }

          const uniq: MentionRow[] = [];
          const seenKeys = new Set<string>();
          for (const m of mentions) {
            const key = `${m.entityType}|${m.mentionNormalized}|${m.mentionPosition ?? -1}|${m.mentionText.toLowerCase()}`;
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
              const candidates = await findAliasCandidates({
                tx: tx as unknown as PrismaClient,
                mentionText: m.mentionText,
                mentionNormalized: m.mentionNormalized,
                entityType: m.entityType
              });

              const exactCanonicals = Array.from(
                new Set(
                  candidates
                    .filter((c) => c.reason === "exact_alias")
                    .map((c) => c.canonicalEntityId)
                )
              );

              const keyCanonicals = Array.from(
                new Set(
                  candidates
                    .filter((c) => c.reason === "key_fingerprint")
                    .map((c) => c.canonicalEntityId)
                )
              );

              const isAmbiguous = exactCanonicals.length > 1 || (exactCanonicals.length === 0 && keyCanonicals.length > 1);

              if (isAmbiguous) {
                const unresolved = await tx.canonicalEntity.create({
                  data: {
                    entityType: m.entityType,
                    canonicalText: m.mentionText,
                    canonicalNormalized: m.mentionNormalized,
                    meta: { unresolved: true, reason: "ambiguous_alias_match" }
                  },
                  select: { id: true, canonicalText: true, canonicalNormalized: true }
                });

                const primaryAliasId = await upsertAlias({
                  tx: tx as unknown as PrismaClient,
                  entityType: m.entityType,
                  canonicalEntityId: unresolved.id,
                  aliasText: m.mentionText,
                  aliasNormalized: m.mentionNormalized
                });

                for (const fp of buildKeyFingerprints(m.entityType, m.mentionText)) {
                  await upsertAlias({
                    tx: tx as unknown as PrismaClient,
                    entityType: m.entityType,
                    canonicalEntityId: unresolved.id,
                    aliasText: m.mentionText,
                    aliasNormalized: fp
                  });
                }

                const legacyEntityId = await getOrCreateLegacyEntityId({
                  tx: tx as unknown as PrismaClient,
                  entityType: m.entityType,
                  canonicalText: unresolved.canonicalText,
                  canonicalNormalized: unresolved.canonicalNormalized
                });

                const mention = await tx.entityMention.create({
                  data: {
                    fileId: f.id,
                    entityId: legacyEntityId,
                    canonicalEntityId: unresolved.id,
                    aliasId: primaryAliasId,
                    mentionText: m.mentionText,
                    mentionNormalized: m.mentionNormalized,
                    pageNumber: null,
                    contextSnippet: m.contextSnippet,
                    mentionPosition: m.mentionPosition,
                    confidence: 1.0
                  },
                  select: { id: true }
                });

                for (const c of candidates) {
                  await tx.entityCandidateLink.create({
                    data: {
                      mentionId: mention.id,
                      candidateCanonicalEntityId: c.canonicalEntityId,
                      score: c.score,
                      reason: c.reason === "exact_alias" ? "exact alias normalized match" : "last-token fingerprint match",
                      status: "PENDING"
                    }
                  });
                }

                stats.newEntities++;
                continue;
              }

              const chosenCanonicalId =
                exactCanonicals.length === 1
                  ? exactCanonicals[0]
                  : keyCanonicals.length === 1
                    ? keyCanonicals[0]
                    : null;

              if (chosenCanonicalId == null) {
                const createdCanonical = await tx.canonicalEntity.create({
                  data: {
                    entityType: m.entityType,
                    canonicalText: m.mentionText,
                    canonicalNormalized: m.mentionNormalized,
                    meta: {}
                  },
                  select: { id: true, canonicalText: true, canonicalNormalized: true }
                });

                const primaryAliasId = await upsertAlias({
                  tx: tx as unknown as PrismaClient,
                  entityType: m.entityType,
                  canonicalEntityId: createdCanonical.id,
                  aliasText: m.mentionText,
                  aliasNormalized: m.mentionNormalized
                });

                for (const fp of buildKeyFingerprints(m.entityType, m.mentionText)) {
                  await upsertAlias({
                    tx: tx as unknown as PrismaClient,
                    entityType: m.entityType,
                    canonicalEntityId: createdCanonical.id,
                    aliasText: m.mentionText,
                    aliasNormalized: fp
                  });
                }

                const legacyEntityId = await getOrCreateLegacyEntityId({
                  tx: tx as unknown as PrismaClient,
                  entityType: m.entityType,
                  canonicalText: createdCanonical.canonicalText,
                  canonicalNormalized: createdCanonical.canonicalNormalized
                });

                await tx.entityMention.create({
                  data: {
                    fileId: f.id,
                    entityId: legacyEntityId,
                    canonicalEntityId: createdCanonical.id,
                    aliasId: primaryAliasId,
                    mentionText: m.mentionText,
                    mentionNormalized: m.mentionNormalized,
                    pageNumber: null,
                    contextSnippet: m.contextSnippet,
                    mentionPosition: m.mentionPosition,
                    confidence: 1.0
                  }
                });

                stats.newEntities++;
                continue;
              }

              const canonical = await tx.canonicalEntity.findUnique({
                where: { id: chosenCanonicalId },
                select: { id: true, canonicalText: true, canonicalNormalized: true }
              });
              if (!canonical) continue;

              const aliasId = await upsertAlias({
                tx: tx as unknown as PrismaClient,
                entityType: m.entityType,
                canonicalEntityId: canonical.id,
                aliasText: m.mentionText,
                aliasNormalized: m.mentionNormalized
              });
              for (const fp of buildKeyFingerprints(m.entityType, m.mentionText)) {
                await upsertAlias({
                  tx: tx as unknown as PrismaClient,
                  entityType: m.entityType,
                  canonicalEntityId: canonical.id,
                  aliasText: m.mentionText,
                  aliasNormalized: fp
                });
              }

              const legacyEntityId = await getOrCreateLegacyEntityId({
                tx: tx as unknown as PrismaClient,
                entityType: m.entityType,
                canonicalText: canonical.canonicalText,
                canonicalNormalized: canonical.canonicalNormalized
              });

              await tx.entityMention.create({
                data: {
                  fileId: f.id,
                  entityId: legacyEntityId,
                  canonicalEntityId: canonical.id,
                  aliasId,
                  mentionText: m.mentionText,
                  mentionNormalized: m.mentionNormalized,
                  pageNumber: null,
                  contextSnippet: m.contextSnippet,
                  mentionPosition: m.mentionPosition,
                  confidence: 1.0
                }
              });
              stats.mergedMentions++;
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
  console.log(`Mentions merged into existing entities: ${stats.mergedMentions}`);
  console.log(`New canonical entities created: ${stats.newEntities}`);
  console.log(`Time elapsed: ${elapsedSec}s`);

  process.exitCode = stats.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(toErrorMessage(err));
  process.exitCode = 1;
});

