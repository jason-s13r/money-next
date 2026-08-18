import { AkahuClient } from "akahu";
import { decryptSecret, tokenAad } from "./secrets";

// No `server-only`: the sync worker imports this from plain Node, where it throws.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

/**
 * Akahu identifies the *app* with an app token and the *user* whose accounts we're
 * reading with a separate access token. For a personal app both come from
 * my.akahu.nz and both belong to one person — which is why they are a *pair* here
 * and why phase 8 stores both per link rather than treating the app token as
 * instance-wide. A second household member connecting their own accounts creates
 * their own personal app, and brings their own app token with them.
 */
export type AkahuCredentials = { appToken: string; userToken: string };

/**
 * What resolving a link's credentials needs to know about it. A structural type,
 * not the Prisma model: the callers select these four columns and nothing else,
 * and a function that took the whole row would invite passing one that was read
 * without them.
 */
export type TokenLink = {
  id: string;
  tokenSource: string;
  appTokenCipher: string | null;
  userTokenCipher: string | null;
};

/**
 * The `select` that produces a `TokenLink`. Exported so the two ingest entry
 * points (the cron script and the worker) can't drift from it — a link read
 * without these columns fails at the type level rather than at the Akahu call.
 */
export const TOKEN_LINK_SELECT = {
  id: true,
  tokenSource: true,
  appTokenCipher: true,
  userTokenCipher: true,
} as const;

/**
 * The credentials a sync should run under.
 *
 * `env` is the v1 arrangement: one instance-wide pair, which is why the workspace
 * it belonged to was "the default workspace" and why so much of docs/multi-user.md
 * carried a caveat about it. It stays supported and stays the default, because an
 * existing single-user install is precisely a `BankLink` in that state and must
 * keep syncing across this change without the operator doing anything.
 *
 * `stored` is the per-link pair, set by `money link token` and decrypted here. Two
 * workspaces with two different people's tokens then sync independently, and no
 * workspace is special.
 *
 * Deliberately synchronous and deliberately throwing: a link that cannot produce
 * credentials must fail the run it was claimed for, loudly, and not fall back to
 * the env pair. Silently syncing workspace B's link with workspace A's token would
 * put A's transactions in B's ledger — the exact cross-tenant leak the whole
 * scoping layer exists to prevent, arriving through the front door.
 */
export function resolveToken(link: TokenLink): AkahuCredentials {
  switch (link.tokenSource) {
    case "env":
      return {
        appToken: requireEnv("AKAHU_APP_ID_TOKEN"),
        userToken: requireEnv("AKAHU_USER_ACCESS_TOKEN"),
      };

    // Phase 10's OAuth links land here too: an access token obtained by code
    // exchange is stored and read exactly like a pasted personal one. What
    // differs is lifecycle (refresh, `auth.revoke()` on unlink), which is why
    // `tokenSource` records which it is even though this branch is shared.
    case "stored":
    case "oauth": {
      if (!link.appTokenCipher || !link.userTokenCipher) {
        throw new Error(
          `Bank link ${link.id} is set to tokenSource="${link.tokenSource}" but has no stored ` +
            "credentials. Set them with `money link token --link " + link.id + "`.",
        );
      }
      return {
        appToken: decryptSecret(link.appTokenCipher, tokenAad(link.id, "appToken")),
        userToken: decryptSecret(link.userTokenCipher, tokenAad(link.id, "userToken")),
      };
    }

    default:
      throw new Error(
        `Bank link ${link.id} has an unknown tokenSource "${link.tokenSource}". ` +
          'Expected "env", "stored" or "oauth".',
      );
  }
}

export function akahuClient(appToken: string): AkahuClient {
  return new AkahuClient({ appToken });
}

/**
 * A resolved client and the user token to call it with — the pair every Akahu
 * request needs, so the ingest steps take one of these rather than reaching for
 * the environment individually.
 *
 * Resolved once at the top of a sync rather than per step. Three steps each doing
 * their own lookup is three decryptions of the same secret, and — worse, once
 * links stopped being instance-wide — three independent chances to resolve a
 * *different* link's credentials than the one the sync is for.
 */
export type AkahuContext = { client: AkahuClient; userToken: string };

export function akahuFor(link: TokenLink): AkahuContext {
  const { appToken, userToken } = resolveToken(link);
  return { client: akahuClient(appToken), userToken };
}
