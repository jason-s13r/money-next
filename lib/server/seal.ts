/**
 * The half of token encryption the *web app* is allowed to have.
 *
 * Phase 8 left the app without `TOKEN_ENCRYPTION_KEY` on purpose: AES-256-GCM is
 * symmetric, so a process that can encrypt a token can decrypt every token, and
 * the internet-facing service holding that key turns any compromise of it into a
 * live banking-read (T19). That was fine for as long as tokens only ever arrived
 * through `pnpm link:token`, which runs on the host.
 *
 * The connect form (app/w/[workspace]/sync/connect-form.tsx) needs the app to
 * *write* a credential it must never be able to *read*, and that is a shape
 * symmetric crypto does not have. So: RSA-OAEP, public key in the app, private
 * key only where `TOKEN_ENCRYPTION_KEY` already is. This module is the encrypt
 * side and holds nothing else — there is no function here that opens a blob,
 * which is what makes it safe for `app/` to import (and what tests/secrets.test.ts
 * checks, since "this file has no decrypt in it" is a property that would
 * otherwise last exactly until someone added a convenient helper).
 *
 * A sealed blob is a *v1pk* value living in the same `BankLink.appTokenCipher` /
 * `userTokenCipher` column as a v1 AES blob. It is not converted afterwards: the
 * worker's `decryptSecret` opens either, so a link connected through the form and
 * one set by the CLI differ only in which key opens them, and no migration or
 * re-encryption pass has to exist. See docs/multi-user.md, phase 10.
 *
 * No `server-only`, matching secrets.ts and akahu.ts next door — the tests import
 * it outside any request.
 */
import { constants, createPublicKey, publicEncrypt, type KeyObject } from "node:crypto";

/**
 * Blob format: `v1pk.<ciphertext>`, base64url.
 *
 * Two segments where the AES format has four, so the version prefix and the
 * shape agree and `decryptSecret` can dispatch on the first field alone. Versioned
 * from the first row written, for the reason secrets.ts spells out: RSA-OAEP fails
 * identically for "wrong key" and "wrong format", so a mis-parsed blob is
 * indistinguishable from a tampered one unless the format says what it is.
 */
export const SEAL_VERSION = "v1pk";

const KEY_ENV = "TOKEN_PUBLIC_KEY";

/**
 * OAEP with SHA-256, and the AAD carried as the OAEP *label*.
 *
 * The label is the direct analogue of GCM's additional authenticated data: not
 * secret, not stored, recomputed from the row at decryption time, and its job is
 * identical — a blob copied from one bank link's row to another's, or from the
 * app-token column to the user-token column, fails to decrypt instead of quietly
 * opening into a token that authorises the wrong connection. Both halves of this
 * scheme therefore bind to the same `tokenAad` string, and a v1 blob and a v1pk
 * blob of the same token are interchangeable in every way except the key.
 */
const OAEP_HASH = "sha256";

/** Bits, matched by scripts/link-keypair.ts. See `sealSecret` for what it bounds. */
export const KEY_BITS = 3072;

function keyHint(problem: string): Error {
  return new Error(
    `${KEY_ENV} ${problem}. Generate a keypair with \`pnpm link:keypair\`, put the public ` +
      `half here and the private half in TOKEN_PRIVATE_KEY wherever the sync worker runs. ` +
      `The app gets only this one — that is the point of there being two.`,
  );
}

/**
 * The public key, decoded and parsed on every call.
 *
 * Base64 of the DER (SPKI), not PEM: an environment variable is one line in
 * practice — `.env` files, compose `environment:`, quadlet `Environment=` — and a
 * PEM's newlines survive none of those reliably. Same encoding as
 * `TOKEN_ENCRYPTION_KEY` next door, so an operator meets one convention.
 *
 * Not cached, for the same reason secrets.ts does not cache its key: a rotated
 * key should take effect without a restart, and parsing a few hundred bytes is
 * nothing beside the RSA operation that follows it.
 */
function publicKey(): KeyObject {
  // Read by its literal name rather than by computed lookup, so that *any*
  // subscripted access to the environment in this file is a red flag — which is
  // what tests/secrets.test.ts asserts, and why `KEY_ENV` above is used only for
  // the messages. The one value this module may read is the one key that cannot
  // open anything; a dynamic lookup is how that stops being checkable by reading
  // the file.
  const raw = process.env.TOKEN_PUBLIC_KEY;
  if (!raw) throw keyHint("is not set");

  const der = Buffer.from(raw, "base64");
  if (der.length === 0) throw keyHint("is not valid base64");

  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    // Deliberately not re-thrown with the OpenSSL message, which for a private
    // key pasted into this variable says "unsupported" and sends the operator
    // looking at their key generation rather than at which half went where.
    throw keyHint(
      "is not an SPKI public key (a private key or a PEM pasted here would fail exactly like this)",
    );
  }
}

/** Whether a usable public key is present, for callers that want to say so nicely. */
export function hasSealKey(): boolean {
  try {
    publicKey();
    return true;
  } catch {
    return false;
  }
}

/** Whether `blob` is a sealed value — i.e. one only the private key opens. */
export function isSealed(blob: string): boolean {
  return blob.startsWith(`${SEAL_VERSION}.`);
}

/**
 * Seal `plaintext` to the worker's private key, binding the result to `aad`.
 *
 * One RSA operation, no hybrid envelope: at 3072 bits OAEP-SHA-256 carries 318
 * bytes, and the two things this ever encrypts are an Akahu app token and a user
 * access token — both well under a hundred characters. A wrapped-AES-key envelope
 * would be the general answer and would also be a second format to get right for
 * no payload we will ever have. `assertFits` below is what keeps that assumption
 * from failing silently on some future longer credential.
 */
export function sealSecret(plaintext: string, aad: string): string {
  if (!plaintext) throw new Error("Refusing to encrypt an empty secret.");

  const bytes = Buffer.from(plaintext, "utf8");
  assertFits(bytes.length);

  const sealed = publicEncrypt(
    {
      key: publicKey(),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: OAEP_HASH,
      oaepLabel: Buffer.from(aad, "utf8"),
    },
    bytes,
  );

  return `${SEAL_VERSION}.${sealed.toString("base64url")}`;
}

/**
 * The binding for a bank link's stored credential — row id and field name, in a
 * namespaced shape so a future second use of this scheme cannot collide with it
 * by choosing the same id.
 *
 * Lives in this file, not in secrets.ts where it started, for one reason: both
 * ends need it and only one end may be imported by `app/`. It carries no key
 * material and no secret — it is a label format — so moving it here costs
 * nothing and removes the alternative, which was the connect form re-typing the
 * string and the two copies drifting the first time either changed. A drift
 * there is silent until a sync fails to decrypt.
 */
export function tokenAad(linkId: string, field: "appToken" | "userToken"): string {
  return `BankLink:${linkId}:${field}`;
}

/**
 * OAEP's payload ceiling: keysize − 2·hashlen − 2.
 *
 * Checked here rather than left to OpenSSL because its error for an oversized
 * payload ("data too large for key size") reaches an *end user* through the
 * connect form, where it would read as a complaint about the token they pasted.
 * This says the true thing instead, which is that the scheme needs changing.
 */
function assertFits(length: number) {
  const max = KEY_BITS / 8 - 2 * 32 - 2;
  if (length > max) {
    throw new Error(
      `Secret is ${length} bytes; RSA-OAEP at ${KEY_BITS} bits carries at most ${max}. ` +
        "A credential this long needs a hybrid envelope (wrap an AES key, encrypt the " +
        "payload with it) rather than a bigger modulus.",
    );
  }
}
