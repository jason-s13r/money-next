import type { NextConfig } from "next";

// A plain-http deployment (a trusted LAN with no TLS). Kept in step with the
// same read in proxy.ts, which drops `upgrade-insecure-requests` from the CSP.
const INSECURE_HTTP = process.env.INSECURE_HTTP === "1" || process.env.INSECURE_HTTP === "true";

const nextConfig: NextConfig = {
  // Traced, minimal server output for the container image (see Dockerfile). This
  // copies only the server plus the node_modules actually reached — but NOT
  // `public/` or `.next/static`, which the Dockerfile copies in by hand. The
  // `@gorules/zen-engine` `.node` binary below is traced rather than bundled, so
  // it must survive into `.next/standalone`; the Docker build verifies it does.
  output: "standalone",

  // `@gorules/zen-engine` is a native (napi-rs) addon: it must be loaded with
  // Node's own `require`, not bundled into the Server Components graph, or the
  // `.node` binary can't be resolved at runtime. Since better-sqlite3 was
  // dropped for Postgres, this is the only native module left in the app.
  serverExternalPackages: ["@gorules/zen-engine"],

  // The Content-Security-Policy is *not* here: it carries a per-request nonce,
  // so it is built in proxy.ts. These two are static, and belong on every
  // response including static assets, which the proxy's matcher skips.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app is a dashboard over someone's bank history: it should never
          // appear as a referrer anywhere, and its URLs carry account and
          // transaction ids.
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Pin HTTPS for one year in production. Gated on the env so the
          // `INSECURE_HTTP` dev/test path (a plain-HTTP container on localhost)
          // does not send a header that would lock a browser to a scheme the
          // next request cannot use. Both spellings are accepted because this
          // gate and proxy.ts's CSP gate must agree — a deployment that dropped
          // `upgrade-insecure-requests` but still got HSTS would be unreachable.
          ...(process.env.NODE_ENV === "production" && !INSECURE_HTTP
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
          // A finance app has no legitimate use of camera, microphone, or
          // geolocation. Deny them at the browser level rather than relying on
          // the app never asking — cheap defense-in-depth.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
