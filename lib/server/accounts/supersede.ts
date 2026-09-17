// Merging an account into the one Akahu replaced it with.
//
// When an institution moves from a classic Akahu connection to official open
// banking, Akahu mints a new `acc_...`, backfills the history under new
// `trans_...` ids, and stops returning the old account. Nothing here notices:
// `Account.id` *is* the Akahu id, so the result is two accounts holding the same
// money, and every balance and spend figure counts it twice.
//
// The fix is to merge rather than to filter. A filtered tombstone would need a
// `supersededById: null` predicate in every aggregation in the app — a dozen
// files, each building its own `where`, where one omission double-counts in
// silence. A *merged* tombstone holds no transactions at all, so the arithmetic
// is right whether or not a query remembers it exists. That is the whole reason
// this module is destructive: the invariant it buys is "a superseded account has
// zero transactions", and nothing weaker is worth having.
//
// Pairing is exact, not heuristic. Akahu's `_migrated` names each row's
// predecessor by id (mirrored here as `migratedFromId`), so there is no date
// tolerance and no ambiguity — which matters more than it sounds, because a real
// account has repeated (date, amount, description) keys that no fuzzy matcher
// can tell apart.

// Deliberately no `import "server-only"`, like `changes.ts` and
// `matching/transfers.ts`: `money account supersede` is the primary caller and
// it runs in plain Node, where that module throws on load.

import { changeRows, type FieldChangeEntry } from "../changes";
import { scopedBatch, type ScopedDb } from "../db";
import type { Prisma } from "../../generated/prisma/client";

/** What to do with an old row in the overlap that no successor claimed. */
export type FallbackMode = "report" | "heuristic" | "move";

/** How close two rows' dates may be and still be the same payment. */
const HEURISTIC_DAY_TOLERANCE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The enrichment ladder, as a number so it can be compared.
 *
 * The same `user > rule > akahu` precedence the sync enforces in
 * `ingest/transactions.ts` and the log records in `changes.ts` — deliberately
 * re-derived from those source names rather than restated, so there is one
 * vocabulary and not a second one that can drift out of step with it.
 */
function rank(source: string): number {
  return source === "user" ? 2 : source === "rule" ? 1 : 0;
}

type AccountRef = {
  id: string;
  name: string;
  displayName: string | null;
  formattedAccount: string | null;
  connectionId: string;
  supersededById: string | null;
  migratedFromId: string | null;
};

type OldRow = {
  id: string;
  date: Date;
  description: string;
  amount: Prisma.Decimal;
  categoryId: string | null;
  categoryGroupId: string | null;
  categorySource: string;
  merchantId: string | null;
  merchantSource: string;
  taxYear: number | null;
  transferGroupId: string | null;
};

type NewRow = {
  id: string;
  date: Date;
  description: string;
  amount: Prisma.Decimal;
  migratedFromId: string | null;
  categoryId: string | null;
  categoryGroupId: string | null;
  categorySource: string;
  merchantId: string | null;
  merchantSource: string;
  taxYear: number | null;
  transferGroupId: string | null;
};

/** One old row and the successor that replaced it. */
export type DuplicatePair = {
  old: OldRow;
  next: NewRow;
  /** How the two were matched — `migrated` is Akahu's word, `heuristic` is ours. */
  via: "migrated" | "heuristic";
  /** Fields to write onto the successor, empty when it already outranks the old row. */
  carry: Prisma.TransactionUpdateInput;
  /** What `carry` changed, for the field-change log. */
  changes: FieldChangeEntry[];
};

export type SupersessionPlan = {
  old: AccountRef;
  next: AccountRef;
  fallback: FallbackMode;
  /** Old rows whose successor is known: metadata moves across, then they go. */
  duplicates: DuplicatePair[];
  /** Old rows with no successor: they carry history the new account never got. */
  moves: OldRow[];
  /**
   * Old rows dated inside the new account's range that nothing claimed. Empty in
   * a clean migration. Non-empty means the backfill has a hole, and moving them
   * blind would put a duplicate back — so `apply` refuses until told how.
   */
  unclaimed: OldRow[];
};

