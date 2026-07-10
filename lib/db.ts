import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";

// Deliberately no `import "server-only"` here: this module is also imported by
// scripts/ingest.ts, which runs in plain Node where `server-only` throws.
// The server-only guard lives in lib/data.ts instead.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
}

function createClient() {
  // The adapter strips the `file:` prefix and passes the rest to SQLite, so a
  // relative url resolves against process.cwd(). Run everything from the repo root.
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl! });
  return new PrismaClient({ adapter });
}

// `next dev` re-evaluates modules on every HMR pass; without this the process
// accumulates a new SQLite connection per edit.
const globalForDb = globalThis as unknown as { db?: ReturnType<typeof createClient> };

export const db = globalForDb.db ?? createClient();

if (process.env.NODE_ENV !== "production") globalForDb.db = db;
