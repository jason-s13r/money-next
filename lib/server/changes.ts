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
 *
 * `label` is here for one narrow case: a tag a *rule* was configured to apply, so
 * the run report can show it. Tags a person adds are not logged — they are nobody
 * else's to disagree with (see the label actions) — and neither are the tags a run
 * derives from what it changed, for the same reason `categoryGroupId` is absent.
 *
 * `taxYear` is the exception to that last rule and it is worth saying why, since a
 * person's own labels are *not* logged. A tax-year override is an assertion about
 * which year a payment belongs to, made to a household's tax figures, and it is
 * exactly the sort of claim someone comes back to a year later asking who decided
 * and when. Nothing writes it but a person: Akahu has no opinion here and no rule
 * sets it, so every row logged for this field is a `user` row.
 */
export const CHANGE_FIELDS = ["category", "merchant", "transfer", "label", "taxYear"] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

/**
 * Who made a change. The first three share their vocabulary with
 * `Transaction.categorySource` / `merchantSource`; `supersession` is a writer
 * this log has and those columns do not, because a merge is an event rather than
 * a standing claim about a value.
 *
 * Precedence — `user` beats `rule` beats `akahu` — is a property of the *value*,
 * so it is not read from here when a row carries someone else's: see
 * `carriedSource` on `ChangeContext` and `AUTHORITY_SOURCES` below.
 */
export const CHANGE_SOURCES = ["akahu", "user", "rule", "supersession"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/**
 * The sources that can be a value's author, which is the subset precedence is
 * defined over. A merge is not among them: it never originates a claim, it moves
 * one, and the claim it moves keeps whichever of these it arrived with.
 */
export const AUTHORITY_SOURCES = ["akahu", "user", "rule"] as const;
export type AuthoritySource = (typeof AUTHORITY_SOURCES)[number];

/**
 * One change, as a writer describes it. Ids are for joining back, labels for
 * reading without a join — and for surviving the row they name being renamed or
 * deleted, which a log has to do.
 *
 * `transfer` sets labels only: the other leg's description is the readable thing,
 * and a transfer group is not a value that a `fromId`/`toId` pair could name.
 * `taxYear` does the same, for the same reason: `FY2027` is a span, not a row.
 */
export type FieldChangeEntry = {
  transactionId: string;
  field: ChangeField;
  fromId?: string | null;
  fromLabel?: string | null;
  toId?: string | null;
  toLabel?: string | null;
  /**
   * Per-entry override of `ChangeContext.carriedSource`, for a writer whose
   * batch carries claims of differing standing — a merge moving one row's
   * `user` category and another's `rule` merchant in the same pass, where a
   * single value for the batch would have to lie about one of them.
   */
  carriedSource?: AuthoritySource | null;
};

/** Who or what to attribute a batch to, beyond its `source`. */
export type ChangeContext = {
  actorUserId?: string | null;
  ruleRunId?: string | null;
  syncRunId?: string | null;
  /**
   * The standing of the value written, when the writer is not its author — a
   * merge carrying a person's category onto a successor row. Readers that ask
   * "whose claim is this?" read this first and fall back to `source`, so a
   * writer that originates its own values leaves it unset.
   */
  carriedSource?: AuthoritySource | null;
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
    syncRunId: ctx?.syncRunId ?? null,
    carriedSource: ctx?.carriedSource ?? null,
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
