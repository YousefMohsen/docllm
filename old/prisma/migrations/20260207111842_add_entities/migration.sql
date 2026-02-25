-- AlterTable
ALTER TABLE "files" ADD COLUMN     "entities_extracted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "entities_extracted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "entities" (
    "id" SERIAL NOT NULL,
    "entity_text" TEXT NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,
    "normalized_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_mentions" (
    "id" SERIAL NOT NULL,
    "file_id" INTEGER NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "page_number" INTEGER,
    "context_snippet" TEXT NOT NULL,
    "mention_position" INTEGER,
    "confidence" DOUBLE PRECISION DEFAULT 1.0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entities_entity_type_idx" ON "entities"("entity_type");

-- CreateIndex
CREATE INDEX "entities_normalized_text_idx" ON "entities"("normalized_text");

-- CreateIndex
CREATE UNIQUE INDEX "entities_normalized_text_entity_type_key" ON "entities"("normalized_text", "entity_type");

-- CreateIndex
CREATE INDEX "entity_mentions_file_id_idx" ON "entity_mentions"("file_id");

-- CreateIndex
CREATE INDEX "entity_mentions_entity_id_idx" ON "entity_mentions"("entity_id");

-- AddForeignKey
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
