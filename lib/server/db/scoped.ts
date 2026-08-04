import { AsyncLocalStorage } from "node:async_hooks";

import type { Prisma } from "../../generated/prisma/client";
import { internalDb } from "./client";

/**
 * The tenancy filter, welded onto the Prisma client. One forgotten `where` is a
 * cross-tenant leak and there are ~130 call sites, so it is applied here alone.
 * This makes the *default* safe, not every query: what cannot be scoped throws.
 */

/**
 * Tenant-owned models: every row belongs to one workspace, filtered on a plain
 * `workspaceId` equality. Absent are the shared catalogs — public facts, the
 * same for everyone — plus `Merchant` (half catalog) and the control plane.
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
  "BudgetInferenceRun",
  "RuleDocument",
  "RuleRun",
  "FieldChange",
  "SyncState",
  "SyncRun",
  // Workspace-scoped like the rest. The *further* narrowing to one user — a
  // chat thread is private to its author — is application code, not RLS, which
  // only knows the workspace.
  "ChatThread",
  "ChatMessage",
]);

/**
 * Carry a `workspaceId` but are deliberately unscoped: the rows that decide who
 * may *enter* a workspace, read before there is a current one to filter by. Code
 * rather than prose so the schema-coverage test catches a new model left out.
 */
export const CONTROL_PLANE_MODELS: ReadonlySet<string> = new Set(["Membership", "Invite"]);

/**
 * Set inside a `withScopedTx` callback so the per-operation wrapper knows the RLS
 * variable is already set and must not open its own transaction. AsyncLocalStorage
 * because the signal follows the callback's async tree, not the shared client.
 */
const inScopedTx = new AsyncLocalStorage<boolean>();

/**
 * Set the Postgres GUC the RLS policies read, transaction-locally. On the
 * unscoped client so it composes into the same `$transaction` as the query —
 * sharing one connection is what makes the variable actually govern it.
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

  // The filter goes into `AND`, the caller's own fields stay top level. Under
  // `AND` a caller naming another workspace contradicts the filter and matches
  // nothing instead of overriding it; at top level `findUnique` still sees `id`.
  return { ...given, AND: [...and, filter] };
}

/**
 * Put the workspace on a row about to be written, refusing if the caller named a
 * different one. Quietly rewriting it would hide both things it can mean: a
 * copy-paste bug, or planting a row in someone else's data.
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
 * A Prisma client that can only see one workspace. No id means no client rather
 * than an unfiltered one, whose failure mode is "returns everything to everyone",
 * silently — exactly what a bug in session handling would produce.
 */
export function scopedDb(workspaceId: string) {
  if (!workspaceId) {
    throw new Error(
      "scopedDb requires a workspaceId. Refusing to build an unscoped client: " +
        "an empty scope would silently read and write every workspace's data.",
    );
  }

  return internalDb.$extends({
    // The workspace this client is bound to, readable by callers. Prisma's
    // generated input types still require `workspaceId` on a create even though
    // the extension below supplies it, so writes say `workspaceId: db.$workspaceId`.
    client: { $workspaceId: workspaceId },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model) && model !== "Merchant") {
            // A shared catalog or the tenancy control plane. Pass through.
            return query(args);
          }

          const a = args as Record<string, unknown>;

          // Rewrite the args with the tenancy filter — the primary mechanism.
          // The cast back is because `args` is typed per model and operation
          // while this runs for all of them; call sites keep the real types.
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
            // Everything else takes a `where`. `findUnique` needs no special
            // case: Prisma 7 accepts a non-unique field beside the unique one
            // and filters on it, so the IDOR closes by the same injection.
            next = { ...a, where: scopeWhere(model, workspaceId, a.where) };
          }

          const run = () => query(next as typeof args);

          // Already set for the whole of an enclosing `withScopedTx`, where
          // nesting a transaction would also break its atomicity.
          if (inScopedTx.getStore()) return run();

          // Otherwise the GUC the RLS policies read — the backstop beneath the
          // filter. `set_config(..., true)` is transaction-local, so a pooled
          // connection never carries one request's scope into the next.
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
 * Merchant creates cannot be stamped: one model carries both Akahu's global
 * catalog (`merchant_...`, `workspaceId: null`) and private `user_...` rows.
 * Stamping would privatise a catalog row and collide the next workspace on its id.
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
 * open transaction. `$transaction` is removed because opening a nested one
 * breaks the one-transaction guarantee the helper gives.
 */
export type ScopedTx = Omit<ScopedDb, "$transaction">;

/**
 * Several scoped writes as one atomic transaction, RLS variable set once. The
 * per-operation wrapper's own tiny transaction is right for a single query but
 * splits a group that must be all-or-nothing. Ready arrays: use `scopedBatch`.
 */
export function withScopedTx<T>(db: ScopedDb, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${db.$workspaceId}, true)`;
    return inScopedTx.run(true, () => fn(tx as unknown as ScopedTx));
  });
}

/**
 * A ready array of scoped ops as one pipelined transaction, results in order.
 * Reads belong here as much as writes: the per-op wrapper costs each its own
 * round trip, and one batch sees one snapshot, so a page and its total agree.
 */
export async function scopedBatch<T extends readonly Prisma.PrismaPromise<unknown>[]>(
  db: ScopedDb,
  ops: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await inScopedTx.run(true, () =>
    db.$transaction([
      db.$executeRaw`SELECT set_config('app.workspace_id', ${db.$workspaceId}, true)`,
      ...ops,
    ]),
  );
  // `$transaction` types its result from the tuple it is given, so dropping the
  // prepended `set_config` needs the cast to shift every index back.
  return results.slice(1) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
