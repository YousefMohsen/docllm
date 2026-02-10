#!/usr/bin/env python3
"""
Extract named entities from docllm Postgres `files.full_text` using spaCy,
and write results to a JSON file (no DB writes).

This is intended as a benchmarking / manual review script.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_text(s: str) -> str:
    return s.strip().lower()


def build_context_snippet(full_text: str, start: int, end: int, before: int = 100, after: int = 100) -> str:
    s = max(0, start - before)
    e = min(len(full_text), end + after)
    return full_text[s:e]


# Map spaCy labels to your TS extractor's EntityType union:
# type EntityType = "PERSON" | "LOCATION" | "ORGANIZATION";
SPACY_LABEL_TO_ENTITY_TYPE: Dict[str, str] = {
    "PERSON": "PERSON",
    "ORG": "ORGANIZATION",
    # Common location-like labels
    "GPE": "LOCATION",
    "LOC": "LOCATION",
    "FAC": "LOCATION",
}


@dataclass(frozen=True)
class FileRow:
    id: int
    dataset: str
    filepath: str
    filename: str
    full_text: str


def find_repo_root(start: Path) -> Path:
    """
    Best-effort: find repo root by walking up until we see prisma/schema.prisma.
    Falls back to the parent of this script's directory.
    """
    cur = start.resolve()
    for _ in range(10):
        if (cur / "prisma" / "schema.prisma").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    # fallback
    return start.resolve().parent


def load_env(repo_root: Path) -> None:
    # Optional dependency; we keep import inside so the script can still
    # print a helpful error if deps aren't installed.
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return

    # Prefer repo root .env, but don't require it.
    load_dotenv(repo_root / ".env")


def connect_and_fetch_files(
    database_url: str,
    *,
    dataset: Optional[str],
    file_id: Optional[int],
    limit: int,
    offset: int,
) -> List[FileRow]:
    try:
        import psycopg  # type: ignore
        from psycopg.rows import dict_row  # type: ignore
    except Exception as e:
        raise RuntimeError(
            "Missing Python deps. From repo root run: `python3 -m pip install -r python/requirements.txt`"
        ) from e

    where: List[str] = ["status = 'processed'", "full_text IS NOT NULL", "length(full_text) >= 50"]
    params: Dict[str, Any] = {"limit": limit, "offset": offset}

    if dataset:
        where.append("dataset = %(dataset)s")
        params["dataset"] = dataset

    if file_id is not None:
        where.append("id = %(file_id)s")
        params["file_id"] = file_id

    sql = f"""
      SELECT id, dataset, filepath, filename, full_text
      FROM files
      WHERE {' AND '.join(where)}
      ORDER BY id ASC
      LIMIT %(limit)s
      OFFSET %(offset)s
    """

    rows: List[FileRow] = []
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            for r in cur.fetchall():
                rows.append(
                    FileRow(
                        id=int(r["id"]),
                        dataset=str(r["dataset"]),
                        filepath=str(r["filepath"]),
                        filename=str(r["filename"]),
                        full_text=str(r["full_text"] or ""),
                    )
                )
    return rows


def load_spacy_model(model: str):
    try:
        import spacy  # type: ignore
    except Exception as e:
        raise RuntimeError(
            "Missing Python deps. From repo root run: `python3 -m pip install -r python/requirements.txt`"
        ) from e

    try:
        return spacy.load(model)
    except OSError as e:
        raise RuntimeError(
            f"spaCy model '{model}' not installed. Try:\n"
            f"  python3 -m spacy download {model}\n"
            f"or install a different model and pass --model."
        ) from e


def extract_entities_for_file(nlp, f: FileRow) -> Tuple[List[Dict[str, Any]], Dict[str, int], int]:
    """
    Returns:
      - deduped entity mentions (list)
      - counts by your EntityType (dict)
      - raw mention count before dedup
    """
    doc = nlp(f.full_text)

    raw_mentions: List[Dict[str, Any]] = []
    for ent in doc.ents:
        mapped = SPACY_LABEL_TO_ENTITY_TYPE.get(ent.label_)
        if not mapped:
            continue
        text = ent.text.strip()
        if not text:
            continue

        start = int(ent.start_char)
        end = int(ent.end_char)
        raw_mentions.append(
            {
                "text": text,
                "type": mapped,  # PERSON | LOCATION | ORGANIZATION
                "spacyLabel": ent.label_,
                "startChar": start,
                "endChar": end,
                "position": start,  # align naming with TS extractor semantics
                "normalizedText": normalize_text(text),
                "context": build_context_snippet(f.full_text, start, end),
            }
        )

    # Deduplicate similarly to TS (type, normalizedText, position)
    uniq: List[Dict[str, Any]] = []
    seen = set()
    for m in raw_mentions:
        key = (m["type"], m["normalizedText"], m["position"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(m)

    counts: Dict[str, int] = {"PERSON": 0, "LOCATION": 0, "ORGANIZATION": 0}
    for m in uniq:
        t = m["type"]
        counts[t] = counts.get(t, 0) + 1

    return uniq, counts, len(raw_mentions)


def ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Extract NER from Postgres files.full_text using spaCy (writes JSON output).")
    p.add_argument("--dataset", type=str, default=None, help="Only process a single dataset (files.dataset).")
    p.add_argument("--file-id", type=int, default=None, help="Only process a single file id (files.id).")
    p.add_argument("--limit", type=int, default=25, help="Max files to process (default: 25).")
    p.add_argument("--offset", type=int, default=0, help="Offset for pagination (default: 0).")
    p.add_argument("--model", type=str, default="en_core_web_sm", help="spaCy model name (default: en_core_web_sm).")
    p.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output JSON path (default: python/output/spacy-entities-<timestamp>.json).",
    )
    return p.parse_args(list(argv))


def main(argv: Sequence[str]) -> int:
    script_dir = Path(__file__).resolve().parent
    repo_root = find_repo_root(script_dir)
    load_env(repo_root)

    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        print("ERROR: DATABASE_URL missing. Set it in your environment or in repo root .env", file=sys.stderr)
        return 2

    args = parse_args(argv)
    if args.limit <= 0:
        print("ERROR: --limit must be > 0", file=sys.stderr)
        return 2
    if args.offset < 0:
        print("ERROR: --offset must be >= 0", file=sys.stderr)
        return 2

    output_path = Path(args.output) if args.output else (repo_root / "python" / "output" / f"spacy-entities-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    ensure_parent_dir(output_path)

    files = connect_and_fetch_files(
        database_url,
        dataset=(args.dataset.strip() if args.dataset else None),
        file_id=args.file_id,
        limit=args.limit,
        offset=args.offset,
    )

    nlp = load_spacy_model(args.model)

    result_files: List[Dict[str, Any]] = []
    stats = {
        "totalFiles": len(files),
        "processed": 0,
        "skippedNoText": 0,
        "totalMentionsRaw": 0,
        "totalMentionsDeduped": 0,
        "byType": {"PERSON": 0, "LOCATION": 0, "ORGANIZATION": 0},
    }

    for f in files:
        full_text = (f.full_text or "").strip()
        if not full_text:
            stats["skippedNoText"] += 1
            continue

        mentions, counts, raw_count = extract_entities_for_file(nlp, FileRow(f.id, f.dataset, f.filepath, f.filename, full_text))
        stats["processed"] += 1
        stats["totalMentionsRaw"] += raw_count
        stats["totalMentionsDeduped"] += len(mentions)
        for k, v in counts.items():
            stats["byType"][k] = stats["byType"].get(k, 0) + int(v)

        result_files.append(
            {
                "id": f.id,
                "dataset": f.dataset,
                "filepath": f.filepath,
                "filename": f.filename,
                "textChars": len(full_text),
                "mentionsRawCount": raw_count,
                "mentionsDedupedCount": len(mentions),
                "countsByType": counts,
                "mentions": mentions,
            }
        )

    out = {
        "generatedAt": utc_now_iso(),
        "source": "spacy",
        "spacyModel": args.model,
        "filters": {"dataset": args.dataset, "fileId": args.file_id, "limit": args.limit, "offset": args.offset},
        "stats": stats,
        "files": result_files,
    }

    output_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(result_files)} file result(s) to: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

