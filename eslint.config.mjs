import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Unused locals/imports are dead weight — fail on them. (Underscore-prefixed
    // names are the opt-out for deliberately-ignored bindings.) Note this catches
    // unused *locals*, not unused *exports*, which the linter can't see across
    // module boundaries.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The back door, closed.
    //
    // `lib/server/db/client.ts` exports the unscoped Prisma client: every query
    // through it reads every workspace's rows. Tenant isolation rests on that
    // client being unreachable, so reaching for it is a lint error rather than a
    // code-review question. The public entry points are `getDb()` in a request,
    // `scopedDb(id)` outside one, `catalogDb` for shared reference data, and
    // `authDb` for the auth layer's control plane.
    //
    // The named doors are not all equal, and the linter can't say so: `authDb`
    // is the raw client too. What keeps *it* narrow is an inventory in
    // tests/isolation.test.ts, which fails when a file outside the auth layer
    // uses it.
    //
    // Deliberately not scoped to a directory allowlist: lib/server/db/'s own
    // files are exempted below, and everything else — app code, scripts, tests —
    // has a legitimate alternative.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["lib/server/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/client", "**/lib/server/db/client"],
              message:
                "Don't import the unscoped Prisma client: it reads every workspace's data. " +
                "Use getDb() in a request, scopedDb(workspaceId) outside one, or catalogDb " +
                "for shared reference data (see lib/server/db/index.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    // The other direction, which phase 3 discovered the hard way.
    //
    // `lib/server/db/` is imported by scripts/ingest.ts, which runs in plain
    // Node with no request and no session. When `getDb()` briefly lived in
    // db/index.ts and reached for `requireWorkspace()`, that made a bank sync
    // depend on `server-only` resolving and on BETTER_AUTH_SECRET being set —
    // and made the import graph circular, since the auth layer imports `authDb`
    // from db/. The database layer knows nothing about who is asking; db/request
    // is where the two meet, and it is the one file exempt below.
    files: ["lib/server/db/**"],
    ignores: ["lib/server/db/request.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/auth", "**/auth/*"],
              message:
                "The database layer must not import the auth layer: scripts/ingest.ts imports " +
                "it and has no session. The request-scoped client lives in lib/server/db/request.ts.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
