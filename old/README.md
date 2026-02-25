# Document Metadata Extraction System

Extract text + metadata from PDF files organized in datasets under `./documents/`, store results in PostgreSQL (Docker) via Prisma, and prepare a foundation for future LLM querying.

## Requirements

- Node.js (recommended: 18+ / 20+)
- Docker + Docker Compose

## Project layout

```
documents/
  dataset1/
    file1.pdf
    file2.pdf
  dataset2/
    EFTA003394638.pdf
    other.pdf
```

The dataset name is derived from the first directory under `documents/` (e.g. `dataset2`).

## Setup

### 1) Start database

```bash
docker compose up -d
```

Note: if you already have PostgreSQL on your machine, using a non-default host port avoids conflicts. This project maps container `5432` to host `5433` (see `docker-compose.yml`). This is the same general approach as publishing a container port for host access. See: [Connecting to Postgresql in a docker container from outside](https://stackoverflow.com/questions/37694987/connecting-to-postgresql-in-a-docker-container-from-outside).

### 2) Install dependencies

```bash
npm install
```

### 3) Configure environment

Create a `.env` file:

```bash
cp .env.example .env
```

### 4) Run Prisma migrations

```bash
npx prisma migrate dev
```

### 5) Generate Prisma Client

```bash
npx prisma generate
```

### 6) Process documents

```bash
npm run process
```

Optional: reprocess all files:

```bash
npm run process -- --reprocess=1
```

## Phase 2: Entity extraction

After Phase 1 has populated `files.fullText` (and `status='processed'`), you can extract named entities into `entities` and `entity_mentions`.

### Run extraction

```bash
npm run extract-entities
```

Options:

```bash
# Re-extract for all processed files (does not rely on entitiesExtracted flag)
npm run extract-entities -- --reprocess=1

# Extract for a single file id
npm run extract-entities -- --file-id=123

# Extract only for a dataset
npm run extract-entities -- --dataset=dataset-8
```

Environment variables (see `.env.example`):

- `OPENAI_API_KEY`
- `EXTRACTION_MODEL` (default: `gpt-4o-mini`)
- `EXTRACTION_DELAY_MS` (default: `200`)
- `EXTRACTION_BATCH_SIZE` (default: `10`)
- `EXTRACTION_MAX_CHARS` (default: `100000`)

## Behavior

- **Default mode**: processes only new/changed files
  - Looks up an existing row by `filepath`
  - Computes SHA-256 `contentHash`
  - If hash matches: **skip**
  - If hash differs: **reprocess**
- **Reprocess mode** (`--reprocess=1`): processes every discovered PDF and upserts by `filepath`

## Data model

Prisma model is defined in `prisma/schema.prisma` and maps to a `files` table:

- `dataset`, `filename`, `filepath` (unique)
  - `filepath` is stored **relative to `DOCUMENTS_PATH`** (e.g. `dataset2/file.pdf`)
- `contentHash` (SHA-256)
- `fullText` (extracted PDF text)
- `sizeBytes`, `pageCount`, `createdAt`, `modifiedAt`, `processedAt`
- `status` (`processed` or `failed`) + `errorMessage`

## Inspect data (optional)

```bash
npm run db:studio
```

## Basic text search (MVP)

Prisma can do simple substring matching on `fullText`. Example (Node REPL / one-liner):

```bash
node -e "const {PrismaClient}=require('@prisma/client');(async()=>{const p=new PrismaClient();const q=process.argv[1]||'agreement';const rows=await p.file.findMany({where:{fullText:{contains:q,mode:'insensitive'}} ,take:10,select:{id:true,dataset:true,filepath:true}});console.log(rows);await p.$disconnect();})().catch(e=>{console.error(e);process.exit(1);});" "agreement"
```

## Phase 3: MCP server (LLM-accessible tools over stdio)

This repo includes an MCP (Model Context Protocol) server that exposes your document database to MCP-compatible clients (ChatGPT, Claude Desktop, etc.) over **stdio**.

### Run locally

```bash
# Dev (TypeScript)
npm run mcp:dev

# Build + start (compiled JS)
npm run mcp:build
npm run mcp:start
```

Environment variables:

- `DATABASE_URL` (required)
- `MCP_SERVER_NAME` (optional, default: `document-search`)

### Tools exposed

- `search_by_entity`: find files mentioning an entity (uses `entity_mentions.context_snippet`)
- `search_files`: full-text search (uses Postgres FTS when enabled; falls back to substring search otherwise)
- `get_file_content`: fetch full text + per-file entity summary
- `get_file_by_filepath`: fetch full text + per-file entity summary by filepath (e.g. `dataset-8/EFTA00014122.pdf`)
- `find_entity_connections`: find files where multiple entities co-occur
- `list_datasets`: list dataset names + file counts
- `list_entities`: browse extracted entities + mention counts

### Client integration (example)

Add a server entry in your MCP client configuration:

```json
{
  "mcpServers": {
    "document-search": {
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:password@127.0.0.1:5433/document_metadata",
        "MCP_SERVER_NAME": "document-search"
      }
    }
  }
}
```

If another app reads MCP server definitions from an env var (for example `MCP_SERVERS_JSON`), the equivalent value is:

```env
MCP_SERVERS_JSON={"mcpServers":{"document-search":{"command":"node","args":["/absolute/path/to/docllm/dist/mcp-server.js"],"env":{"DATABASE_URL":"postgresql://...","MCP_SERVER_NAME":"document-search"}}}}
```

### Quick sanity check

```bash
npm run mcp:test
```

## Phase 4: Advanced PostgreSQL full-text search (FTS)

Phase 4 upgrades `search_files` from substring matching to **ranked PostgreSQL full-text search** using a `tsvector` column + GIN index.

### Apply migration

```bash
npx prisma migrate dev
```

This adds:

- `files.full_text_tsv` (type `tsvector`)
- `files_full_text_tsv_idx` (GIN index)
- `tsvectorupdate` trigger to keep `full_text_tsv` up to date on insert/update

### Search capabilities

`search_files` supports:

- **Ranking**: results ordered by relevance
- **Excerpts**: auto-generated snippets via `ts_headline`
- **Stemming**: `releasing` matches `release`
- **Search types**:
  - `plain` → `plainto_tsquery`
  - `phrase` → `phraseto_tsquery`
  - `websearch` → `websearch_to_tsquery` (Google-like syntax)

### Test FTS vs basic search

```bash
npm run search:test
```

## Phase 5: Semantic search (pgvector embeddings)

Phase 5 adds semantic search over document content by:

- Chunking `files.fullText` into `document_chunks`
- Generating OpenAI embeddings (`text-embedding-3-small`, 1536 dims)
- Storing embeddings in Postgres via `pgvector` (`embedding vector(1536)`)
- Exposing `semantic_search` as an MCP tool

### Apply migration

```bash
# Non-interactive (recommended for CI / scripted runs)
npx prisma migrate deploy

# Dev (interactive)
npx prisma migrate dev
```

### Create embeddings

```bash
# Incremental: only files without chunks
npm run create-embeddings

# Re-chunk + re-embed everything
npm run create-embeddings -- --reprocess=1

# Single file
npm run create-embeddings -- --file-id=123

# One dataset
npm run create-embeddings -- --dataset=dataset-8
```

Environment variables (see `.env.example`):

- `OPENAI_API_KEY`
- `EMBEDDING_MODEL` (default: `text-embedding-3-small`)
- `CHUNK_SIZE_TOKENS` (default: `700`)
- `CHUNK_OVERLAP_TOKENS` (default: `100`)
- `EMBEDDING_BATCH_SIZE` (default: `50`)
- `EMBEDDING_DELAY_MS` (default: `100`)
- `IVFFLAT_PROBES` (default: `50`)

### MCP tool: semantic_search

`semantic_search` embeds the query and returns the most similar chunks.

Input example:

```json
{
  "query": "work release letter",
  "topK": 5,
  "dataset": "dataset-8",
  "minSimilarity": 0.2
}
```

Note: the ivfflat index is approximate. The server sets `ivfflat.probes` per request (default: `topK * 10`) to avoid low-recall / empty results on small datasets. You can override with `IVFFLAT_PROBES`.
