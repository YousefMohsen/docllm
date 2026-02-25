-- Phase 4: PostgreSQL full-text search (FTS) support for files.full_text

-- Add tsvector column
ALTER TABLE "files"
ADD COLUMN "full_text_tsv" tsvector;

-- Create GIN index for fast search
CREATE INDEX "files_full_text_tsv_idx"
ON "files" USING GIN ("full_text_tsv");

-- Auto-update trigger
CREATE OR REPLACE FUNCTION files_tsvector_update()
RETURNS trigger AS $$
BEGIN
  NEW.full_text_tsv := to_tsvector('english', COALESCE(NEW.full_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tsvectorupdate ON "files";
CREATE TRIGGER tsvectorupdate
BEFORE INSERT OR UPDATE ON "files"
FOR EACH ROW
EXECUTE FUNCTION files_tsvector_update();

-- Populate existing rows
UPDATE "files"
SET "full_text_tsv" = to_tsvector('english', COALESCE("full_text", ''));

