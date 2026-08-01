import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Four jobs, all deliberately dumb.
 *
 * Next 16 renamed middleware to Proxy; the guidance is unchanged and worth
 * restating, because it is load-bearing: **this is not the authorization
 * layer**. It runs before the request, it cannot be trusted to have looked at
 * the database, and a check here is at best a redirect that saves a round trip.
 * The real check lives in the data access layer — `requireWorkspace()` in
 * lib/server/auth/session.ts, reached by every query through `getDb()`.
 *
 * 1. **Copy the workspace slug out of the path into a header.** Server actions
 *    never receive route params, but they POST to the page's own URL, so the
 *    path is the one place both a page and its actions can be read from. See
 *    `WORKSPACE_SLUG_HEADER` for why an untrusted header is a fine way to carry
 *    it: it names a workspace, it does not grant one.
 *
 * 2. **Optimistically redirect to /login when there is no session cookie.**
 *    This only checks that a cookie *exists* — `getSessionCookie` does not
 *    validate it, and must not be mistaken for proof of anything. A forged
 *    cookie gets past this and then dies at the DAL, which is the design. It is
 *    here so a signed-out visitor gets a login page instead of a flash of
 *    layout, and nothing more.
 *
 * 3. **Mint a CSP nonce and set the policy.** See `csp()` below.
 *
 * 4. **Remember which workspace you were last in.** See `LAST_WORKSPACE_COOKIE`.
 */

/** Keep in sync with `WORKSPACE_SLUG_HEADER` in lib/server/auth/session.ts. */
const WORKSPACE_SLUG_HEADER = "x-workspace-slug";

/**
 * Where you were, so `/` can put you back.
 *
 * `/` is a signpost that redirects into a workspace, and with nothing to go on it
 * picked the first one alphabetically. For anyone in more than one workspace that
 * made leaving the app — /account, /enrol-mfa, the wordmark in either sidebar —
 * a way to lose your place: you came out of "Work" and went back into "Alpha".
 *
 * This is a preference, not a credential. `app/page.tsx` reads it and then looks
 * it up in *your* memberships, so a forged or stale value redirects you to a
 * workspace you already belong to or is ignored entirely — it names a workspace,
 * it does not grant one, exactly like the slug header above. `httpOnly` anyway:
 * nothing on the client has a use for it.
 */
const LAST_WORKSPACE_COOKIE = "last-workspace";
const LAST_WORKSPACE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

/**
 * Paths reachable without a session. Everything else needs one.
 *
 * `/invite/…` is here, and the reasoning is worth writing down because an earlier
 * version of this comment got it wrong. It claimed an invitee could bounce
 * through /login and return via `?next=`, on the grounds that accepting requires
 * a session whose email matches the invite. The email check is real — but it
 * assumes the invitee *has an account to sign in with*, and the whole point of an
 * invite is usually that they don't. Bouncing them to /login sent the one person
 * the link was for to a form they could not fill in.
 *
 * So the page is public, and it is where the account is created (option A in
 * docs/multi-user.md's open questions). That makes the link a bearer credential
 * until it is used: whoever holds it can create one account, at the address the
 * owner typed, once, inside three days. app/invite/[id]/page.tsx accounts for
 * that honestly, and T12 has been corrected to match. Being public costs nothing
 * extra — every check that matters is in the page and the action, not here.
 *
 * `/reset-password` is public for the same reason and carries the same bearer
 * property, narrower still: the person following a reset link is the one who
 * *cannot* sign in, so bouncing them to /login would be the invite bug again.
 * The token in the link is the authority, it is single-use and expires in an
 * hour, and Better Auth validates it in the action — not here.
 */
const PUBLIC_PATHS = ["/login", "/enrol-mfa", "/invite", "/reset-password"];

