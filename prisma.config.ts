import { defineConfig, env } from "@prisma/config";

// Prisma 7 no longer loads `.env` automatically. Node's built-in loader is
// enough here; `next dev` loads `.env` itself, so this only matters for the CLI.
process.loadEnvFile?.(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // NOTE: the better-sqlite3 adapter strips the `file:` prefix and hands the
    // rest to SQLite, so this path resolves relative to `process.cwd()` — not
    // to this file. Always run prisma/scripts from the project root.
    url: env("DATABASE_URL"),
  },
});
