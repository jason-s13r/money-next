import { AsyncLocalStorage } from "node:async_hooks";

import type { Prisma } from "../../generated/prisma/client";
import { internalDb } from "./client";

/**
 * The tenancy filter, welded onto the Prisma client.
 *
 * The premise: one forgotten `where` is a cross-tenant financial data leak, and
 * there are ~130 call sites. Discipline does not scale to that, and a code
 * review cannot see the query that *wasn't* written. So the filter is applied in
 * exactly one place — here — and the raw client is unreachable from outside this
 * directory (see ./client and the ESLint rule).
 *
 * What this does not do is more interesting than what it does. It does not make
 * every query safe. It makes the *default* safe: a query written with no thought
 * about tenancy gets scoped, and a query that cannot be scoped automatically
 * throws rather than quietly returning everything.
 */

/**
 * Tenant-owned models: every row belongs to exactly one workspace, and the
 * filter is a plain equality on `workspaceId`.
 *
 * Not listed, and why:
 *
 *   - `Category`, `CategoryGroup`, `FxRate`, `Connection` — shared catalogs. The
 *     NZFCC standard, ECB rates and Akahu's institution ids are public facts,
 *     identical for everyone. Scoping them would mean re-importing the same
 *     catalog per workspace.
 *   - `Merchant` — half catalog, half tenant data. Handled separately below.
 *   - The control plane — see `CONTROL_PLANE_MODELS`.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  "BankLink",
  "Account",
  "Transaction",
  "PendingTransaction",
  "BalanceSnapshot",
  "TransferGroup",
  "TransactionConflict",
  "Label",
  "TransactionLabel",
  "Budget",
  "BudgetItem",
  "Forecast",
  "BudgetInferenceRun",
  "RuleDocument",
  "RuleRun",
  "FieldChange",
  "SyncState",
  "SyncRun",
]);

/**
 * Models that carry a `workspaceId` and are still deliberately *not* scoped.
 *
 * These are the tenancy control plane — the rows that decide who may enter a
 * workspace — rather than data held inside one. The code that reads them
 * legitimately spans workspaces, and a `workspaceId = current` filter would
 * break each case: resolving a session before a current workspace exists,
 * listing the workspaces someone may switch to, and redeeming an invite to a
 * workspace you are by definition not yet in.
 *
 * This list is an admission, not a design: it is the set of tables the scoped
 * client does not protect. Phase 3 gives them their own guarded access path when
 * it writes the code that reads them. Until then nothing reads them at all.
 *
 * It exists as code rather than a comment so the schema-coverage test can hold
 * it to account: a *new* model carrying a `workspaceId` must be classified here
 * or in `TENANT_MODELS`, and cannot be quietly forgotten into being unscoped.
 */
export const CONTROL_PLANE_MODELS: ReadonlySet<string> = new Set(["Membership", "Invite"]);

/**
 * Set within a `withScopedTx` callback so the per-operation extension knows the
 * RLS session variable is already set for the enclosing transaction and must not
 * open its own — see the note at the query wrapper below. An `AsyncLocalStorage`
 * rather than a flag on the client because the signal has to follow the async
 * call tree of the callback, not the client instance (which is shared).
 */
const inScopedTx = new AsyncLocalStorage<boolean>();

/**
 * Set the Postgres GUC the RLS policies read, transaction-locally. Runs on the
 * unscoped client so it composes into the same `$transaction` batch as the query
 * — that is what puts both statements on one connection so the variable actually
 * governs the query. `$executeRaw`'s tagged template parameterises the id.
 */
function setWorkspaceVar(workspaceId: string) {
  return internalDb.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}

/** Operations whose `data` is a row (or rows) about to be written. */
const CREATE_OPS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
]);

/**
 * Reads and writes on `Merchant` see the workspace's own merchants *and* the
 * global Akahu catalog. `null` means catalog.
 */
function merchantFilter(workspaceId: string) {
  return { OR: [{ workspaceId: null }, { workspaceId }] };
}

