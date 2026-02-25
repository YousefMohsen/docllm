-- Add canonical entity fields.
ALTER TABLE "entities"
ADD COLUMN "canonical_text" TEXT NOT NULL DEFAULT '',
ADD COLUMN "aliases" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN "alias_fingerprints" JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN "meta" JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN "entity_hash" VARCHAR(128);

-- Backfill canonical fields from existing single-name entities.
UPDATE "entities"
SET
  "canonical_text" = "entity_text",
  "aliases" = to_jsonb(ARRAY["entity_text"]),
  "alias_fingerprints" = to_jsonb(ARRAY["normalized_text"])
WHERE "canonical_text" = '';

-- Relax one-row-per-normalized-text so aliases can merge.
DROP INDEX IF EXISTS "entities_normalized_text_entity_type_key";

-- Add lookup indexes for the new shape.
CREATE INDEX IF NOT EXISTS "entities_canonical_text_idx" ON "entities"("canonical_text");
CREATE INDEX IF NOT EXISTS "entities_entity_type_normalized_text_idx" ON "entities"("entity_type", "normalized_text");
CREATE INDEX IF NOT EXISTS "entities_aliases_gin_idx" ON "entities" USING GIN ("aliases");
CREATE INDEX IF NOT EXISTS "entities_alias_fingerprints_gin_idx" ON "entities" USING GIN ("alias_fingerprints");

-- Preserve raw mention surface forms.
ALTER TABLE "entity_mentions"
ADD COLUMN "mention_text" TEXT,
ADD COLUMN "mention_normalized" TEXT;

-- Best-effort backfill for historical mention rows.
UPDATE "entity_mentions" em
SET
  "mention_text" = e."entity_text",
  "mention_normalized" = e."normalized_text"
FROM "entities" e
WHERE em."entity_id" = e."id"
  AND em."mention_text" IS NULL
  AND em."mention_normalized" IS NULL;

CREATE INDEX IF NOT EXISTS "entity_mentions_mention_normalized_idx" ON "entity_mentions"("mention_normalized");
