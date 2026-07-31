/**
 * Re-encrypts stored Akahu tokens from the symmetric scheme to the sealed one.
 *
 *   pnpm link:upgrade            # report what would change, touch nothing
 *   pnpm link:upgrade --apply    # do it
 *
 * Phase 8 stored tokens as `v1` AES-256-GCM under `TOKEN_ENCRYPTION_KEY`. The
 * app's connect form writes `v1pk` instead — sealed to `TOKEN_PUBLIC_KEY`, opened
 * only by `TOKEN_PRIVATE_KEY` — because the web app must be able to store a
 * credential it can never read. Both formats work side by side and always will;
 * `decryptSecret` dispatches on the prefix, so nothing is broken by leaving a row
 * alone.
 *
 * **So why upgrade at all.** Because "both formats work" costs a key. Every `v1`
 * row that survives keeps `TOKEN_ENCRYPTION_KEY` load-bearing on the worker, and
 * that key is the one whose whole story is that a process holding it can read
 * every token in the database. Convert the last row and the variable can come out
 * of the deployment entirely, leaving one key that only opens things and one that
 * only closes them. That is the point of running this.
 *
 * **Where it runs.** The host that has both keys — the same shell that runs
 * `pnpm link:token`. It reads with the symmetric key and writes with the public
 * one, so the two must be present together exactly once, here, and never in the
 * app.
 *
 * **What it does not do.** Downgrade. There is no `v1pk` → `v1` direction and
 * there should not be: it would exist only to give a symmetric key back its
 * reach, and an operator who needs a link re-keyed can re-run `pnpm link:token`,
 * which is the path that verifies the token against Akahu anyway.
 */
import { decryptSecret, hasEncryptionKey } from "../lib/server/secrets";
import { hasSealKey, isSealed, sealSecret, tokenAad } from "../lib/server/seal";
import { runScript } from "./_bootstrap";

// Bound in `main`, after the `--help` check: lib/server/db throws at module scope
// without DATABASE_URL, and the machine whose operator is reading `--help` is
// exactly the machine that is not configured yet. Same pattern as the other
// scripts.
let catalogDb: typeof import("../lib/server/db").catalogDb;
let scopedDb: typeof import("../lib/server/db").scopedDb;

const USAGE = `Usage:
  pnpm link:upgrade            list stored tokens and which scheme holds each
  pnpm link:upgrade --apply    re-seal every symmetric one to TOKEN_PUBLIC_KEY

Converts phase 8's AES tokens (v1, TOKEN_ENCRYPTION_KEY) to the sealed format the
app's connect form writes (v1pk, TOKEN_PUBLIC_KEY / TOKEN_PRIVATE_KEY). Run it on
the host that has both keys. Once no link reports [symmetric], TOKEN_ENCRYPTION_KEY
can be removed from the worker and cron services.`;

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
 * What state a link's stored pair is in.
 *
 * `mixed` is a real outcome, not a defensive branch: an `--apply` interrupted
 * between the two fields of one row leaves the app token sealed and the user
 * token not. Re-running fixes it — each field is converted on its own merits —
 * and the listing names it so that a half-converted row is not read as "done".
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
 * The check is the part worth reading. This rewrites a live banking credential
 * in place, and the failure that matters is not an exception — it is a row that
 * writes cleanly and cannot be opened by the worker, which surfaces hours later
 * as a sync failure with no obvious connection to the command that caused it. So
 * every field is decrypted, re-sealed, and then *opened again through the same
 * path the worker uses* and compared against the plaintext, before a single
 * column is updated. `decryptSecret` dispatches on the prefix, so that read
 * exercises the private key and the OAEP label binding together — precisely the
 * two things that would be wrong if `TOKEN_PRIVATE_KEY` were the wrong half of
 * the pair.
 *
 * The plaintext lives in this process's memory for the length of that check and
 * is never written anywhere, which is the same exposure `pnpm link:token` has
 * when it verifies a pasted token against Akahu.
 */
function reseal(link: Row): Partial<Record<`${Field}Cipher`, string>> {
  const data: Partial<Record<`${Field}Cipher`, string>> = {};

  for (const field of FIELDS) {
    const blob = cipherOf(link, field);
    if (!blob || isSealed(blob)) continue;

    const aad = tokenAad(link.id, field);
    const plaintext = decryptSecret(blob, aad);
    const sealed = sealSecret(plaintext, aad);

    // A mismatched keypair aborts inside that read rather than here — OAEP fails
    // to unwrap at all, and `decryptSecret` says so by name. Verified against a
    // real database: the run stops, exits 1, and the row is still symmetric. The
    // comparison below is the backstop for the case that *would* be silent, a
    // decrypt that returns something rather than throwing.
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

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const apply = process.argv.includes("--apply");

  ({ catalogDb, scopedDb } = await import("../lib/server/db"));

  // Both keys, checked before any row is read. A missing public key means there
  // is nothing to convert *to*; a missing symmetric key means the `v1` rows
  // cannot be opened at all, and finding that out per-row would produce a
  // half-converted instance and a wall of identical errors.
  if (!hasSealKey()) {
    throw new Error(
      "TOKEN_PUBLIC_KEY is not set, so there is nothing to re-seal to.\n" +
        "Generate the pair with `pnpm link:keypair` first.",
    );
  }
  if (!hasEncryptionKey()) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set, so the existing tokens cannot be opened to be\n" +
        "re-sealed. Run this on the host that holds it — the same one that runs\n" +
        "`pnpm link:token`. If no link reports [symmetric], there is nothing to do and the\n" +
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

      // One field at a time is fine without a transaction: `scheme` reports the
      // in-between state, re-running converts whatever is left, and a link whose
      // app token is sealed and user token is not is *readable* throughout —
      // `decryptSecret` picks the scheme per blob, so a sync landing mid-upgrade
      // still works either side of this write.
      const data = reseal(link);
      await db.bankLink.update({ where: { id: link.id }, data });
      converted++;
      console.log(`  ${link.id}  ${link.name} — re-sealed`);
    }
  }

  if (pending === 0) {
    console.log(
      "\nNothing to convert — every stored token is sealed. TOKEN_ENCRYPTION_KEY can come\n" +
        "out of the worker and cron services; `pnpm link:token` no longer needs it either.",
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

runScript(main, () => catalogDb?.$disconnect());
