/*
  Warnings:

  - You are about to drop the column `page_number` on the `entity_mentions` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('EMAIL', 'IMAGE', 'OTHER');

-- AlterTable
ALTER TABLE "entity_mentions" DROP COLUMN "page_number",
ADD COLUMN     "pageNumber" INTEGER;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "type" "FileType" NOT NULL DEFAULT 'OTHER';

-- RenameIndex
ALTER INDEX "entities_type_text_idx" RENAME TO "entities_entity_type_text_idx";
