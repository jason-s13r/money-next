// The Akahu payload archive: whatever the API said about an entity, kept whole
// beside the narrow columns that mirror part of it.
//
// Everything else in this directory is a *projection* — it reads the handful of
// fields the app knows it wants and drops the rest. That works until the day a
// field nobody projected turns out to matter, at which point the only way to get
// it is to re-fetch every page of history. `_migrated` cost exactly that, and it
// had been in every payload all along (see the AkahuRecord comment in the
// schema). So this writes the payload down once per entity and lets a later
// question be a SQL backfill instead.
//
// Deliberately not a version history: one row per entity, overwritten. The point
// is "what does Akahu currently say", not "when did it change its mind" —
// FieldChange already answers the second one for every field anyone can edit.

import type { Prisma } from "../../generated/prisma/client";
import type { ScopedDb } from "../db";

/**
 * What an archived payload belongs to. Mirrors the Akahu id prefixes.
 *
 * No `pending`: a pending transaction carries no `_id` at all — which is why
 * `PendingTransaction` has an autoincrement key and is replaced wholesale on
 * every sync — so there is nothing stable to file one under. Transient rows that
 * vanish on settlement are also the one kind of payload nobody will come back
 * looking for a missing field in.
 */
export type AkahuEntityType = "account" | "transaction" | "connection";

/**
 * Upserts for a page of payloads, to be appended to the caller's own
 * `scopedBatch`.
 *
 * Ops rather than awaited writes, so the payload lands in the same transaction
 * as the row it describes — the discipline `syncAccounts` already applies to an
 * account and its balance snapshot. An archive that commits separately can
 * disagree with the projection it is supposed to explain, which is the one thing
 * it must never do.
 *
 * No read-before-write and no change detection. Comparing costs a query per page
 * to save writes on rows that are cheap to write anyway, and the comparison is
 * the fiddly part: Akahu's `updated_at` moves for reasons the payload does not
 * always show, so "has this changed?" is a question with a surprising answer.
 * Overwriting unconditionally has none.
 */
export function archiveOps(
  db: ScopedDb,
  entityType: AkahuEntityType,
  rows: { id: string; payload: unknown }[],
  runId: string | null,
): Prisma.PrismaPromise<unknown>[] {
  return rows.map((row) => {
    // Cast because Prisma types `Json` as its own input union and these payloads
    // are the SDK's response types — plain JSON by construction, but structurally
    // unrelated to that union.
    const payload = row.payload as Prisma.InputJsonValue;

    return db.akahuRecord.upsert({
      where: { entityType_entityId: { entityType, entityId: row.id } },
      create: {
        workspaceId: db.$workspaceId,
        entityType,
        entityId: row.id,
        payload,
        syncRunId: runId,
      },
      // `fetchedAt` is `@updatedAt`, so it moves on its own.
      update: { payload, syncRunId: runId },
    });
  });
}
