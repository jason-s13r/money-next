import "server-only";

import { revalidatePath } from "next/cache";

import { workspacePath } from "../workspace-path";
import { requireWorkspace } from "./auth/session";

/**
 * `revalidatePath`, for a path inside the current workspace.
 *
 * `revalidatePath` is global: it takes a path, not a tenant, so
 * `revalidatePath("/transactions/trans_x")` in a multi-tenant app means "every
 * workspace's copy of that page". Today that is harmless — every read awaits
 * `connection()`, so nothing is cached to bust — and it stops being harmless the
 * moment anyone adds `"use cache"` (T13).
 *
 * Putting the workspace in the URL is what defuses that, and this is where the
 * defusing happens: the path revalidated is the path rendered, slug and all, so
 * a cache keyed on the path is tenant-scoped for free. Every call site that used
 * to say `revalidatePath("/rules")` says `await revalidateWorkspacePath("/rules")`
 * instead, and no longer has to know why.
 */
export async function revalidateWorkspacePath(path: string) {
  const { workspace } = await requireWorkspace();
  revalidatePath(workspacePath(workspace.slug, path));
}
