import { catalogDb as db } from "../db";
import { fetchNzfccCatalog, OTHER_INCOME_GROUP, PERIODIC_INCOME_GROUP } from "./nzfcc";

/**
 * Refresh the NZFCC category catalog from nzfcc.org. Best-effort: the catalog is
 * a slowly-changing lookup table, so a fetch failure logs a warning and lets the
 * financial sync proceed rather than blocking balances and transactions on it.
 */
export async function syncCategories(): Promise<void> {
  try {
    const { version, categories } = await fetchNzfccCatalog();

    // The distinct groups the catalog references, seeded once into `CategoryGroup`
    // so both the `Category.groupId` and `Transaction.categoryGroupId` FKs resolve.
    // The two invented income groups are seeded unconditionally (see nzfcc.ts).
    const groups = new Map<string, string>([
      [PERIODIC_INCOME_GROUP._id, PERIODIC_INCOME_GROUP.name],
      [OTHER_INCOME_GROUP._id, OTHER_INCOME_GROUP.name],
    ]);
    for (const category of categories) {
      if (category.groupId && category.groupName) groups.set(category.groupId, category.groupName);
    }

    await db.$transaction([
      // Groups lead so the category `groupId` FK always finds its row.
      ...[...groups].map(([id, name]) =>
        db.categoryGroup.upsert({ where: { id }, create: { id, name }, update: { name } }),
      ),
      ...categories.map((category) =>
        db.category.upsert({
          where: { id: category.id },
          create: {
            id: category.id,
            name: category.name,
            direction: category.direction,
            groupId: category.groupId,
          },
          update: {
            name: category.name,
            direction: category.direction,
            groupId: category.groupId,
          },
        }),
      ),
    ]);

    console.log(`categories:   ${categories.length} synced (NZFCC ${version})`);
  } catch (error) {
    console.warn(
      `categories:   skipped — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
