// Queuing mail. The web app's half of sending an email, and all of it.
//
// The app composes a message and writes it here; the `money_sync` worker delivers
// it. That is the same arrangement the Akahu tokens have, for the same reason —
// an SMTP credential that can send mail as this domain has no business in the
// internet-facing process — and it has a second half that the tokens do not: the
// app is revoked SELECT on this table, so it cannot read back a queue full of live
// invite and reset links. Hence one exported function, and no reader anywhere.
//
// `authDb` rather than a scoped client: an outbox row has no workspace. A password
// reset belongs to a person, and `/account` can reach one with no workspace in
// scope at all.
//
// No `import "server-only"`: the CLI reaches this through the same auth callbacks.

import { authDb } from "../db";
import { emailEnabled } from "./config";
import type { OutboxMessage } from "./messages";

/**
 * Queue a message, if this instance sends mail at all.
 *
 * Silent when SMTP is unconfigured, which is the default and not an error: invites
 * and reset links were copyable links before there was a mailer and remain so.
 *
 * **Never throws.** Every caller is a delivery callback hanging off an action that
 * has already done the thing that matters — the invitation row exists, the reset
 * token is minted — and the copyable link on the page is the delivery path that
 * always works. Failing the action because the *notification* could not be queued
 * would undo real work to report a secondary failure, and would do it by throwing
 * out of a library callback, where the error surfaces as something unrelated. So a
 * failure here is logged and the queue simply has one fewer row in it.
 */
export async function enqueueEmail(message: OutboxMessage): Promise<void> {
  if (!emailEnabled()) return;

  try {
    await authDb.emailOutbox.createMany({
      data: {
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        kind: message.kind,
      },
    });
  } catch (error) {
    // Deliberately not the message: the subject and body of a reset mail carry the
    // token, and a log line is the wrong place for a live credential.
    console.error(`could not queue a ${message.kind} email:`, error);
  }
}
