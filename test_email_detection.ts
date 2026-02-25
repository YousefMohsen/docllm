import fs from "node:fs/promises";
import path from "node:path";

type ExampleFileRecord = {
  id: number;
  fullText: string;
};

function looksLikeEmail(fullText: string): boolean {
  const headerWindow = fullText.slice(0, 4000);

  // High-precision heuristic:
  // require From/To/Subject plus either Date or Sent in the header area.
  const hasFrom = /^From:/im.test(headerWindow);
  const hasTo = /^To:/im.test(headerWindow);
  const hasSubject = /^Subject:/im.test(headerWindow);
  const hasDateOrSent = /^Date:/im.test(headerWindow) || /^Sent:/im.test(headerWindow);

  return hasFrom && hasTo && hasSubject && hasDateOrSent;
}

async function main(): Promise<void> {
  const inputPath = path.resolve(process.cwd(), "exampleFiles.json");
  const raw = await fs.readFile(inputPath, "utf8");
  const docs = JSON.parse(raw) as ExampleFileRecord[];

  let emailCount = 0;

  for (const doc of docs) {
    const isEmail = looksLikeEmail(doc.fullText ?? "");
    if (isEmail) emailCount += 1;
    console.log(JSON.stringify({ id: doc.id, isEmail }));
  }

  console.log(`emails=${emailCount} total=${docs.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
