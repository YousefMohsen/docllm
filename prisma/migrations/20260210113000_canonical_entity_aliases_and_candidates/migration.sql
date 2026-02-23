-- Canonical entities
CREATE TABLE "canonical_entities" (
    "id" SERIAL NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,
    "canonical_text" TEXT NOT NULL,
    "canonical_normalized" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_entity_id" INTEGER,
    CONSTRAINT "canonical_entities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "canonical_entities_entity_type_canonical_normalized_idx"
ON "canonical_entities"("entity_type", "canonical_normalized");

CREATE UNIQUE INDEX "canonical_entities_source_entity_id_key"
ON "canonical_entities"("source_entity_id");

-- Aliases (one canonical can have many alias strings/fingerprints)
CREATE TABLE "entity_aliases" (
    "id" SERIAL NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,
    "canonical_entity_id" INTEGER NOT NULL,
    "alias_text" TEXT NOT NULL,
    "alias_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "entity_aliases_entity_type_alias_normalized_idx"
ON "entity_aliases"("entity_type", "alias_normalized");

CREATE UNIQUE INDEX "entity_aliases_canonical_entity_id_alias_normalized_key"
ON "entity_aliases"("canonical_entity_id", "alias_normalized");

ALTER TABLE "entity_aliases"
ADD CONSTRAINT "entity_aliases_canonical_entity_id_fkey"
FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mention table links to canonical + alias
ALTER TABLE "entity_mentions"
ADD COLUMN "canonical_entity_id" INTEGER,
ADD COLUMN "alias_id" INTEGER;

CREATE INDEX "entity_mentions_canonical_entity_id_idx" ON "entity_mentions"("canonical_entity_id");
CREATE INDEX "entity_mentions_alias_id_idx" ON "entity_mentions"("alias_id");

ALTER TABLE "entity_mentions"
ADD CONSTRAINT "entity_mentions_canonical_entity_id_fkey"
FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entity_mentions"
ADD CONSTRAINT "entity_mentions_alias_id_fkey"
FOREIGN KEY ("alias_id") REFERENCES "entity_aliases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ambiguous candidate links
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntityCandidateStatus') THEN
    CREATE TYPE "EntityCandidateStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
  END IF;
END $$;

CREATE TABLE "entity_candidate_links" (
    "id" SERIAL NOT NULL,
    "mention_id" INTEGER NOT NULL,
    "candidate_canonical_entity_id" INTEGER NOT NULL,
    "score" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "status" "EntityCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entity_candidate_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entity_candidate_links_mention_id_candidate_canonical_entity_id_key"
ON "entity_candidate_links"("mention_id", "candidate_canonical_entity_id");

CREATE INDEX "entity_candidate_links_status_idx"
ON "entity_candidate_links"("status");

ALTER TABLE "entity_candidate_links"
ADD CONSTRAINT "entity_candidate_links_mention_id_fkey"
FOREIGN KEY ("mention_id") REFERENCES "entity_mentions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entity_candidate_links"
ADD CONSTRAINT "entity_candidate_links_candidate_canonical_entity_id_fkey"
FOREIGN KEY ("candidate_canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill canonical entities from existing entities
INSERT INTO "canonical_entities" (
    "entity_type",
    "canonical_text",
    "canonical_normalized",
    "meta",
    "created_at",
    "updated_at",
    "source_entity_id"
)
SELECT
    e."entity_type",
    COALESCE(NULLIF(e."canonical_text", ''), e."entity_text") AS canonical_text,
    COALESCE(NULLIF(e."normalized_text", ''), lower(trim(COALESCE(NULLIF(e."canonical_text", ''), e."entity_text")))) AS canonical_normalized,
    '{}'::jsonb,
    e."created_at",
    CURRENT_TIMESTAMP,
    e."id"
FROM "entities" e;

-- Backfill aliases from current entities rows (canonical, normalized)
INSERT INTO "entity_aliases" (
    "entity_type",
    "canonical_entity_id",
    "alias_text",
    "alias_normalized",
    "created_at",
    "updated_at"
)
SELECT
    ce."entity_type",
    ce."id",
    ce."canonical_text",
    ce."canonical_normalized",
    ce."created_at",
    CURRENT_TIMESTAMP
FROM "canonical_entities" ce
ON CONFLICT ("canonical_entity_id", "alias_normalized") DO NOTHING;

-- Backfill additional aliases from entities.aliases JSONB, if present
INSERT INTO "entity_aliases" (
    "entity_type",
    "canonical_entity_id",
    "alias_text",
    "alias_normalized",
    "created_at",
    "updated_at"
)
SELECT
    ce."entity_type",
    ce."id",
    a.alias_text,
    lower(trim(regexp_replace(a.alias_text, '[^a-zA-Z0-9\\s]', ' ', 'g'))),
    ce."created_at",
    CURRENT_TIMESTAMP
FROM "canonical_entities" ce
JOIN "entities" e ON e."id" = ce."source_entity_id"
JOIN LATERAL (
    SELECT jsonb_array_elements_text(e."aliases") AS alias_text
) a ON TRUE
WHERE trim(a.alias_text) <> ''
ON CONFLICT ("canonical_entity_id", "alias_normalized") DO NOTHING;

-- Backfill key fingerprint aliases (last token) for PERSON / ORGANIZATION
INSERT INTO "entity_aliases" (
    "entity_type",
    "canonical_entity_id",
    "alias_text",
    "alias_normalized",
    "created_at",
    "updated_at"
)
SELECT
    ea."entity_type",
    ea."canonical_entity_id",
    ea."alias_text",
    regexp_replace(ea."alias_normalized", '^.*\\s', ''),
    ea."created_at",
    CURRENT_TIMESTAMP
FROM "entity_aliases" ea
WHERE ea."entity_type" IN ('PERSON', 'ORGANIZATION')
  AND position(' ' in ea."alias_normalized") > 0
  AND length(regexp_replace(ea."alias_normalized", '^.*\\s', '')) >= 4
ON CONFLICT ("canonical_entity_id", "alias_normalized") DO NOTHING;

-- Backfill mentions to point to canonical entities via old entity_id
UPDATE "entity_mentions" em
SET "canonical_entity_id" = ce."id"
FROM "canonical_entities" ce
WHERE ce."source_entity_id" = em."entity_id";

-- Best-effort backfill alias link by mention normalized within canonical
UPDATE "entity_mentions" em
SET "alias_id" = ea."id"
FROM "entity_aliases" ea
WHERE em."canonical_entity_id" = ea."canonical_entity_id"
  AND em."mention_normalized" = ea."alias_normalized"
  AND em."alias_id" IS NULL;

-- Canonical link is required for all mentions
ALTER TABLE "entity_mentions"
ALTER COLUMN "canonical_entity_id" SET NOT NULL;

-- Cleanup migration-only helper
DROP INDEX IF EXISTS "canonical_entities_source_entity_id_key";
ALTER TABLE "canonical_entities" DROP COLUMN "source_entity_id";
