/**
 * The payload Akahu last gave us for one entity.
 *
 *   money akahu show acc_cll36gzlz000o08jme90napwb
 *   money akahu show trans_cmu4ruo5g02rk02lb4gkf6w7q --diff
 *
 * `--diff` is the one worth knowing about: it lists the payload keys that no
 * column of ours reflects. That is the report which would have surfaced
 * `_migrated` — the field that identifies an account's predecessor across an
 * open-banking migration — years before anyone needed it, instead of after a
 * duplicate bank connection had already been double-counting for a month.
 */
import { Command } from "commander";

import { resolveWorkspace } from "../../lib/membership";
import { onExit } from "../../runtime";

type Opts = { workspace: string; diff?: boolean };

/**
 * Which payload keys each entity type already has a home for.
 *
 * Hand-written rather than derived from the Prisma model: the mapping is not
 * name-for-name (`_account` lands in `accountId`, `meta.particulars` in
 * `particulars`), so a reflection over the columns would report keys as missing
 * that are merely spelt differently, and the report would be noise.
 */
const MIRRORED: Record<string, Set<string>> = {
  account: new Set([
    "_id", "_migrated", "name", "status", "type", "formatted_account", "connection",
    "meta", "attributes", "balance", "refreshed", "_authorisation", "_credentials", "_user",
  ]),
  transaction: new Set([
    "_id", "_migrated", "_account", "_connection", "_user", "date", "description", "amount",
    "balance", "type", "hash", "merchant", "category", "meta", "created_at", "updated_at",
  ]),
  connection: new Set(["_id", "name", "logo", "connection_type"]),
};

export function register(parent: Command): void {
  parent
    .command("show <entityId>")
    .description("The payload Akahu last gave us for an account, transaction or connection")
    .requiredOption("--workspace <slug|id>", "which workspace")
    .option("--diff", "list only the payload keys no column of ours reflects")
    .addHelpText(
      "after",
      `
Reads the AkahuRecord archive, not Akahu — no network, no token. A payload
appears here once a sync has touched that entity, so history older than the
archive will not be present until a "money sync --full" reaches it.
`,
    )
    .action(run);
}

async function run(entityId: string, opts: Opts) {
  // `catalogDb` purely as a teardown handle; the control-plane lookup belongs to
  // `resolveWorkspace`. Registered before the first query so a throw still closes.
  const { catalogDb, scopedDb } = await import("../../../lib/server/db");
  onExit(() => catalogDb.$disconnect());

  const workspace = await resolveWorkspace(opts.workspace);
  const db = scopedDb(workspace.id);

  const record = await db.akahuRecord.findFirst({ where: { entityId } });
  if (!record) {
    throw new Error(
      `Nothing archived for "${entityId}" in ${workspace.slug}. A payload lands ` +
        `when a sync touches the entity: money sync --workspace ${workspace.slug} --full`,
    );
  }

  const payload = record.payload as Record<string, unknown>;

  if (!opts.diff) {
    console.log(`${record.entityType}  ${record.entityId}`);
    console.log(`fetched ${record.fetchedAt.toISOString()}${record.syncRunId ? `  run ${record.syncRunId}` : ""}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const mirrored = MIRRORED[record.entityType];
  if (!mirrored) {
    throw new Error(`--diff does not know the shape of a "${record.entityType}" payload yet.`);
  }

  const unmirrored = Object.keys(payload).filter((key) => !mirrored.has(key));
  console.log(`${record.entityType}  ${record.entityId}`);
  if (unmirrored.length === 0) {
    console.log("Every key in this payload has a column. Nothing is being dropped.");
    return;
  }
  console.log(`${unmirrored.length} key(s) Akahu sends that no column keeps:`);
  for (const key of unmirrored) {
    console.log(`  ${key} = ${JSON.stringify(payload[key])}`);
  }
}
