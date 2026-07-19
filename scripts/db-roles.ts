/**
 * Grants LOGIN + a password to the RLS runtime roles.
 *
 *   pnpm db:roles           # after `prisma migrate deploy`
 *   pnpm db:setup           # migrate deploy + this, in one step
 *
 * The `20260718000000_rls_backstop` migration creates `money_app` and
 * `money_sync` NOLOGIN and passwordless on purpose — a credential does not
 * belong in a committed migration. This is the second half: it reads the two
 * passwords from the environment and sets them, so the app and cron can actually
 * connect as their least-privileged, RLS-bound roles. Runs as the owner
 * (`DATABASE_URL`), the only role that may ALTER another.
 *
 * Idempotent: re-running just re-sets the same passwords. Run it whenever the
 * passwords rotate.
 *
 * Not folded into the migration or a server path because it needs secrets the
 * migration must not carry and the app must not hold the privilege to grant.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../lib/generated/prisma/client";

const ROLES = [
  { role: "money_app", env: "APP_DB_PASSWORD" },
  { role: "money_sync", env: "SYNC_DB_PASSWORD" },
] as const;

/**
 * ALTER ROLE ... PASSWORD is a utility statement and cannot be parameterised, so
 * the password goes in as a literal. Postgres string literals escape a single
 * quote by doubling it; with standard_conforming_strings on (the default)
 * backslashes are ordinary, so that is the whole escape. A NUL can't appear in a
 * literal at all — reject it rather than truncate silently.
 */
function sqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("password contains a NUL byte");
  return `'${value.replace(/'/g, "''")}'`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (the owner connection).");

  const missing = ROLES.filter(({ env }) => !process.env[env]);
  if (missing.length > 0) {
    throw new Error(
      `Missing password env for the runtime roles: ${missing.map((m) => m.env).join(", ")}. ` +
        `Set them (see .env.example) before running db:roles.`,
    );
  }

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    for (const { role, env } of ROLES) {
      const password = process.env[env]!;
      await db.$executeRawUnsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${sqlLiteral(password)}`);
      console.log(`${role}: login enabled, password set from ${env}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
