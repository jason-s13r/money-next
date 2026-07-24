/**
 * What tenants exist, who is in them, and where each one's bank credentials
 * come from.
 *
 *   pnpm workspace:list
 *
 * The survey that phase 8 made necessary. While there was one workspace and one
 * Akahu pair in env, "what is on this instance" was answerable by reading `.env`;
 * with credentials on the link (`tokenSource`) and workspaces that can be created
 * from the shell, it is not. This is the read-only counterpart to
 * `workspace:create` and `link:token --list`, and the first place to look when a
 * sync produced data in a workspace you did not expect.
 *
 * Two clients, on purpose, and the split is the interesting part of this file:
 *
 *   - Workspaces, memberships and users are the tenancy *control plane*. They
 *     decide who may enter a workspace rather than living inside one, which is
 *     why `scopedDb` exempts them (`CONTROL_PLANE_MODELS`) and why reading them
 *     across tenants is the correct thing to do here rather than a leak.
 *   - Bank links are tenant data, so they are read through a client scoped to
 *     one workspace at a time — a loop, not one unscoped query. That looks like
 *     the long way round and is the point, exactly as in `link:token`: this
 *     cannot quietly become a cross-tenant read later.
 *
 * Never prints a token, only where one comes from. `stored` means the link holds
 * its own encrypted pair (phase 8); `env` means it uses the instance-wide
 * `AKAHU_*` pair, which belongs to whoever set up the original workspace.
 */

// Every import here is dynamic (see `main`), and a file with no static
// import or export is not a module — its top-level names would land in the
// global scope and collide with the identically-named ones in its sibling
// scripts. This makes it a module and does nothing else.
export {};

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm workspace:list

Lists every workspace with its members, roles and bank links (and where each
link's Akahu credentials come from). Reads only; prints no secrets.`;

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const { authDb, scopedDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

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
    console.log('  pnpm workspace:create --name "<name>" --owner <email>');
    return;
  }

  for (const workspace of workspaces) {
    console.log(`${workspace.name}  /w/${workspace.slug}  (${workspace.id})`);

    if (workspace.members.length === 0) {
      // Reachable, and worth saying rather than printing an empty heading: a
      // workspace whose last owner deleted their account is a tenant nobody can
      // reach through the app, holding financial data that still syncs.
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
      console.log("  no bank links — pnpm link:token --workspace " + workspace.slug);
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect?.();
  });
