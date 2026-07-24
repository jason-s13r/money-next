/**
 * Retires the bootstrap workspace and bank link's placeholder ids.
 *
 *   pnpm unhook-bootstrap-ids
 *
 * The first workspace and its bank link do not come from `workspace:create` /
 * `link:token` — they are inserted by a *migration* (`20260717001104_tenancy_models`)
 * with the fixed ids `ws_bootstrap` and `link_bootstrap`, because a migration
 * cannot mint a random id and stay deterministic. Every row made since gets a
 * real, generated id; these two are the only ones left carrying a placeholder,
 * and a placeholder is the kind of value code starts special-casing.
 *
 * This is the one-shot that obsoletes them: it gives each row an id in exactly
 * the shape it would have had if it had been created through the app — a `cuid`
 * for the link (its `@default(cuid())`, like every link `link:token` makes), and
 * Better Auth's own organization id generator for the workspace (the 32-char
 * string `createOrganization` would have produced, since a workspace is an
 * auth/tenancy object) — so afterwards nothing about the bootstrap workspace or
 * link is structurally distinguishable from any other.
 *
 * Idempotent by construction: it acts only on the rows whose id *is* the
 * placeholder, so a second run finds nothing and does nothing. There is no flag
 * and no id to pass — the whole point is that the new ids are generated, not
 * chosen.
 *
 * ## Why a rename is one statement
 *
 * Every `workspaceId` / `bankLinkId` foreign key is `ON UPDATE CASCADE` (see the
 * tenancy migrations), so renaming `Workspace.id` moves its memberships, invites,
 * links and all financial rows, and renaming `BankLink.id` moves its accounts,
 * transactions, sync state and sync runs — the database fans it out, and
 * referential-action cascades bypass RLS, so nothing is stranded. Two references
 * a cascade does not reach, both handled here:
 *
 *   - `Session.activeWorkspaceId` is a plain string, not a foreign key (nothing
 *     reads it — the app routes the workspace in the URL), so it is updated in the
 *     same transaction as the workspace.
 *   - `BankLink` is a tenant table under RLS, so its own UPDATE runs through
 *     `scopedDb`, with the workspace scope set, or the policy would hide the very
 *     row being renamed. The workspace rename, being control-plane, uses `authDb`.
 *
 * The link is renamed first, while the workspace it belongs to still exists to be
 * scoped to; the workspace rename then carries the (already-renamed) link's
 * `workspaceId` along with everything else.
 *
 * ## Why the shell
 *
 * Same reasoning as the tenant-lifecycle tools next door: this spans the control
 * plane by definition and is a once-at-setup operation, so it wants the
 * owner/migration database connection, the same one `db:migrate` assumes.
 */
import { askYesNo, promptSession } from "./read-secret";
import type { Auth } from "../lib/server/auth";
import type { ScopedDb } from "../lib/server/db";

/** The ids the bootstrap migration hard-codes. This tool exists to erase them. */
const BOOTSTRAP_WORKSPACE_ID = "ws_bootstrap";
const BOOTSTRAP_LINK_ID = "link_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm unhook-bootstrap-ids [--yes]

Gives the bootstrap workspace (${BOOTSTRAP_WORKSPACE_ID}) and its bank link
(${BOOTSTRAP_LINK_ID}) freshly generated ids, so they become structurally
identical to any workspace and link created through the app. The change cascades
to every dependent row in one transaction.

