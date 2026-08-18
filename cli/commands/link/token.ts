/**
 * Stores an Akahu token on a bank link, encrypted.
 *
 *   money link token --list
 *   money link token --workspace <slug|id> --name "Sam (personal)"   # new link
 *   money link token --link <linkId>                                 # re-key one
 *   money link token --link <linkId> --source env                    # back to env
 *
 * A command and not a page because an Akahu token reads a whole bank history and
 * outlives us. Typing one into a web form puts it through a server-action
 * payload, form autofill and whatever the browser remembers — for a credential
 * whose security model is that few things ever hold it.
 *
 * The pair is verified against Akahu before it is stored: the command calls
 * `/accounts` and prints what it can see. That is why there is no "type it
 * again" prompt — nobody types a token, and Akahu naming the right accounts
 * proves what a second paste cannot.
 *
 * Reads `Workspace` unscoped, since which workspaces exist is control-plane
 * data. Everything it writes goes through a client scoped to one workspace.
 */
import { Command, Option } from "commander";

import { akahuClient, TOKEN_LINK_SELECT } from "../../../lib/server/akahu";
// Bound in the action rather than imported statically — the rule in cli/program.ts.
let catalogDb: typeof import("../../../lib/server/db").catalogDb;
let scopedDb: typeof import("../../../lib/server/db").scopedDb;
let withScopedTx: typeof import("../../../lib/server/db").withScopedTx;
import { encryptSecret, hasEncryptionKey, tokenAad } from "../../../lib/server/secrets";
import { hasSealKey, isSealed, sealSecret } from "../../../lib/server/seal";
import { askPastedSecret, askYesNo, promptSession } from "../../lib/read-secret";
import { onExit } from "../../runtime";

type Opts = {
  list?: boolean;
  workspace?: string;
  name?: string;
  link?: string;
  source?: string;
};

export function register(parent: Command): void {
  parent
    .command("token")
    .description("Store an Akahu token on a bank link, encrypted")
    .option("--list", "every link on the instance, and where its token comes from")
    .option("--workspace <slug|id>", "the workspace a new link belongs to")
    .option("--name <name>", "what to call a new link")
    .option("--link <linkId>", "an existing link, to replace its token pair")
    .addOption(
      new Option("--source <source>", "where the link takes its credentials from").choices([
        "env",
        "stored",
      ]),
    )
    .addHelpText(
      "after",
      `
  money link token --list
  money link token --workspace <slug|id> --name "<name>"   create a link and store a token pair
  money link token --link <linkId>                         replace an existing link's token pair
  money link token --link <linkId> --source env            revert a link to the AKAHU_* env pair

The pair is prompted for, never passed as a flag, and is checked against Akahu
before it is stored — the accounts it can see are printed for you to confirm.
`,
    )
    .action(run);
}

/** Every workspace, oldest first — the outer loop of anything instance-wide. */
async function workspaces() {
  return catalogDb.workspace.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Find a link by id without knowing its workspace. A loop over scoped clients
 * rather than one unscoped read: `scopedDb` needs a workspace to exist at all,
 * so this cannot become a cross-tenant query later.
 */
async function findLink(linkId: string) {
  for (const workspace of await workspaces()) {
    const db = scopedDb(workspace.id);
    const link = await db.bankLink.findFirst({
      where: { id: linkId },
      select: { ...TOKEN_LINK_SELECT, name: true, status: true, workspaceId: true },
    });
    if (link) return { link, workspace, db };
  }
  return null;
}

async function list() {
  let found = 0;
  for (const workspace of await workspaces()) {
    const links = await scopedDb(workspace.id).bankLink.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        tokenSource: true,
        tokenUpdatedAt: true,
        userTokenCipher: true,
      },
      orderBy: { createdAt: "asc" },
    });
    if (links.length === 0) continue;

    console.log(`\n${workspace.name} (/w/${workspace.slug})`);
    for (const link of links) {
      found++;
      // `stored` with nothing stored is a real state: the row was created and
      // the token step failed. Made obvious here, or it surfaces hours later as
      // a sync error.
      const source =
        link.tokenSource === "stored" && !link.userTokenCipher
          ? "stored (MISSING — re-run --link)"
          : link.tokenSource;
      // Which scheme holds it, so the `link upgrade` backlog shows up in the
      // listing an operator already runs.
      const scheme = link.userTokenCipher
        ? isSealed(link.userTokenCipher)
          ? " [sealed]"
          : " [symmetric — `money link upgrade`]"
        : "";
      const set = link.tokenUpdatedAt ? `, set ${link.tokenUpdatedAt.toISOString()}` : "";
      console.log(`  ${link.id}  ${link.name} — ${link.status}, token: ${source}${scheme}${set}`);
    }
  }

  if (found === 0) {
    console.log("No bank links yet. Create one with --workspace <slug> --name \"<name>\".");
  }
}

