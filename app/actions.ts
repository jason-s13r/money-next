"use server";

import { revalidatePath } from "next/cache";
import { akahuClient, akahuUserToken } from "@/lib/server/akahu";
import { runSync } from "@/lib/server/ingest/sync";
import { db } from "@/lib/server/db";

/**
 * Ask Akahu to refresh all connected accounts, then run a local incremental sync.
 *
 * This is the manual counterpart to the cron-driven `pnpm db:sync`. It is safe
 * to call repeatedly: Akahu's refresh is idempotent for a given connection, and
 * the ingest upserts every row on its Akahu id.
 */
export async function refreshAndSync() {
  const akahu = akahuClient();
  await akahu.accounts.refreshAll(akahuUserToken());
  await runSync({ full: false });
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/sync");
}

/**
 * Run a full historical sync and record it as a `SyncRun`, just like the cron
 * script does. This can take a while, so it is offered as an explicit action
 * rather than running on every page load.
 */
export async function fullSync() {
  const run = await db.syncRun.create({ data: {} });

  try {
    const akahu = akahuClient();
    await akahu.accounts.refreshAll(akahuUserToken());
    await runSync({ full: true });

    await db.syncRun.update({
      where: { id: run.id },
      data: { status: "success", finishedAt: new Date() },
    });
  } catch (error) {
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  // Deliberately no `db.$disconnect()` here. This runs inside the server, where
  // the client is shared by every request — disconnecting it would tear down the
  // connection pool under whatever else is mid-flight. Only a script that owns
  // its process should disconnect (see scripts/ingest.ts).

  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/sync");
}
