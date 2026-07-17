/**
 * How a workspace-relative path becomes a URL. `/rules` → `/w/<slug>/rules`.
 *
 * Lives here, in a module with no `"use client"` and no server imports, because
 * both sides need it: the `<Link>` wrapper in ui/chrome/workspace-context.tsx
 * and `revalidateWorkspacePath` in lib/server/workspace.ts. A `"use client"`
 * module's exports become client references, so a server caller cannot invoke
 * one — this file is what keeps the two uses honest about being the same rule.
 */
export function workspacePath(slug: string, path: string) {
  return path === "/" ? `/w/${slug}` : `/w/${slug}${path}`;
}
