// The two messages this app sends, and the link-building they share.
//
// Composed at enqueue time, in the web process, rather than by the worker from a
// row of parameters. That way what was queued is what is sent: a message cannot
// change meaning between the click and the delivery because the template moved
// underneath it, and reading the queue tells you exactly what a person received.
//
// By standing rule these carry no financial data — an address, a workspace name,
// who invited you, a link, and prose. Never an amount, a balance or a
// transaction. Mail leaves the app boundary, and that boundary is where the
// household's finances stop.

/** What every message needs, whatever put it in the queue. */
export type OutboxMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: "invite" | "reset";
};

/**
 * The origin links in mail point at.
 *
 * The in-app copy buttons build their links from `window.location.origin`,
 * deliberately: the origin someone reached the page on is by definition one that
 * resolves for them, so a misconfigured base URL cannot silently poison a link
 * they are about to hand over. A message composed on the server has no browser
 * origin to borrow, so it has to trust configuration instead — which promotes
 * BETTER_AUTH_URL from "how same-origin is judged" to "where a password-reset
 * capability points". Set it wrong and you mail a working reset link to a host
 * you do not control, so this validates it rather than interpolating a string.
 */
function baseUrl(): string {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) {
    throw new Error(
      "BETTER_AUTH_URL is not set, so there is no origin to build email links " +
        "from. It must be the external URL people actually browse to.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`BETTER_AUTH_URL is not an absolute URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`BETTER_AUTH_URL is not an http(s) URL: ${raw}`);
  }

  return parsed.origin;
}

/**
 * Exported for the CLI, which prints the link when SMTP is unconfigured and
 * `enqueueEmail` no-ops. Same builder, so the printed link cannot drift.
 */
export const inviteUrl = (inviteId: string) => `${baseUrl()}/invite/${inviteId}`;

export const resetUrl = (token: string) =>
  `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Both parts of every message, from the same prose.
 *
 * The plaintext part is not a courtesy. A message with no `text/plain` alternative
 * scores as spam with most filters, and an invite that lands in a spam folder is
 * indistinguishable — to the owner who sent it — from one that was never sent.
 */
function body(lines: string[], action: { label: string; url: string }): { text: string; html: string } {
  const text = [...lines, "", action.label + ":", action.url, ""].join("\n");

  const paragraphs = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n    ");
  const href = escapeHtml(action.url);
  const html = `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
    ${paragraphs}
    <p><a href="${href}">${escapeHtml(action.label)}</a></p>
    <p style="color: #666; font-size: 0.9em;">If the link doesn't work, paste this into your browser:<br>${href}</p>
  </body>
</html>`;

  return { text, html };
}

/**
 * An invitation to join a workspace.
 *
 * The link carries the invitation id, which is not by itself the capability —
 * accepting requires being signed in as the address the invite names. Saying so
 * in the message saves the recipient wondering why they were asked to sign in.
 */
export function inviteMessage(opts: {
  to: string;
  workspaceName: string;
  inviterName: string | null;
  inviteId: string;
}): OutboxMessage {
  const from = opts.inviterName ? `${opts.inviterName} has invited you` : "You have been invited";

  const { text, html } = body(
    [
      `${from} to join "${opts.workspaceName}".`,
      "Opening the link below will ask you to sign in, or to pick a password if " +
        "you don't have an account yet. It only works for this email address.",
      "The invitation expires in three days.",
    ],
    { label: "Accept the invitation", url: inviteUrl(opts.inviteId) },
  );

  return {
    to: opts.to,
    subject: `You've been invited to "${opts.workspaceName}"`,
    text,
    html,
    kind: "invite",
  };
}

/**
 * A password-reset link.
 *
 * Short-lived and single-use, and the message says so: this is a bearer
 * credential, so a recipient who did not expect it should know it is worth
 * mentioning rather than ignoring.
 */
export function resetMessage(opts: { to: string; token: string }): OutboxMessage {
  const url = resetUrl(opts.token);

  const { text, html } = body(
    [
      "Someone asked to reset the password on your account.",
      "The link below works once and expires in an hour.",
      "If you didn't ask for this, you can ignore this message — your password " +
        "won't change until the link is used.",
    ],
    { label: "Choose a new password", url },
  );

  return { to: opts.to, subject: "Reset your password", text, html, kind: "reset" };
}
