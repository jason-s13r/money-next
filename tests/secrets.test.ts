/**
 * Encryption at rest for Akahu tokens, and the resolution step that decides which
 * credentials a sync runs under. See lib/server/secrets.ts and lib/server/akahu.ts.
 *
 * The stakes are why this file is longer than the code it tests: an Akahu token
 * reads the holder's entire bank history, so the two failures that matter are
 * "ciphertext that opens when it shouldn't" and "a link that syncs with somebody
 * else's credentials". Both are silent by nature — the first looks like working
 * decryption, the second looks like a successful sync — so neither would be
 * noticed by running the thing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import { resolveToken, type TokenLink } from "../lib/server/akahu";
import { decryptSecret, encryptSecret, hasEncryptionKey, tokenAad } from "../lib/server/secrets";
import { hasSealKey, isSealed, sealSecret } from "../lib/server/seal";

/** Two distinct valid keys, so "wrong key" can be tested against a real one. */
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

/**
 * Two real keypairs, generated once. RSA-3072 keygen is the slowest thing in this
 * file by an order of magnitude, and "wrong key" is only a meaningful test against
 * a second *valid* one — a corrupt string exercises the parser, not the crypto.
 */
const PAIR_A = keypair();
const PAIR_B = keypair();

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    public: publicKey.toString("base64"),
    private: privateKey.toString("base64"),
  };
}

/** Put a keypair in the environment the way the deploy files do. */
function useKeypair(pair: { public: string; private: string }) {
  process.env.TOKEN_PUBLIC_KEY = pair.public;
  process.env.TOKEN_PRIVATE_KEY = pair.private;
}

const ENV_KEYS = [
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_PUBLIC_KEY",
  "TOKEN_PRIVATE_KEY",
  "AKAHU_APP_ID_TOKEN",
  "AKAHU_USER_ACCESS_TOKEN",
] as const;
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

const AAD = tokenAad("app_link_abc", "userToken");

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a token", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret("user_token_secret", AAD);
    assert.equal(decryptSecret(blob, AAD), "user_token_secret");
  });

  test("the ciphertext does not contain the token", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret("user_token_secret", AAD);
    assert.ok(!blob.includes("user_token_secret"));
    // ...and not base64 of it either, which is the way this test usually passes
    // while being wrong.
    assert.ok(!blob.includes(Buffer.from("user_token_secret").toString("base64url")));
  });

  test("encrypting the same token twice gives different ciphertext", () => {
    // A fresh IV per encryption. Without it, equal ciphertexts announce that two
    // links share a token — and GCM with a reused nonce is catastrophically broken,
    // not merely leaky.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    assert.notEqual(encryptSecret("same", AAD), encryptSecret("same", AAD));
  });

  test("is versioned, so a future format change can tell the two apart", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    assert.match(encryptSecret("t", AAD), /^v1\./);
  });

  test("a tampered ciphertext is rejected, not silently mangled", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const parts = encryptSecret("user_token_secret", AAD).split(".");

    // Flip a character in the ciphertext segment. Without the GCM tag this would
    // decrypt to garbage and be handed to Akahu as if it were a token.
    const c = parts[3];
    parts[3] = (c[0] === "A" ? "B" : "A") + c.slice(1);

    assert.throws(() => decryptSecret(parts.join("."), AAD), /Could not decrypt/);
  });

  test("the wrong key is rejected", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret("user_token_secret", AAD);

    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    assert.throws(() => decryptSecret(blob, AAD), /Could not decrypt/);
  });

  test("a blob is bound to its row: moving it to another link fails", () => {
    // The database is a place where rows get copied — by a restore, a botched
    // migration, or someone with a psql prompt. GCM alone authenticates the bytes
    // and says nothing about where they belong, so without the AAD a token lifted
    // from link A's row into link B's would decrypt happily and sync A's bank
    // into B's workspace. That is the cross-tenant leak the whole scoping layer
    // exists to prevent, arriving as valid data.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret("user_token_secret", tokenAad("app_link_aaa", "userToken"));

    assert.throws(
      () => decryptSecret(blob, tokenAad("app_link_bbb", "userToken")),
      /Could not decrypt/,
    );
  });

  test("a blob is bound to its field: the app token can't stand in for the user token", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret("app_token_value", tokenAad("app_link_aaa", "appToken"));

    assert.throws(
      () => decryptSecret(blob, tokenAad("app_link_aaa", "userToken")),
      /Could not decrypt/,
    );
  });

  test("an unknown format is refused rather than guessed at", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    for (const bad of ["", "user_token_plaintext", "v2.a.b.c", "v1.a.b", "v1.a.b.c.d"]) {
      assert.throws(() => decryptSecret(bad, AAD), /encrypted secret|Not a v1/, `accepted: ${bad}`);
    }
  });

  test("a plaintext token is never mistaken for ciphertext", () => {
    // The failure this guards: a decrypt path that falls back to returning its
    // input when it doesn't look encrypted. That would make an un-migrated row
    // work, which is exactly why someone would write it, and would also make
    // every wrong-key failure look like a successful read of a bad token.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    assert.throws(() => decryptSecret("user_token_1234567890", AAD));
  });

  test("refuses to encrypt nothing", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    assert.throws(() => encryptSecret("", AAD), /empty secret/);
  });
});