Run once. A second run is a no-op — there is no placeholder left to find.

  --yes    skip the confirmation prompt (for non-interactive use)`;

/** Ask before writing, unless --yes. Fails loudly on a non-tty without --yes. */
async function confirm(yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  return promptSession((io) => askYesNo(io, question));
}

/**
 * Mint a cuid the way `@default(cuid())` does — by asking the database for one.
 * Prisma generates cuids in its query engine and exposes no function to call, and
 * there is no cuid package here (see lib/ids.ts), so the way to get an id
 * byte-for-byte identical to every other bank link's is to let the database make
 * one: create a throwaway link, take its id, delete it. INACTIVE so nothing tries
 * to sync it in the millisecond it exists.
 */
async function mintLinkCuid(db: ScopedDb): Promise<string> {
  const probe = await db.bankLink.create({
    data: { workspaceId: db.$workspaceId, name: "cuid-probe", status: "INACTIVE" },
  });
  await db.bankLink.delete({ where: { id: probe.id } });
  return probe.id;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const yes = process.argv.includes("--yes");

  // After the --help check: `lib/server/auth` throws at module scope without
  // BETTER_AUTH_SECRET, so a static import would make --help fail on exactly the
  // machine whose operator is reading it.
  const { authDb, scopedDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  // Read across tenants to find the two rows by their placeholder ids — control
  // plane, and the whole instance has at most one of each.
  const link = await authDb.bankLink.findUnique({
    where: { id: BOOTSTRAP_LINK_ID },
    select: { id: true, name: true, workspaceId: true },
  });
  const workspace = await authDb.workspace.findUnique({
    where: { id: BOOTSTRAP_WORKSPACE_ID },
    select: { id: true, name: true, slug: true },
  });

  if (!link && !workspace) {
    console.log("Nothing to unhook — the bootstrap ids are already retired.");
    return;
  }

  // The workspace's replacement is Better Auth's own organization id, from the
  // same generator `createOrganization` uses — a workspace stays on Better Auth
  // ids. Computed in memory (no write), so it is safe to show before confirming;
  // the link's cuid is minted only after, since minting it touches the database.
  let newWorkspaceId: string | null = null;
  if (workspace) {
    const { auth } = (await import("../lib/server/auth")) as { auth: Auth };
    const ctx = await auth.$context;
    // `false` would mean id generation is deferred to the database — not this
    // instance's config, but the type admits it, and we need a concrete id for an
    // UPDATE, not an INSERT default.
    const generated = ctx.generateId({ model: "organization" });
    if (!generated) {
      throw new Error(
        "Better Auth is configured to let the database generate ids, so a workspace " +
          "id can't be minted here. Rename it by hand, or set an explicit generateId.",
      );
    }
    newWorkspaceId = generated;
  }

  console.log("About to retire the bootstrap placeholder ids:");
  if (workspace) console.log(`  workspace "${workspace.name}" (/w/${workspace.slug})`);
  if (workspace) console.log(`    ${workspace.id}  ->  ${newWorkspaceId}`);
  if (link) console.log(`  bank link "${link.name}"`);
  if (link) console.log(`    ${link.id}  ->  a new cuid`);
  console.log("  the change cascades to every dependent row; slugs are unchanged");
  console.log();
  if (!(await confirm(yes, "Proceed?"))) return console.log("Unchanged.");

  // The link first, while its workspace still exists to be scoped to. Its new id
  // is a cuid the only way this app can mint one (see `mintLinkCuid`). A
  // tenant-table write, so it goes through the scoped client — the FK cascade
  // (which bypasses RLS) carries the new id into accounts, transactions, sync
  // state and sync runs.
  let newLinkId: string | null = null;
  if (link) {
    const db = scopedDb(link.workspaceId);
    newLinkId = await mintLinkCuid(db);
    await db.bankLink.update({ where: { id: link.id }, data: { id: newLinkId } });
  }

  // Then the workspace, in one transaction with the one reference no cascade
  // reaches — a session's stale "active workspace", a plain column rather than a
  // foreign key.
  if (workspace && newWorkspaceId) {
    await authDb.$transaction([
      authDb.session.updateMany({
        where: { activeWorkspaceId: workspace.id },
        data: { activeWorkspaceId: newWorkspaceId },
      }),
      authDb.workspace.update({ where: { id: workspace.id }, data: { id: newWorkspaceId } }),
    ]);
  }

  console.log("Done. The bootstrap workspace and link now have generated ids.");
  if (workspace) console.log(`  workspace: ${newWorkspaceId}`);
  if (link) console.log(`  bank link: ${newLinkId}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect?.();
  });
