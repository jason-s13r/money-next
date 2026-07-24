/**
 * Generates the keypair that lets the web app store an Akahu token it cannot read.
 *
 *   pnpm link:keypair
 *
 * Run once per instance, before anyone uses the connect form. Prints two
 * environment variables and writes nothing: where they go is a deployment
 * decision, and a script that edited `.env` for you would be a script that
 * decided which container gets the private half.
 *
 * **The split is the whole point.** `TOKEN_PUBLIC_KEY` goes everywhere,
 * including the internet-facing app — it can only seal. `TOKEN_PRIVATE_KEY` goes
 * exactly where `TOKEN_ENCRYPTION_KEY` already is (the worker and the CLI) and
 * nowhere else. Putting the private half on the app undoes phase 8 silently: the
 * form keeps working, and a compromise of the web service becomes a live
 * banking-read again with nothing in the code to show it.
 *
 * Not `openssl genpkey` in the README, though it is the same two keys, because
 * the encoding matters and is easy to get subtly wrong: these variables hold
 * base64 of the DER, not PEM, so that each is one line that survives a `.env`
 * file, a compose `environment:` and a quadlet `Environment=` without quoting
 * rules entering the picture.
 */
import { generateKeyPairSync } from "node:crypto";

import { KEY_BITS } from "../lib/server/seal";

// See the note in list-workspaces.ts: a file with no import or export is not a
// module, and its `const`s would land in the global scope.
export {};

const USAGE = `Usage:
  pnpm link:keypair

Prints a fresh RSA-${KEY_BITS} keypair as two environment variables. The public half
lets the web app's connect form seal an Akahu token; only the private half opens
one. Give the app TOKEN_PUBLIC_KEY only — see docs/multi-user.md.`;

function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: KEY_BITS,
    publicKeyEncoding: { type: "spki", format: "der" },
    // Unencrypted PKCS#8: a passphrase here would have to be supplied by another
    // environment variable sitting beside this one, which protects nothing and
    // adds a way for the worker to fail at 3am.
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  console.log(`# Everywhere, including the web app — this half only seals.
TOKEN_PUBLIC_KEY=${publicKey.toString("base64")}

# The worker and the CLI ONLY. Never the app: it is what opens a bank token.
TOKEN_PRIVATE_KEY=${privateKey.toString("base64")}`);

  console.error(
    "\nGenerated. Rotating these later leaves already-sealed tokens unreadable — the worker\n" +
      "opens each blob with the key it was sealed to, so keep the old private half until\n" +
      "every link has been re-connected, or re-set them with `pnpm link:token`.",
  );
}

main();
