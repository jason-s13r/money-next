"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient, twoFactorClient } from "better-auth/client/plugins";

/**
 * Better Auth in the browser: sign-in, sign-out, TOTP enrolment and challenge,
 * and the organization plugin's member/invite calls.
 *
 * The client plugins mirror the server's (lib/server/auth) — they are what make
 * `authClient.twoFactor.*` and `authClient.organization.*` exist and typecheck.
 * A plugin enabled on one side only is the classic Better Auth footgun: the
 * endpoint answers but the caller has no method for it.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient(), organizationClient()],
});