/**
 * Who last set a row's transfer link, by transaction id.
 *
 * `TransferGroup` has no `*Source` column — the group is shared by its legs, so
 * there is nowhere on it to record which leg's author is speaking. The answer
 * lives in the change log instead, which is written by every writer that links a
 * transfer. Absent means nobody logged one, which reads as `akahu`: the weakest
 * claim, and the right default for a link nothing takes credit for.
 */
type TransferAuthors = ReadonlyMap<string, string>;

/** Which enrichment `next` should inherit from `old`, and the log rows for it. */
function carryOver(
  old: OldRow,
  next: NewRow,
  transferAuthors: TransferAuthors,
): Pick<DuplicatePair, "carry" | "changes"> {
  const carry: Prisma.TransactionUpdateInput = {};
  const changes: FieldChangeEntry[] = [];

  // Category and merchant move only when the old row's owner outranks the new
  // one's. Usually that is `user` or `rule` over the `akahu` the successor
  // arrived with — but not always: rules run against the new account too, and a
  // rule must not overwrite a person.
  if (rank(old.categorySource) > rank(next.categorySource)) {
    carry.category = old.categoryId ? { connect: { id: old.categoryId } } : { disconnect: true };
    carry.categoryGroup = old.categoryGroupId
      ? { connect: { id: old.categoryGroupId } }
      : { disconnect: true };
    carry.categorySource = old.categorySource;
    changes.push({
      transactionId: next.id,
      field: "category",
      fromId: next.categoryId,
      fromLabel: null,
      toId: old.categoryId,
      toLabel: null,
    });
  }

  if (rank(old.merchantSource) > rank(next.merchantSource)) {
    carry.merchant = old.merchantId ? { connect: { id: old.merchantId } } : { disconnect: true };
    carry.merchantSource = old.merchantSource;
    changes.push({
      transactionId: next.id,
      field: "merchant",
      fromId: next.merchantId,
      fromLabel: null,
      toId: old.merchantId,
      toLabel: null,
    });
  }

  // Tax year has no `*Source` column, so "did someone set this?" is just "is it
  // set?" — and only a person ever writes it (see the schema). Fill what the
  // successor is missing; anything already there is the later word.
  if (next.taxYear === null && old.taxYear !== null) {
    carry.taxYear = old.taxYear;
    changes.push({
      transactionId: next.id,
      field: "taxYear",
      fromId: null,
      fromLabel: null,
      toId: null,
      toLabel: `FY${old.taxYear}`,
    });
  }

  // A transfer group is the one thing that links two *transactions*, so it is
  // the one relationship a merge can break from the far side: labels, conflicts
  // and log rows all name their transaction directly and are simply repointed,
  // but the other leg of a transfer holds no reference to this row at all — it
  // only shares a group id. Dissolve that group and a row on an account which
  // never migrated silently stops being a transfer.
  //
  // So when both rows are already in a group, the decision is whose link to
  // keep, and it follows the same `user > rule > akahu` ladder as everything
  // above. Taking the successor's unconditionally is what broke three real
  // transfers here: the rules pass had auto-linked a successor minutes after the
  // migration landed, and that guess then outranked a link a person had made by
  // hand two months earlier.
  //
  // The ladder matters more here than anywhere else above, because the two kinds
  // of link are not equally replaceable. A displaced `rule` link costs nothing —
  // the next rules pass re-makes it. A displaced `user` link is unrecoverable:
  // the ones people make by hand are precisely the ones matching cannot find,
  // like a Kiwibank debit and the Wise credit that answers it days later, where
  // the lag and the FX defeat any automatic pairing. Losing one is losing the
  // only record that those two rows were the same movement of money.
  const inheritedGroup = ((): string | null => {
    const group = old.transferGroupId;
    if (group === null || group === next.transferGroupId) return null;
    if (next.transferGroupId === null) return group;
    const author = (id: string) => rank(transferAuthors.get(id) ?? "akahu");
    return author(old.id) > author(next.id) ? group : null;
  })();

  if (inheritedGroup !== null) {
    // Both legs of a group carry the same id across, so a transfer survives the
    // merge whole. Displacing a weaker link can leave *its* group one leg short;
    // `applySupersession` sweeps whatever is left singular and reports the count,
    // because a rules pass can re-make its own guess and a person cannot be asked
    // to notice one that vanished.
    carry.transferGroup = { connect: { id: inheritedGroup } };
    changes.push({
      transactionId: next.id,
      field: "transfer",
      fromId: null,
      fromLabel: null,
      toId: null,
      toLabel: old.description,
    });
  }

  return { carry, changes };
}

