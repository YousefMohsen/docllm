# Agent Notes (docllm)

This repo is a document + entity pipeline for media-investigation style queries. Target: MCP server an LLM can call to ask “where is this person mentioned?”, “documents that mention A and B?”, etc.

**Current state:** Prisma schema, migrations, docker-compose, and package.json are set up for the new approach. Ingest, entity extraction, chunking/embeddings, and MCP server scripts are **not** implemented yet (see `NEW_APPROACH.md` for the model; previous implementation is in `old/`).

## Schema (new approach)

- **File**: one row per document; `path` (unique, relative to docs root), `fullText`, `size`, `pageCount`, `summary`, optional `contentHash`.
- **DocumentChunk**: RAG chunks per file; `content`, `chunkIndex`, optional `pageNumber`, `tokenCount`, `embedding` (pgvector).
- **Entity**: canonical entity (person/location/organisation); `text`, `type`; text is **not** unique.
- **EntityVariant**: spellings/aliases per entity; `(entityId, normalizedText)` unique.
- **EntityMention**: links file (and optional chunk) to entity; indexes for “docs mentioning A and B” and per-file lookups.

## Quick commands

- Start DB: `docker compose up -d`
- Migrate + generate client: `npm run db:migrate` then `npm run db:generate` (or `npx prisma migrate dev` / `npx prisma generate`). If the DB already has the **old** schema (e.g. from before the new approach), use a fresh DB: `docker compose down -v`, then `npm run db:up`, then `npx prisma migrate deploy`.
- DB UI: `npm run db:studio`

## Important details

- **Database port**: container `5432` → host **`5433`** (see `docker-compose.yml`). `.env.example` uses `127.0.0.1:5433`.
- **Path**: File identity is `path` (e.g. `dataset-8/report.pdf`), relative to `DOCUMENTS_PATH`. No separate dataset/filename columns.
- **Old code**: `old/` contains the previous schema, migrations, and src (process, extract-entities, MCP, etc.). See `old/README.md`.

## Where things live

- `prisma/schema.prisma`: new schema (File, DocumentChunk, Entity, EntityVariant, EntityMention).
- `prisma/migrations/`: migrations for new approach (pgvector enabled).
- `NEW_APPROACH.md`: full design (indexes, constraints, pipeline).
- `docker-compose.yml`: Postgres + pgvector.
- `.env.example`: `DATABASE_URL`, `DOCUMENTS_PATH` (and optional vars for future scripts).

## Safety / hygiene

- Don’t commit secrets: `.env` is gitignored.
- Use Prisma migrations for schema changes.
