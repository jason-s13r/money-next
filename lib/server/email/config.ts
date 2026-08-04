// SMTP settings, split along the line between what the web app may know and what
// only the worker may hold.
//
// The split is the whole point of the module. `emailEnabled()` answers "will a
// message queued right now actually be delivered?", which the web app genuinely
// needs — telling someone their invite was emailed when nothing in the stack can
// send it is precisely the silent failure this queue exists to prevent. It reads
// the host and nothing else, so it is safe anywhere. `smtpConfig()` reads the
// credential and belongs to the worker alone: SMTP_PASSWORD is blanked on the app
// and cron services, so a caller there gets a config that cannot authenticate.
//
// No `import "server-only"`: the worker is plain Node, outside any request.

/**
 * Whether this instance sends mail at all.
 *
 * Keyed on the host because it is the one setting with no sensible default —
 * every other value can be derived or guessed, and a relay this app has not been
 * told about cannot be. Unset means invites and reset links stay what they were
 * before there was a mailer: copyable links, handed over by the person who
 * generated them.
 */
export function emailEnabled(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim());
}

export type SmtpConfig = {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465), rather than STARTTLS. */
  secure: boolean;
  /** On a STARTTLS port, refuse to continue if the relay will not upgrade. */
  requireTLS: boolean;
  /** Absent for a relay that wants no authentication, which a local one usually doesn't. */
  auth?: { user: string; pass: string };
  from: string;
};

/** "true"/"false"/"1"/"0", or undefined when the variable is empty or unset. */
function flag(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  return value === "true" || value === "1";
}

/**
 * The full settings, credential included. Worker-side.
 *
 * Throws rather than returning null on a half-configured stack, and the caller
 * turns that into a failed outbox row with the message on it. A misconfiguration
 * that quietly sends nothing is the one outcome worth ruling out here: the row
 * would sit `queued` looking healthy while nobody received anything.
 */
export function smtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    throw new Error("SMTP_HOST is not set, so this instance cannot send mail.");
  }

  const port = Number(process.env.SMTP_PORT?.trim() || 465);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT is not a valid port number: ${process.env.SMTP_PORT}`);
  }

  // Derived from the port, which covers both of the arrangements a provider
  // actually documents: 465 is TLS from the first byte, 587 and 25 negotiate up
  // with STARTTLS. SMTP_SECURE is for a relay that disagrees with the convention.
  //
  // `requireTLS` on the STARTTLS path is not the default and matters: without it
  // nodemailer will happily continue in the clear against a relay that does not
  // offer the upgrade, which is how a password ends up on the wire in plaintext.
  const secure = flag(process.env.SMTP_SECURE) ?? port === 465;

  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;

  // The From: header is not the login. Most providers reject a From they have not
  // verified — Fastmail accepts only an identity or alias on the account — so this
  // is its own setting, defaulting to the login because that address is always one
  // the account may send as.
  const from = process.env.SMTP_FROM?.trim() || user;
  if (!from) {
    throw new Error(
      "SMTP_HOST is set but neither SMTP_FROM nor SMTP_USER is, so there is no " +
        "address to send from. Set SMTP_FROM — see .env.example.",
    );
  }

  return {
    host,
    port,
    secure,
    requireTLS: !secure,
    // Both or neither: half a credential is a misconfiguration, and sending it to
    // a relay that wanted none would fail in a way that reads as a wrong password.
    auth: user && pass ? { user, pass } : undefined,
    from,
  };
}
