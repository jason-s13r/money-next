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
    // `scopedDb(id)` outside one, and `catalogDb` for shared reference data.
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
