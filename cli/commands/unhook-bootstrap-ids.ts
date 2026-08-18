/**
 * Retires the bootstrap workspace and bank link's placeholder ids.
 *
 *   money unhook-bootstrap-ids
 *
 * The first workspace and its bank link are inserted by a migration with the
 * fixed ids `ws_bootstrap` and `link_bootstrap`, because a migration cannot mint
 * a random id and stay deterministic. They are the only rows left carrying a
 * placeholder, and a placeholder is what code starts special-casing.
 *
 * This gives each an id in the shape it would have had from the app — a `cuid`
 * for the link, Better Auth's organization id generator for the workspace — so
 * afterwards neither is structurally distinguishable from any other.
 *
 * Idempotent by construction: it acts only on rows whose id *is* the
 * placeholder. No flag and no id to pass; the new ids are generated, not chosen.
 *
 * A rename is one statement because every `workspaceId` / `bankLinkId` foreign
 * key is `ON UPDATE CASCADE`, and referential-action cascades bypass RLS. Two
 * references the cascade does not reach are handled here:
 *
 *   - `Session.activeWorkspaceId` is a plain string, not a foreign key, so it is
 *     updated in the same transaction as the workspace.
 *   - `BankLink` is under RLS, so its UPDATE runs through `scopedDb` — otherwise
 *     the policy hides the row being renamed. The workspace rename is control
 *     plane and uses `authDb`.
 *
 * The link goes first, while the workspace it is scoped to still exists; the
 * workspace rename then carries its `workspaceId` along with everything else.
 */
import { Command } from "commander";

import type { Auth } from "../../lib/server/auth";
import type { ScopedDb } from "../../lib/server/db";
import { askYesNo, promptSession } from "../lib/read-secret";
import { onExit } from "../runtime";

/** The ids the bootstrap migration hard-codes. This command exists to erase them. */
const BOOTSTRAP_WORKSPACE_ID = "ws_bootstrap";
const BOOTSTRAP_LINK_ID = "link_bootstrap";

type Opts = { yes?: boolean };

export function register(program: Command): void {
  program
    .command("unhook-bootstrap-ids")
    .description("One-shot: retire the bootstrap rows' placeholder ids")
    .option("--yes", "skip the confirmation prompt, for non-interactive use")
    .addHelpText(
      "after",
      `
Gives the bootstrap workspace (${BOOTSTRAP_WORKSPACE_ID}) and its bank link
(${BOOTSTRAP_LINK_ID}) freshly generated ids, so they become structurally
identical to any workspace and link created through the app. The change cascades
to every dependent row in one transaction.

Run once. A second run is a no-op — there is no placeholder left to find.
`,
    )
    .action(run);
}

/** Ask before writing, unless --yes. Fails loudly on a non-tty without --yes. */
async function confirm(yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  return promptSession((io) => askYesNo(io, question));
}

/**
 * Mint a cuid by asking the database for one. Prisma generates them in its query
 * engine and exposes no function to call, and there is no cuid package here — so
 * an id identical to every other link's means creating a throwaway, taking its
 * id and deleting it. INACTIVE, so nothing syncs it in the millisecond it exists.
 */
async function mintLinkCuid(db: ScopedDb): Promise<string> {
  const probe = await db.bankLink.create({
    data: { workspaceId: db.$workspaceId, name: "cuid-probe", status: "INACTIVE" },
  });
  await db.bankLink.delete({ where: { id: probe.id } });
  return probe.id;
}

async function run({ yes }: Opts) {
  const { authDb, scopedDb } = await import("../../lib/server/db");
  onExit(() => authDb.$disconnect());

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

  // From the same generator `createOrganization` uses. Computed in memory, so it
  // is safe to show before confirming — the link's cuid is minted after, since
  // minting one touches the database.
  let newWorkspaceId: string | null = null;
  if (workspace) {
    const { auth } = (await import("../../lib/server/auth")) as { auth: Auth };
    const ctx = await auth.$context;
    // `false` means generation is deferred to the database. Not this instance's
    // config, but the type admits it, and an UPDATE needs a concrete id.
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
  if (!(await confirm(yes ?? false, "Proceed?"))) return console.log("Unchanged.");

  // The link first, while its workspace still exists to be scoped to. A tenant
  // write, so it goes through the scoped client; the FK cascade carries the new
  // id into accounts, transactions, sync state and sync runs.
  let newLinkId: string | null = null;
  if (link) {
    const db = scopedDb(link.workspaceId);
    newLinkId = await mintLinkCuid(db);
    await db.bankLink.update({ where: { id: link.id }, data: { id: newLinkId } });
  }

  // Then the workspace, in one transaction with the reference no cascade reaches
  // — `Session.activeWorkspaceId` is a plain column, not a foreign key.
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
