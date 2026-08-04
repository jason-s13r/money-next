// Delivery. The worker's half, and the only file in the app that holds an SMTP
// credential or opens a connection to a relay.
//
// Nothing under `app/` may import this — the same fence the Akahu modules have,
// and enforced the same way, by inventory rather than by convention. The point of
// queuing mail at all is that the internet-facing process never authenticates to
// the relay, and one convenient import would undo that while leaving every test
// green.

import { createTransport, type Transporter } from "nodemailer";

import { smtpConfig } from "./config";

/**
 * One transport for the process, built on first use.
 *
 * Built lazily rather than at module load because the config throws when SMTP is
 * unconfigured, and a worker on a stack that sends no mail must still start and
 * drain every other queue.
 *
 * Reused because nodemailer pools connections behind it: a burst of invites then
 * costs one TLS handshake rather than one each.
 */
let transport: Transporter | null = null;

function connection(): Transporter {
  if (transport) return transport;

  const config = smtpConfig();
  transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    auth: config.auth,
    // Bounded, because the worker drains queues in sequence and a relay that
    // accepts a connection and then says nothing would otherwise hold up every
    // sync and rules run behind it. Well above a slow handshake, far below the
    // stale-claim window that would reap this row out from under us.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  return transport;
}

/** What `deliver` needs. Structurally an outbox row, without depending on Prisma's type. */
export type Deliverable = {
  to: string;
  subject: string;
  text: string;
  html: string | null;
};

/**
 * Send one message, or throw so the queue can retry it.
 *
 * Throwing is the contract: the run-queue protocol turns it into backoff and, once
 * the attempts are spent, a `failed` row carrying the reason. A relay that is down
 * for a minute therefore resolves itself, and one that is misconfigured stops
 * rather than spinning — with the error visible on the row instead of only in a log
 * nobody is tailing.
 */
export async function deliver(message: Deliverable): Promise<void> {
  const { from } = smtpConfig();

  await connection().sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
}