function scopeWhere(model: string, workspaceId: string, where: unknown) {
  const filter =
    model === "Merchant" ? merchantFilter(workspaceId) : { workspaceId };

  const given = (where ?? {}) as Record<string, unknown>;
  const existing = given.AND;
  const and = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];

  // The filter goes *into* `AND` while the caller's own fields stay at the top
  // level. Both halves of that matter:
  //
  //   - Under `AND`, the filter cannot be overridden. Merging it into the
  //     caller's `where` with a spread would let `where: { workspaceId: theirs }`
  //     replace it, which is precisely the attack. Prisma ANDs top-level fields,
  //     so a caller naming another workspace now contradicts the filter and
  //     matches nothing — it fails closed.
  //
  //   - The caller's fields must stay at the top level or `findUnique` breaks:
  //     it requires a unique field *there*, and wrapping the whole `where` in
  //     `AND` hides `id` from it. Prisma rejects that outright rather than
  //     quietly returning everything, but it would still have broken every
  //     lookup in the app.
  return { ...given, AND: [...and, filter] };
}

/**
 * Put the workspace on a row about to be written — and refuse if the caller
 * named a different one.
 *
 * Rejecting rather than silently rewriting is deliberate. A create that names
 * another workspace is either a copy-paste bug or an attempt to plant a row in
 * someone else's data; quietly "fixing" it to the current workspace would hide
 * both. There is no legitimate way for a client scoped to A to write a row owned
 * by B.
 */
function stampRow(workspaceId: string, row: unknown) {
  const given = (row as { workspaceId?: unknown })?.workspaceId;
  if (given !== undefined && given !== workspaceId) {
    throw new Error(
      `Refusing to write a row owned by workspace ${String(given)} through a ` +
        `client scoped to ${workspaceId}.`,
    );
  }
  return { ...(row as object), workspaceId };
}

/**
 * A Prisma client that can only see one workspace.
 *
 * Fails closed: no workspace id means no client, rather than a client with no
 * filter. The difference matters — the failure mode of the second one is
 * "returns everything to everyone", silently, and it is exactly what a bug in
 * session handling would produce.
 */
export function scopedDb(workspaceId: string) {
  if (!workspaceId) {
    throw new Error(
      "scopedDb requires a workspaceId. Refusing to build an unscoped client: " +
        "an empty scope would silently read and write every workspace's data.",
    );
  }

  return internalDb.$extends({
    // The workspace this client is bound to, readable by callers.
    //
    // Prisma's generated input types still require `workspaceId` on a create
    // even though the extension below supplies it, so writes say
    // `workspaceId: db.$workspaceId`. That reads as what it is — "this row
    // belongs to the workspace this client is scoped to" — it typechecks, and
    // it survives phase 3 untouched, because the constant moves into `getDb`
    // rather than into the call sites.
    client: { $workspaceId: workspaceId },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model) && model !== "Merchant") {
            // A shared catalog or the tenancy control plane. Pass through.
            return query(args);
          }

          const a = args as Record<string, unknown>;

          // Rewrite the args with the tenancy filter (the app-level scope, still
          // the primary mechanism). `next` is handed back through a cast: `args`
          // is typed per model and per operation, but this runs for all of them
          // at once. The shapes are checked at every call site by the generated
          // types; what is lost here is only the ability to name that shape.
          let next: Record<string, unknown>;
          if (CREATE_OPS.has(operation)) {
            next = { ...a, data: stampFor(model, workspaceId, a.data) };
          } else if (operation === "upsert") {
            next = {
              ...a,
              where: scopeWhere(model, workspaceId, a.where),
              create: stampFor(model, workspaceId, a.create),
            };
          } else {
            // Everything else takes a `where`: the finds, count, aggregate,
            // groupBy, update(Many), delete(Many).
            //
            // `findUnique`/`findFirst` need no special handling despite the plan
            // expecting to rewrite them: Prisma 7 accepts a non-unique field
            // alongside the unique one in `findUnique`'s where and filters on it,
            // verified against the real database. So the IDOR case —
            // `findUnique({ where: { id } })` handing over another workspace's
            // transaction — is closed by the same injection as everything else.
            next = { ...a, where: scopeWhere(model, workspaceId, a.where) };
          }

          const run = () => query(next as typeof args);

          // Then set the Postgres session variable the RLS policies read (phase
          // 6, the backstop beneath the filter above). This model is RLS-guarded,
          // so the query must run in a transaction that first sets
          // `app.workspace_id` — set_config(..., true) is transaction-local, so a
          // pooled connection never carries one request's scope into the next.
          //
          // Inside a `withScopedTx`, the variable is already set for the whole
          // transaction: skip the per-op wrapper, both to avoid the cost and
          // because nesting a transaction inside the interactive one would break
          // its atomicity (a batch write splitting into separate transactions).
          if (inScopedTx.getStore()) return run();
          const [, result] = await internalDb.$transaction([
            setWorkspaceVar(workspaceId),
            run(),
          ]);
          return result;
        },
      },
    },
  });
}

