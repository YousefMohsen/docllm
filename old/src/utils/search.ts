import { Prisma, PrismaClient } from "@prisma/client";

export type FullTextSearchType = "plain" | "phrase" | "websearch";

export type FullTextSearchParams = {
  query: string;
  dataset?: string;
  searchType?: FullTextSearchType;
  limit?: number;
};

export type FullTextSearchRow = {
  id: number;
  filename: string;
  dataset: string;
  filepath: string;
  rank: number;
  excerpt: string | null;
};

function normalizeQuery(query: string): string {
  return query.trim();
}

export async function fullTextSearch(
  prisma: PrismaClient,
  params: FullTextSearchParams
): Promise<{ files: Array<{ id: number; filename: string; dataset: string; excerpt: string | null }>; totalResults: number }> {
  const query = normalizeQuery(params.query);
  if (!query) {
    throw new Error("query is required");
  }

  const dataset = params.dataset?.trim() ? params.dataset.trim() : undefined;
  const searchType: FullTextSearchType = params.searchType ?? "plain";
  const limit = Math.max(1, Math.min(200, params.limit ?? 20));

  const tsqueryFunc =
    searchType === "plain"
      ? "plainto_tsquery"
      : searchType === "phrase"
        ? "phraseto_tsquery"
        : "websearch_to_tsquery";

  const datasetSql = dataset ? Prisma.sql`AND f.dataset = ${dataset}` : Prisma.empty;
  const headlineOptions = "MaxWords=50, MinWords=25, ShortWord=3, HighlightAll=TRUE";

  // Note: full_text_tsv is not in Prisma schema; we query it via raw SQL.
  try {
    const totalRows = (await prisma.$queryRaw<
      Array<{ total: number }>
    >(Prisma.sql`
      WITH q AS (
        SELECT ${Prisma.raw(tsqueryFunc)}('english', ${query}) AS query
      )
      SELECT COUNT(*)::int AS total
      FROM files f, q
      WHERE f.full_text_tsv @@ q.query
        ${datasetSql}
    `)) as Array<{ total: number }>;

    const totalResults = totalRows[0]?.total ?? 0;

    const rows = (await prisma.$queryRaw<FullTextSearchRow[]>(Prisma.sql`
      WITH q AS (
        SELECT ${Prisma.raw(tsqueryFunc)}('english', ${query}) AS query
      )
      SELECT
        f.id,
        f.filename,
        f.dataset,
        f.filepath,
        ts_rank(f.full_text_tsv, q.query)::float8 AS rank,
        ts_headline('english', COALESCE(f.full_text, ''), q.query, ${headlineOptions}) AS excerpt
      FROM files f, q
      WHERE f.full_text_tsv @@ q.query
        ${datasetSql}
      ORDER BY rank DESC, f.id DESC
      LIMIT ${limit}
    `)) as FullTextSearchRow[];

    return {
      files: rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        dataset: r.dataset,
        excerpt: r.excerpt
      })),
      totalResults
    };
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    const looksLikeMissingFtsColumn =
      msg.includes("full_text_tsv") || msg.includes("column") || msg.includes("tsvector");
    if (!looksLikeMissingFtsColumn) throw err;

    // Fallback: basic substring matching (pre-Phase 4 DB migration).
    const where: any = { fullText: { contains: query, mode: "insensitive" } };
    if (dataset) where.dataset = dataset;

    const [totalResults, files] = await prisma.$transaction([
      prisma.file.count({ where }),
      prisma.file.findMany({
        where,
        take: limit,
        orderBy: { id: "desc" },
        select: { id: true, filename: true, dataset: true, fullText: true }
      })
    ]);

    return {
      files: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        dataset: f.dataset,
        excerpt: (f.fullText ?? "").slice(0, 300)
      })),
      totalResults
    };
  }
}

