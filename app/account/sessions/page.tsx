import type { Metadata } from "next";

import { authDb } from "@/lib/server/db";
import { getSession, requireUser } from "@/lib/server/auth/session";
import { formatDateTime } from "@/lib/format";
import { AccountSection } from "../section";
import { SessionList, type SessionView } from "../session-list";

export const metadata: Metadata = { title: "Signed-in devices" };

/**
 * The devices your account is currently signed in on, and a way to end any but
 * this one. Account-level (`requireUser`), like the rest of the area.
 */
export default async function SessionsPage() {
  const user = await requireUser();
  const sessions = await activeSessions(user.id);

  return (
    <AccountSection
      title="Signed-in devices"
      description="Where your account is currently signed in. Sign out any you don't recognise."
    >
      <SessionList sessions={sessions} />
    </AccountSection>
  );
}

/**
 * The user's live sessions, read straight from the table.
 *
 * Not `auth.api.listSessions`: that endpoint is gated on a *fresh* session (a
 * login within the last day), so it would 403 anyone whose browser had been
 * signed in longer — which is most of the time you'd open this page. The read is
 * the same one the endpoint does (this user's rows, not yet expired), and
 * membership-style direct reads of the auth tables are already how the invite
 * page and session guard work. `money_app` has SELECT on `Session`.
 *
 * Tokens are never read: only the row id reaches the client, and the revoke
 * action resolves the token from it. The current session is identified by id,
 * not by token — selecting the token at all was wider than needed.
 */
async function activeSessions(userId: string): Promise<SessionView[]> {
  const current = await getSession();
  const currentId = current?.session.id;

  const rows = await authDb.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentId,
    device: describeUserAgent(row.userAgent),
    ip: row.ipAddress?.trim() ? row.ipAddress : "Unknown location",
    signedIn: formatDateTime(row.createdAt),
    expires: formatDateTime(row.expiresAt),
  }));
}

/**
 * A user-agent string, boiled down to a browser and OS a person recognises.
 *
 * Deliberately small: this is a label to help someone spot the device that
 * isn't theirs, not device analytics. Anything it can't place falls back to
 * "Unknown device" rather than dumping the raw string, which is noise here.
 */
function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";

  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : null;

  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : null;

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return "Unknown device";
}
