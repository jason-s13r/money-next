/**
 * Stores an Akahu token on a bank link, encrypted.
 *
 *   pnpm link:token --list
 *   pnpm link:token --workspace <slug|id> --name "Sam (personal)"   # new link
 *   pnpm link:token --link <linkId>                                   # re-key one
 *   pnpm link:token --link <linkId> --source env                      # back to env
 *
 * Why a script and not a page: an Akahu access token reads the holder's entire
 * bank history and outlives us (T19). Typing one into a web form puts it through
 * a server-action payload, a browser's form autofill, and whatever the browser
 * chooses to remember — for a credential whose entire security model is that few
 * things ever hold it. Shell access is the authority here, exactly as it is for
 * `pnpm user:password`: the in-app path doesn't exist, on purpose.
 *
 * The token is verified against Akahu before it is stored — the script calls
 * `/accounts` with it and prints what it can see. That is deliberate and it is
 * why there is no "type it again" confirmation prompt: nobody types a token, they
 * paste it, so a second paste proves nothing, whereas Akahu answering with the
 * right list of accounts proves the thing you actually wanted to know.
 *
 * Reads `Workspace` unscoped, like `scripts/ingest.ts` does and for the same
 * reason: *which* workspaces exist is control-plane data and the one question
 * here that legitimately spans tenants. Everything it writes — `BankLink` is a
 * tenant table — goes through a client scoped to one workspace.
 */
import { akahuClient, TOKEN_LINK_SELECT } from "../lib/server/akahu";
// Bound in `main`, after the `--help` check, rather than imported statically:
// lib/server/db throws at module scope without DATABASE_URL, so a static import
// would make `--help` fail on a machine that has not been configured — which is
// the machine whose operator is reading it. Same pattern as the other scripts.
let catalogDb: typeof import("../lib/server/db").catalogDb;
let scopedDb: typeof import("../lib/server/db").scopedDb;
let withScopedTx: typeof import("../lib/server/db").withScopedTx;
import { encryptSecret, hasEncryptionKey, tokenAad } from "../lib/server/secrets";
import { hasSealKey, isSealed, sealSecret } from "../lib/server/seal";
import { askPastedSecret, askYesNo, promptSession } from "./read-secret";
import { runScript } from "./_bootstrap";

type Args = {
  list: boolean;
  workspace?: string;
  name?: string;
  link?: string;
  source?: string;
};

const USAGE = `Usage:
  pnpm link:token --list
  pnpm link:token --workspace <slug|id> --name "<name>"   create a link and store a token pair
  pnpm link:token --link <linkId>                         replace an existing link's token pair
  pnpm link:token --link <linkId> --source env            revert a link to the AKAHU_* env pair`;

function parseArgs(argv: string[]): Args {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const args: Args = {
    list: argv.includes("--list"),
    workspace: flag("workspace"),
    name: flag("name"),
    link: flag("link"),
    source: flag("source"),
  };

  if (args.list) return args;
  if (args.link) return args;
  if (args.workspace && args.name) return args;

  throw new Error(USAGE);
}

