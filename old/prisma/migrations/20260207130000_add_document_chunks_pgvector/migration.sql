-- Phase 5: Semantic search (pgvector + document chunks)

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Add tracking columns to files
ALTER TABLE "files"
ADD COLUMN     "chunks_created" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chunks_created_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" SERIAL NOT NULL,
    "file_id" INTEGER NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "page_number" INTEGER,
    "token_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_file_id_chunk_index_key" ON "document_chunks"("file_id", "chunk_index");

-- CreateIndex
CREATE INDEX "document_chunks_file_id_idx" ON "document_chunks"("file_id");

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_file_id_fkey"
FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add embedding column (Prisma doesn't support vector type natively)
ALTER TABLE "document_chunks" ADD COLUMN "embedding" vector(1536);

-- Vector similarity index (cosine)
CREATE INDEX "document_chunks_embedding_ivfflat_idx"
ON "document_chunks" USING ivfflat ("embedding" vector_cosine_ops)
WITH (lists = 100);

