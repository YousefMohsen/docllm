-- New approach: File, DocumentChunk, Entity, EntityVariant, EntityMention

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable: files
CREATE TABLE "files" (
    "id" SERIAL NOT NULL,
    "path" TEXT NOT NULL,
    "full_text" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "page_count" INTEGER,
    "summary" TEXT,
    "content_hash" VARCHAR(64),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "files_path_key" ON "files"("path");

-- CreateTable: document_chunks
CREATE TABLE "document_chunks" (
    "id" SERIAL NOT NULL,
    "file_id" INTEGER NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "page_number" INTEGER,
    "token_count" INTEGER,
    "embedding" vector(1536),

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_chunks_file_id_chunk_index_key" ON "document_chunks"("file_id", "chunk_index");
CREATE INDEX "document_chunks_file_id_chunk_index_idx" ON "document_chunks"("file_id", "chunk_index");

ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: entities
CREATE TABLE "entities" (
    "id" SERIAL NOT NULL,
    "text" TEXT NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "entities_type_text_idx" ON "entities"("entity_type", "text");

-- CreateTable: entity_variants
CREATE TABLE "entity_variants" (
    "id" SERIAL NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "variant_text" TEXT NOT NULL,
    "normalized_text" TEXT NOT NULL,

    CONSTRAINT "entity_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entity_variants_entity_id_normalized_text_key" ON "entity_variants"("entity_id", "normalized_text");
CREATE INDEX "entity_variants_entity_id_idx" ON "entity_variants"("entity_id");

ALTER TABLE "entity_variants" ADD CONSTRAINT "entity_variants_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: entity_mentions
CREATE TABLE "entity_mentions" (
    "id" SERIAL NOT NULL,
    "file_id" INTEGER NOT NULL,
    "chunk_id" INTEGER,
    "entity_id" INTEGER NOT NULL,
    "entity_variant_id" INTEGER,
    "mention_text" TEXT,
    "page_number" INTEGER,
    "context_snippet" TEXT NOT NULL,

    CONSTRAINT "entity_mentions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "entity_mentions_entity_id_file_id_idx" ON "entity_mentions"("entity_id", "file_id");
CREATE INDEX "entity_mentions_file_id_entity_id_idx" ON "entity_mentions"("file_id", "entity_id");
CREATE INDEX "entity_mentions_chunk_id_idx" ON "entity_mentions"("chunk_id");

-- Prevent duplicate mentions: same file, entity, mention span, page (nulls coalesced)
CREATE UNIQUE INDEX "entity_mentions_file_entity_mention_page_key"
ON "entity_mentions" ("file_id", "entity_id", COALESCE("mention_text", ''), COALESCE("page_number", -1));

ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_chunk_id_fkey"
    FOREIGN KEY ("chunk_id") REFERENCES "document_chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_variant_id_fkey"
    FOREIGN KEY ("entity_variant_id") REFERENCES "entity_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