/** Every workspace, oldest first — the outer loop of anything instance-wide. */
async function workspaces() {
  return catalogDb.workspace.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Find a link by id without knowing its workspace.
 *
 * A loop over scoped clients rather than one unscoped read, which looks like the
 * long way round and is the point: `scopedDb` needs a workspace to exist at all,
 * so this cannot accidentally become a cross-tenant query later. There are a
 * handful of workspaces and this is a CLI.
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
      // A link marked `stored` with nothing stored is a real state — the row was
      // created and the token step failed or was abandoned — and it is the one
      // this listing most needs to make obvious, since the failure it causes
      // otherwise appears hours later in a sync run.
      const source =
        link.tokenSource === "stored" && !link.userTokenCipher
          ? "stored (MISSING — re-run --link)"
          : link.tokenSource;
      // Which scheme holds it, so the `pnpm link:upgrade` backlog is visible from
      // the listing an operator already runs rather than only from the upgrade
      // command itself.
      const scheme = link.userTokenCipher
        ? isSealed(link.userTokenCipher)
          ? " [sealed]"
          : " [symmetric — `pnpm link:upgrade`]"
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
 * Storing an unverified token means the first sign it was wrong is a failed sync
 * run some hours later, attributed to "the sync" rather than to the typo. Worse,
 * a token for the *wrong Akahu account* is not an error at all — it authenticates
 * fine and quietly ingests somebody else's accounts into this workspace. Printing
 * the account list is the only check that catches that one, and it needs a human
 * to read it, which is the other reason this is a CLI.
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
 *
 * Prompts, network call and confirmation all inside ONE `promptSession`. Asking
 * the confirmation on a second readline interface is the trap read-secret.ts
 * documents — the new interface discards whatever the first left buffered on
 * stdin — and the Akahu call in the middle is no reason to close the session:
 * it is only sitting on stdin while it waits.
 *
 * Returns the plaintext pair rather than the ciphertext, because the id it is
 * encrypted against does not exist yet on the create path — the database mints it
 * (see `createLink`). `cipherFields` does the binding once an id is known.
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
 * Seals to `TOKEN_PUBLIC_KEY` when there is one, and falls back to the symmetric
 * key otherwise. The preference matters more than it looks: the app's connect
 * form writes `v1pk`, so an instance with a keypair configured is one where the
 * two paths should agree — a CLI that kept minting `v1` would be quietly adding
 * to the backlog `pnpm link:upgrade` exists to clear, and would keep
 * `TOKEN_ENCRYPTION_KEY` load-bearing forever. Both formats stay readable either
 * way; this only decides what *new* writes look like.
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
 * The reminder that saves the support question. The key is set wherever this
 * script runs — that is how we got here — but the process that actually *uses*
 * these rows is the worker, in another container, and a key set only here
 * produces a link that stores fine and fails every sync.
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

async function createLink(args: Args) {
  const workspace = (await workspaces()).find(
    (w) => w.slug === args.workspace || w.id === args.workspace,
  );
  if (!workspace) {
    throw new Error(
      `No workspace matches "${args.workspace}". Run --list, or check /w/<slug> in the app.`,
    );
  }

  const db = scopedDb(workspace.id);

  // Two ACTIVE links in one workspace both syncing the same Akahu account would
  // ingest every transaction twice — same Akahu ids, so the upserts collide
  // rather than duplicating, but the two links then fight over the same rows
  // every sync. Warn; don't refuse, because two genuinely different connections
  // in one workspace is the whole point of the model.
  const existing = await db.bankLink.count({ where: { status: "ACTIVE" } });
  if (existing > 0) {
    console.log(
      `Note: "${workspace.name}" already has ${existing} active link(s). Two links pointing at\n` +
        "the same Akahu account will contend over the same transactions on every sync.\n",
    );
  }

  // Verify the pair before writing anything, so an abort leaves no row behind.
  const tokens = await promptTokens();

  // The database mints the id — a `@default(cuid())`, like every other bank link
  // — rather than this script. The encryption still binds each token to the row
  // id, and that id only exists after the insert, so the row is created first and
  // the ciphertext written second, both in one transaction: a failure between
  // them can never leave a tokenless link claiming to be `stored`.
  const link = await withScopedTx(db, async (tx) => {
    const created = await tx.bankLink.create({
      data: {
        workspaceId: workspace.id,
        name: args.name!,
        // No `connectedByUserId`: nobody clicked anything, an operator ran a
        // script. The column records a person who went through a connect flow,
        // which is phase 10's job, and inventing one here would be a lie the
        // members page would later render.
      },
    });
    await tx.bankLink.update({ where: { id: created.id }, data: cipherFields(created.id, tokens) });
    return created;
  });

  console.log(`Created link ${link.id} — "${args.name}" in ${workspace.name} (/w/${workspace.slug}).`);
  keyReminder();
}

async function updateLink(args: Args) {
  const found = await findLink(args.link!);
  if (!found) throw new Error(`No bank link with id ${args.link}. Run --list to see them.`);
  const { link, workspace, db } = found;

  console.log(`Link "${link.name}" in ${workspace.name} — currently ${link.tokenSource}.`);

  if (args.source === "env") {
    // Clear the ciphertext rather than leave it: a row that says `env` while
    // still holding an encrypted pair is a credential nobody is tracking any
    // more, sitting in every backup taken from now on.
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

  if (args.source && args.source !== "stored") {
    throw new Error(`--source accepts "env" or "stored" (omit it to store a pasted pair).`);
  }

  const data = cipherFields(link.id, await promptTokens());
  await db.bankLink.update({ where: { id: link.id }, data });

  console.log(`Updated ${link.id}.`);
  keyReminder();
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  ({ catalogDb, scopedDb, withScopedTx } = await import("../lib/server/db"));

  const args = parseArgs(process.argv.slice(2));

  if (args.list) return list();

  // Check the key before prompting, not after: discovering it is missing at the
  // encrypt step means the operator has already pasted a bank credential into a
  // terminal for nothing.
  const revertingToEnv = args.source === "env";
  if (!revertingToEnv && !hasSealKey() && !hasEncryptionKey()) {
    throw new Error(
      "Neither TOKEN_PUBLIC_KEY nor TOKEN_ENCRYPTION_KEY is set, so there is nothing to\n" +
        "encrypt with. Generate a keypair with `pnpm link:keypair` — the app's connect form\n" +
        "needs it too — and give the worker the private half. (An older instance may still\n" +
        "use the symmetric key alone: `openssl rand -base64 32`, same value on the worker\n" +
        "and cron services.)",
    );
  }

  return args.link ? updateLink(args) : createLink(args);
}

runScript(main, () => catalogDb?.$disconnect());
