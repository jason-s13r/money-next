/**
 * Every command this repo has, grouped, with a line each on when to reach for it.
 *
 *   pnpm help:commands
 *
 * The names alone are not the useful part. `pnpm run` already lists those, and so
 * does package.json — what neither answers is which of `db:migrate`, `db:deploy`
 * and `db:setup` you want in front of you right now, or that `user:password` is
 * the way back in when nobody can sign in. Every script under scripts/ opens with
 * a paragraph saying exactly that; this is the index to them.
 *
 * The descriptions are written here rather than parsed out of those headers. A
 * one-line summary and a file's opening sentence are different things — several
 * of those sentences run two lines and none of them is phrased for a column of
 * fifteen — and a parser would tie the help output to comment formatting.
 *
 * Drift is fenced by tests/help.test.ts instead: it fails when a script is added
 * to package.json with no line here, which is the only way this file goes stale.
 */

// Every import here is dynamic: a file with no static import or export is not
// a module.
export {};
import { readFileSync } from "node:fs";

import { runScript } from "./_bootstrap";

/** In display order. Everything before the first `:` is the group. */
export const GROUPS: { prefix: string; title: string }[] = [
  { prefix: "", title: "Development" },
  { prefix: "db", title: "Database" },
  { prefix: "worker", title: "Worker" },
  { prefix: "user", title: "Users" },
  { prefix: "workspace", title: "Workspaces" },
  { prefix: "email", title: "Email queue" },
  { prefix: "link", title: "Bank links" },
  { prefix: "help", title: "Help" },
];

/**
 * One line each, in the imperative. Exported so the test can check this covers
 * package.json rather than re-deriving the list.
 */
export const DESCRIPTIONS: Record<string, string> = {
  dev: "Run the app locally with hot reload",
  build: "Production build (standalone output)",
  start: "Serve a build made by `build`",
  lint: "ESLint",
  typecheck: "Types only, no emit",
  test: "The whole suite",

  "db:up": "Start local Postgres in Docker",
  "db:down": "Stop it",
  "db:generate": "Regenerate the Prisma client after a schema edit",
  "db:migrate": "Author a migration from schema changes, and apply it (dev)",
  "db:deploy": "Apply pending migrations without authoring one (prod)",
  "db:roles": "Give the least-privileged RLS roles a login and password",
  "db:setup": "`db:deploy` then `db:roles` — what a fresh database needs",
  "db:studio": "Prisma's table browser",

  "worker:sync": "Queue an Akahu sync for every active bank link, now",
  "worker:start": "Drain the queues — syncs, rules, budget inference, email — forever",

  "user:create": "Create an account. The only way one comes into being",
  "user:list": "Every account, its workspaces, and whether it has a second factor",
  "user:delete": "Delete an account (not the workspaces it owns)",
  "user:rename": "Change a display name",
  "user:password": "Set a password from the shell, for someone locked out",

  "workspace:create": "Create a workspace and its first owner",
  "workspace:list": "Every tenant, its members, and where its bank credentials come from",
  "workspace:member": "Put an existing user into an existing workspace",
  "workspace:delete": "Delete a workspace and all its financial data",

  "email:list": "Queued and failed messages, with the reason each one failed",
  "email:retry": "Requeue failed messages after fixing whatever broke",
  "email:clear-failed": "Delete failed messages",

  "link:token": "Store an Akahu token on a bank link, encrypted",
  "link:keypair": "Generate the keypair that lets the app store a token it cannot read",
  "link:upgrade": "Re-encrypt stored tokens to the sealed scheme",

  "unhook-bootstrap-ids": "One-shot: retire the bootstrap rows' placeholder ids",

  "help:commands": "This list",
};

/**
 * Not shown. `postinstall` is npm's to call, not yours, and the two aliases exist
 * only so an old command in someone's notes prints a redirect instead of "command
 * not found" — listing them would advertise the thing they are retiring.
 */
export const HIDDEN = new Set(["postinstall", "db:sync", "db:worker"]);

/**
 * The bare-named commands that belong under Development. Listed rather than
 * inferred from "has no colon", because `unhook-bootstrap-ids` has no colon
 * either and is not a development command — it is a one-shot migration, and it
 * belongs under Other with anything else that arrives unnamespaced.
 */
const DEVELOPMENT = new Set(["dev", "build", "start", "lint", "typecheck", "test"]);

/** The group a script belongs to: its namespace, or "" for a bare name. */
function groupOf(name: string): string {
  const colon = name.indexOf(":");
  if (colon !== -1) return name.slice(0, colon);
  return DEVELOPMENT.has(name) ? "" : "other";
}

async function main() {
  const root = new URL("..", import.meta.url).pathname;
  const { scripts } = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
    scripts: Record<string, string>;
  };

  const names = Object.keys(scripts).filter((name) => !HIDDEN.has(name));
  const width = Math.max(...names.map((name) => name.length)) + 2;

  for (const { prefix, title } of GROUPS) {
    const inGroup = names.filter((name) => groupOf(name) === prefix);
    if (inGroup.length === 0) continue;

    console.log(`\n${title}`);
    for (const name of inGroup) {
      // A script with no line here still prints, rather than vanishing from the
      // help because someone forgot to describe it. The test is what makes that
      // loud; this just keeps the output honest in the meantime.
      console.log(`  ${name.padEnd(width)}${DESCRIPTIONS[name] ?? "(undescribed)"}`);
    }
  }

  // Anything whose namespace is not in GROUPS — a new one, or a one-shot like
  // `unhook-bootstrap-ids`. Printed last rather than dropped.
  const known = new Set(GROUPS.map((group) => group.prefix));
  const rest = names.filter((name) => !known.has(groupOf(name)));
  if (rest.length > 0) {
    console.log("\nOther");
    for (const name of rest) {
      console.log(`  ${name.padEnd(width)}${DESCRIPTIONS[name] ?? "(undescribed)"}`);
    }
  }

  console.log("\nRun any of these with `pnpm <name>`. Most take `--help`.");
}

runScript(main);
