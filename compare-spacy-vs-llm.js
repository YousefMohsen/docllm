/* eslint-disable no-console */
/**
 * Compare spaCy NER output (python/output/*.json) vs LLM-extracted entities in Postgres.
 *
 * Reads:
 *  - spaCy JSON produced by `python/extract_entities_spacy.py`
 *  - DB rows from `entity_mentions` + `entities` for the same file ids (via Prisma)
 *
 * Outputs:
 *  - Summary overlap stats (entity-level + mention-level)
 *  - A small sample of disagreements for manual inspection
 *
 * Usage:
 *   node compare-spacy-vs-llm.js
 *   node compare-spacy-vs-llm.js --input python/output/spacy-entities-....json
 *   node compare-spacy-vs-llm.js --dataset dataset-8 --limit-diffs 30
 */

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

function parseArgs(argv) {
  const out = {
    input: "python/output/spacy-entities-20260207-163729.json",
    dataset: null,
    limitDiffs: 25,
    out: null,
    entitiesOut: null
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--input" && next) {
      out.input = next;
      i++;
      continue;
    }
    if (a === "--dataset" && next) {
      out.dataset = next;
      i++;
      continue;
    }
    if (a === "--limit-diffs" && next) {
      out.limitDiffs = Number(next);
      i++;
      continue;
    }
    if (a === "--out" && next) {
      out.out = next;
      i++;
      continue;
    }
    if (a === "--entities-out" && next) {
      out.entitiesOut = next;
      i++;
      continue;
    }
  }

  if (!Number.isFinite(out.limitDiffs) || out.limitDiffs < 0) out.limitDiffs = 25;
  return out;
}

function normalizeText(s) {
  return String(s || "").trim().toLowerCase();
}