describe("the key itself", () => {
  test("a missing key says what to do about it", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.equal(hasEncryptionKey(), false);
    assert.throws(() => encryptSecret("t", AAD), /openssl rand -base64 32/);
  });

  test("a wrong-length or non-base64 key is caught at use, not at first decrypt", () => {
    // `Buffer.from(x, "base64")` stops at the first invalid character and returns
    // a short buffer rather than throwing, so "is this base64" and "is this 32
    // bytes" are the same check. A 16-byte key would otherwise fail inside
    // createCipheriv with a message about IV length.
    for (const bad of ["short", Buffer.alloc(16).toString("base64"), "!!!!", ""]) {
      process.env.TOKEN_ENCRYPTION_KEY = bad;
      assert.equal(hasEncryptionKey(), false, `accepted: ${JSON.stringify(bad)}`);
      assert.throws(() => encryptSecret("t", AAD), /TOKEN_ENCRYPTION_KEY/);
    }
  });

  test("accepts both base64 and base64url spellings of the same key", () => {
    // `openssl rand -base64 32` emits `+` and `/`; a key pasted through something
    // URL-safe arrives as `-` and `_`. Both must open the same rows, or an
    // operator's copy-paste route silently becomes part of the key.
    const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 251) % 256));
    process.env.TOKEN_ENCRYPTION_KEY = raw.toString("base64");
    const blob = encryptSecret("user_token_secret", AAD);

    process.env.TOKEN_ENCRYPTION_KEY = raw.toString("base64url");
    assert.equal(decryptSecret(blob, AAD), "user_token_secret");
  });

  test("is re-read each time, so rotating it does not need a restart", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret("user_token_secret", AAD);
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    assert.throws(() => decryptSecret(blob, AAD));
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    assert.equal(decryptSecret(blob, AAD), "user_token_secret");
  });
});

/**
 * The sealed scheme — what the app's connect form writes.
 *
 * Everything the symmetric tests above assert has to hold here too, because the
 * two formats sit in the same column and the worker cannot tell from the call
 * site which one it is about to open. What is *new* is the asymmetry itself: the
 * public key must not be able to read back, which is the property the whole
 * arrangement is for and the only one that is invisible from the outside.
 */