/**
 * Merchant is the one model where a create cannot be stamped automatically.
 *
 * Both kinds of merchant are written through the same model: the ingest mirrors
 * Akahu's catalog (`merchant_...`, global, `workspaceId: null`) and the
 * transaction page mints private ones (`user_...`, a name someone typed, which
 * is their data). Blanket-stamping the workspace would make the first Akahu
 * merchant a workspace ever syncs private to that workspace — and the next
 * workspace to see the same merchant would then fail on a primary key collision
 * rather than reuse the catalog row.
 *
 * So the caller must say which kind it is, and forgetting throws. The failure
 * this prevents is a private merchant name silently becoming a global catalog
 * entry visible in every other workspace's picker.
 */
function stampFor(model: string, workspaceId: string, data: unknown) {
  const one = (row: unknown) => {
    if (model !== "Merchant") return stampRow(workspaceId, row);

    if (!row || !("workspaceId" in (row as object))) {
      throw new Error(
        "Merchant creates must set workspaceId explicitly: the workspace's id " +
          "for a private `user_...` merchant, or null for Akahu's shared catalog. " +
          "It cannot be inferred — see lib/server/db/scoped.ts.",
      );
    }
    const given = (row as { workspaceId?: unknown }).workspaceId;
    if (given !== null && given !== workspaceId) {
      throw new Error(
        `Refusing to write a merchant owned by workspace ${String(given)} ` +
          `through a client scoped to ${workspaceId}.`,
      );
    }
    return row;
  };

  return Array.isArray(data) ? data.map(one) : one(data);
}

export type ScopedDb = ReturnType<typeof scopedDb>;

/**
 * The client handed to a `withScopedTx` callback: a scoped client bound to the
 * open transaction. `$transaction` is removed because opening a nested one is a
 * footgun the type should forbid — the whole point of the helper is that there
 * is exactly one transaction, with the RLS variable set once at its start.
 */
export type ScopedTx = Omit<ScopedDb, "$transaction">;

/**
 * Run several scoped writes as one atomic transaction, with the RLS session
 * variable set once for the whole of it.
 *
 * This exists because the per-operation wrapper above (which sets the variable
 * in its own tiny transaction) is correct for single queries but wrong for a
 * group that must be all-or-nothing: wrapping each member separately splits the
 * group into independent transactions and loses atomicity.
 *
 * Use this form when the writes are interleaved with reads or branching logic —
 * `linkTransferLegs`, the transfer-unlink action. It opens one interactive
 * transaction, sets `app.workspace_id` on that connection, marks the async
 * context so the per-operation wrapper stands down, and runs the callback against
 * the transaction client. For a ready array of independent writes with no logic
 * between them, `scopedBatch` pipelines in a single round trip.
 */
export function withScopedTx<T>(db: ScopedDb, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${db.$workspaceId}, true)`;
    return inScopedTx.run(true, () => fn(tx as unknown as ScopedTx));
  });
}

/**
 * Run a ready array of scoped writes as one atomic, pipelined transaction with
 * the RLS variable set once at its head.
 *
 * The batch counterpart to `withScopedTx`, for the ingest steps that build a page
 * of upserts up front and commit them together (`syncTransactions`,
 * `syncPendingTransactions`). The ops are built from the scoped client as before;
 * this prepends the `set_config` as the batch's first statement and runs the whole
 * batch inside the `inScopedTx` context, so the per-operation wrapper stands down
 * and every op executes on the one connection where the variable is set. That the
 * async context reaches Prisma's internal batch execution — so the wrapper does
 * not nest a transaction inside the batch — is verified against the database.
 */
export function scopedBatch(db: ScopedDb, ops: Prisma.PrismaPromise<unknown>[]) {
  return inScopedTx.run(true, () =>
    db.$transaction([
      db.$executeRaw`SELECT set_config('app.workspace_id', ${db.$workspaceId}, true)`,
      ...ops,
    ]),
  );
}
