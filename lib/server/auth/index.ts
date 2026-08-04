// Authentication and the tenancy control plane. Better Auth owns what is
// dangerous to hand-roll — password hashing, session tokens, CSRF, TOTP, rate
// limiting — but not authorization: `scopedDb` decides which rows you may see.
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { organization, twoFactor } from "better-auth/plugins";

import { authDb } from "../db";
import { ac, editor, owner, viewer } from "./roles";
import { captureResetToken } from "./reset-capture";

/** Required, with no generated fallback: a per-process secret would log everyone
 *  out on restart and two replicas would never agree on a session token. */
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

  secret: authSecret(),

  // Set explicitly because Better Auth otherwise derives the origin from the
  // request, which is also how it judges same-origin — leaving that to a `Host`
  // header an attacker can write.
  baseURL: process.env.BETTER_AUTH_URL,

  session: {
    // 30 days, refreshed at most daily, both as seconds. This only bounds an
    // idle session — per-request membership re-validation is what makes
    // revocation work.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },

  // Better Auth's `account` is a credential; this app's `Account` is a *bank*
  // account. Renaming Better Auth's table is the side of the collision where
  // nothing else has to move.
  account: { modelName: "authAccount" },

  user: {
    // Confirmation email is only required when the *current* address is verified,
    // and nothing here ever verifies one. Adding a verification flow would make
    // this insufficient and a confirmation sender required.
    changeEmail: {
      enabled: true,
      updateEmailWithoutVerification: true,
    },
  },

  emailAndPassword: {
    enabled: true,
    // Above the library's default of 8: this instance holds a complete picture of
    // someone's finances, and the friction is paid once per person. Signup is
    // invite-only, so this is not a public form.
    minPasswordLength: 12,

    // 1 hour, as seconds. A reset link is a bearer credential, so it is much
    // shorter-lived than an invite: an owner generates one for someone locked
    // out and about to use it, not to sit in an inbox.
    resetPasswordTokenExpiresIn: 60 * 60,

    // Delivery is ours: no SMTP. The token reaches the owner action that asked
    // for it via `captureResetToken`; a reset triggered from anywhere else lands
    // here, goes nowhere, and expires unused.
    async sendResetPassword({ token }) {
      captureResetToken(token);
    },
  },

  plugins: [
    // Enrolment is available always, enforcement is the REQUIRE_MFA flag: the
    // capability is what is expensive to retrofit onto live accounts.
    twoFactor(),

    organization({
      // Our tables, under their own names. `modelName` is the *Prisma client
      // property*, not the model — the adapter does `db[modelName]`, so it is
      // `membership`, not `Membership`.
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
          // Nothing reads this: the URL names the workspace and the membership
          // check decides. Mapped only because the plugin's endpoints write it.
          fields: { activeOrganizationId: "activeWorkspaceId" },
        },
      },

      ac,
      roles: { owner, editor, viewer },
      // The plugin holds the last-owner invariant for us: `leave` and
      // `update-member-role` refuse to strip the final one.
      creatorRole: "owner",

      invitationExpiresIn: 60 * 60 * 24 * 3, // 3 days, as seconds.

      // Delivery is ours: a copyable link, no SMTP. The plugin still owns the
      // expiry, the role and the single-use redemption.
      async sendInvitationEmail() {
        // Intentionally nothing. `app/w/[workspace]/members` surfaces the link.
      },
    }),

    // Must stay last — Better Auth applies plugin hooks in order, and this wraps
    // every endpoint so `set-cookie` survives a call from a server action.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