function looseNormalizeText(s) {
  // Intended to reduce false mismatches from whitespace / punctuation / quotes.
  // Keep it conservative: we only collapse whitespace and trim common edge punctuation.
  return normalizeText(s)
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’()[\]{}<>,.;:]+/g, "")
    .replace(/[\s"'“”‘’()[\]{}<>,.;:]+$/g, "");
}

function keyEntity(type, normalizedText) {
  return `${type}|${normalizedText}`;
}

function keyMention(type, normalizedText, position) {
  const pos = Number.isFinite(position) ? Math.floor(position) : -1;
  return `${type}|${normalizedText}|${pos}`;
}

function setIntersectionSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function takeSome(iterable, limit) {
  const out = [];
  for (const x of iterable) {
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

function safeReadJson(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Input JSON not found: ${abs}`);
  }
  const raw = fs.readFileSync(abs, "utf8");
  return { absPath: abs, json: JSON.parse(raw) };
}

function buildSpacySets(spacyFile) {
  /** @type {Set<string>} */
  const entityKeys = new Set();
  /** @type {Set<string>} */
  const entityKeysLoose = new Set();
  /** @type {Map<string, {type:string, text:string}>} */
  const entityLooseToExample = new Map();
  /** @type {Set<string>} */
  const mentionKeys = new Set();
  /** @type {Map<string, any>} */
  const mentionByKey = new Map();

  for (const m of spacyFile.mentions || []) {
    const type = m.type;
    const normalized = m.normalizedText ? String(m.normalizedText) : normalizeText(m.text);
    entityKeys.add(keyEntity(type, normalized));
    const looseNorm = looseNormalizeText(normalized);
    const ekLoose = keyEntity(type, looseNorm);
    entityKeysLoose.add(ekLoose);
    if (!entityLooseToExample.has(ekLoose)) {
      entityLooseToExample.set(ekLoose, { type, text: String(m.text || "").trim() });
    }
    const mk = keyMention(type, normalized, m.position);
    mentionKeys.add(mk);
    if (!mentionByKey.has(mk)) mentionByKey.set(mk, m);
  }

  return { entityKeys, entityKeysLoose, entityLooseToExample, mentionKeys, mentionByKey };
}

async function fetchLlmMentions(prisma, fileId) {
  const rows = await prisma.entityMention.findMany({
    where: { fileId },
    include: { entity: true }
  });

  /** @type {Array<{type:string, normalizedText:string, position:number|null, entityText:string, contextSnippet:string}>} */
  const out = [];
  for (const r of rows) {
    const type = r.entity?.entityType;
    const normalized = r.entity?.normalizedText ?? normalizeText(r.entity?.entityText ?? "");
    if (!type || !normalized) continue;
    out.push({
      type,
      normalizedText: normalized,
      position: r.mentionPosition == null ? null : Number(r.mentionPosition),
      entityText: r.entity?.entityText ?? "",
      contextSnippet: r.contextSnippet ?? ""
    });
  }
  return out;
}

function buildLlmSets(llmMentions) {
  /** @type {Set<string>} */
  const entityKeys = new Set();
  /** @type {Set<string>} */
  const entityKeysLoose = new Set();
  /** @type {Map<string, {type:string, text:string}>} */
  const entityLooseToExample = new Map();
  /** @type {Set<string>} */
  const mentionKeys = new Set();
  /** @type {Map<string, any>} */
  const mentionByKey = new Map();

  for (const m of llmMentions) {
    entityKeys.add(keyEntity(m.type, m.normalizedText));
    const looseNorm = looseNormalizeText(m.normalizedText);
    const ekLoose = keyEntity(m.type, looseNorm);
    entityKeysLoose.add(ekLoose);
    if (!entityLooseToExample.has(ekLoose)) {
      entityLooseToExample.set(ekLoose, { type: m.type, text: String(m.entityText || "").trim() || String(m.normalizedText || "") });
    }
    const mk = keyMention(m.type, m.normalizedText, m.position);
    mentionKeys.add(mk);
    if (!mentionByKey.has(mk)) mentionByKey.set(mk, m);
  }

  return { entityKeys, entityKeysLoose, entityLooseToExample, mentionKeys, mentionByKey };
}

function formatPct(n, d) {
  if (!d) return "0%";
  return `${Math.round((n / d) * 1000) / 10}%`;
}

function writeEntitiesListJson({ outPath, input, dataset, extractedSpacy, llmExtracted }) {
  const abs = path.resolve(outPath);
  const payload = {
    generatedAt: new Date().toISOString(),
    input,
    dataset,
    extractedSpacy,
    llmExtracted
  };
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return abs;
}

async function main() {
  const args = parseArgs(process.argv);
  const { absPath: inputAbs, json } = safeReadJson(args.input);

  const files = Array.isArray(json.files) ? json.files : [];
  if (files.length === 0) {
    throw new Error("Input JSON has no `files[]` entries.");
  }

  const prisma = new PrismaClient();

  const summary = {
    input: inputAbs,
    filters: { dataset: args.dataset, limitDiffs: args.limitDiffs },
    filesInInput: files.length,
    filesCompared: 0,
    entityLevel: { spacy: 0, llm: 0, overlap: 0 },
    entityLevelLoose: { spacy: 0, llm: 0, overlap: 0 },
    mentionLevel: { spacy: 0, llm: 0, overlap: 0 },
    byTypeEntity: {},
    byTypeEntityLoose: {},
    byTypeMention: {},
    disagreementsSample: []
  };

  /** @type {Map<string, {type:string, text:string}>} */
  const spacyEntityLooseToExampleAll = new Map();
  /** @type {Map<string, {type:string, text:string}>} */
  const llmEntityLooseToExampleAll = new Map();

  // Compare per file and aggregate.
  try {
    for (const f of files) {
      if (args.dataset && f.dataset !== args.dataset) continue;
      if (typeof f.id !== "number") continue;

      const spacyMentions = Array.isArray(f.mentions) ? f.mentions : [];
      const spacySets = buildSpacySets({ mentions: spacyMentions });

      const llmMentions = await fetchLlmMentions(prisma, f.id);
      const llmSets = buildLlmSets(llmMentions);

      summary.filesCompared++;

      // Collect global unique-entity lists (loose-normalized) for easy manual review.
      for (const [k, v] of spacySets.entityLooseToExample.entries()) {
        if (!spacyEntityLooseToExampleAll.has(k) && v.text) spacyEntityLooseToExampleAll.set(k, v);
      }
      for (const [k, v] of llmSets.entityLooseToExample.entries()) {
        if (!llmEntityLooseToExampleAll.has(k) && v.text) llmEntityLooseToExampleAll.set(k, v);
      }

      summary.entityLevel.spacy += spacySets.entityKeys.size;
      summary.entityLevel.llm += llmSets.entityKeys.size;
      summary.entityLevel.overlap += setIntersectionSize(spacySets.entityKeys, llmSets.entityKeys);

      summary.entityLevelLoose.spacy += spacySets.entityKeysLoose.size;
      summary.entityLevelLoose.llm += llmSets.entityKeysLoose.size;
      summary.entityLevelLoose.overlap += setIntersectionSize(spacySets.entityKeysLoose, llmSets.entityKeysLoose);

      summary.mentionLevel.spacy += spacySets.mentionKeys.size;
      summary.mentionLevel.llm += llmSets.mentionKeys.size;
      summary.mentionLevel.overlap += setIntersectionSize(spacySets.mentionKeys, llmSets.mentionKeys);

      // Type breakdown (entity-level).
      for (const k of spacySets.entityKeys) {
        const [type] = k.split("|");
        summary.byTypeEntity[type] = summary.byTypeEntity[type] ?? { spacy: 0, llm: 0, overlap: 0 };
        summary.byTypeEntity[type].spacy++;
      }
      for (const k of llmSets.entityKeys) {
        const [type] = k.split("|");
        summary.byTypeEntity[type] = summary.byTypeEntity[type] ?? { spacy: 0, llm: 0, overlap: 0 };
        summary.byTypeEntity[type].llm++;
      }
      for (const k of spacySets.entityKeys) {
        if (!llmSets.entityKeys.has(k)) continue;
        const [type] = k.split("|");
        summary.byTypeEntity[type].overlap++;
      }

      // Type breakdown (entity-level, loose normalization).
      for (const k of spacySets.entityKeysLoose) {
        const [type] = k.split("|");
        summary.byTypeEntityLoose[type] = summary.byTypeEntityLoose[type] ?? { spacy: 0, llm: 0, overlap: 0 };
        summary.byTypeEntityLoose[type].spacy++;
      }
      for (const k of llmSets.entityKeysLoose) {
        const [type] = k.split("|");
        summary.byTypeEntityLoose[type] = summary.byTypeEntityLoose[type] ?? { spacy: 0, llm: 0, overlap: 0 };
        summary.byTypeEntityLoose[type].llm++;
      }
      for (const k of spacySets.entityKeysLoose) {
        if (!llmSets.entityKeysLoose.has(k)) continue;
        const [type] = k.split("|");
        summary.byTypeEntityLoose[type].overlap++;
      }

      // Type breakdown (mention-level).
      for (const k of spacySets.mentionKeys) {
        const [type] = k.split("|");
        summary.byTypeMention[type] = summary.byTypeMention[type] ?? { spacy: 0, llm: 0, overlap: 0 };
        summary.byTypeMention[type].spacy++;
      }
      for (const k of llmSets.mentionKeys) {
        const [type] = k.split("|");
        summary.byTypeMention[type] = summary.byTypeMention[type] ?? { spacy: 0, llm: 0, overlap: 0 };
        summary.byTypeMention[type].llm++;
      }
      for (const k of spacySets.mentionKeys) {
        if (!llmSets.mentionKeys.has(k)) continue;
        const [type] = k.split("|");
        summary.byTypeMention[type].overlap++;
      }

      // Disagreement samples (per file): show a few "only spaCy" and "only LLM" items.
      if (summary.disagreementsSample.length < args.limitDiffs) {
        const onlySpacyEntity = takeSome(
          (function* () {
            for (const k of spacySets.entityKeys) if (!llmSets.entityKeys.has(k)) yield k;
          })(),
          5
        );
        const onlyLlmEntity = takeSome(
          (function* () {
            for (const k of llmSets.entityKeys) if (!spacySets.entityKeys.has(k)) yield k;
          })(),
          5
        );

        const onlySpacyMention = takeSome(
          (function* () {
            for (const k of spacySets.mentionKeys) if (!llmSets.mentionKeys.has(k)) yield k;
          })(),
          5
        );
        const onlyLlmMention = takeSome(
          (function* () {
            for (const k of llmSets.mentionKeys) if (!spacySets.mentionKeys.has(k)) yield k;
          })(),
          5
        );

        summary.disagreementsSample.push({
          file: { id: f.id, dataset: f.dataset, filepath: f.filepath, filename: f.filename },
          onlySpacyEntity,
          onlyLlmEntity,
          onlySpacyMention: onlySpacyMention.map((k) => ({ key: k, example: spacySets.mentionByKey.get(k) ?? null })),
          onlyLlmMention: onlyLlmMention.map((k) => ({ key: k, example: llmSets.mentionByKey.get(k) ?? null }))
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  // Print a compact summary to stdout
  const entityOverlapPctSpacy = formatPct(summary.entityLevel.overlap, summary.entityLevel.spacy);
  const entityOverlapPctLlm = formatPct(summary.entityLevel.overlap, summary.entityLevel.llm);
  const mentionOverlapPctSpacy = formatPct(summary.mentionLevel.overlap, summary.mentionLevel.spacy);
  const mentionOverlapPctLlm = formatPct(summary.mentionLevel.overlap, summary.mentionLevel.llm);
  const entityLooseOverlapPctSpacy = formatPct(summary.entityLevelLoose.overlap, summary.entityLevelLoose.spacy);
  const entityLooseOverlapPctLlm = formatPct(summary.entityLevelLoose.overlap, summary.entityLevelLoose.llm);

  console.log("spaCy vs LLM entity extraction comparison");
  console.log("=======================================");
  console.log(`Input: ${summary.input}`);
  console.log(`Files compared: ${summary.filesCompared}/${summary.filesInInput}`);
  console.log("");
  console.log("Entity-level (type + normalizedText)");
  console.log(`  spaCy unique entities: ${summary.entityLevel.spacy}`);
  console.log(`  LLM  unique entities: ${summary.entityLevel.llm}`);
  console.log(`  Overlap: ${summary.entityLevel.overlap} (${entityOverlapPctSpacy} of spaCy, ${entityOverlapPctLlm} of LLM)`);
  console.log("");
  console.log("Entity-level (loose normalization: collapse whitespace + trim punctuation)");
  console.log(`  spaCy unique entities: ${summary.entityLevelLoose.spacy}`);
  console.log(`  LLM  unique entities: ${summary.entityLevelLoose.llm}`);
  console.log(
    `  Overlap: ${summary.entityLevelLoose.overlap} (${entityLooseOverlapPctSpacy} of spaCy, ${entityLooseOverlapPctLlm} of LLM)`
  );
  console.log("");
  console.log("Mention-level (type + normalizedText + position)");
  console.log(`  spaCy unique mentions: ${summary.mentionLevel.spacy}`);
  console.log(`  LLM  unique mentions: ${summary.mentionLevel.llm}`);
  console.log(`  Overlap: ${summary.mentionLevel.overlap} (${mentionOverlapPctSpacy} of spaCy, ${mentionOverlapPctLlm} of LLM)`);
  console.log("");
  console.log("Type breakdown (entity-level)");
  for (const type of Object.keys(summary.byTypeEntity).sort()) {
    const t = summary.byTypeEntity[type];
    console.log(
      `  ${type}: spaCy=${t.spacy}, LLM=${t.llm}, overlap=${t.overlap} (${formatPct(t.overlap, t.spacy)} of spaCy, ${formatPct(
        t.overlap,
        t.llm
      )} of LLM)`
    );
  }
  console.log("");
  console.log("Type breakdown (entity-level, loose normalization)");
  for (const type of Object.keys(summary.byTypeEntityLoose).sort()) {
    const t = summary.byTypeEntityLoose[type];
    console.log(
      `  ${type}: spaCy=${t.spacy}, LLM=${t.llm}, overlap=${t.overlap} (${formatPct(t.overlap, t.spacy)} of spaCy, ${formatPct(
        t.overlap,
        t.llm
      )} of LLM)`
    );
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log("");
    console.log(`Wrote full report JSON to: ${outPath}`);
  }

  // Also write a minimal "just entities" JSON to make manual diff/review easy.
  const entitiesOutPath =
    args.entitiesOut ??
    (args.out
      ? path.resolve(String(args.out)).replace(/\.json$/i, "") + "-entities.json"
      : path.resolve("python/output/spacy-vs-llm-entities.json"));

  const extractedSpacy = Array.from(spacyEntityLooseToExampleAll.values())
    .filter((e) => e && e.type && e.text)
    .sort((a, b) => (a.type + "|" + a.text).localeCompare(b.type + "|" + b.text));
  const llmExtracted = Array.from(llmEntityLooseToExampleAll.values())
    .filter((e) => e && e.type && e.text)
    .sort((a, b) => (a.type + "|" + a.text).localeCompare(b.type + "|" + b.text));

  const wrote = writeEntitiesListJson({
    outPath: entitiesOutPath,
    input: summary.input,
    dataset: args.dataset,
    extractedSpacy,
    llmExtracted
  });
  console.log(`Wrote entity lists JSON to: ${wrote}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