describe("sealSecret / decryptSecret", () => {
  const AAD_PK = tokenAad("app_link_sealed", "userToken");

  test("round-trips through the private key", () => {
    useKeypair(PAIR_A);
    const blob = sealSecret("user_token_secret", AAD_PK);
    assert.equal(decryptSecret(blob, AAD_PK), "user_token_secret");
  });

  test("is labelled v1pk, so decryptSecret can dispatch without guessing", () => {
    useKeypair(PAIR_A);
    const blob = sealSecret("t", AAD_PK);
    assert.match(blob, /^v1pk\./);
    assert.ok(isSealed(blob));
    assert.ok(!isSealed(encryptWith(KEY_A, "t", AAD_PK)));
  });

  test("the ciphertext does not contain the token", () => {
    useKeypair(PAIR_A);
    const blob = sealSecret("user_token_secret", AAD_PK);
    assert.ok(!blob.includes("user_token_secret"));
    assert.ok(!blob.includes(Buffer.from("user_token_secret").toString("base64url")));
  });

  test("sealing the same token twice gives different ciphertext", () => {
    // OAEP's random seed. Equal ciphertexts would announce that two links share a
    // token, exactly as a reused GCM nonce would.
    useKeypair(PAIR_A);
    assert.notEqual(sealSecret("same", AAD_PK), sealSecret("same", AAD_PK));
  });

  test("the public key alone cannot read it back", () => {
    // The property the split is for, and the reason the app may hold this key at
    // all. Everything else in this file would pass just as well if `sealSecret`
    // were symmetric.
    useKeypair(PAIR_A);
    const blob = sealSecret("user_token_secret", AAD_PK);

    delete process.env.TOKEN_PRIVATE_KEY;
    assert.equal(hasSealKey(), true, "the app still has its half");
    assert.throws(() => decryptSecret(blob, AAD_PK), /TOKEN_PRIVATE_KEY/);
  });

  test("the wrong private key is rejected", () => {
    useKeypair(PAIR_A);
    const blob = sealSecret("user_token_secret", AAD_PK);

    process.env.TOKEN_PRIVATE_KEY = PAIR_B.private;
    assert.throws(() => decryptSecret(blob, AAD_PK), /Could not decrypt/);
  });

  test("the two halves cannot be swapped between variables", () => {
    // The mistake `pnpm link:keypair` prints two labelled lines to prevent, and
    // the one whose OpenSSL error is least informative.
    process.env.TOKEN_PUBLIC_KEY = PAIR_A.private;
    assert.equal(hasSealKey(), false);
    assert.throws(() => sealSecret("t", AAD_PK), /TOKEN_PUBLIC_KEY/);

    useKeypair(PAIR_A);
    const blob = sealSecret("t", AAD_PK);
    process.env.TOKEN_PRIVATE_KEY = PAIR_A.public;
    assert.throws(() => decryptSecret(blob, AAD_PK), /TOKEN_PRIVATE_KEY/);
  });

  test("a blob is bound to its row and its field", () => {
    // The OAEP label doing the same job GCM's AAD does — a ciphertext moved
    // between rows or between the two token columns must fail, not quietly
    // authenticate as another connection.
    useKeypair(PAIR_A);
    const blob = sealSecret("user_token_secret", tokenAad("app_link_aaa", "userToken"));

    assert.throws(
      () => decryptSecret(blob, tokenAad("app_link_bbb", "userToken")),
      /Could not decrypt/,
    );
    assert.throws(
      () => decryptSecret(blob, tokenAad("app_link_aaa", "appToken")),
      /Could not decrypt/,
    );
  });

  test("a tampered ciphertext is rejected, not silently mangled", () => {
    useKeypair(PAIR_A);
    const [version, body] = sealSecret("user_token_secret", AAD_PK).split(".");
    const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1);

    assert.throws(() => decryptSecret(`${version}.${flipped}`, AAD_PK), /Could not decrypt/);
  });

  test("a malformed v1pk blob is refused rather than guessed at", () => {
    useKeypair(PAIR_A);
    for (const bad of ["v1pk.", "v1pk", "v1pk.a.b"]) {
      assert.throws(() => decryptSecret(bad, AAD_PK), /v1pk|Not a v1/, `accepted: ${bad}`);
    }
  });

  test("refuses to seal nothing", () => {
    useKeypair(PAIR_A);
    assert.throws(() => sealSecret("", AAD_PK), /empty secret/);
  });

  test("a missing public key says what to do about it", () => {
    delete process.env.TOKEN_PUBLIC_KEY;
    assert.equal(hasSealKey(), false);
    assert.throws(() => sealSecret("t", AAD_PK), /pnpm link:keypair/);
  });
});

/**
 * `pnpm link:upgrade` in miniature: the conversion itself, without the database.
 *
 * The script's own loop is bookkeeping; what would actually lose someone's bank
 * connection is the re-encryption being wrong in a way that still writes — so
 * that is what is tested here, at the level the script does it.
 */
