// The append-only field change log: the vocabulary all three writers share, and
// the one way rows get into `FieldChange`.
//
// Kept free of `import "server-only"` (like matching/transfers.ts) because the
// Akahu sync writes here too, and it runs inside the plain-Node ingest script as
// well as in the server.
//
// The rule the whole log rests on: a row here means the value *changed*. Writers
// diff before they log, and a no-op write logs nothing. Without that the table
// would fill with one row per field per sync per transaction — 4,000 rows a pass
// saying nothing happened — and "what changed?" would become a question you had
// to compute rather than read.

import type { Prisma } from "../generated/prisma/client";
import type { ScopedDb } from "./db";

/**
 * The attributable fields: the enrichment a writer can disagree with a previous
 * writer about. Deliberately not every column — `description` and `amount` are
 * Akahu's facts, mirrored, and nobody edits them, so a log of them would only
 * record the sync talking to itself.
 *
 * `categoryGroupId` is absent because it is not independently attributable: it
 * is kept in step with the category by whoever sets the category, so logging it
 * would double every category change.
 */
export const CHANGE_FIELDS = ["category", "merchant", "transfer"] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

/**
 * What made a change. The same vocabulary as `Transaction.categorySource` /
 * `merchantSource`, and the same precedence: `user` beats `rule` beats `akahu`.
 */
export const CHANGE_SOURCES = ["akahu", "user", "rule"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/**
 * One change, as a writer describes it. Ids are for joining back, labels for
 * reading without a join — and for surviving the row they name being renamed or
 * deleted, which a log has to do.
 *
 * `transfer` sets labels only: the other leg's description is the readable thing,
 * and a transfer group is not a value that a `fromId`/`toId` pair could name.
 */
export type FieldChangeEntry = {
  transactionId: string;
  field: ChangeField;
  fromId?: string | null;
  fromLabel?: string | null;
  toId?: string | null;
  toLabel?: string | null;
};

/** Who or what to attribute a batch to, beyond its `source`. */
export type ChangeContext = {
  actorUserId?: string | null;
  ruleRunId?: string | null;
};

/**
 * Change entries as rows ready to write.
 *
 * Handed back rather than written so a caller can put them in a transaction it
 * already owns. The Akahu sync does exactly that: its log rows commit in the same
 * statement as the upserts they describe, because a log that says a change
 * happened when it didn't is worse than no log at all.
 */
export function changeRows(
  workspaceId: string,
  source: ChangeSource,
  entries: readonly FieldChangeEntry[],
  ctx?: ChangeContext,
): Prisma.FieldChangeCreateManyInput[] {
  return entries.map((entry) => ({
    workspaceId,
    source,
    actorUserId: ctx?.actorUserId ?? null,
    ruleRunId: ctx?.ruleRunId ?? null,
    ...entry,
  }));
}

/**
 * Record what a person just did.
 *
 * The actor is null on every row this writes today, and that is the honest value
 * rather than a placeholder: there are no users until phase 3 brings auth, so a
 * null `actorUserId` says "written before this instance knew who anyone was",
 * which is true. Phase 3 replaces the one line below with the session's user id
 * and every call site above is already correct — the same seam `getDb()` uses for
 * the workspace.
 */
export async function recordUserChanges(
  db: ScopedDb,
  entries: readonly FieldChangeEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.fieldChange.createMany({
    data: changeRows(db.$workspaceId, "user", entries, { actorUserId: null }),
  });
}
