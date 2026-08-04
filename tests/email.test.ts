/**
 * Email: the settings, the messages, and the fence that keeps the relay
 * credential out of the web process.
 *
 * Two of the three failures worth guarding here are silent by nature. A message
 * that is never delivered looks, to the owner who clicked Invite, exactly like one
 * that was — which is why the queue exists and why the config throws rather than
 * shrugging. And a link built from a misconfigured origin is a working reset
 * credential pointed at somebody else's host; it does not fail, it succeeds
 * somewhere it shouldn't.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, test } from "node:test";

import { emailEnabled, smtpConfig } from "../lib/server/email/config";
import { inviteMessage, resetMessage } from "../lib/server/email/messages";

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_SECURE",
  "BETTER_AUTH_URL",
] as const;

const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

/** A configured relay, which each test then varies one setting of. */
function useSmtp(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "money@example.com";
  process.env.SMTP_PASSWORD = "app-specific";
  process.env.BETTER_AUTH_URL = "https://money.example.com";
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

describe("SMTP configuration", () => {
  test("unset host means this instance sends no mail", () => {
    useSmtp();
    delete process.env.SMTP_HOST;
    assert.equal(emailEnabled(), false);
    // And the sender refuses rather than silently doing nothing, so a
    // half-configured stack surfaces as a failed row with a reason on it.
    assert.throws(() => smtpConfig(), /SMTP_HOST is not set/);
  });

  test("encryption is derived from the port", () => {
    // 465 is TLS from the first byte; 587 negotiates up and must be *required* to
    // do so, or a relay that does not offer STARTTLS takes the password in clear.
    useSmtp({ SMTP_PORT: "465" });
    assert.deepEqual(
      { secure: smtpConfig().secure, requireTLS: smtpConfig().requireTLS },
      { secure: true, requireTLS: false },
    );

    useSmtp({ SMTP_PORT: "587" });
    assert.deepEqual(
      { secure: smtpConfig().secure, requireTLS: smtpConfig().requireTLS },
      { secure: false, requireTLS: true },
    );
  });

  test("SMTP_SECURE overrides the port's convention", () => {
    useSmtp({ SMTP_PORT: "587", SMTP_SECURE: "true" });
    assert.equal(smtpConfig().secure, true);

    useSmtp({ SMTP_PORT: "465", SMTP_SECURE: "false" });
    assert.equal(smtpConfig().secure, false);
  });

  test("a nonsense port is refused, not coerced", () => {
    useSmtp({ SMTP_PORT: "not-a-port" });
    assert.throws(() => smtpConfig(), /not a valid port/);
  });

  test("From defaults to the login but is its own setting", () => {
    // Most relays reject a From they have not verified, so this is the setting
    // that differs when mail is sent as an alias rather than as the account.
    useSmtp();
    assert.equal(smtpConfig().from, "money@example.com");

    useSmtp({ SMTP_FROM: "Money <noreply@example.com>" });
    assert.equal(smtpConfig().from, "Money <noreply@example.com>");
  });

  test("a host with no From at all is a misconfiguration", () => {
    useSmtp();
    delete process.env.SMTP_USER;
    assert.throws(() => smtpConfig(), /neither SMTP_FROM nor SMTP_USER/);
  });

  test("authentication is omitted entirely for a relay that wants none", () => {
    // A local relay usually wants no credential, and offering half of one fails
    // in a way that reads like a wrong password.
    useSmtp();
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    process.env.SMTP_FROM = "money@example.com";
    assert.equal(smtpConfig().auth, undefined);

    useSmtp();
    delete process.env.SMTP_PASSWORD;
    assert.equal(smtpConfig().auth, undefined);
  });
});

describe("message composition", () => {
  test("links are built from BETTER_AUTH_URL", () => {
    useSmtp();
    const message = resetMessage({ to: "someone@example.com", token: "tok" });
    assert.match(message.text, /https:\/\/money\.example\.com\/reset-password\?token=tok/);
    assert.equal(message.kind, "reset");
  });

  test("a base URL that is missing or not absolute is refused", () => {
    // The in-app copy buttons read `window.location.origin`, which resolves by
    // definition. A message has no such luck, so the configured value is checked
    // rather than interpolated — a wrong one mails a live reset link elsewhere.
    useSmtp();
    delete process.env.BETTER_AUTH_URL;
    assert.throws(() => resetMessage({ to: "a@example.com", token: "t" }), /BETTER_AUTH_URL is not set/);

    useSmtp({ BETTER_AUTH_URL: "money.example.com" });
    assert.throws(() => resetMessage({ to: "a@example.com", token: "t" }), /not an absolute URL/);

    useSmtp({ BETTER_AUTH_URL: "javascript:alert(1)" });
    assert.throws(() => resetMessage({ to: "a@example.com", token: "t" }), /not an http\(s\) URL/);
  });

  test("a token needing escaping survives the round trip", () => {
    useSmtp();
    const message = resetMessage({ to: "a@example.com", token: "a+b/c=" });
    assert.match(message.text, /token=a%2Bb%2Fc%3D/);
  });

  test("an invite names the workspace and links to the invitation", () => {
    useSmtp();
    const message = inviteMessage({
      to: "someone@example.com",
      workspaceName: "Personal",
      inviterName: "Sam",
      inviteId: "inv_123",
    });
    assert.equal(message.kind, "invite");
    assert.match(message.subject, /Personal/);
    assert.match(message.text, /Sam has invited you/);
    assert.match(message.text, /https:\/\/money\.example\.com\/invite\/inv_123/);
  });

  test("an invite with no inviter name still reads as a sentence", () => {
    useSmtp();
    const message = inviteMessage({
      to: "someone@example.com",
      workspaceName: "Personal",
      inviterName: null,
      inviteId: "inv_123",
    });
    assert.match(message.text, /You have been invited/);
  });

  test("a workspace name is escaped in the HTML part", () => {
    // Workspace names are user-supplied and end up in an HTML body. An unescaped
    // one is a script tag in somebody's mail client.
    useSmtp();
    const message = inviteMessage({
      to: "someone@example.com",
      workspaceName: '<script>alert("x")</script>',
      inviterName: null,
      inviteId: "inv_123",
    });
    assert.doesNotMatch(message.html, /<script>/);
    assert.match(message.html, /&lt;script&gt;/);
  });

  test("both parts are always present", () => {
    // A message with no text/plain alternative scores as spam with most filters,
    // and an invite in a spam folder is indistinguishable from one never sent.
    useSmtp();
    for (const message of [
      resetMessage({ to: "a@example.com", token: "t" }),
      inviteMessage({ to: "a@example.com", workspaceName: "W", inviterName: null, inviteId: "i" }),
    ]) {
      assert.ok(message.text.length > 0);
      assert.ok(message.html.length > 0);
    }
  });
});

/**
 * The relay credential lives with the worker, and the web app queues rows it
 * cannot even read back. Both halves are invisible in the code and one import
 * would undo the first, so it is fenced by inventory — the same style, and for the
 * same reason, as the Akahu checks in secrets.test.ts.
 */
describe("the app never connects to the relay", () => {
  const root = new URL("..", import.meta.url).pathname;

  function grep(pattern: string, paths: string[]): string[] {
    let matches = "";
    try {
      matches = execFileSync(
        // `--untracked` so a not-yet-added file is caught: the first version of a
        // new route is exactly when this mistake gets made.
        "git",
        ["grep", "-l", "-E", "--untracked", pattern, "--", ...paths],
        { cwd: root, encoding: "utf8" },
      );
    } catch (error) {
      const { status, stdout } = error as { status?: number; stdout?: string };
      if (status !== 1) throw error;
      matches = stdout ?? "";
    }
    return matches.split("\n").filter(Boolean);
  }

  test("nothing under app/ imports the sender or nodemailer", () => {
    // `email/messages` and `email/outbox` are deliberately not matched: composing
    // and queuing are the app's half. Only delivery is withheld.
    const offenders = grep("(server/email/send|nodemailer)", ["app/*.ts", "app/*.tsx"]);

    assert.deepEqual(
      offenders,
      [],
      `these files let the web app reach the mail relay: ${offenders.join(", ")}. ` +
        `SMTP_PASSWORD is blanked on the app service in compose.prod.yaml and ` +
        `money-app.container — the app writes an EmailOutbox row and scripts/drain.ts ` +
        `sends it. Queuing is lib/server/email/outbox.`,
    );
  });

  test("the sender is not reachable from the app through the queue module", () => {
    // The likely accident is not an import in `app/` but one added here: a
    // convenience re-export from outbox.ts would put nodemailer on the app's
    // import graph while every check above stayed green.
    const source = execFileSync("cat", ["lib/server/email/outbox.ts"], { cwd: root, encoding: "utf8" });

    assert.doesNotMatch(
      source,
      /nodemailer|\.\/send/,
      "lib/server/email/outbox.ts is imported by the auth layer, which the app imports. " +
        "It must not reach the sender: that would pull the relay connection into the web " +
        "process and make the blanked SMTP_PASSWORD the only thing standing between them.",
    );
  });
});
