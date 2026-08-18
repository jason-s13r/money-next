/**
 * Generates the keypair that lets the web app store an Akahu token it cannot read.
 *
 *   money link keypair
 *
 * Run once per instance, before anyone uses the connect form. Prints two
 * environment variables and writes nothing: which container gets the private
 * half is a deployment decision, not this command's to make.
 *
 * The split is the whole point. `TOKEN_PUBLIC_KEY` goes everywhere, including
 * the internet-facing app — it can only seal. `TOKEN_PRIVATE_KEY` goes only
 * where `TOKEN_ENCRYPTION_KEY` already is. Putting it on the app is silent: the
 * form keeps working, and a web compromise is a live banking-read again.
 *
 * A command rather than `openssl genpkey` in the README because the encoding is
 * easy to get subtly wrong — these hold base64 of the DER, not PEM, so each is
 * one line that survives `.env`, compose and quadlet without quoting rules.
 */
import { generateKeyPairSync } from "node:crypto";

import { Command } from "commander";

import { KEY_BITS } from "../../../lib/server/seal";

export function register(parent: Command): void {
  parent
    .command("keypair")
    .description("Generate the keypair that lets the app store a token it cannot read")
    .addHelpText(
      "after",
      `
Prints a fresh RSA-${KEY_BITS} keypair as two environment variables and writes
nothing. The public half lets the web app's connect form seal an Akahu token;
only the private half opens one. Give the app TOKEN_PUBLIC_KEY only — see
docs/multi-user.md.
`,
    )
    .action(run);
}

function run() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: KEY_BITS,
    publicKeyEncoding: { type: "spki", format: "der" },
    // Unencrypted PKCS#8: a passphrase would need another environment variable
    // beside this one, protecting nothing and adding a way for the worker to fail.
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  console.log(`# Everywhere, including the web app — this half only seals.
TOKEN_PUBLIC_KEY=${publicKey.toString("base64")}

# The worker and the CLI ONLY. Never the app: it is what opens a bank token.
TOKEN_PRIVATE_KEY=${privateKey.toString("base64")}`);

  console.error(
    "\nGenerated. Rotating these later leaves already-sealed tokens unreadable — the worker\n" +
      "opens each blob with the key it was sealed to, so keep the old private half until\n" +
      "every link has been re-connected, or re-set them with `money link token`.",
  );
}
