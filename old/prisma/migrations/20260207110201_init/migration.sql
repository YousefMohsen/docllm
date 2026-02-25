-- CreateTable
CREATE TABLE "files" (
    "id" SERIAL NOT NULL,
    "filename" TEXT NOT NULL,
    "filepath" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "file_type" TEXT NOT NULL DEFAULT 'pdf',
    "size_bytes" BIGINT NOT NULL,
    "page_count" INTEGER NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "full_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "modified_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error_message" TEXT,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_filepath_key" ON "files"("filepath");

-- CreateIndex
CREATE INDEX "files_content_hash_idx" ON "files"("content_hash");

-- CreateIndex
CREATE INDEX "files_dataset_idx" ON "files"("dataset");

-- CreateIndex
CREATE INDEX "files_status_idx" ON "files"("status");
