/**
 * Encryption at rest for the one class of secret this app stores: Akahu tokens.
 *
 * An Akahu access token reads the holder's entire bank history and keeps working
 * after we are cleaned up, which is why the threat model (T19) ranks a database
 * or backup leak that contains one as a *live banking-read* leak rather than a
 * disclosure of stale records. The mitigation was pre-committed there and is
 * implemented here: AES-256-GCM, with the key held in the environment and never
 * in the same store as the ciphertext. A stolen dump is then inert — the thing
 * that opens it was never in the dump.
 *
 * No `server-only`: the CLI and the sync worker import this from plain Node,
 * where it throws. The *web app* is the one place that must not import it at all
 * — phase 7 left the web role unable to call Akahu, and this keeps it unable to
 * read the credential that would let it.
 *
 * The app *does* need to write a token now (the connect form), which is a
 * different power from reading one and gets a different key: ./seal.ts is the
 * encrypt-only half it imports instead, and `decryptSecret` below opens what that
 * produces. Nothing in this file is reachable from `app/`.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";

import { SEAL_VERSION, isSealed } from "./seal";

/**
 * Ciphertext format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 *
 * Versioned from the first row written. Changing algorithm or key derivation
 * later is otherwise a migration that has to guess what each existing blob is,
 * and the guess is unfalsifiable — GCM's tag check fails identically for "wrong
 * key" and "wrong format", so a mis-parsed old row is indistinguishable from a
 * tampered one.
 *
 * That versioning is now load-bearing rather than precautionary: `v1pk` blobs
 * (./seal.ts) share these columns, written by the connect form with a public key
 * the app holds and opened here with the private half. `decryptSecret` dispatches
 * on the prefix, which is the whole reason there is one.
 */
const VERSION = "v1";

/** AES-256 takes a 32-byte key; GCM's standard nonce is 12 bytes. */
const KEY_BYTES = 32;
const IV_BYTES = 12;

const KEY_ENV = "TOKEN_ENCRYPTION_KEY";
const PRIVATE_KEY_ENV = "TOKEN_PRIVATE_KEY";

function keyHint(problem: string): Error {
  return new Error(
    `${KEY_ENV} ${problem}. Generate one with \`openssl rand -base64 32\` and set it ` +
      `wherever the sync worker and \`money link token\` run. It is not needed by the web app.`,
  );
}

/**
 * The key, decoded and length-checked on every call.
 *
 * Deliberately not cached in a module-level constant: this module is imported by
 * long-lived processes (the worker), and a cached key is a key that stays
 * resident and identical for the life of the process even after the operator has
 * rotated it. Decoding 32 bytes is free next to an HTTP call to Akahu.
 */
function key(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) throw keyHint("is not set");

  // `base64` accepts base64url and tolerates missing padding, so both spellings
  // of a generated key work. What it will *not* do is reject non-base64 input —
  // it stops at the first invalid character and returns a short buffer — which
  // is what the length check below is really guarding.
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw keyHint(
      `must decode to ${KEY_BYTES} bytes, got ${decoded.length}` +
        (decoded.length === 0 ? " (not valid base64?)" : ""),
    );
  }
  return decoded;
}

/** Whether a usable key is present, for callers that want to say so nicely. */
export function hasEncryptionKey(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt `plaintext`, binding the result to `aad`.
 *
 * The additional authenticated data is not secret and is not stored — it is
 * recomputed from the row at decryption time (see `tokenAad`). Its job is to make
 * a ciphertext meaningful *only where it was put*: a blob copied from one bank
 * link's row to another's, or from the app-token column to the user-token column,
 * fails its tag check instead of quietly decrypting into a token that authorises
 * the wrong connection. Without it, GCM authenticates the bytes but says nothing
 * about where they belong, and the database is a place where rows get moved.
 */
export function encryptSecret(plaintext: string, aad: string): string {
  if (!plaintext) throw new Error("Refusing to encrypt an empty secret.");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join(".");
}

/**
 * Decrypt a blob produced by `encryptSecret` under the same `aad`.
 *
 * Throws on a wrong key, a tampered ciphertext, a blob bound to a different row,
 * or an unknown version — all of which are the same answer to the caller ("this
 * is not a credential you can use") and none of which should be recoverable by
 * falling back to treating the value as plaintext. A silent fallback here would
 * mean an operator who set the wrong key gets "your token is invalid" from Akahu
 * instead of "you set the wrong key", and would spend the afternoon on it.
 */
export function decryptSecret(blob: string, aad: string): string {
  // A blob sealed by the app to the public key. Dispatched on the prefix before
  // anything else looks at the shape, so a `v1pk` value is never measured against
  // the AES format and reported as malformed — which would send an operator to
  // check TOKEN_ENCRYPTION_KEY over a row that has nothing to do with it.
  if (isSealed(blob)) return unsealSecret(blob, aad);

  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(
      `Not a ${VERSION} or ${SEAL_VERSION} encrypted secret. Re-set this link's tokens with ` +
        "`money link token`.",
    );
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error("Encrypted secret is malformed (bad IV or tag length).");
  }

  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // `final()` throwing *is* the authentication failure. Re-thrown with the
    // three things it can actually mean, because the raw message
    // ("Unsupported state or unable to authenticate data") tells an operator
    // nothing about which of them to go and check.
    throw new Error(
      "Could not decrypt this link's Akahu token: wrong TOKEN_ENCRYPTION_KEY, altered " +
        "ciphertext, or a value copied from another link. Re-set it with `money link token`.",
    );
  }
}

