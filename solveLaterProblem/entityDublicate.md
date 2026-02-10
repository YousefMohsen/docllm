
-maybe add aliases? 


-From llm chat:
I've ran the extraction. seems fine, but seems like persons that seems to be the same are stored in different tables?

Like "Mr. Epstein", "jeffrey", "Epstein", , "Jeffrey Epstein"

Is there a smart way to group these? they might be the same person?

12.29
Excellent catch! This is a classic entity resolution problem. You have several options, ranging from simple to sophisticated:

Quick Fixes (Simple)
Option 1: Improve Normalization in Extraction
Modify the extraction script to normalize better before storing:

typescript
function normalizeEntity(text: string, type: string): string {
  let normalized = text.toLowerCase().trim();
  
  if (type === 'PERSON') {
    // Remove titles
    normalized = normalized
      .replace(/^(mr|mrs|ms|dr|prof|sir|dame)\.?\s+/i, '')
      .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '');
    
    // Remove middle initials for matching
    // "John Q. Smith" → "john smith"
    normalized = normalized.replace(/\s+[a-z]\.\s+/g, ' ');
  }
  
  return normalized;
}
This would merge:

"Mr. Epstein" → "epstein"
"Jeffrey Epstein" → "jeffrey epstein"
But "jeffrey" and "epstein" would still be separate (partial names problem).

Better Solutions (Moderate Complexity)
Option 2: Post-Processing Merge Script
Create a script that finds and merges similar entities:

bash
npm run merge-entities
Logic:

Find entities of same type where one is a substring of another
"epstein" is substring of "jeffrey epstein" → merge
"jeffrey" is substring of "jeffrey epstein" → merge
Use fuzzy matching (Levenshtein distance) for typos
Pseudocode:

typescript
// Find all PERSON entities
const persons = await prisma.entity.findMany({
  where: { entityType: 'PERSON' }
});

// Group by containment
for (const entity of persons) {
  const candidates = persons.filter(p => 
    p.normalizedText.includes(entity.normalizedText) &&
    p.id !== entity.id
  );
  
  if (candidates.length > 0) {
    // Merge entity into the longest match (most complete name)
    const canonical = candidates.sort((a, b) => 
      b.normalizedText.length - a.normalizedText.length
    )[0];
    
    // Update all mentions to point to canonical entity
    await prisma.entityMention.updateMany({
      where: { entityId: entity.id },
      data: { entityId: canonical.id }
    });
    
    // Delete duplicate
    await prisma.entity.delete({ where: { id: entity.id } });
  }
}
Merges:

"jeffrey" → "jeffrey epstein"
"epstein" → "jeffrey epstein"
"mr. epstein" → "jeffrey epstein"
Option 3: Add Canonical Entity Field
Extend your schema to track entity aliases:

prisma
model Entity {
  id             Int      @id @default(autoincrement())
  entityText     String
  entityType     String
  normalizedText String
  canonicalId    Int?     @map("canonical_id") // Points to "true" entity
  canonical      Entity?  @relation("EntityAliases", fields: [canonicalId], references: [id])
  aliases        Entity[] @relation("EntityAliases")
  // ... rest of fields
}
Usage:

Keep all entities in DB
Mark "jeffrey" and "epstein" as aliases of "Jeffrey Epstein"
Queries automatically resolve to canonical entity
Advanced Solution (Most Accurate)
Option 4: LLM-Based Entity Resolution
Use ChatGPT to decide if entities are the same:

typescript
const prompt = `
Are these entities the same person?

Entity 1: "Mr. Epstein"
Context: "Ms not in yet. We'll discuss as soon as he gets here."

Entity 2: "Jeffrey Epstein"  
Context: "Any comments on the Epstein work release letter?"

Entity 3: "jeffrey"
Context: "Letter re Epstein work release"

Answer with JSON:
{
  "same_person": true/false,
  "canonical_name": "Jeffrey Epstein",
  "reasoning": "..."
}
`;
Pros:

Very accurate with context
Handles edge cases (different people with same last name)
Cons:

Expensive (API calls for every entity pair)
Slower
My Recommendation
For your use case, I'd do this in 2 phases:

Phase 2A: Improve Extraction (Do Now)
Update your extraction script's normalization:

typescript
function normalizeEntity(text: string, type: string): string {
  let normalized = text.toLowerCase().trim();
  
  if (type === 'PERSON') {
    // Remove common titles
    normalized = normalized.replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, '');
  }
  
  if (type === 'LOCATION') {
    // Normalize "FL" → "florida", etc.
    const stateAbbrev: Record<string, string> = {
      'fl': 'florida',
      'ca': 'california',
      // ... add more
    };
    normalized = stateAbbrev[normalized] || normalized;
  }
  
  return normalized;
}
Re-run extraction with --reprocess=1 to apply better normalization.

Phase 2B: Manual Merge Script (Do Later)
Create a simple merge script for obvious cases:

bash
npm run merge-entities -- --dry-run  # Preview merges
npm run merge-entities                # Execute merges
Strategy:

Find entities where one is substring of another (same type)
Prefer longer, more complete names as canonical
Show user what will be merged for confirmation
Update entity_mentions to point to canonical entity
Delete duplicates
Quick Win for Now
Would you like me to give you requirements for a simple entity merge script that handles the substring matching? It would:

Merge "jeffrey" → "jeffrey epstein"
Merge "epstein" → "jeffrey epstein"
Merge "mr. epstein" → "jeffrey epstein" (after normalization)
Handle all entity types (PERSON, LOCATION, ORG)
Provide dry-run mode to preview changes
Log all merges for audit trail




-