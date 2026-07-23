import { requireWorkspace } from "@/lib/server/auth/session";
import { listMembers, listPendingInvites } from "@/lib/server/auth/members";
import { ROLES } from "@/lib/server/auth/roles";
import { formatDate } from "@/lib/format";
import { InviteForm } from "./invite-form";
import { InviteLink } from "./invite-link";
import { CancelInviteButton, RemoveMemberButton, RoleSelect } from "./member-controls";
import { ResetLinkButton } from "./reset-link";

export const metadata = { title: "Members" };

/**
 * Who can see this household's money, and who has been asked.
 *
 * threat-model.md's T12 recorded this surface as "not built", and its absence was
 * the actual problem rather than an omission: invites were being minted with no
 * way to list them, withdraw them, or notice they'd been accepted. An invite that
 * nobody can see is a standing grant of access nobody is watching.
 *
 * ## The management controls are hidden here and enforced elsewhere
 *
 * Non-owners get the list and nothing else — no role selects, no remove buttons,
 * no invite form. That is a rendering decision, not a control: every action opens
 * with `requireRole` (./actions), and a viewer who forges the POST is refused
 * there. Hiding them is for the person who would otherwise click a button that
 * always fails, and the page would be just as safe if it hid nothing.
 *
 * The list itself is shown to everyone, deliberately. Knowing who can read your
 * transactions is not a privilege — it is the thing you would most want to check
 * if you suspected something was wrong, and reserving it for owners would mean
 * the person with the least power has the least ability to notice.
 */
export default async function MembersPage() {
  const { workspace, role, user } = await requireWorkspace();
  const [members, invites] = await Promise.all([listMembers(), listPendingInvites()]);

  const isOwner = role === "owner";
  const owners = members.filter((m) => m.role === "owner").length;

  return (
    <main className="mx-auto w-full max-w-3xl p-2">
      <header className="mb-6">
        <h1 className="sr-only">Members</h1>
        <p className="mt-1 text-sm text-muted">
          Everyone here can see every transaction in {workspace.name}.
        </p>
      </header>

      <ul className="divide-y divide-current/10 border-y border-current/10">
        {members.map((member) => {
          const isSelf = member.userId === user.id;
          // The last owner can't be demoted or removed — Better Auth refuses
          // both, and a control that always errors is worse than no control.
          const isLastOwner = member.role === "owner" && owners === 1;

          return (
            <li key={member.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.name}
                  {isSelf ? <span className="ml-1.5 text-xs text-muted">you</span> : null}
                </p>
                <p className="truncate text-xs text-muted">{member.email}</p>
              </div>

              <p className="text-xs text-muted tabular-nums">
                joined {formatDate(member.joinedAt)}
              </p>

              {isOwner && !isLastOwner ? (
                <RoleSelect memberId={member.id} role={member.role} roles={ROLES} />
              ) : (
                <span className="rounded bg-current/10 px-1.5 py-0.5 text-xs">{member.role}</span>
              )}

              {isOwner && !isLastOwner ? (
                <RemoveMemberButton memberId={member.id} name={member.name} self={isSelf} />
              ) : null}

              {/* Available for every member, including the last owner and
                  yourself: a reset changes a password, not a role, so the
                  last-owner invariant that gates the controls above has nothing
                  to protect here. The person just needs the link (see
                  ./reset-link and app/reset-password). */}
              {isOwner ? <ResetLinkButton userId={member.userId} name={member.name} /> : null}
            </li>
          );
        })}
      </ul>

      <section className="mt-12">
        <div className="border-b border-current/20 pb-2">
          <h2 className="text-sm font-medium opacity-60">Pending invitations</h2>
        </div>

        {invites.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">
            No invitations waiting to be accepted.
          </p>
        ) : (
          <ul className="divide-y divide-current/10">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{invite.email}</p>
                  <p className="truncate text-xs text-muted">
                    invited as {invite.role}
                    {invite.invitedBy ? ` by ${invite.invitedBy}` : null} · expires{" "}
                    {formatDate(invite.expiresAt)}
                  </p>
                </div>

                {/* No email is sent (see lib/server/auth/index.ts) — the owner
                    delivers the link themselves, so the link has to be here. */}
                {isOwner ? <InviteLink id={invite.id} /> : null}
                {isOwner ? <CancelInviteButton invitationId={invite.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner ? (
        <section className="mt-12">
          <div className="border-b border-current/20 pb-2">
            <h2 className="text-sm font-medium opacity-60">Invite someone</h2>
          </div>
          <InviteForm roles={ROLES} />
        </section>
      ) : null}
    </main>
  );
}
