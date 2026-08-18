/**
 * Re-encrypts stored Akahu tokens from the symmetric scheme to the sealed one.
 *
 *   money link upgrade            # report what would change, touch nothing
 *   money link upgrade --apply    # do it
 *
 * Both formats work side by side and always will — `decryptSecret` dispatches on
 * the prefix, so leaving a row alone breaks nothing. What it costs is a key:
 * every surviving `v1` row keeps `TOKEN_ENCRYPTION_KEY` load-bearing on the
 * worker, and that is the key whose whole story is that whoever holds it can
 * read every token in the database. Convert the last row and it leaves the
 * deployment, leaving one key that only opens and one that only closes.
 *
 * Runs on the host that has both keys, since it reads with the symmetric one and
 * writes with the public one. There is no downgrade direction and should not be:
 * it would exist only to give a symmetric key back its reach.
 */
import { Command } from "commander";

import { decryptSecret, hasEncryptionKey } from "../../../lib/server/secrets";
import { hasSealKey, isSealed, sealSecret, tokenAad } from "../../../lib/server/seal";
import { onExit } from "../../runtime";

// Bound in the action rather than imported statically — the rule in cli/program.ts.
let catalogDb: typeof import("../../../lib/server/db").catalogDb;
let scopedDb: typeof import("../../../lib/server/db").scopedDb;

type Opts = { apply?: boolean };

export function register(parent: Command): void {
  parent
    .command("upgrade")
    .description("Re-encrypt stored tokens to the sealed scheme")
    .option("--apply", "actually write; without it nothing is changed")
    .addHelpText(
      "after",
      `
Converts phase 8's AES tokens (v1, TOKEN_ENCRYPTION_KEY) to the sealed format
the app's connect form writes (v1pk, TOKEN_PUBLIC_KEY / TOKEN_PRIVATE_KEY). Run
it on the host that has both keys. Once no link reports [symmetric],
TOKEN_ENCRYPTION_KEY can be removed from the worker and cron services.
`,
    )
    .action(run);
}

const FIELDS = ["appToken", "userToken"] as const;
type Field = (typeof FIELDS)[number];

type Row = {
  id: string;
  name: string;
  appTokenCipher: string | null;
  userTokenCipher: string | null;
};

/** Every workspace, oldest first — the outer loop of anything instance-wide. */
async function workspaces() {
  return catalogDb.workspace.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

const cipherOf = (link: Row, field: Field) =>
  field === "appToken" ? link.appTokenCipher : link.userTokenCipher;

/**
 * What state a link's stored pair is in. `mixed` is a real outcome, not a
 * defensive branch: an `--apply` interrupted between the two fields leaves one
 * sealed and one not. Named in the listing so it is not read as "done".
 */
function scheme(link: Row): "sealed" | "symmetric" | "mixed" | "none" {
  const blobs = FIELDS.map((f) => cipherOf(link, f)).filter((b): b is string => Boolean(b));
  if (blobs.length === 0) return "none";
  if (blobs.every(isSealed)) return "sealed";
  if (blobs.some(isSealed)) return "mixed";
  return "symmetric";
}

/**
 * Convert one link, verifying the result before it is written.
 *
 * The failure that matters is not an exception — it is a row that writes cleanly
 * and the worker cannot open, surfacing hours later as a sync failure. So every
 * field is re-sealed and then opened again *through the path the worker uses*
 * and compared, before a column is updated. That read exercises the private key
 * and the OAEP label binding together, the two things a wrong
 * `TOKEN_PRIVATE_KEY` would break.
 *
 * The plaintext is in memory for the length of that check and written nowhere.
 */
function reseal(link: Row): Partial<Record<`${Field}Cipher`, string>> {
  const data: Partial<Record<`${Field}Cipher`, string>> = {};

  for (const field of FIELDS) {
    const blob = cipherOf(link, field);
    if (!blob || isSealed(blob)) continue;

    const aad = tokenAad(link.id, field);
    const plaintext = decryptSecret(blob, aad);
    const sealed = sealSecret(plaintext, aad);

    // A mismatched keypair aborts inside that read — OAEP fails to unwrap and
    // `decryptSecret` says so by name. This is the backstop for the case that
    // would be silent: a decrypt returning something rather than throwing.
    if (decryptSecret(sealed, aad) !== plaintext) {
      throw new Error(
        `Re-sealed ${field} for link ${link.id} opened to a different value. ` +
          "Nothing was written — do not re-run until that is understood.",
      );
    }

    data[`${field}Cipher`] = sealed;
  }

  return data;
}

async function run({ apply }: Opts) {
  ({ catalogDb, scopedDb } = await import("../../../lib/server/db"));
  onExit(() => catalogDb?.$disconnect());

  // Both keys, before any row is read. Finding either missing per-row would
  // produce a half-converted instance and a wall of identical errors.
  if (!hasSealKey()) {
    throw new Error(
      "TOKEN_PUBLIC_KEY is not set, so there is nothing to re-seal to.\n" +
        "Generate the pair with `money link keypair` first.",
    );
  }
  if (!hasEncryptionKey()) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set, so the existing tokens cannot be opened to be\n" +
        "re-sealed. Run this on the host that holds it — the same one that runs\n" +
        "`money link token`. If no link reports [symmetric], there is nothing to do and the\n" +
        "key is already retired.",
    );
  }

  let pending = 0;
  let converted = 0;

  for (const workspace of await workspaces()) {
    const db = scopedDb(workspace.id);
    const links: Row[] = await db.bankLink.findMany({
      select: { id: true, name: true, appTokenCipher: true, userTokenCipher: true },
      orderBy: { createdAt: "asc" },
    });

    const stored = links.filter((link) => scheme(link) !== "none");
    if (stored.length === 0) continue;

    console.log(`\n${workspace.name} (/w/${workspace.slug})`);

    for (const link of stored) {
      const state = scheme(link);

      if (state === "sealed") {
        console.log(`  ${link.id}  ${link.name} — sealed already`);
        continue;
      }

      pending++;

      if (!apply) {
        console.log(`  ${link.id}  ${link.name} — ${state}, would re-seal`);
        continue;
      }

      // No transaction needed: `decryptSecret` picks the scheme per blob, so a
      // half-converted link stays readable and a sync landing mid-upgrade works
      // either side of this write. `scheme` reports the in-between state.
      const data = reseal(link);
      await db.bankLink.update({ where: { id: link.id }, data });
      converted++;
      console.log(`  ${link.id}  ${link.name} — re-sealed`);
    }
  }

  if (pending === 0) {
    console.log(
      "\nNothing to convert — every stored token is sealed. TOKEN_ENCRYPTION_KEY can come\n" +
        "out of the worker and cron services; `money link token` no longer needs it either.",
    );
    return;
  }

  console.log(
    apply
      ? `\nRe-sealed ${converted} link(s). The worker needs TOKEN_PRIVATE_KEY to open them —\n` +
          "confirm it is set there before the next sync, then drop TOKEN_ENCRYPTION_KEY."
      : `\n${pending} link(s) would be re-sealed. Nothing was written — re-run with --apply.`,
  );
}
