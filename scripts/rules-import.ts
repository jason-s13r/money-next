/**
 * Seeds `ClassificationRule` from a JSON file.
 *
 *   pnpm db:rules classify.rules.json
 *
 * The file is authoritative for the rule *kinds* it contains: rules of those
 * kinds that aren't in the file are deleted. Editing a pattern in the file would
 * otherwise leave the old pattern behind as an orphan — and two rules at the same
 * priority break ties arbitrarily, so an orphan can silently outrank its
 * replacement. Kinds absent from the file are left alone.
 *
 * The file is only a seed. Once imported, the database is the source of truth,
 * and the file can be deleted.
 */
import { readFileSync } from "node:fs";
import { parseRawRules, type RawRules } from "../lib/classify-rules";
import { db } from "../lib/db";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: pnpm db:rules <file.json>");

  const raw = JSON.parse(readFileSync(file, "utf8")) as RawRules;
  // Compiles every pattern, so a typo fails here rather than mid-classification.
  const rows = parseRawRules(raw);

  const kinds = [...new Set(rows.map((row) => row.kind))];

  let pruned = 0;
  for (const kind of kinds) {
    const patterns = rows.filter((row) => row.kind === kind).map((row) => row.pattern);
    const { count } = await db.classificationRule.deleteMany({
      where: { kind, pattern: { notIn: patterns } },
    });
    pruned += count;
  }

  for (const row of rows) {
    await db.classificationRule.upsert({
      where: { kind_pattern: { kind: row.kind, pattern: row.pattern } },
      create: row,
      update: {
        incomeCategory: row.incomeCategory,
        priority: row.priority,
        enabled: row.enabled,
      },
    });
  }

  const counts = await db.classificationRule.groupBy({ by: ["kind"], _count: true });
  console.log(`imported ${rows.length} rules from ${file}`);
  if (pruned > 0) console.log(`pruned ${pruned} rule(s) no longer in the file`);
  for (const c of counts) console.log(`  ${c.kind}: ${c._count} in database`);
  console.log("\nThe database is now the source of truth. You can delete the seed file.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
