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
import type { ScopedTx } from "./db";

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
 * The actor is read here rather than passed in, and that is the point of the
 * seam: every one of the nine call sites is a server action that has already
 * resolved a session, so threading a user id through nine signatures would add
 * nine chances to forget one — and a forgotten one doesn't fail, it silently
 * writes `null` and blames nobody. Reading it here means "user changed this" and
 * "which user" cannot come apart.
 *
 * `getSession` is React-cached, so this costs nothing: the action above already
 * paid for it.
 *
 * The import is dynamic because this module deliberately has no `server-only`
 * (see the top of the file) and the Akahu sync imports `changeRows` from plain
 * Node. `./auth/session` *does* import `server-only`, whose whole job is to throw
 * when it is loaded outside a React Server Component — so a static import here
 * would kill the ingest script on load, before a line of it ran. Checked, not
 * assumed: making this import static and running the script throws
 * "This module cannot be imported from a Client Component module".
 *
 * Deferring it to the call moves that load into the only place the session could
 * exist anyway. The sync attributes its own writes to `akahu` and never calls
 * this function, so the module it cannot load is one it never reaches.
 *
 * Rows still carry `null` when there is no session, which stays honest: it means
 * "written before this instance knew who anyone was", and the rows written
 * before phase 3 say exactly that.
 *
 * Takes a `ScopedTx` rather than a `ScopedDb` so it can be called from inside an
 * open transaction — which is where `applyEnrichment` calls it, so that the log
 * rows commit with the write they describe. `ScopedTx` is `ScopedDb` minus
 * `$transaction`, so every caller holding the full client still typechecks; what
 * the narrower type says is that this function does not open one of its own.
 */
export async function recordUserChanges(
  db: ScopedTx,
  entries: readonly FieldChangeEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const { getSession } = await import("./auth/session");
  const session = await getSession();

  await db.fieldChange.createMany({
    data: changeRows(db.$workspaceId, "user", entries, {
      actorUserId: session?.user.id ?? null,
    }),
  });
}
