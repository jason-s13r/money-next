/**
 * What tenants exist, who is in them, and where each one's bank credentials
 * come from.
 *
 *   money workspace list
 *
 * Once credentials moved onto the link, "what is on this instance" stopped being
 * answerable by reading `.env`. First place to look when a sync produced data in
 * a workspace you did not expect.
 *
 * Two clients, and the split is the interesting part. Workspaces, memberships
 * and users are the tenancy control plane — they decide who may enter a
 * workspace rather than living inside one, so reading them across tenants is
 * correct here. Bank links are tenant data, so they go through a client scoped
 * to one workspace at a time: a loop, not one unscoped query. That is the long
 * way round on purpose — it cannot quietly become a cross-tenant read later.
 *
 * Never prints a token, only where one comes from.
 */
import { Command } from "commander";

import { onExit } from "../../runtime";

export function register(parent: Command): void {
  parent
    .command("list")
    .description("Every tenant, its members, and where its bank credentials come from")
    .addHelpText(
      "after",
      `
Lists every workspace with its members, roles and bank links (and where each
link's Akahu credentials come from). Reads only; prints no secrets.
`,
    )
    .action(run);
}

async function run() {
  const { authDb, scopedDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const workspaces = await authDb.workspace.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      members: {
        select: { role: true, user: { select: { name: true, email: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (workspaces.length === 0) {
    console.log("No workspaces. Create one:");
    console.log('  money workspace create --name "<name>" --owner <email>');
    return;
  }

  for (const workspace of workspaces) {
    console.log(`${workspace.name}  /w/${workspace.slug}  (${workspace.id})`);

    if (workspace.members.length === 0) {
      // Worth saying rather than an empty heading: financial data that still
      // syncs, and nobody who can reach it through the app.
      console.log("  members:  none — unreachable through the app");
    } else {
      for (const member of workspace.members) {
        console.log(`  ${member.role.padEnd(7)} ${member.user.name} <${member.user.email}>`);
      }
    }

    const links = await scopedDb(workspace.id).bankLink.findMany({
      select: { id: true, name: true, status: true, tokenSource: true, tokenUpdatedAt: true },
      orderBy: { createdAt: "asc" },
    });

    if (links.length === 0) {
      console.log("  no bank links — money link token --workspace " + workspace.slug);
    } else {
      for (const link of links) {
        const keyed = link.tokenUpdatedAt
          ? ` since ${link.tokenUpdatedAt.toISOString().slice(0, 10)}`
          : "";
        console.log(
          `  link    ${link.name} [${link.status}] token=${link.tokenSource}${keyed} (${link.id})`,
        );
      }
    }

    console.log();
  }
}
