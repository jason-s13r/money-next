import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

/**
 * What each role may do inside a workspace.
 *
 * The plan described these as a string ordering — `requireRole(session,
 * "editor")` with `owner > editor > viewer`. This says the same thing
 * declaratively instead, because the ordering only works while every capability
 * happens to nest. It already doesn't: `sync.run` is an editor power, but it is
 * also the one action a *viewer* arguably wants and the one an owner might want
 * to withhold. Statements let that be answered per capability rather than by
 * where a word sits in a list.
 *
 * Reading is deliberately absent. It is not a permission here, because it is not
 * enforced here: membership of the workspace *is* read access, and `scopedDb`
 * is what makes that true for every query at once. A role that could "read" and
 * a role that could not would be a second, weaker copy of the control that
 * already exists.
 */
export const statements = {
  ...defaultStatements,

  /// The enrichment layer: category, merchant, transfer links, rules. Everything
  /// a person can change about a transaction that the bank did not tell us.
  enrichment: ["update"],

  /// Budgets, their items, and the forecast scenarios built from them. Its own
  /// statement rather than part of `enrichment`, because that one is explicitly
  /// about a *transaction* — what a person can change about a row the bank told
  /// us about. A budget is not a claim about the past at all; it is the user's
  /// plan, and the two can sensibly be granted apart (a bookkeeper who may
  /// recategorise need not be able to rewrite the household's plan).
  budget: ["update"],

  /// Triggering an Akahu refresh and re-ingest. Its own statement because it
  /// spends someone else's rate limit (T3) rather than writing a row.
  sync: ["run"],

  /// Connecting and revoking a bank. Owner-only: it is the workspace's
  /// relationship with Akahu, and revoking it is the consumer-control lever
  /// accreditation requires.
  bankLink: ["create", "revoke"],
} as const;

export const ac = createAccessControl(statements);

export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  enrichment: ["update"],
  budget: ["update"],
  sync: ["run"],
  bankLink: ["create", "revoke"],
});

export const editor = ac.newRole({
  enrichment: ["update"],
  budget: ["update"],
  sync: ["run"],
});

/// Read and export only — so, no statements at all. See the note above: reading
/// is membership, not a permission.
export const viewer = ac.newRole({});

/** The roles a `Membership.role` may hold, and the only strings an invite may carry. */
export const ROLES = ["owner", "editor", "viewer"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
