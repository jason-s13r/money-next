import "server-only";

import { cache } from "react";

import { authDb } from "../db";
import { requireUser } from "./session";

/**
 * Every workspace the current user is a member of, for the switcher and for
 * deciding where `/` should land them.
 *
 * Control-plane read: it spans workspaces by definition, which is exactly why
 * `Membership` is exempt from `scopedDb` (see `CONTROL_PLANE_MODELS`). The
 * filter that matters here is `userId` — this is the one query in the app whose
 * tenancy is "the user's", not "the workspace's".
 */
export const listWorkspaces = cache(async () => {
  const user = await requireUser();

  const memberships = await authDb.membership.findMany({
    where: { userId: user.id },
    select: { role: true, workspace: { select: { id: true, slug: true, name: true } } },
    orderBy: { workspace: { name: "asc" } },
  });

  return memberships.map((m) => ({ ...m.workspace, role: m.role }));
});