/**
 * The Content-Security-Policy, with a fresh nonce per request.
 *
 * This lives here rather than in `next.config.ts` because a nonce cannot be
 * static. Next reads the `nonce-…` back out of this header during rendering and
 * stamps it onto its own scripts, so nothing has to be annotated by hand.
 *
 * It only works on a **dynamically rendered** page: a static one is built when
 * there is no request, so there is no nonce to mint. Every page here qualifies,
 * but by accident rather than design — they all reach `requireUser()` or
 * `requireWorkspace()`, which read cookies and headers, and reading either opts
 * a page into dynamic rendering. The one page that reached neither was the 404,
 * and it broke exactly this way; app/not-found.tsx now awaits `connection()` to
 * force the issue. If a page is ever added that touches no request data, it
 * needs the same treatment. `next build` names the ones at risk: anything marked
 * `○` rather than `ƒ`.
 *
 * ## The bug this replaces, because it is a good lesson
 *
 * The first version set `default-src 'self'` and left `script-src` out, with a
 * comment claiming scripts were deliberately unpoliced. That is not how CSP
 * works: **`default-src` is the fallback for `script-src`**, so leaving it out
 * silently policed scripts with `'self'` — which blocks Next's inline bootstrap.
 * No bootstrap meant no hydration, which meant no client-side navigation, and
 * meant the login form's `onSubmit` never ran: the browser fell back to a native
 * submit, and since a `<form>` with no method GETs, **the password went into the
 * URL**. One wrong assumption about a fallback directive, and the failure landed
 * three layers away as a credential in the address bar.
 *
 * `img-src` is the line with a specific threat behind it (T22): logos arrive
 * from Akahu as URLs and render as raw `<img src={row.logo}>`. Every logo in the
 * real database is on `cdn.akahu.nz` — checked, not assumed — so the allowlist is
 * exact.
 */
