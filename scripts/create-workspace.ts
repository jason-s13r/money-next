/**
 * Creates a workspace and its first owner.
 *
 *   pnpm workspace:create --name "Flat" --owner me@example.com
 *   pnpm workspace:create --name "Flat" --slug flat --owner me@example.com
 *
 * Until this existed, a workspace could only come into being in a *migration* —
 * `ws_bootstrap`, inserted by `20260717001104_tenancy_models`. That made the
 * tenancy model unexercisable: phase 8 gave a link its own Akahu credentials, so
 * a second workspace can sync its own bank, but there was no way to *have* a
 * second workspace. It also inverted the bootstrap dependency, since a workspace
 * then preceded every user — which is what `user:create --owner` was for, and
 * why both it and `lib/server/tenancy.ts` are gone.
 *
 * Why the shell rather than a page: creating a workspace is not an action taken
 * from inside one, so it has no `[workspace]` segment to be authorized against,
 * and this instance has no notion of a site admin to authorize it instead. That
 * is a real design question (who may mint tenants, and what stops them minting
 * a thousand) and the shell is the honest answer until it is decided — the same
 * reasoning as `user:create`, which exists because the first account cannot come
 * from an app whose registration is invite-only.
 *
 * The owner is named by email and must already exist: `pnpm user:create` mints
 * accounts, this one places them. Two steps rather than one because the failure
 * modes differ — a typo'd email here should not silently create a second account
 * for the same person.
 */
import type { Auth } from "../lib/server/auth";
import { assertSlug, chooseSlug, slugBase, slugify, suggestName } from "./slug";
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm workspace:create --owner <email> [--name "<name>"] [--slug <slug>]

  --owner  email of an existing user, who becomes its owner
  --name   display name (default: "<their first name>'s Personal")
  --slug   URL segment (/w/<slug>); derived from the name when omitted

  --owner sam@example.com                     "Sam's Personal"  /w/sam-personal
  --owner sam@example.com --name "The Flat"   "The Flat"        /w/the-flat
  --owner sam@example.com --slug foo          "Sam's Personal"  /w/foo

A slug already in use gets a short suffix (/w/flat-a3f9), however it was
arrived at. Creating a workspace never fails because someone picked the name
first.`;

type Args = { owner: string; name?: string; slug?: string };

function parseArgs(argv: string[]): Args {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const owner = flag("owner");
  if (!owner) throw new Error(USAGE);

  return { owner, name: flag("name"), slug: flag("slug") };
}

async function main() {
  // Before the imports below, deliberately. `lib/server/auth` builds its client
  // at module scope and throws if BETTER_AUTH_SECRET is unset, so a static
  // import would make `--help` fail on exactly the machine whose operator most
  // needs to read it.
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  const { auth } = (await import("../lib/server/auth")) as { auth: Auth };
  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const owner = await authDb.user.findUnique({
    where: { email: args.owner },
    select: { id: true, email: true, name: true },
  });
  if (!owner) {
    throw new Error(
      `No user with ${args.owner}. Create them first:\n` +
        `  pnpm user:create --email ${args.owner} --name "<name>"`,
    );
  }

  // The name defaults from the owner, so the first workspace on an instance is
  // one flag: `pnpm workspace:create --owner me@example.com`. See ./slug for
  // why the owner may seed the *name* even though ownership must not define the
  // identity — the short version is that this runs once and is never re-derived,
  // so it cannot go stale when the workspace changes hands.
  const name = args.name ?? suggestName(owner.name);

  // `--slug` chooses the base, the name derives it, and either way the same
  // disambiguation runs. One rule rather than two: a collision is never an
  // error, and creating a workspace never fails on a name someone else picked
  // first. The suffix says which of the two situations you are in.
  //
  // Note what that costs, deliberately: there is no way to *insist* on a slug
  // and be told when you cannot have it. `workspace:create --slug prod` twice
  // yields `prod` and `prod-a3f9` rather than an error the second time.
  // `workspace:list` shows which is which.
  const base = args.slug ?? slugBase(name, owner.name);
  assertSlug(base);

  if (!args.slug && base !== slugify(name)) {
    // Said out loud, because the URL will not resemble the name and that is
    // surprising enough to explain once rather than leave to be discovered.
    console.log(`"${name}" has nothing usable in a URL; naming it after ${owner.name} instead.`);
  }

  const slug = await chooseSlug(base, async (candidate) => {
    return (await authDb.workspace.count({ where: { slug: candidate } })) > 0;
  });

  // Through Better Auth's own API for the same reason `user:create` signs up
  // rather than inserting a row: the organization plugin owns what a workspace
  // *is* — the slug-uniqueness check, the `creatorRole` membership, the
  // `organizationLimit` hook that deferred quotas will land in. A hand-written
  // pair of inserts here would be a second, divergent definition, and the one
  // that drifts is always the one written by the script nobody reads.
  //
  // Called with no headers and an explicit `userId`, which the plugin
  // recognises as a server-side system action (`isSystemAction`) — there is no
  // session out here, and this is the sanctioned way to say so.
  const { id } = await auth.api.createOrganization({
    body: { name, slug, userId: owner.id },
  });

  console.log(`Created "${name}" (${id}) — /w/${slug}`);
  console.log(`Owner: ${owner.name} <${owner.email}>`);
  console.log();
  console.log("Give it a bank:");
  console.log(`  pnpm link:token --workspace ${slug} --name "<link name>"`);
}

runScript(main, () => disconnect?.());