/**
 * Pair the leftovers by shape when Akahu's ids don't reach them.
 *
 * Only ever used on rows `_migrated` said nothing about. 1:1 and greedy from the
 * closest date outwards, because a real account genuinely does have two
 * identical transactions on one day and an `EXISTS` join would match both of
 * them to the same successor.
 */
function heuristicPairs(olds: OldRow[], candidates: NewRow[]): Map<string, NewRow> {
  const byKey = new Map<string, NewRow[]>();
  for (const row of candidates) {
    const key = `${row.amount.toString()}|${row.description}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const paired = new Map<string, NewRow>();
  for (const old of olds) {
    const bucket = byKey.get(`${old.amount.toString()}|${old.description}`);
    if (!bucket || bucket.length === 0) continue;

    let bestIndex = -1;
    let bestGap = Infinity;
    for (let i = 0; i < bucket.length; i++) {
      const gap = Math.abs(bucket[i].date.getTime() - old.date.getTime());
      if (gap <= HEURISTIC_DAY_TOLERANCE * DAY_MS && gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) continue;

    // Claimed, so the next old row with the same shape cannot take it too.
    paired.set(old.id, bucket.splice(bestIndex, 1)[0]);
  }
  return paired;
}

const OLD_SELECT = {
  id: true,
  date: true,
  description: true,
  amount: true,
  categoryId: true,
  categoryGroupId: true,
  categorySource: true,
  merchantId: true,
  merchantSource: true,
  taxYear: true,
  transferGroupId: true,
} as const;

const ACCOUNT_SELECT = {
  id: true,
  name: true,
  displayName: true,
  formattedAccount: true,
  connectionId: true,
  supersededById: true,
  migratedFromId: true,
} as const;

/**
 * Work out what merging `oldId` into `newId` would do, without doing any of it.
 *
 * Pure reads, so the CLI's dry-run and its apply run the same code and can't
 * disagree about what is about to happen.
 */
export async function planSupersession(
  db: ScopedDb,
  { oldId, newId, fallback = "report" }: { oldId: string; newId: string; fallback?: FallbackMode },
): Promise<SupersessionPlan> {
  if (oldId === newId) {
    throw new Error("An account cannot supersede itself.");
  }

  // Through the scoped client, so an id from a CLI flag or a form field can only
  // ever name an account in this workspace.
  const [old, next] = await Promise.all([
    db.account.findFirst({ where: { id: oldId }, select: ACCOUNT_SELECT }),
    db.account.findFirst({ where: { id: newId }, select: ACCOUNT_SELECT }),
  ]);

  if (!old) throw new Error(`No account ${oldId} in this workspace.`);
  if (!next) throw new Error(`No account ${newId} in this workspace.`);
  if (old.supersededById) {
    throw new Error(`${oldId} is already superseded by ${old.supersededById}.`);
  }
  // Chains would make "which account holds this history?" a walk rather than a
  // lookup, and there is no case for one: a second migration supersedes the
  // survivor, which by then holds everything.
  if (next.supersededById) {
    throw new Error(`${newId} is itself superseded by ${next.supersededById} — merge into that instead.`);
  }

  const [oldRows, newRows, transferLog] = await Promise.all([
    db.transaction.findMany({
      where: { accountId: oldId },
      select: OLD_SELECT,
      orderBy: { date: "asc" },
    }),
    db.transaction.findMany({
      where: { accountId: newId },
      select: { ...OLD_SELECT, migratedFromId: true },
      orderBy: { date: "asc" },
    }),
    // Who linked each transfer, newest last so the final write wins. Scoped to
    // these two accounts' rows by `transactionId` below rather than in the
    // query, because a leg on a *third* account is exactly what this protects
    // and its own log row is not what decides the outcome.
    db.fieldChange.findMany({
      where: { field: "transfer" },
      select: { transactionId: true, source: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const transferAuthors = new Map<string, string>();
  for (const row of transferLog) transferAuthors.set(row.transactionId, row.source);

  // Akahu's own answer first: every successor that names a predecessor.
  const claimed = new Map<string, NewRow>();
  for (const row of newRows) {
    if (row.migratedFromId) claimed.set(row.migratedFromId, row);
  }

  const duplicates: DuplicatePair[] = [];
  const leftovers: OldRow[] = [];
  for (const old of oldRows) {
    const match = claimed.get(old.id);
    if (match)
      duplicates.push({ old, next: match, via: "migrated", ...carryOver(old, match, transferAuthors) });
    else leftovers.push(old);
  }

  // Anything before the successor's first transaction is history the new account
  // was never given — it moves across whatever the fallback says. Only the
  // overlap is ambiguous, because only there could a duplicate be hiding.
  const newStart = newRows[0]?.date;
  const inOverlap = (row: OldRow) => newStart !== undefined && row.date >= newStart;

  const moves: OldRow[] = leftovers.filter((row) => !inOverlap(row));
  let unclaimed: OldRow[] = leftovers.filter(inOverlap);

  if (fallback === "heuristic" && unclaimed.length > 0) {
    const free = newRows.filter((row) => !row.migratedFromId);
    const paired = heuristicPairs(unclaimed, free);
    const stillUnclaimed: OldRow[] = [];
    for (const old of unclaimed) {
      const match = paired.get(old.id);
      if (match)
        duplicates.push({ old, next: match, via: "heuristic", ...carryOver(old, match, transferAuthors) });
      else stillUnclaimed.push(old);
    }
    unclaimed = stillUnclaimed;
  }

  if (fallback === "move" || fallback === "heuristic") {
    moves.push(...unclaimed);
    unclaimed = [];
  }

  return { old, next, fallback, duplicates, moves, unclaimed };
}

export type SupersessionResult = {
  duplicatesRemoved: number;
  transactionsMoved: number;
  enrichmentCarried: number;
  labelsCarried: number;
  conflictsCarried: number;
  changesRepointed: number;
  snapshotsMoved: number;
  transferGroupsPruned: number;
};

/**
 * Perform the merge the plan describes, as one transaction.
 *
 * One `scopedBatch` per account pair rather than one for a whole run: the pair is
 * the unit somebody decided to merge, so it is the right thing to be all-or-
 * nothing, and batching three pairs together would only make the failure mode
 * bigger without making any of them safer.
 */
export async function applySupersession(
  db: ScopedDb,
  plan: SupersessionPlan,
): Promise<SupersessionResult> {
  if (plan.unclaimed.length > 0) {
    throw new Error(
      `${plan.unclaimed.length} transaction(s) on ${plan.old.id} sit inside ` +
        `${plan.next.id}'s date range with no successor. Moving them blind would ` +
        `restore a duplicate; re-run with --fallback heuristic or --fallback move.`,
    );
  }

  const oldDupIds = plan.duplicates.map((pair) => pair.old.id);
  const successorOf = new Map(plan.duplicates.map((pair) => [pair.old.id, pair.next.id]));

  // Read what actually hangs off the doomed rows before building the writes.
  // Querying first keeps the write batch to the rows that really have a label, a
  // conflict or a log entry, instead of thousands of updates that match nothing.
  const [oldLabels, oldConflicts, newConflicts, loggedIds, oldSnapshots, newSnapshots] =
    await Promise.all([
      db.transactionLabel.findMany({
        where: { transactionId: { in: oldDupIds } },
        select: { transactionId: true, labelId: true },
      }),
      db.transactionConflict.findMany({
        where: { transactionId: { in: oldDupIds } },
        select: { id: true, transactionId: true, field: true },
      }),
      db.transactionConflict.findMany({
        where: { transactionId: { in: [...successorOf.values()] } },
        select: { transactionId: true, field: true },
      }),
      db.fieldChange.findMany({
        where: { transactionId: { in: oldDupIds } },
        select: { transactionId: true },
        distinct: ["transactionId"],
      }),
      db.balanceSnapshot.findMany({
        where: { accountId: plan.old.id },
        select: { id: true, capturedAt: true },
      }),
      db.balanceSnapshot.findMany({
        where: { accountId: plan.next.id },
        select: { capturedAt: true },
      }),
    ]);

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const changes: FieldChangeEntry[] = [];

  // 1. Enrichment onto the survivors, before the old rows are gone.
  let enrichmentCarried = 0;
  for (const pair of plan.duplicates) {
    if (Object.keys(pair.carry).length === 0) continue;
    enrichmentCarried++;
    changes.push(...pair.changes);
    ops.push(db.transaction.update({ where: { id: pair.next.id }, data: pair.carry }));
  }

  // 2. Labels are a union, not a copy: the successor keeps any tag it already has
  //    and gains the rest. `skipDuplicates` is what makes that true when both
  //    rows carry the same tag, the composite PK being (transactionId, labelId).
  const labelRows = oldLabels.map((row) => ({
    workspaceId: db.$workspaceId,
    transactionId: successorOf.get(row.transactionId)!,
    labelId: row.labelId,
  }));
  if (labelRows.length > 0) {
    ops.push(db.transactionLabel.createMany({ data: labelRows, skipDuplicates: true }));
  }

  // 3. Open conflicts follow the value they are about — unless the successor
  //    already has one for that field, which `@@unique([transactionId, field])`
  //    would reject. Its own is the current disagreement; the old row's is about
  //    a value that is about to stop existing.
  const takenFields = new Set(newConflicts.map((row) => `${row.transactionId}:${row.field}`));
  let conflictsCarried = 0;
  for (const conflict of oldConflicts) {
    const successor = successorOf.get(conflict.transactionId)!;
    if (takenFields.has(`${successor}:${conflict.field}`)) continue;
    takenFields.add(`${successor}:${conflict.field}`);
    conflictsCarried++;
    ops.push(
      db.transactionConflict.update({
        where: { id: conflict.id },
        data: { transactionId: successor },
      }),
    );
  }

  // 4. Repoint the audit log. `FieldChange.transactionId` is a plain column
  //    precisely so an append-only log can't be shredded by a cascade — which
  //    also means it can be pointed at the surviving row, so "who set this
  //    category, and when?" still answers after the merge.
  for (const row of loggedIds) {
    ops.push(
      db.fieldChange.updateMany({
        where: { transactionId: row.transactionId },
        data: { transactionId: successorOf.get(row.transactionId)! },
      }),
    );
  }

  // 5. The duplicates go. Cascades take their remaining labels and conflicts;
  //    their Akahu payloads stay, `AkahuRecord.entityId` being a plain column.
  if (oldDupIds.length > 0) {
    ops.push(db.transaction.deleteMany({ where: { id: { in: oldDupIds } } }));
  }

  // 6. Everything with no successor moves across, keeping its id and every edit
  //    on it. `connectionId` is normalised to the survivor's on the way: after a
  //    migration Akahu reports backfilled rows under the *old* connection, so
  //    leaving it would file this history under an institution row the account no
  //    longer belongs to.
  if (plan.moves.length > 0) {
    ops.push(
      db.transaction.updateMany({
        where: { id: { in: plan.moves.map((row) => row.id) } },
        data: { accountId: plan.next.id, connectionId: plan.next.connectionId },
      }),
    );
  }

  // 7. Balance history. The old account's snapshots reach back further than the
  //    new one's, so they are worth keeping — but `@@unique([accountId,
  //    capturedAt])` means the days both recorded have to give way, and on those
  //    days the successor's own figure is the right one.
  const newDays = new Set(newSnapshots.map((row) => row.capturedAt.getTime()));
  const collided = oldSnapshots.filter((row) => newDays.has(row.capturedAt.getTime()));
  const movable = oldSnapshots.filter((row) => !newDays.has(row.capturedAt.getTime()));
  if (collided.length > 0) {
    ops.push(
      db.balanceSnapshot.deleteMany({ where: { id: { in: collided.map((r) => r.id) } } }),
    );
  }
  if (movable.length > 0) {
    ops.push(
      db.balanceSnapshot.updateMany({
        where: { id: { in: movable.map((r) => r.id) } },
        data: { accountId: plan.next.id },
      }),
    );
  }

  // 8. Pending rows are a snapshot of what is in flight, replaced wholesale every
  //    sync. The tombstone will never sync again, so its own would sit there for
  //    good.
  ops.push(db.pendingTransaction.deleteMany({ where: { accountId: plan.old.id } }));

  // 9. The tombstone itself.
  ops.push(
    db.account.update({
      where: { id: plan.old.id },
      data: { supersededById: plan.next.id, supersededAt: new Date() },
    }),
  );

  if (changes.length > 0) {
    ops.push(
      db.fieldChange.createMany({
        // `user`, not `akahu`: a person decided these two accounts were one, and
        // this is that decision reaching the rows. Attributing it to the sync
        // would say Akahu changed its mind, which is the opposite of what
        // happened — Akahu's own values are the ones being overwritten.
        data: changeRows(db.$workspaceId, "user", changes),
      }),
    );
  }

  await scopedBatch(db, ops);

  // A group whose other leg was a duplicate that did not carry its id across is
  // now a transfer of one, which no longer means anything. Swept afterwards
  // rather than inside: it is a consequence of the merge, and can only be seen
  // once the merge has happened.
  const groups = await db.transferGroup.findMany({
    select: { id: true, _count: { select: { transactions: true } } },
  });
  const prunable = groups.filter((g) => g._count.transactions < 2).map((g) => g.id);
  if (prunable.length > 0) {
    await db.transferGroup.deleteMany({ where: { id: { in: prunable } } });
  }

  return {
    duplicatesRemoved: oldDupIds.length,
    transactionsMoved: plan.moves.length,
    enrichmentCarried,
    labelsCarried: labelRows.length,
    conflictsCarried,
    changesRepointed: loggedIds.length,
    snapshotsMoved: movable.length,
    transferGroupsPruned: prunable.length,
  };
}

/**
 * The pairs Akahu itself proposes: an account naming a predecessor this
 * workspace actually holds.
 *
 * A `migratedFromId` pointing at an account that was never ingested is normal
 * and not an error — an institution can migrate before anyone connects it, which
 * is exactly what ASB did here — so it is filtered out rather than reported.
 */
export async function proposeSupersessions(
  db: ScopedDb,
): Promise<{ oldId: string; newId: string }[]> {
  const accounts = await db.account.findMany({
    select: { id: true, migratedFromId: true, supersededById: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  return accounts
    .filter((a) => a.migratedFromId !== null && !a.supersededById)
    .flatMap((a) => {
      const predecessor = byId.get(a.migratedFromId!);
      // Not held: the migration happened before this workspace ever connected
      // the institution, so there is nothing here to merge. Already superseded:
      // a previous run did this pair.
      if (!predecessor || predecessor.supersededById) return [];
      return [{ oldId: predecessor.id, newId: a.id }];
    });
}
