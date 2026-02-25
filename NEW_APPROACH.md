# New approach: document + entity model

## Goal

MCP server that an LLM can call to query a database of preprocessed documents. Support media-investigation style questions:

- "Where is this person mentioned?"
- "Which documents mention both person A and person B?"
- "Which documents relate to this location?"

All sources (PDFs, plain-text emails, etc.) are treated as **documents**; no special casing per format.

---

## Tables

### File

One row per document.

| Field      | Purpose |
|-----------|---------|
| id        | PK      |
| path      | Full path relative to documents root (e.g. `dataset-8/report.pdf`, `inbox/msg_001.txt`). Single column avoids folder-depth limitations; dataset can be derived (e.g. first segment) for filtering. |
| fullText  | Extracted full text |
| size      | Size in bytes |
| pageCount | Number of pages (e.g. PDF); null or 1 for plain text |
| summary   | Optional short summary (e.g. for MCP preview) |

**Uniqueness:** `path` unique. Optional: `contentHash` for change detection so reprocessing can skip unchanged files.

---

### DocumentChunk

Fragments of a document used for RAG (retrieve relevant chunks, then optionally use full document).

| Field       | Purpose |
|------------|---------|
| id         | PK      |
| fileId     | FK → File |
| content    | Chunk text |
| chunkIndex | Order within the file |
| pageNumber | Optional (PDFs). If a chunk spans pages, define this as **start page** (or use startPage/endPage instead). |
| tokenCount | Optional (context-window logic) |
| embedding  | Vector for semantic search (pgvector) |

**Uniqueness:** `(fileId, chunkIndex)` unique.

---

### Entity

One row per real-world entity (person, location, organisation). Canonical form.

| Field | Purpose |
|-------|---------|
| id    | PK      |
| text  | Canonical display form (e.g. "U.S.A.", "John Smith"). **Not unique** — name collisions allowed (e.g. two different people named "John Smith" are two entities). |
| type  | PERSON \| LOCATION \| ORGANIZATION |

---

### EntityVariant

Spellings/aliases for an entity. Used for matching user queries and raw text.

| Field         | Purpose |
|---------------|---------|
| id            | PK      |
| entityId      | FK → Entity |
| variantText   | Surface form (e.g. "USA", "US", "Amerika", "u.s.") |
| normalizedText| Lowercased/trimmed for consistent matching |

**Uniqueness:** `(entityId, normalizedText)` unique.

---

### EntityMention

Links a mention in a document to an entity. Supports "where is X mentioned?" and "documents that mention A and B".

| Field         | Purpose |
|---------------|---------|
| id            | PK      |
| fileId        | FK → File (required) |
| chunkId       | FK → DocumentChunk (optional): which chunk contains this mention; enables "chunks that mention X" for RAG |
| entityId      | FK → Entity |
| entityVariantId | FK → EntityVariant (optional): which variant was seen in text |
| mentionText   | Optional: exact span as it appeared |
| pageNumber    | Optional |
| contextSnippet| Short surrounding text (e.g. for MCP to show context) |

**Dedup note:** strict uniqueness on `(fileId, entityId, mentionText, pageNumber)` can collapse valid repeats (same mention text repeated on one page) and is tricky with nulls. Safer options:
- keep mentions non-unique and dedupe in query/application logic, or
- use a deterministic `mentionKey`/fingerprint (for example hash of normalized mention + snippet + chunk position) for duplicate protection.

**Note:** If chunking runs after entity extraction, chunkId can be set when we know which chunk contains the mention; otherwise leave null. File-level queries (list documents mentioning X) use fileId only.

---

### FileEntity (optional, performance)

Pre-aggregated document-level mentions for faster multi-entity document queries.

| Field       | Purpose |
|-------------|---------|
| fileId      | FK → File |
| entityId    | FK → Entity |
| mentionCount| Number of mentions of this entity in this file |

**Use case:** quickly answer "documents mentioning A and B" without scanning the full `EntityMention` table.

---

## Indexes

| Table         | Index | Purpose |
|---------------|-------|---------|
| EntityMention | (entityId, fileId) | **Critical** for "docs mentioning A and B" (filter by entityIds, intersect fileIds). |
| EntityMention | (fileId, entityId) | List entities per document; lookups by file. |
| DocumentChunk | (fileId, chunkIndex) | Order chunks per file; already unique. |
| EntityVariant | (normalizedText) | Fast entity/variant resolution from user query text. |
| EntityVariant | (normalizedText, entityId) | Optional variant lookup + join helper. |
| Entity         | (type, text) | Optional: filter by type and canonical text. |
| FileEntity (optional) | (entityId, fileId) | Fast candidate-doc retrieval for multi-entity queries. |

---

## Design choices

- **Path:** Single `path` column (e.g. `dataset-8/report.pdf`) instead of (dataset, filename) to avoid future folder-depth or structure limitations. Derive dataset in queries if needed (e.g. first path segment).
- **Mention scope:** EntityMention has both fileId and optional chunkId. FileId is required (every mention is in a file). ChunkId optional so we can still record mentions before chunks exist, and support "retrieve chunks that mention X" when we have it.
- **Query ownership:** if `FileEntity` is used, use it for candidate document retrieval; use `EntityMention` for evidence (snippets/pages/chunks).
- **Change detection:** Optional `contentHash` on File to avoid reprocessing unchanged documents.
- **Documents only:** No email-specific fields or types; all inputs are documents.

---

## MCP use cases (covered)

| Question | How |
|----------|-----|
| Where is this person mentioned? | Entity + EntityVariant lookup → EntityMention (fileId, pageNumber, contextSnippet). |
| Documents that mention person A and B? | EntityMention filtered by two entityIds, intersect by fileId. |
| Documents related to this location? | Same: entity type LOCATION → EntityMention → list files. |
| Semantic search over content | DocumentChunk.embedding + user query embedding; return chunks/files. |
| Full-text search | Prefer `tsvector` on `DocumentChunk.content` (and optional File.fullText) so results map directly to returnable chunks. |

---

## Pipeline (conceptual)

1. **process_documents:** Scan documents → create/update File (path, fullText, size, pageCount, optional summary).
2. **Chunk:** Split File.fullText → DocumentChunk (content, embedding).
3. **Extract entities:** From fullText or chunks → Entity + EntityVariant (dedupe) → EntityMention (fileId, optional chunkId, entityId, entityVariantId, contextSnippet, pageNumber).

No implementation in this repo yet; this doc describes the target model only.
