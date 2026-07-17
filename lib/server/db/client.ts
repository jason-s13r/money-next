import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

// The unscoped Prisma client. Internal to this directory on purpose.
//
// Nothing outside lib/server/db/ may import this — an ESLint rule enforces it
// (see eslint.config.mjs). It has no idea what a workspace is, so every query
// made through it reaches every tenant's rows. The public entry point is
// `scopedDb(workspaceId)` from ./scoped: this client with the tenancy filter
// welded on.
//
// The paths that legitimately have no workspace to scope to — the catalog syncs
// (NZFCC categories, ECB rates) and the throwaway SQLite importer — reach it
// through ./index's `catalogDb`, which is this same client under a name that
// says why.
//
// Deliberately no `import "server-only"` here: this module is also imported by
// scripts/ingest.ts, which runs in plain Node where `server-only` throws.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

function createClient() {
  // The adapter owns a `pg` connection pool. A serverless deployment must point
  // DATABASE_URL at a pooler rather than the database directly, or concurrent
  // functions will exhaust Postgres' connection limit.
  const adapter = new PrismaPg({ connectionString: databaseUrl! });
  return new PrismaClient({ adapter });
}

// `next dev` re-evaluates modules on every HMR pass; without this the process
// accumulates a new connection pool per edit.
const globalForDb = globalThis as unknown as { db?: ReturnType<typeof createClient> };

export const internalDb = globalForDb.db ?? createClient();

if (process.env.NODE_ENV !== "production") globalForDb.db = internalDb;
