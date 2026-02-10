# Python spaCy NER (benchmark script)

This folder contains a standalone script to run **spaCy NER** on the same text your pipeline already stored in Postgres (`files.full_text`) and write the results to a **JSON output file** (no DB writes).

## Setup

From repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r python/requirements.txt
python -m spacy download en_core_web_sm
```

Ensure your `DATABASE_URL` is available (repo root `.env` works).

## Run

Process 25 files (default) and write output JSON under `python/output/`:

```bash
python3 python/extract_entities_spacy.py
```

Process a specific dataset:

```bash
python3 python/extract_entities_spacy.py --dataset dataset-8 --limit 10
```

Process a specific file id:

```bash
python3 python/extract_entities_spacy.py --file-id 123
```

Write to a specific output path:

```bash
python3 python/extract_entities_spacy.py --output /tmp/spacy-entities.json
```

## Output

The output JSON contains:

- `files[]`: per-file mentions (deduped similarly to the TS extractor by `(type, normalizedText, position)`)
- `stats`: totals and counts by `PERSON | LOCATION | ORGANIZATION`

