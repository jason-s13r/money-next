"use server";

import { requireRole } from "@/lib/server/auth/session";
import { withScopedTx } from "@/lib/server/db";
import { getDb } from "@/lib/server/db/request";
import { enqueueSync } from "@/lib/server/queue";
import { hasSealKey, sealSecret, tokenAad } from "@/lib/server/seal";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { text } from "@/lib/form-data";
import { NOT_SAVED, type ConnectBankState } from "./types";

/**
 * Connect a bank by pasting a personal Akahu token pair.
 *
 * `pnpm link:token` remains the operator path and is still the better one — it
 * verifies the pair against Akahu and shows which accounts it can see before
 * storing anything, which is the only check that catches a token for the *wrong*
 * Akahu account (that authenticates fine and quietly ingests somebody else's
 * transactions into this workspace). This form cannot do that: since phase 7 the
 * web role does not call Akahu at all. What it does instead is queue a sync
 * immediately, so the answer arrives seconds later on the page the form is on,
 * attributed to the thing that was just done rather than to a cron run at 3am.
 *
 * The token is sealed to a public key (lib/server/seal.ts), not encrypted with
 * the symmetric one: the app must be able to *write* a credential it can never
 * *read*. That distinction is the reason this page can exist at all — see the
 * comment on the blanked TOKEN_ENCRYPTION_KEY in compose.prod.yaml, which is
 * where the alternative was rejected.
 */
export async function connectBank(
  _prev: ConnectBankState,
  formData: FormData,
): Promise<ConnectBankState> {
  // `bankLink: ["create"]` is owner-only (lib/server/auth/roles.ts): it is the
  // workspace's relationship with Akahu, not an edit to its data. A server action
  // is a public POST endpoint, so this is the control — the form being hidden
  // from editors is not (T9).
  const ctx = await requireRole({ bankLink: ["create"] });

  const name = text(formData, "name");
  if (!name) return fail("Give this connection a name.");

  const pair = readPair(formData);
  if ("error" in pair) return pair;

  const db = await getDb();

  // The form only renders when there are none, but the endpoint does not know
  // that. Two ACTIVE links pointing at the same Akahu account contend over the
  // same transactions on every sync — the CLI warns and continues because an
  // operator can weigh it, which nobody can do against a double-submitted form.
  if ((await db.bankLink.count({ where: { status: "ACTIVE" } })) > 0) {
    return fail("This workspace already has a bank connected.");
  }

  // The database mints the id, and each blob is bound to it as additional
  // authenticated data — so the row must exist before the tokens can be sealed.
  // Both statements in one transaction, exactly as `pnpm link:token` does it: a
  // failure between them would otherwise leave a link claiming `stored` with
  // nothing stored, which fails hours later as a sync error.
  const link = await withScopedTx(db, async (tx) => {
    const created = await tx.bankLink.create({
      data: {
        workspaceId: ctx.workspace.id,
        name,
        // Unlike the CLI path, somebody really did click something, and this is
        // the column that records who. It is what a future revoke surface shows,
        // and the reason the CLI leaves it null rather than inventing a user.
        connectedByUserId: ctx.user.id,
      },
    });

    await tx.bankLink.update({ where: { id: created.id }, data: sealedFields(created.id, pair) });

    return created;
  });

  // The verification the app cannot do itself. The worker opens the sealed pair,
  // calls Akahu and finalises the run; the page auto-refreshes while anything is
  // in flight, so a bad token shows up as a failed run with Akahu's own message
  // rather than as silence until the next scheduled sync.
  await enqueueSync(db, { bankLinkId: link.id, clearBackoff: true });

  await revalidateWorkspacePath("/sync");
  return { error: null, saved: true };
}

/**
 * Replace an existing link's token pair.
 *
 * The counterpart `connectBank` needed and did not have. Because that action
 * refuses when a link already exists — rightly, two links contending over one
 * Akahu account is not something a double-submitted form should be able to
 * cause — the *first* version of this page had a trap in it: paste a token
 * wrong, and the link is created, the form disappears, every sync fails
 * authentication, and the only way to correct a typo is a shell on the host.
 * The failure mode a self-hoster is most likely to hit was the one with no
 * in-app answer.
 *
 * So the pair is replaceable, and deliberately without a "are you sure": there
 * is nothing to lose. A stored token is write-only from here (the app cannot
 * read one back), the ciphertext being overwritten is by hypothesis the one
 * that does not work, and the ingested history hangs off the link row, which
 * this does not touch.
 */
export async function replaceBankTokens(
  _prev: ConnectBankState,
  formData: FormData,
): Promise<ConnectBankState> {
  await requireRole({ bankLink: ["create"] });

  const linkId = text(formData, "linkId");
  if (!linkId) return fail("Which connection?");

  const pair = readPair(formData);
  if ("error" in pair) return pair;

  const db = await getDb();

  // Read through the scoped client, so `linkId` can only ever name a link in
  // *this* workspace — the id comes from a form field, and a form field is never
  // honest by assumption. A link belonging to someone else is indistinguishable
  // from one that does not exist, which is the correct answer to both.
  const link = await db.bankLink.findFirst({ where: { id: linkId }, select: { id: true } });
  if (!link) return fail("That connection no longer exists — reload the page.");

  await db.bankLink.update({ where: { id: link.id }, data: sealedFields(link.id, pair) });

  // `clearBackoff`, because this is the same explicit override the Sync button
  // makes: a link that has been failing is sitting out an exponential retry
  // wait, and somebody who just pasted a new token should not be told to come
  // back in an hour. Without this the fix looks like it did nothing.
  await enqueueSync(db, { bankLinkId: link.id, clearBackoff: true });

  await revalidateWorkspacePath("/sync");
  return { error: null, saved: true };
}

type Pair = { appToken: string; userToken: string };

/**
 * The pasted pair, validated — or the state to render instead.
 *
 * Shared by both actions because both are one paste away from the same three
 * mistakes, and the third of them is worth the special case: the two fields are
 * indistinguishable to anyone who has not read Akahu's docs, and swapping them
 * stores cleanly and then fails every sync with an authentication error that
 * names neither field. Checked by prefix rather than by full format — an
 * unfamiliar token shape should be stored and tried, not refused by us.
 */
function readPair(formData: FormData): Pair | ConnectBankState {
  const appToken = text(formData, "appToken");
  const userToken = text(formData, "userToken");

  if (!appToken || !userToken) return fail("Both tokens are required.");
  if (appToken.startsWith("user_token") || userToken.startsWith("app_token")) {
    return fail("Those look swapped — the app token goes in the first field.");
  }

  // Checked before the paste is treated as usable, not at the write: `pnpm
  // link:token` checks its key up front for the same reason, so that a
  // misconfigured instance does not make someone hand over a bank credential
  // for nothing.
  if (!hasSealKey()) {
    return fail(
      "This instance has no TOKEN_PUBLIC_KEY set, so a token cannot be stored safely. " +
        "Whoever runs it needs to generate one with `pnpm link:keypair`.",
    );
  }

  return { appToken, userToken };
}

/** A link's token columns, sealed and bound to that row id. */
function sealedFields(linkId: string, pair: Pair) {
  return {
    tokenSource: "stored",
    appTokenCipher: sealSecret(pair.appToken, tokenAad(linkId, "appToken")),
    userTokenCipher: sealSecret(pair.userToken, tokenAad(linkId, "userToken")),
    tokenUpdatedAt: new Date(),
  };
}

function fail(error: string): ConnectBankState {
  return { ...NOT_SAVED, error };
}
