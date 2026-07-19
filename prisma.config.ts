import { defineConfig, env } from "@prisma/config";

// Prisma 7 no longer loads `.env` automatically. Node's built-in loader is
// enough here; `next dev` loads `.env` itself, so this only matters for the CLI.
// The file is optional: in a container there is no `.env` — the environment is
// already the environment — and `loadEnvFile` throws on a missing file rather
// than returning, so the absence is swallowed here on purpose.
try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env; rely on the ambient environment (containers, CI).
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `pnpm db:up` starts the local Postgres this points at by default.
    url: env("DATABASE_URL"),
  },
});