describe("upgrading a symmetric token to a sealed one", () => {
  const LINK = "app_link_upgrading";

  test("both formats stay readable side by side", () => {
    // The state every instance is in mid-upgrade, and the reason the script can
    // convert one field at a time without a transaction: a link whose app token
    // is sealed and whose user token is not must sync throughout.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    useKeypair(PAIR_A);

    const link = {
      id: LINK,
      tokenSource: "stored",
      appTokenCipher: sealSecret("app_token_mine", tokenAad(LINK, "appToken")),
      userTokenCipher: encryptSecret("user_token_mine", tokenAad(LINK, "userToken")),
    };

    assert.deepEqual(resolveToken(link), {
      appToken: "app_token_mine",
      userToken: "user_token_mine",
    });
  });

  test("re-sealing preserves the token exactly", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    useKeypair(PAIR_A);
    const aad = tokenAad(LINK, "userToken");

    const before = encryptSecret("user_token_mine", aad);
    const after = sealSecret(decryptSecret(before, aad), aad);

    assert.ok(isSealed(after));
    assert.notEqual(before, after);
    assert.equal(decryptSecret(after, aad), "user_token_mine");
  });

  test("an upgraded link no longer needs the symmetric key", () => {
    // The whole point of running the upgrade: TOKEN_ENCRYPTION_KEY becomes
    // removable. If a converted row still needed it, the operator would drop the
    // key on this promise and break every sync.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    useKeypair(PAIR_A);
    const aad = tokenAad(LINK, "userToken");
    const sealed = sealSecret(decryptSecret(encryptSecret("tok", aad), aad), aad);

    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.equal(decryptSecret(sealed, aad), "tok");
  });

  test("re-sealing under a mismatched keypair is caught before it is written", () => {
    // The script seals, opens the result, and compares — this is that check
    // failing. Without it the write succeeds and the link is unopenable by the
    // worker, which surfaces hours later as a sync error naming neither key.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const aad = tokenAad(LINK, "userToken");

    process.env.TOKEN_PUBLIC_KEY = PAIR_A.public;
    process.env.TOKEN_PRIVATE_KEY = PAIR_B.private;

    const resealed = sealSecret(decryptSecret(encryptSecret("tok", aad), aad), aad);
    assert.throws(() => decryptSecret(resealed, aad), /Could not decrypt/);
  });
});

/** `encryptSecret` under a named key, for tests that need both schemes at once. */
function encryptWith(key: string, plaintext: string, aad: string) {
  process.env.TOKEN_ENCRYPTION_KEY = key;
  return encryptSecret(plaintext, aad);
}

describe("resolveToken", () => {
  const link = (over: Partial<TokenLink>): TokenLink => ({
    id: "app_link_abc",
    tokenSource: "env",
    appTokenCipher: null,
    userTokenCipher: null,
    ...over,
  });

  test("env links read the instance-wide pair", () => {
    process.env.AKAHU_APP_ID_TOKEN = "app_token_env";
    process.env.AKAHU_USER_ACCESS_TOKEN = "user_token_env";

    assert.deepEqual(resolveToken(link({ tokenSource: "env" })), {
      appToken: "app_token_env",
      userToken: "user_token_env",
    });
  });

  test("stored links decrypt their own pair", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const id = "app_link_stored";

    const resolved = resolveToken(
      link({
        id,
        tokenSource: "stored",
        appTokenCipher: encryptSecret("app_token_mine", tokenAad(id, "appToken")),
        userTokenCipher: encryptSecret("user_token_mine", tokenAad(id, "userToken")),
      }),
    );

    assert.deepEqual(resolved, { appToken: "app_token_mine", userToken: "user_token_mine" });
  });

  test("a stored link never falls back to the env pair", () => {
    // The one that would be a cross-tenant leak. A `stored` link whose token
    // cannot be produced must fail its sync run, loudly. Falling back would sync
    // *the default workspace's bank* into this workspace's ledger, through the
    // front door, with every scoping check satisfied — the data would genuinely
    // belong to the link it was ingested for.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    process.env.AKAHU_APP_ID_TOKEN = "app_token_env";
    process.env.AKAHU_USER_ACCESS_TOKEN = "user_token_env";

    assert.throws(
      () => resolveToken(link({ tokenSource: "stored" })),
      /no stored credentials/,
      "a stored link with no ciphertext resolved to something",
    );

    // Half a pair is the same answer: a row mid-way through an interrupted
    // `pnpm link:token` must not sync with the env user token.
    assert.throws(
      () =>
        resolveToken(
          link({
            tokenSource: "stored",
            appTokenCipher: encryptSecret("app_token_mine", tokenAad("app_link_abc", "appToken")),
          }),
        ),
      /no stored credentials/,
    );
  });

  test("an unknown source is refused rather than defaulted", () => {
    process.env.AKAHU_APP_ID_TOKEN = "app_token_env";
    process.env.AKAHU_USER_ACCESS_TOKEN = "user_token_env";

    // A typo'd or future `tokenSource` must not quietly mean "use the env pair" —
    // same leak as above, arrived at by a different route.
    assert.throws(() => resolveToken(link({ tokenSource: "oauth2" })), /unknown tokenSource/);
    assert.throws(() => resolveToken(link({ tokenSource: "" })), /unknown tokenSource/);
  });

  test("an env link with no env pair says which variable is missing", () => {
    delete process.env.AKAHU_APP_ID_TOKEN;
    assert.throws(() => resolveToken(link({ tokenSource: "env" })), /AKAHU_APP_ID_TOKEN/);
  });
});

