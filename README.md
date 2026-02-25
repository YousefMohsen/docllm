# docllm

Document + entity pipeline for media-investigation style queries. Target: an MCP server an LLM can call to ask “where is this person mentioned?”, “which documents mention both A and B?”, etc.

**Current state:** Database schema/migrations are ready. `process_documents` and `run_pipeline` are implemented for step 1 (document processing). Chunking, entity extraction, and MCP are planned next.

---

## Prerequisites

- **Node.js** (v18+; LTS recommended) and **npm**
- **Docker** and **Docker Compose** — used to run PostgreSQL (with pgvector) locally

---

## Setup local

1. **Install + env**
   ```bash
   npm install
   cp .env.example .env
   ```

2. **Start DB (Docker Compose)**
   ```bash
   npm run db:up
   npm run db:migrate
   npm run db:generate
   ```
   Postgres runs on `127.0.0.1:5433` (from `docker-compose.yml` / `DATABASE_URL`).

3. **Put source files**
   - Place documents under the folder in `DOCUMENTS_PATH` (default: `./documents`).
   - Current supported formats in `process_documents`: `.pdf`, `.txt`, `.md`, `.eml`.
   - Example paths:
     - `documents/dataset-1/report.pdf`
     - `documents/dataset-2/email-001.eml`

4. **Run processing**
   ```bash
   npm run process_documents
   # or
   npm run run_pipeline
   ```

5. **What to expect**
   - Each discovered file becomes one row in `files`.
   - Existing files are skipped by default if already present in DB.
   - `fullText`, `size`, `pageCount`, and `contentHash` are stored.
   - Chunking/entities are not run yet by `run_pipeline` (placeholder steps).

---

## Commands

| Command        | Description                          |
|----------------|--------------------------------------|
| `npm run db:up`     | Start Postgres (Docker).             |
| `npm run db:down`   | Stop Postgres.                      |
| `npm run db:migrate`| Apply migrations (`prisma migrate dev`). |
| `npm run db:generate` | Generate Prisma client.          |
| `npm run db:studio` | Open Prisma Studio.                 |
| `npm run process_documents` | Scan documents and write `files` rows. |
| `npm run run_pipeline` | Run pipeline entrypoint (currently step 1 only). |

---

## Project layout

- `prisma/schema.prisma` — data model (File, DocumentChunk, Entity, EntityVariant, EntityMention).
- `prisma/migrations/` — migrations (Postgres + pgvector).
- `NEW_APPROACH.md` — design, indexes, constraints.
- `AGENTS.md` — notes for AI/agents.
- `old/` — previous implementation (archived).
