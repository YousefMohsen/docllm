# Scripts and pipeline (new approach)

This doc describes the scripts needed for the project and how to implement them. It aligns with the pipeline in [NEW_APPROACH.md](./NEW_APPROACH.md#pipeline-conceptual).

---

## Pipeline overview

The main pipeline runs three steps in order:

1. **process_documents** — Scan documents under `DOCUMENTS_PATH` → create/update `File` (path, fullText, size, pageCount, optional summary, contentHash).
2. **Chunk** — Split each file’s fullText into `DocumentChunk` rows (content, chunkIndex, tokenCount, optional pageNumber) and compute embeddings (pgvector) for semantic search.
3. **Extract entities** — Run an LLM over fullText (or chunks) → create/update `Entity`, `EntityVariant`, and `EntityMention` (fileId, optional chunkId, entityId, entityVariantId, contextSnippet, pageNumber).

A **pipeline script** can run all three (e.g. `npm run pipeline` or `npm run pipeline -- --reprocess`) or expose flags to run only `process_documents`, only chunk, or only extract-entities.

---

## 1. process_documents script

**Goal:** Turn every document under `DOCUMENTS_PATH` into a `File` row with extracted full text and metadata.

### Implementation

**Reuse the previous implementation.** The old `old/src/process.ts` already does the right thing; adapt it to the new schema and path convention.

- **Discovery:** Walk `DOCUMENTS_PATH` recursively. Support at least PDFs; optionally plain text (`.txt`, `.eml` or similar). For each file, compute **path** = path relative to `DOCUMENTS_PATH`, using POSIX-style slashes (e.g. `dataset-8/report.pdf`, `inbox/msg_001.txt`).
- **Change detection:** Compute SHA-256 of file bytes → `contentHash`. If a `File` with the same `path` already exists and `contentHash` matches, skip (no reprocessing).
- **Text extraction:**
  - **PDF:** Use `pdf-parse` (same as before). It returns `text` and `numpages`. Map to `fullText` and `pageCount`. No change from `old/src/process.ts` (`extractPdfTextAndPages`).
  - **Plain text / emails:** Read file as UTF-8; use contents as `fullText`. `pageCount` = null or 1.
- **Storage:** Upsert `File`: `path` (unique), `fullText`, `size` (from `fs.stat`), `pageCount`, optional `summary` (leave null for now), `contentHash`. No `dataset`/`filename` columns; derive dataset in queries from the first path segment if needed.
- **Options:** `--reprocess` to ignore contentHash and reprocess all. Optional `--path <prefix>` to restrict to paths starting with a prefix.
- **Errors:** On extract failure, still upsert `File` with `fullText` null or empty and store failure info if you add a status/error column later; or skip and log. Prefer continuing with other files.

**Dependencies:** `pdf-parse`, `commander`, `dotenv`, Prisma. Same as old process script.

---

## 2. Chunk script

**Goal:** For each `File` that has `fullText` but no (or outdated) chunks, split text into `DocumentChunk` rows and fill `content`, `chunkIndex`, `tokenCount`, optional `pageNumber`, and `embedding` (pgvector).

### How to split documents (chunking strategy)

Options:

| Strategy | Description | Pros | Cons |
|----------|-------------|------|------|
| **Fixed size** | Cut every N characters or tokens (with or without overlap). | Simple, deterministic, fast. | Can split mid-sentence or mid-paragraph; worse retrieval. |
| **Paragraph / recursive** | Split on `\n\n`, then by sentence or token limit; respect natural boundaries. | Better coherence; common in RAG. | Slightly more code. |
| **Semantic** | Use embeddings or a model to find “semantic” breakpoints. | Theoretically better boundaries. | Extra cost and complexity; recent work suggests gains are task-dependent. |

**Recommendation:** Use **paragraph-first recursive chunking with overlap**:

- Start by splitting on double newline (`\n\n`) to preserve paragraph boundaries.
- If a section is too large, recursively split by: single newline (`\n`) -> sentence boundaries -> spaces.
- Accumulate pieces until adding the next would exceed `chunkSizeTokens`, then start a new chunk.
- Apply **overlap** so context is preserved across chunk boundaries.
- Track **`startChar` / `endChar` offsets** for each chunk (relative to file `fullText`).

This keeps coherence high while avoiding giant-paragraph failure cases, and offsets make downstream mapping/debugging deterministic (e.g. mention -> chunkId).

**Default config:** start with `chunkSizeTokens = 800` and `chunkOverlapTokens = 120` (about 15% overlap). This is a strong baseline for mixed retrieval + reasoning workloads.

**Token count:** Prefer a **real tokenizer** (for example `tiktoken`) for chunk sizing and `tokenCount` so limits match model behavior. A heuristic is acceptable only as an MVP fallback and should be easy to backfill later.

### Implementation

- **Input:** Files that have `fullText` and (if incremental) no chunks yet. Support `--reprocess` to delete existing chunks and re-chunk.
- **Chunking:** For each file, run a recursive splitter (paragraph -> newline -> sentence -> spaces) with token-based limits and overlap. Produce list of `{ text, tokenCount, startChar, endChar }` (and optionally `pageNumber` if you have page info).
- **Store chunks:** Insert `DocumentChunk` rows: `fileId`, `chunkIndex`, `content` = text, `tokenCount`, `startChar`, `endChar`, `pageNumber`. Then call OpenAI Embeddings API (e.g. `text-embedding-3-small`) in batches, and write the vector into the `embedding` column via raw SQL (`UPDATE document_chunks SET embedding = $vec WHERE id = $id`), same as in `old/src/createEmbeddings.ts`.
- **Config:** Env vars for chunk size, overlap, embedding model, batch size, delay, and tokenizer (e.g. `CHUNK_SIZE_TOKENS`, `CHUNK_OVERLAP_TOKENS`, `EMBEDDING_MODEL`, `EMBEDDING_BATCH_SIZE`, `EMBEDDING_DELAY_MS`, `TOKENIZER_ENCODING`).
- **Options:** `--reprocess`, optional `--file-id`, `--path-prefix` to limit scope.

---

## 3. Extract-entities script

**Goal:** For each `File` with `fullText`, run an LLM to extract PERSON, LOCATION, ORGANIZATION mentions; create `Entity`, `EntityVariant`, and `EntityMention` rows and link variants to entities.

### LLM extraction

Reuse the pattern from `old/src/extractEntities.ts` and `extractEntitiesCanonical.ts`:

- **Chunking for the LLM:** If `fullText` is large, split by character limit (e.g. 80k–100k chars) with boundary at `\n\n` so you don’t cut mid-paragraph. Call the LLM per chunk.
- **Prompt:** Ask for a JSON list of entities, e.g. `{ "entities": [ { "text": "John Smith", "type": "PERSON", "context": "...", "position": 145 } ] }`. Rules: exact span as in document, type in {PERSON, LOCATION, ORGANIZATION}, include short context and character position.
- **API:** OpenAI Chat Completions with `response_format: { type: "json_object" }`, temperature 0. Retry with backoff on failure.
- **Output:** List of `{ text, type, context?, position? }` per chunk; merge and dedupe by (position, text) if you call LLM per chunk.

### Entity and EntityVariant model

- **Entity:** One row per “real-world” entity. `text` = canonical display form (e.g. "U.S.A."). `type` = PERSON | LOCATION | ORGANIZATION. **Entity.text is not unique** (two different people can both be "John Smith").
- **EntityVariant:** One row per spelling/alias. `entityId`, `variantText` (as seen in doc), `normalizedText` (lowercased, trimmed, maybe collapse spaces) for matching. Unique on `(entityId, normalizedText)`.

**Mapping variant → entity (two approaches):**

1. **Simple (MVP):** Treat each LLM-extracted mention as its own entity. For each mention: create one `Entity` (text = mention text, type = type); create one `EntityVariant` (variantText = mention text, normalizedText = normalize(mention text)); create `EntityMention` (fileId, entityId, entityVariantId, mentionText, contextSnippet, pageNumber). No deduplication (e.g. "USA" and "U.S.A." become two entities). Good for getting end-to-end working; later add merging.
2. **Dedupe by normalized form:** Before creating an Entity, look up existing Entity by (type, normalizedText). If found, use that Entity and add a new EntityVariant for this surface form if needed. If not, create Entity + EntityVariant. Then create EntityMention. This merges "USA", "U.S.A.", "usa" into one Entity with multiple EntityVariants. Risk: two different people named "John Smith" get merged; acceptable if you don’t need to distinguish them, or you add a disambiguation step later (e.g. LLM or manual).

Recommendation: start with **(2) dedupe by (type, normalizedText)** so “where is X mentioned?” returns one entity with many variants; document that name collisions (same name, different person) are possible and can be handled later with a clustering or disambiguation step.

### Implementation

- **Input:** Files that have `fullText`. Optionally only those without existing mentions (incremental). Support `--reprocess`, `--file-id`, `--path-prefix`.
- **Per file:** Chunk fullText for LLM; call LLM; parse entities. For each entity:
  - `normalized = normalize(mentionText)` (lowercase, trim, collapse spaces; optionally strip punctuation for LOCATION/ORG).
  - Find existing Entity with same `type` and same canonical normalized form. If you store a “normalized” on Entity (e.g. `Entity.normalizedText` or derive from first variant), use that for lookup; otherwise match by existing EntityVariant with same `normalizedText` and take its `entityId`.
  - If no Entity found: create Entity (text = mention text or a “canonical” form, type = type). Create EntityVariant (entityId, variantText = mention text, normalizedText = normalized).
  - If Entity found: ensure an EntityVariant exists for this surface form (variantText/normalizedText); if not, create it.
  - Create EntityMention: fileId, entityId, entityVariantId (the variant for this mention), mentionText, contextSnippet (from LLM context or slice around position), pageNumber (if you have it from `process_documents`/chunking). Use upsert or ignore on conflict so you don’t duplicate (fileId, entityId, mentionText, pageNumber) per your uniqueness rule.
- **Optional:** If you run chunking before entities, you can compute which chunk contains each mention (by position) and set `EntityMention.chunkId` for “chunks that mention X” queries.
- **Config:** `OPENAI_API_KEY`, `EXTRACTION_MODEL`, `EXTRACTION_DELAY_MS`, `EXTRACTION_BATCH_SIZE`, `EXTRACTION_MAX_CHARS` (for chunking fullText for the LLM).

---

## 4. Pipeline script

**Goal:** Single entry point to run `process_documents` → chunk → extract-entities in order.

- **Default:** Run all three steps (`process_documents`, then chunk, then extract-entities).
- **Flags:** e.g. `--process-documents-only`, `--chunk-only`, `--entities-only` to run only one step; `--reprocess` to force full reprocess in each step that supports it.
- **Order:** Always run `process_documents` first so new/changed files get fullText; then chunk; then extract-entities so mentions can optionally get chunkId once chunks exist.

---

## Summary table

| Script | Purpose | Key implementation |
|--------|---------|--------------------|
| **process_documents** | Scan docs → File (path, fullText, size, pageCount, contentHash) | Reuse old process: pdf-parse for PDFs, UTF-8 read for plain text; path = relative; skip when contentHash unchanged. |
| **Chunk** | fullText → DocumentChunk (content, chunkIndex, tokenCount, embedding) | Paragraph-first chunker + token limit + overlap (reuse old chunkTextByParagraphs); OpenAI embeddings → pgvector. |
| **Extract-entities** | fullText → Entity, EntityVariant, EntityMention | LLM extraction (old prompt/API pattern); dedupe Entity by (type, normalizedText); one EntityVariant per surface form; EntityMention links file (+ optional chunk) to entity/variant. |
| **Pipeline** | Run `process_documents` → chunk → extract-entities | Orchestrate the three scripts with flags (e.g. `--process-documents-only`, `--reprocess`). |

No implementation in the repo yet; this doc is the spec for building these scripts.
