import { randomUUID } from "node:crypto";

/**
 * Ids for the rows this app mints itself, as opposed to the ones it mirrors.
 *
 * The shape is `<namespace>_<type>_<random>`, e.g.
 * `app_merchant_9f2c4e1a7b3d4f6a8c0e2b4d6f8a0c2e`.
 *
 * Why a namespace at all: most rows here carry an id somebody else chose —
 * Akahu's `acc_`/`trans_`/`merchant_`, NZFCC's `nzfcc_`. When a user types a
 * merchant name, or (later) invents their own category or category group, that
 * row is *ours*, and telling the two apart at a glance matters. NZFCC's ids are
 * cuid-shaped, so an un-prefixed random id would be indistinguishable from an
 * imported one; the namespace makes provenance unmistakable in a log line, a
 * `psql` session, or a URL.
 *
 * What must not depend on this: correctness. Provenance is answered by the
 * `workspaceId` column — `null` means shared catalog, set means a workspace
 * typed it — and that is what `scopedDb` enforces. Nothing parses an id to
 * decide what may be read or written, and nothing should start: the namespace is
 * configurable, so any code branching on it would break the moment someone set
 * it to something else. It is for humans.
 *
 * That inertness is also what makes the namespace safe to change: ids minted
 * before the change keep their old prefix, nothing compares them, and the two
 * coexist. Ids are opaque; only the database's uniqueness constraint has an
 * opinion about them.
 *
 * Not literally cuids, despite `@default(cuid())` on the tenancy models: Prisma
 * mints those inside its query engine and exposes no generator to call, and
 * there is no cuid package here. `randomUUID` is built into Node, is already
 * what the merchant action used, and buys the same thing — unguessable, unique,
 * no coordination. Adding a dependency to make the characters look different
 * would be paying for a haircut.
 */

/** Default namespace, so the app runs without configuring anything. */
const DEFAULT_NAMESPACE = "app";

/**
 * The namespace new ids are minted under. Configurable because it is a label for
 * *this* instance — a self-hoster's ids should say so, rather than carrying a
 * prefix borrowed from whoever wrote the code.
 *
 * Underscore-free by necessity: it is the separator. Validated rather than
 * sanitised, because silently rewriting someone's configuration into something
 * they did not ask for is worse than telling them it is wrong.
 */
function namespace(): string {
  const configured = process.env.ID_NAMESPACE?.trim();
  if (!configured) return DEFAULT_NAMESPACE;
  if (!/^[a-z0-9]+$/.test(configured)) {
    throw new Error(
      `ID_NAMESPACE must be lowercase letters and digits only (got "${configured}"). ` +
        "It is the first segment of ids like `app_merchant_<random>`, and `_` is the separator.",
    );
  }
  return configured;
}

/**
 * The kinds of row this app mints. Add a case when a feature invents rows.
 *
 * `merchant` is the only one wired up today — a name someone typed, which needs an
 * id that cannot be mistaken for one of Akahu's `merchant_...` catalog entries.
 * `category` and `group` are here for when a workspace can invent its own the same
 * way. Everything else this app generates either mirrors an upstream id (Akahu,
 * NZFCC) or takes a `@default(cuid())` — including `BankLink`, which was once
 * minted here and is now left to the database like any other row.
 */
export type MintedType = "merchant" | "category" | "group";

/**
 * A fresh id for a row this app is creating.
 *
 * @example mintId("merchant") // "app_merchant_9f2c4e1a7b3d4f6a8c0e2b4d6f8a0c2e"
 */
export function mintId(type: MintedType): string {
  return `${namespace()}_${type}_${randomUUID().replace(/-/g, "")}`;
}