function csp(nonce: string) {
  const dev = process.env.NODE_ENV === "development";
  // Set INSECURE_HTTP=1 for a plain-http deployment (e.g. on a trusted LAN with
  // no TLS). It drops `upgrade-insecure-requests` below, which would otherwise
  // rewrite every subresource to https:// and fail against an http-only origin.
  // `true` is accepted as well, because next.config.ts gates HSTS on the same
  // variable and the two must never disagree about what it says.
  const insecureHttp =
    process.env.INSECURE_HTTP === "1" || process.env.INSECURE_HTTP === "true";

  return [
    "default-src 'self'",
    // `strict-dynamic` lets the nonce'd bootstrap load the chunks it needs
    // without naming each one; it also makes browsers ignore `'self'` here, which
    // is the point — an injected <script src> is not trusted just for being
    // same-origin. Dev needs `unsafe-eval` because React uses eval to rebuild
    // server stacks in the browser; production does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Dev injects inline styles for HMR that carry no nonce.
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // Inline `style=""` *attributes* — set dynamically by React and shadcn: the
    // chart SVGs' `fill`/`stroke`, stat-tile/meter/legend colors, the sidebar's
    // `--sidebar-width`. A nonce can only ever whitelist a `<style>` *element*,
    // never a style *attribute*, so those answer to `style-src-attr` instead and
    // were all being blocked. This is a deliberately narrow relaxation: it opens
    // style *attributes* only, leaving `<style>`/`<link>` stylesheets nonce-bound
    // via `style-src` above. A URL inside a style (e.g. `background:url()`) still
    // has to clear img-src, so this does not reopen a CSS-exfiltration path.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https://cdn.akahu.nz",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only in production, and only over https: dev is served over plain http on
    // localhost, and a LAN deployment may be too (INSECURE_HTTP=1). In either
    // case upgrading subresource requests to https breaks them.
    ...(dev || insecureHttp ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Base64, because a CSP nonce-value is defined as base64 — a raw UUID's
  // hyphens are outside that alphabet, and leaning on browsers being lenient
  // about it is not a thing to lean on. `btoa` rather than `Buffer` so this does
  // not care whether the proxy runs on the Node or edge runtime.
  const nonce = btoa(crypto.randomUUID());
  const policy = csp(nonce);

  const headers = new Headers(request.headers);
  // Next parses the nonce back out of this request header while rendering.
  headers.set("Content-Security-Policy", policy);
  headers.set("x-nonce", nonce);

  // Unconditionally, before anything else: whatever the client sent under this
  // name is gone. The value is set below from the path alone, so a request can
  // never smuggle one in. (It would be harmless if it did — the membership check
  // would reject it — but a header that is sometimes ours and sometimes the
  // caller's is the kind of thing that becomes a bug later.)
  headers.delete(WORKSPACE_SLUG_HEADER);

  const workspace = pathname.match(/^\/w\/([^/]+)/)?.[1];
  if (workspace) headers.set(WORKSPACE_SLUG_HEADER, decodeURIComponent(workspace));

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isPublic && !getSessionCookie(request)) {
    const login = new URL("/login", request.url);
    // So the user lands where they were headed once they're in. Only ever a
    // path on this origin — `next` is read back through a same-origin check
    // (lib/safe-next.ts), never used to build an absolute URL.
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  const response = NextResponse.next({ request: { headers } });
  // And on the way out, for the browser to actually enforce. Both are needed:
  // the request header is how Next learns the nonce, this is how the browser
  // learns the policy.
  response.headers.set("Content-Security-Policy", policy);

  // Only when it changed: every navigation inside a workspace comes through here,
  // prefetches included, and re-sending an identical Set-Cookie on all of them is
  // a header on every response to say nothing new.
  if (workspace) {
    const slug = decodeURIComponent(workspace);
    if (request.cookies.get(LAST_WORKSPACE_COOKIE)?.value !== slug) {
      response.cookies.set(LAST_WORKSPACE_COOKIE, slug, {
        httpOnly: true,
        sameSite: "lax",
        // Not `secure` unconditionally: dev is plain http on localhost and a LAN
        // deployment may be too (INSECURE_HTTP=1), and a secure cookie over http
        // is a cookie the browser drops.
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: LAST_WORKSPACE_MAX_AGE,
      });
    }
  }

  return response;
}

export const config = {
  // Everything except Next's own assets and the auth endpoints themselves —
  // `/api/auth/*` must stay reachable while signed out, or logging in would
  // redirect to the login page forever.
  //
  // Next's CSP guide suggests also excluding `next/link` prefetches. **Don't**:
  // this proxy's other job is the workspace header, and a prefetch of
  // `/w/<slug>/…` that skipped it would resolve no workspace and 404. The nonce
  // on a prefetched RSC payload is unused, which is harmless; a prefetch that
  // 404s is not.
  // The app-icon and manifest file conventions (app/favicon.ico, app/icon.png,
  // app/apple-icon.png, app/manifest.ts) plus the manifest's own referenced icons
  // (the android-chrome PNGs in public/) are public static assets — a browser
  // requests them for the tab and home screen without a session, so they skip the
  // proxy exactly as `favicon.ico` does rather than redirect to /login.
  // `img` is the image optimizer, renamed from `_next/image` by `images.path` in
  // next.config.ts and rewritten back before the filesystem check. It is excluded
  // for the same reason `_next/image` was: a nonce'd CSP on an image response
  // says nothing, and a logo request without a session would 307 to /login rather
  // than fail visibly. (Prefix match, as every entry here is — there is no other
  // route starting `img`.)
  //
  // `merchant-default.png` is the logo placeholder (lib/ui/logo.ts). It must be
  // listed even though it is only ever rendered to a signed-in reader, because
  // the optimizer fetches it back over this origin: left in, the fetch answered
  // with the /login redirect and the optimizer returned 400 "not a valid image"
  // for every logo-less merchant.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|img|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest|android-chrome-|merchant-default.png).*)",
  ],
};
