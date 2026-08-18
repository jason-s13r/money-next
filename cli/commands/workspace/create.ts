/**
 * Creates a workspace and its first owner.
 *
 *   money workspace create --name "Flat" --owner me@example.com
 *   money workspace create --name "Flat" --slug flat --owner me@example.com
 *   money workspace create --name "Flat" --invite-owner them@example.com
 *
 * The shell rather than a page: creating a workspace is not an action taken from
 * inside one, so it has no `[workspace]` segment to be authorized against, and
 * this instance has no site admin to authorize it instead. Who may mint tenants,
 * and what stops them minting a thousand, is a real design question; the shell is
 * the honest answer until it is decided.
 *
 * The two owners differ in what they assume. `--owner` names an account that
 * exists and makes it owner now — two steps rather than one, so a typo'd email
 * cannot silently create a second account for the same person. `--invite-owner`
 * creates nothing for them and chooses no password on their behalf; ownership
 * lands when they accept, and until then the workspace has no members, which
 * `money workspace list` reports as unreachable.
 */
import { Command } from "commander";

import { orgAdapter, sendInvite } from "../../lib/invite";
import { normalizedEmail } from "../../lib/options";
import { assertSlug, chooseSlug, slugBase, slugify, suggestName } from "../../lib/slug";
import { onExit } from "../../runtime";

type Opts = { owner?: string; inviteOwner?: string; name?: string; slug?: string };

export function register(parent: Command): void {
  parent
    .command("create")
    .description("Create a workspace, for an owner who exists or one you invite")
    .option("--owner <email>", "email of an existing user, who becomes its owner now", normalizedEmail)
    .option("--invite-owner <email>", "email anyone at all; they own it once they accept", normalizedEmail)
    .option("--name <name>", 'display name (default: "<their first name>\'s Personal")')
    .option("--slug <slug>", "URL segment (/w/<slug>); derived from the name when omitted")
    .addHelpText(
      "after",
      `
  --owner sam@example.com                     "Sam's Personal"  /w/sam-personal
  --owner sam@example.com --name "The Flat"   "The Flat"        /w/the-flat
  --owner sam@example.com --slug foo          "Sam's Personal"  /w/foo

--name is required with --invite-owner: there is no account to borrow a name
from yet, and there may never have been one.

A slug already in use gets a short suffix (/w/flat-a3f9), however it was
arrived at. Creating a workspace never fails because someone picked the name
first.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  if (opts.owner && opts.inviteOwner) {
    throw new Error(
      "--owner and --invite-owner are two answers to the same question. Use " +
        "--owner for an account that exists, --invite-owner for anyone else.",
    );
  }
  if (!opts.owner && !opts.inviteOwner) {
    throw new Error("One of --owner or --invite-owner is required. See --help.");
  }
  // The default name comes from the owner's, and there is no owner yet. Deriving
  // one from the email would put a string nobody typed on a workspace nobody can
  // rename.
  if (opts.inviteOwner && !opts.name) {
    throw new Error("--name is required with --invite-owner. What should the workspace be called?");
  }

  const { auth } = await import("../../../lib/server/auth");
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const owner = opts.owner
    ? await authDb.user.findUnique({
        where: { email: opts.owner },
        select: { id: true, email: true, name: true },
      })
    : null;

  if (opts.owner && !owner) {
    throw new Error(
      `No user with ${opts.owner}. Create them first:\n` +
        `  money user create --email ${opts.owner} --name "<name>"\n` +
        `or have them create their own account by accepting an invite:\n` +
        `  money workspace create --invite-owner ${opts.owner} --name "<name>"`,
    );
  }

  // An invited owner has an address and nothing else, so its local part stands
  // in. Only ever feeds the slug fallback — `--invite-owner` demands `--name`.
  const ownerLabel = owner?.name ?? opts.inviteOwner!.split("@")[0];

  const name = opts.name ?? suggestName(ownerLabel);

  // `--slug` chooses the base, the name derives it, and either way the same
  // disambiguation runs — so a collision is never an error. The cost, accepted:
  // there is no way to insist on a slug and be told you cannot have it. `--slug
  // prod` twice yields `prod` and `prod-a3f9`.
  const base = opts.slug ?? slugBase(name, ownerLabel);
  assertSlug(base);

  if (!opts.slug && base !== slugify(name)) {
    // The URL will not resemble the name — surprising enough to explain once
    // rather than leave to be discovered.
    console.log(`"${name}" has nothing usable in a URL; naming it after ${ownerLabel} instead.`);
  }

  const slug = await chooseSlug(base, async (candidate) => {
    return (await authDb.workspace.count({ where: { slug: candidate } })) > 0;
  });

  let id: string;

  if (owner) {
    // Better Auth's own API rather than a pair of inserts: the organization
    // plugin owns what a workspace *is* — slug uniqueness, the `creatorRole`
    // membership, the `organizationLimit` hook quotas will land in. No headers
    // and an explicit `userId` is how the plugin is told there is no session.
    ({ id } = await auth.api.createOrganization({ body: { name, slug, userId: owner.id } }));
  } else {
    // The endpoint cannot express this: a `userId` makes that person the
    // `creatorRole` member, and without one it wants a session. An invited owner
    // is neither, since the membership must not exist until they accept. Its
    // slug check goes too, having never guaranteed anything — `Workspace.slug
    // @unique` is the guarantee, as on the `--owner` path.
    const adapter = await orgAdapter();

    ({ id } = await adapter.createOrganization({
      organization: { name, slug, createdAt: new Date() },
    }));
  }

  console.log(`Created "${name}" (${id}) — /w/${slug}`);

  if (owner) {
    console.log(`Owner: ${owner.name} <${owner.email}>`);
  } else {
    const invite = await sendInvite({
      workspace: { id, name, slug },
      email: opts.inviteOwner!,
      role: "owner",
    });

    console.log(`Owner: ${opts.inviteOwner} — invited, expires in 3 days`);
    console.log(`  ${invite.url}`);
    if (!invite.queued) {
      console.log();
      console.log("SMTP is not configured, so nothing was emailed. Send them that link.");
    }
    console.log();
    console.log("Until they accept it the workspace has no members, which is what");
    console.log("`money workspace list` will report it as.");
  }

  console.log();
  console.log("Give it a bank:");
  console.log(`  money link token --workspace ${slug} --name "<link name>"`);
}
