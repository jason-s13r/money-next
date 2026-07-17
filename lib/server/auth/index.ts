import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { organization, twoFactor } from "better-auth/plugins";

import { authDb } from "../db";
import { ac, editor, owner, viewer } from "./roles";

/**
 * Authentication, and the tenancy control plane it carries.
 *
 * Better Auth owns the parts that are dangerous to hand-roll — password
 * hashing, session tokens, CSRF, TOTP enrolment and challenge, rate limiting,
 * enumeration-resistant responses — and, via the organization plugin, the
 * membership and invitation lifecycle.
 *
 * What it does *not* own is authorization over the financial data. That stays in
 * the data access layer: `getDb()` resolves the `[workspace]` URL segment
 * against a membership check on every request, and `scopedDb` welds the
 * `workspaceId` filter onto every query. Better Auth decides who you are and
 * what workspaces you belong to; `scopedDb` decides what rows you may see. See
 * docs/multi-user.md.
 *
 * ## Why the schema is one long mapping block
 *
 * The plugin's vocabulary is `organization`/`member`/`invitation`; this app's is
 * `Workspace`/`Membership`/`Invite`, and phase 2 modelled those tables before
 * this phase chose the library. Mapping is the cheap direction: `modelName` and
 * `fieldName` tell Better Auth where our columns live, and the app keeps the
 * words it already uses in its schema, its queries and its docs.
 *
 * `modelName` is the *Prisma client property*, not the model name — the adapter
 * does `db[modelName]`, so it is `membership`, not `Membership`.
 */
function authSecret() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` " +
        "and put it in .env — see .env.example.",
    );
  }
  return secret;
}

export const auth = betterAuth({
  database: prismaAdapter(authDb, { provider: "postgresql" }),

  // Signs session tokens. No default and no fallback on purpose: a generated
  // one would differ per process, so every restart would silently log everyone
  // out, and two container replicas would never agree.
  secret: authSecret(),

  // Better Auth derives the origin from the incoming request when this is
  // unset, which is also how it decides whether a request is same-origin. Set it
  // explicitly so that decision doesn't depend on a `Host` header an attacker
  // can write.
  baseURL: process.env.BETTER_AUTH_URL,

  session: {
    // A finance dashboard on a household host: long enough not to be a nuisance,
    // short enough that a forgotten logged-in browser expires. Note this is not
    // the control that makes revocation work — per-request membership
    // re-validation is (T11). This only bounds an idle session.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },

  // Better Auth's own table is `account` — its word for a credential or a linked
  // OAuth identity. This app's `Account` is a *bank* account, and has been since
  // long before auth existed. The collision is real but shallow: name Better
  // Auth's table `AuthAccount` and nothing else has to move.
  account: { modelName: "authAccount" },

  emailAndPassword: {
    enabled: true,
    // Registration is invite-only (docs/multi-user.md, Open questions), so there
    // is no open signup path to disable later. `signUp` here is the mechanism
    // the invite-acceptance flow and the bootstrap script call; it is not
    // reachable as a public form.
    //
    // Minimum length above the library's default of 8: this instance holds a
    // complete picture of someone's finances, and the account count is small
    // enough that the friction is paid once per person, forever.
    minPasswordLength: 12,
  },

  plugins: [
    // Server-validated MFA. Built now, required only when REQUIRE_MFA says so
    // — the capability is what is expensive to retrofit onto live accounts,
    // the enforcement is a flag. Akahu's accreditation makes MFA mandatory, so
    // this is what makes that posture reachable without a migration of people.
    twoFactor(),

    organization({
      // Our tables, under their own names.
      schema: {
        organization: {
          modelName: "workspace",
        },
        member: {
          modelName: "membership",
          fields: { organizationId: "workspaceId" },
        },
        invitation: {
          modelName: "invite",
          fields: { organizationId: "workspaceId", inviterId: "invitedByUserId" },
        },
        session: {
          // The plugin keeps the "active organization" on the session. This app
          // routes the workspace in the URL instead (`app/w/[workspace]/`), so
          // nothing reads this column — the URL names the workspace and the
          // membership check decides. Kept because the plugin's own endpoints
          // write it, and mapped so it at least speaks our vocabulary.
          fields: { activeOrganizationId: "activeWorkspaceId" },
        },
      },

      ac,
      roles: { owner, editor, viewer },
      creatorRole: "owner",

      // A workspace must always have an owner, and the plugin enforces the
      // last-owner invariant for us: `leave` and `update-member-role` refuse to
      // strip the final one.
      invitationExpiresIn: 60 * 60 * 24 * 3, // 3 days — days, not weeks (T12).

      // Delivery is ours: a copyable link, no SMTP. A self-hosted instance may
      // have no mail sender, and at two-people scale pasting a link into a
      // message beats configuring one. The plugin still owns the expiry, the
      // role, and the single-use redemption.
      async sendInvitationEmail() {
        // Intentionally nothing. `app/w/[workspace]/members` surfaces the link.
      },
    }),

    // Must stay last: it wraps every endpoint so `set-cookie` survives being
    // called from a server action. Ordering is a real constraint here, not a
    // style choice — Better Auth applies plugin hooks in order.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
