import type { Metadata } from "next";

import { authDb } from "@/lib/server/db";
import { getSession } from "@/lib/server/auth/session";
import { Button } from "@/components/ui/button";
import { AcceptForm, SignUpForm } from "./forms";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = { title: "Invitation" };

/**
 * The one door into this instance.
 *
 * Registration is invite-only (docs/multi-user.md, Open questions), so this page
 * is where every account after the first is born, and where every membership
 * after the bootstrap is granted. It handles four states, because an invite link
 * gets opened by more kinds of person than the plan imagined:
 *
 *   - **nobody** — the invitee has no account yet, and signs up here;
 *   - **the invitee, signed in** — one button, and they're in;
 *   - **someone else, signed in** — refused, and told why (a household shares a
 *     browser; this is the most likely wrong state, not a hostile one);
 *   - **an expired, cancelled, or accepted link** — one flat answer.
 *
 * ## The honest note about what this link is
 *
 * threat-model.md's T12 says a forwarded invite link is useless to whoever
 * receives it, because acceptance demands a session whose email matches. That is
 * true, and it stops being the whole story right here: an invitee who has **no
 * account** cannot be logged in as anyone, so for them the link is what
 * authorises creating the account — a bearer credential, which is exactly what
 * dropping `Invite.token` was supposed to have avoided. It doesn't avoid it; it
 * narrows it. Whoever opens this link may create *one* account, at *the address
 * the owner typed*, once, within three days, and the owner sees the acceptance
 * on /members with the name attached. That is the real property, and it is
 * weaker than "useless to a thief".
 *
 * The email is never read from the form below — only from the invite row — so
 * the link cannot be redirected to an attacker's address. It is the same
 * bearer window a password-reset link has, and the alternative (an operator
 * minting accounts and passwords by hand, over the same chat app the link would
 * have gone through) is not obviously safer and is definitely worse to use.
 */
export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Read directly rather than through `auth.api.getInvitation`: that endpoint
  // requires a session whose email already matches, which is precisely the
  // person who cannot exist yet. `Invite` is a control-plane model and exempt
  // from `scopedDb` — there is no workspace to scope to here, which is the
  // point: this page runs before you belong to one.
  const invite = await authDb.invite.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      role: true,
      name: true,
      status: true,
      expiresAt: true,
      workspace: { select: { name: true, slug: true } },
    },
  });

  const live = invite && invite.status === "pending" && invite.expiresAt > new Date();

  // One answer for expired, cancelled, already-accepted and never-existed. Not
  // to be clever about enumeration — a cuid is not a secret worth protecting
  // that way — but because the four states have exactly one useful next step
  // between them, and it is "ask them to send another".
  if (!live) {
    return (
      <Shell title="This invitation isn't valid">
        <p className="text-sm opacity-70">
          It may have expired, been withdrawn, or already been used. Ask whoever invited you
          to send a new one.
        </p>
      </Shell>
    );
  }

  const session = await getSession();
  const workspace = invite.workspace.name;

  if (!session) {
    const existing = await authDb.user.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });

    // They already have an account — signing up again would fail on the unique
    // email anyway, and "log in" is the answer they need. `next` brings them
    // back here, which is the bounce proxy.ts describes.
    if (existing) {
      return (
        <Shell title={`Join ${workspace}`}>
          <p className="text-sm opacity-70">
            You already have an account here. Sign in as{" "}
            <strong className="font-medium">{invite.email}</strong> and this page will let
            you in.
          </p>
          <Button
            className="mt-4"
            render={
              <a href={`/login?next=${encodeURIComponent(`/invite/${invite.id}`)}`}>Sign in</a>
            }
          />
        </Shell>
      );
    }

    return (
      <Shell title={`Join ${workspace}`}>
        <p className="text-sm opacity-70">
          You&rsquo;ve been invited as {invite.role === "viewer" ? "a" : "an"}{" "}
          <strong className="font-medium">{invite.role}</strong>. Create your account to
          accept.
        </p>
        <SignUpForm inviteId={invite.id} email={invite.email} name={invite.name} />
      </Shell>
    );
  }

  // Signed in as the wrong person. Very likely a shared browser rather than an
  // attack, so it says the plain thing rather than a 404.
  if (session.user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Shell title="This invitation isn't for you">
        <p className="text-sm opacity-70">
          It was sent to <strong className="font-medium">{invite.email}</strong>, and
          you&rsquo;re signed in as{" "}
          <strong className="font-medium">{session.user.email}</strong>. Sign out and open
          the link again.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title={`Join ${workspace}`}>
      <p className="text-sm opacity-70">
        You&rsquo;ve been invited as {invite.role === "viewer" ? "a" : "an"}{" "}
        <strong className="font-medium">{invite.role}</strong>, and you&rsquo;re signed in
        as <strong className="font-medium">{session.user.email}</strong>.
      </p>
      <AcceptForm inviteId={invite.id} workspace={workspace} />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="mt-2">{children}</div>
    </main>
  );
}