/**
 * The private half of ./seal.ts — the only thing that opens what the app writes.
 *
 * Lives here rather than beside `sealSecret` deliberately. seal.ts is imported by
 * `app/`, and a module the web app imports must contain no path to a plaintext
 * token; splitting the pair across the two files is what makes that true by
 * construction instead of by everyone remembering. It is also why this key is a
 * *third* environment variable rather than a field on the same one: the deploy
 * files can then hand `TOKEN_PUBLIC_KEY` to the app and withhold this, which is
 * the entire arrangement expressed in the place an operator can see it.
 */
function privateKey(): KeyObject {
  const raw = process.env[PRIVATE_KEY_ENV];
  if (!raw) {
    throw new Error(
      `${PRIVATE_KEY_ENV} is not set, so a token connected through the app's form cannot be ` +
        "opened. Generate the pair with `money link keypair` and set the private half wherever " +
        "the sync worker runs — never on the web app.",
    );
  }

  const der = Buffer.from(raw, "base64");
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error(
      `${PRIVATE_KEY_ENV} is not a base64 PKCS#8 private key. The public half (TOKEN_PUBLIC_KEY) ` +
        "pasted here would fail exactly like this — check which half went where.",
    );
  }
}

/**
 * Open a `v1pk` blob, under the same `aad` it was sealed with.
 *
 * The failure modes are the AES ones, one-for-one: wrong key, altered ciphertext,
 * a blob bound to another row. OAEP's label check is what covers that last one and
 * it fails the same silent-looking way GCM's tag does, so the message enumerates
 * the three causes for the same reason `decryptSecret`'s does — "decoding error"
 * from OpenSSL tells an operator nothing about which to go and look at.
 */
function unsealSecret(blob: string, aad: string): string {
  const parts = blob.split(".");
  if (parts.length !== 2 || !parts[1]) {
    throw new Error(`Malformed ${SEAL_VERSION} encrypted secret.`);
  }

  try {
    return privateDecrypt(
      {
        key: privateKey(),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        oaepLabel: Buffer.from(aad, "utf8"),
      },
      Buffer.from(parts[1], "base64url"),
    ).toString("utf8");
  } catch (error) {
    // A missing or malformed key has already said something specific and useful;
    // re-wrapping it as "could not decrypt" would bury the one message that names
    // the variable to fix.
    if (error instanceof Error && error.message.includes(PRIVATE_KEY_ENV)) throw error;

    throw new Error(
      "Could not decrypt this link's Akahu token: wrong TOKEN_PRIVATE_KEY (it must be the " +
        "pair of the TOKEN_PUBLIC_KEY the app sealed it with), altered ciphertext, or a value " +
        "copied from another link.",
    );
  }
}

/**
 * The binding for a bank link's stored credential — see `encryptSecret`.
 *
 * Re-exported rather than defined here since the connect form arrived: both the
 * sealing side and the opening side must compute the identical string, and only
 * ./seal.ts may be imported by `app/`. Existing callers (akahu.ts, the CLI, the
 * tests) keep importing it from this module, which is where it has always been
 * from their point of view.
 */
export { tokenAad } from "./seal";

function b64(buffer: Buffer): string {
  return buffer.toString("base64url");
}
