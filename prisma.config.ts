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
    // `pnpm db:up` starts the local Postgres this points at by default.
    url: env("DATABASE_URL"),
  },
});