/**
 * Prove the pair works before storing it, and show the operator what it reaches.
 *
 * Unverified, the first sign of a wrong token is a failed sync hours later. And a
 * token for the *wrong Akahu account* is no error at all — it authenticates and
 * quietly ingests somebody else's accounts here. Printing the account list is
 * the only check that catches that, and it needs a human to read it.
 */
async function verify(credentials: { appToken: string; userToken: string }) {
  const accounts = await akahuClient(credentials.appToken).accounts.list(credentials.userToken);

  if (accounts.length === 0) {
    throw new Error(
      "That token authenticated but can see no accounts. It is probably the right app " +
        "and the wrong user token, or the Akahu connection has been revoked.",
    );
  }

  console.log(`\nAkahu accepted it. This token can see ${accounts.length} account(s):`);
  for (const account of accounts) {
    const where = account.connection?.name ?? "unknown institution";
    console.log(`  ${account.name} — ${where} (${account._id})`);
  }
  console.log("\nIf that is not the account you meant to connect, answer no.\n");
}

/**
 * Read the pair, verify it against Akahu, and confirm the operator meant it.
 * Prompts, network call and confirmation all inside ONE `promptSession` — see
 * cli/lib/read-secret for why reopening one loses buffered stdin.
 *
 * Returns plaintext, not ciphertext: on the create path the id it binds to does
 * not exist yet. `cipherFields` binds once there is one.
 */
async function promptTokens() {
  return promptSession(async (io) => {
    const appToken = await askPastedSecret(io, "Akahu app token (app_token_...): ");
    const userToken = await askPastedSecret(io, "Akahu user access token (user_token_...): ");

    await verify({ appToken, userToken });

    if (!(await askYesNo(io, "Store this token pair?"))) {
      throw new Error("Aborted — nothing was written.");
    }
    return { appToken, userToken };
  });
}

/**
 * Encrypt a verified pair for one link's row, binding each blob to that row id as
 * additional authenticated data — so a ciphertext moved to another link fails to
 * decrypt rather than silently authenticating as someone else's connection.
 *
 * Seals to `TOKEN_PUBLIC_KEY` when there is one, else the symmetric key. The
 * preference matters: the app's connect form writes `v1pk`, so minting `v1` here
 * would add to the backlog `link upgrade` exists to clear and keep
 * `TOKEN_ENCRYPTION_KEY` load-bearing forever. Both stay readable either way —
 * this only decides what *new* writes look like.
 */
function cipherFields(linkId: string, tokens: { appToken: string; userToken: string }) {
  const encrypt = hasSealKey() ? sealSecret : encryptSecret;

  return {
    tokenSource: "stored",
    appTokenCipher: encrypt(tokens.appToken, tokenAad(linkId, "appToken")),
    userTokenCipher: encrypt(tokens.userToken, tokenAad(linkId, "userToken")),
    tokenUpdatedAt: new Date(),
  };
}

/**
 * The key is set wherever this command ran, but the process that *uses* these
 * rows is the worker, in another container. A key set only here produces a link
 * that stores fine and fails every sync.
 */
function keyReminder() {
  console.log(
    hasSealKey()
      ? "\nStored, sealed to TOKEN_PUBLIC_KEY. The `worker` service needs the matching\n" +
          "TOKEN_PRIVATE_KEY — it is what opens this. The web app gets the public half only,\n" +
          "which is what lets its connect form store a token it can never read back."
      : "\nStored, encrypted. TOKEN_ENCRYPTION_KEY must be set for the `worker` and `cron`\n" +
          "services too — they are what decrypt this. The web app neither needs it nor gets it.",
  );
}

