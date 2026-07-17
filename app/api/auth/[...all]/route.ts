import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/server/auth";

/**
 * Better Auth's own endpoints: sign-in, sign-out, TOTP enrolment and challenge,
 * and the organization plugin's member/invite management.
 *
 * The only route in the app outside `/w/[workspace]/` that touches the database,
 * and the only one `proxy.ts` does not gate — it has to stay reachable while
 * signed out, or logging in would redirect to the login page forever.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);
