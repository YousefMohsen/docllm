import process from "node:process";

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseBooleanFlag(v: string | boolean | undefined): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

export function parseEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

// Heuristic token estimation. Good enough for chunk sizing; exact tokenization is not required.
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.ceil(words * 1.3));
}

function lastNWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return text.trim();
  return words.slice(words.length - n).join(" ");
}

export type TextChunk = {
  text: string;
  tokenCount: number;
};

export function chunkTextByParagraphs(args: {
  text: string;
  chunkSizeTokens: number;
  overlapTokens: number;
}): TextChunk[] {
  const fullText = args.text ?? "";
  const chunkSizeTokens = Math.max(100, args.chunkSizeTokens);
  const overlapTokens = Math.max(0, Math.min(chunkSizeTokens - 1, args.overlapTokens));

  const paragraphs = fullText
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [];

  const overlapWords = Math.max(0, Math.round(overlapTokens / 1.3));
  const chunks: TextChunk[] = [];

  let carryover = "";
  let current = "";

  function flushChunk() {
    const text = current.trim();
    if (!text) return;
    chunks.push({ text, tokenCount: estimateTokens(text) });
    carryover = overlapWords > 0 ? lastNWords(text, overlapWords) : "";
    current = "";
  }

  for (const para of paragraphs) {
    const candidate = current
      ? `${current}\n\n${para}`
      : carryover
        ? `${carryover}\n\n${para}`
        : para;

    if (estimateTokens(candidate) <= chunkSizeTokens) {
      current = candidate;
      continue;
    }

    // If current is empty, the paragraph itself is too big. Split by words.
    if (!current) {
      const words = candidate.split(/\s+/).filter(Boolean);
      const sizeWords = Math.max(50, Math.round(chunkSizeTokens / 1.3));
      const step = Math.max(1, sizeWords - Math.max(0, Math.round(overlapTokens / 1.3)));
      for (let i = 0; i < words.length; i += step) {
        const slice = words.slice(i, i + sizeWords).join(" ");
        if (!slice.trim()) continue;
        chunks.push({ text: slice, tokenCount: estimateTokens(slice) });
      }
      carryover = overlapWords > 0 ? lastNWords(chunks[chunks.length - 1]!.text, overlapWords) : "";
      current = "";
      continue;
    }

    // Flush current chunk, then retry this paragraph as start of next chunk.
    flushChunk();
    const retry = carryover ? `${carryover}\n\n${para}` : para;
    current = retry;
  }

  flushChunk();
  return chunks;
}

export function vectorLiteral(embedding: number[]): string {
  // pgvector accepts: '[1,2,3]'. Keep it compact and numeric.
  const parts = embedding.map((n) => (Number.isFinite(n) ? String(n) : "0"));
  return `[${parts.join(",")}]`;
}

export async function createEmbeddings(args: {
  apiKey: string;
  model: string;
  inputs: string[];
}): Promise<number[][]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      input: args.inputs
    })
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI embeddings error ${resp.status}: ${raw}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI embeddings response was not valid JSON: ${raw.slice(0, 500)}`);
  }

  const data = parsed?.data;
  if (!Array.isArray(data)) {
    throw new Error(`OpenAI embeddings response missing data[]: ${raw.slice(0, 500)}`);
  }

  const vectors: number[][] = [];
  for (const row of data) {
    if (!Array.isArray(row?.embedding)) {
      throw new Error(`OpenAI embeddings row missing embedding[]: ${raw.slice(0, 500)}`);
    }
    vectors.push(row.embedding as number[]);
  }

  if (vectors.length !== args.inputs.length) {
    throw new Error(`Embedding count mismatch: got ${vectors.length}, expected ${args.inputs.length}`);
  }

  return vectors;
}