/**
 * The web app must not be able to reach an Akahu credential.
 *
 * Phase 7 left the web role unable to *call* Akahu (it enqueues a job; the worker
 * fetches). Phase 8 adds the other half: it holds no key, so the ciphertext in
 * `BankLink` is inert in its hands — which is why compose.prod.yaml and
 * money-app.container blank TOKEN_ENCRYPTION_KEY on the app service.
 *
 * That arrangement is invisible in the code and would be undone by one innocuous
 * import, in a file whose author had no idea any of this was true. So it is fenced
 * by inventory, in the same style as the unscoped-client checks in
 * isolation.test.ts: adding a file here is allowed, it just has to be a decision
 * someone typed out.
 */
describe("the app never touches Akahu credentials", () => {
  const root = new URL("..", import.meta.url).pathname;

  /** Files matching a git-grep pattern, as a list. Empty when nothing matches. */
  function grep(pattern: string, paths: string[]): string[] {
    let matches = "";
    try {
      matches = execFileSync(
        "git",
        // `--untracked` so a not-yet-added file is caught too: the first version
        // of a new route is exactly when this mistake gets made.
        ["grep", "-l", "-E", "--untracked", pattern, "--", ...paths],
        { cwd: root, encoding: "utf8" },
      );
    } catch (error) {
      const { status, stdout } = error as { status?: number; stdout?: string };
      if (status !== 1) throw error;
      matches = stdout ?? "";
    }
    return matches.split("\n").filter(Boolean);
  }

  test("nothing under app/ imports the akahu or secrets modules", () => {
    // `server/seal` is deliberately not matched: it is the encrypt-only half the
    // connect form uses, and the test below is what keeps it that.
    const offenders = grep("server/(akahu|secrets)", ["app/*.ts", "app/*.tsx"]);

    assert.deepEqual(
      offenders,
      [],
      `these files let the web app reach an Akahu credential: ${offenders.join(", ")}. ` +
        `The web role does not call Akahu and holds no TOKEN_ENCRYPTION_KEY — it enqueues a ` +
        `SyncRun and scripts/worker.ts does the fetch. The app may import lib/server/seal, ` +
        `which seals a token to a public key and cannot open one; anything more than that ` +
        `needs a reason added here and the key granted back in compose.prod.yaml and ` +
        `money-app.container.`,
    );
  });

  test("lib/server/seal.ts cannot open what it seals", () => {
    /**
     * The property the test above is standing on. `app/` may import seal.ts only
     * because there is no path from it to a plaintext token — and that is a fact
     * about the file's *contents*, which would survive exactly until someone
     * added a convenient `unseal` beside `seal` and moved the private key import
     * up two lines. Nothing else in the app would fail; the guarantee printed on
     * the connect form would simply stop being true.
     *
     * Checked by inventory rather than by behaviour for the reason isolation.ts
     * gives: the mistake belongs to code that has not been written yet.
     */
    const source = readFileSync(new URL("../lib/server/seal.ts", import.meta.url), "utf8");

    // Constructs, not the variable's *name*: seal.ts names TOKEN_PRIVATE_KEY in
    // the error it prints when the public half is missing, because "the private
    // half goes elsewhere" is the single most useful thing to tell an operator
    // at that moment. Telling someone where a key belongs is not holding it. So
    // this looks for the calls that could open a blob, plus *any* computed
    // environment access — seal.ts reads `process.env.TOKEN_PUBLIC_KEY` by its
    // literal name precisely so that `process.env[…]` appearing here at all is a
    // question worth asking.
    const forbidden = ["privateDecrypt", "createPrivateKey", "createDecipheriv", "env["];
    const found = forbidden.filter((token) => source.includes(token));

    assert.deepEqual(
      found,
      [],
      `lib/server/seal.ts mentions ${found.join(", ")}, which means it may be able to open a ` +
        `sealed token. It is imported by app/, so anything that can decrypt in there hands ` +
        `the web app the power the split exists to deny it. The opening side belongs in ` +
        `lib/server/secrets.ts, which app/ may not import.`,
    );
  });
});