async function createLink(opts: Opts) {
  const workspace = (await workspaces()).find(
    (w) => w.slug === opts.workspace || w.id === opts.workspace,
  );
  if (!workspace) {
    throw new Error(
      `No workspace matches "${opts.workspace}". Run --list, or check /w/<slug> in the app.`,
    );
  }

  const db = scopedDb(workspace.id);

  // Two ACTIVE links on the same Akahu account contend over the same rows every
  // sync (same ids, so upserts collide rather than duplicate). Warn, don't
  // refuse — two genuinely different connections is the point of the model.
  const existing = await db.bankLink.count({ where: { status: "ACTIVE" } });
  if (existing > 0) {
    console.log(
      `Note: "${workspace.name}" already has ${existing} active link(s). Two links pointing at\n` +
        "the same Akahu account will contend over the same transactions on every sync.\n",
    );
  }

  // Verify the pair before writing anything, so an abort leaves no row behind.
  const tokens = await promptTokens();

  // The database mints the id, and each blob is bound to it — so the row must
  // exist before the tokens can be encrypted. Both statements in one
  // transaction, or a failure between them leaves a link claiming `stored` with
  // nothing stored.
  const link = await withScopedTx(db, async (tx) => {
    const created = await tx.bankLink.create({
      data: {
        workspaceId: workspace.id,
        name: opts.name!,
        // No `connectedByUserId`: the column records a person who went through
        // the connect flow, and nobody did. Inventing one would be a lie the
        // members page renders.
      },
    });
    await tx.bankLink.update({ where: { id: created.id }, data: cipherFields(created.id, tokens) });
    return created;
  });

  console.log(`Created link ${link.id} — "${opts.name}" in ${workspace.name} (/w/${workspace.slug}).`);
  keyReminder();
}

async function updateLink(opts: Opts) {
  const found = await findLink(opts.link!);
  if (!found) throw new Error(`No bank link with id ${opts.link}. Run --list to see them.`);
  const { link, workspace, db } = found;

  console.log(`Link "${link.name}" in ${workspace.name} — currently ${link.tokenSource}.`);

  if (opts.source === "env") {
    // Clear the ciphertext: a row saying `env` while still holding a pair is an
    // untracked credential in every backup taken from now on.
    await db.bankLink.update({
      where: { id: link.id },
      data: {
        tokenSource: "env",
        appTokenCipher: null,
        userTokenCipher: null,
        tokenUpdatedAt: null,
      },
    });
    console.log(
      "Reverted to the AKAHU_APP_ID_TOKEN / AKAHU_USER_ACCESS_TOKEN pair; stored copy erased.",
    );
    return;
  }

  const data = cipherFields(link.id, await promptTokens());
  await db.bankLink.update({ where: { id: link.id }, data });

  console.log(`Updated ${link.id}.`);
  keyReminder();
}

async function run(opts: Opts) {
  // One of three shapes, and Commander cannot express "these flags together or
  // those": listing, creating (a workspace and a name), or re-keying a link.
  if (!opts.list && !opts.link && !(opts.workspace && opts.name)) {
    throw new Error(
      "Nothing to do. Pass --list, --link <id> to re-key one, or --workspace and --name " +
        "to create one. See --help.",
    );
  }

  ({ catalogDb, scopedDb, withScopedTx } = await import("../../../lib/server/db"));
  onExit(() => catalogDb?.$disconnect());

  if (opts.list) return list();

  // Before prompting, not at the encrypt step — otherwise the operator has
  // already pasted a bank credential into a terminal for nothing.
  const revertingToEnv = opts.source === "env";
  if (!revertingToEnv && !hasSealKey() && !hasEncryptionKey()) {
    throw new Error(
      "Neither TOKEN_PUBLIC_KEY nor TOKEN_ENCRYPTION_KEY is set, so there is nothing to\n" +
        "encrypt with. Generate a keypair with `money link keypair` — the app's connect form\n" +
        "needs it too — and give the worker the private half. (An older instance may still\n" +
        "use the symmetric key alone: `openssl rand -base64 32`, same value on the worker\n" +
        "and cron services.)",
    );
  }

  return opts.link ? updateLink(opts) : createLink(opts);
}
