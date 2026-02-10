# Agent Notes (docllm)

This repo is a local document ingestion pipeline:

- Scan PDFs under `DOCUMENTS_PATH` (default `./documents`)
- Extract text + metadata
- Store into PostgreSQL (Docker) via Prisma
- Phase 2: extract named entities via OpenAI into Postgres
- Phase 3: MCP server exposing DB tools over stdio
- Phase 4: PostgreSQL full-text search (tsvector + GIN + trigger)
- Phase 5: semantic search (pgvector embeddings over document chunks)

## Quick commands

- Start DB:

```bash
docker compose up -d
```

- Run migrations + generate client:

```bash
npx prisma migrate dev
npx prisma generate
```

- Process documents (default mode = only new/changed):

```bash
npm run process
```

- Reprocess everything:

```bash
npm run process -- --reprocess=1
```

- Extract entities (default mode = only files not yet extracted):
 
```bash
npm run extract-entities
```

- Re-extract entities for all processed files:

```bash
npm run extract-entities -- --reprocess=1
```

- Run MCP server (stdio):

```bash
# Dev (TypeScript)
npm run mcp:dev

# Build + start (compiled JS)
npm run mcp:build
npm run mcp:start
```

- Test FTS + MCP tools:

```bash
npm run search:test
npm run mcp:test
```

- Create embeddings (Phase 5):

```bash
# Incremental (files without chunks/embeddings)
npm run create-embeddings

# Re-embed everything
npm run create-embeddings -- --reprocess=1
```

## Important details

- **Database port**: container `5432` is published to host **`5433`** (see `docker-compose.yml`). The `.env.example` `DATABASE_URL` uses `127.0.0.1:5433`.
- **File identity**:
  - `dataset` is the first folder under `DOCUMENTS_PATH` (e.g. `documents/dataset-8/...` → `dataset-8`)
  - `filepath` stored in DB is **relative to `DOCUMENTS_PATH`** (POSIX-like, e.g. `dataset-8/EFTA00014114.pdf`)
- **Change detection**: SHA-256 of bytes stored in `contentHash`.
- **Skip behavior** (default mode): if a DB row exists for `filepath` and `contentHash` matches, the file is skipped.
- **Error handling**: failures are recorded with `status='failed'` and `errorMessage`; processing continues with other files.
- **Full-text search**:
  - Phase 4 adds `files.full_text_tsv` + GIN index + trigger for ranked Postgres FTS.
  - `search_files` falls back to substring search if the FTS column isn't present yet.
- **Entity extraction tracking**: `File.entitiesExtracted` / `File.entitiesExtractedAt` indicate whether Phase 2 has been run successfully for a file.
- **Semantic search**:
  - Phase 5 adds `document_chunks` with `embedding vector(1536)` (pgvector) and an ivfflat index.
  - `semantic_search` sets `ivfflat.probes` (default: \(topK * 10\)) to avoid empty/low-recall results on small datasets. You can override via `IVFFLAT_PROBES`.

## Where things live

- `src/process.ts`: main ingestion CLI.
- `src/extractEntities.ts`: Phase 2 entity extraction CLI.
- `src/createEmbeddings.ts`: Phase 5 chunking + embedding CLI.
- `src/mcp-server.ts`: Phase 3 MCP server entrypoint (stdio).
- `src/tools/*`: MCP tool implementations.
- `src/tools/semantic-search.ts`: Phase 5 MCP semantic search tool.
- `src/utils/search.ts`: ranked full-text search helper (FTS with fallback).
- `src/utils/embeddings.ts`: chunking + OpenAI embeddings helpers.
- `prisma/schema.prisma`: database schema (`File` model → `files` table).
- `docker-compose.yml`: local Postgres + volume.
- `.env.example`: required env vars (`DATABASE_URL`, `DOCUMENTS_PATH`).

## Safety / hygiene

- Don’t commit secrets: `.env` is gitignored.
- Prefer Prisma migrations (already enabled) for schema changes.

