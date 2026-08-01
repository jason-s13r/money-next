import type { BuildInfo } from "@/lib/server/build-info";
import { formatDateTime } from "@/lib/format";

// The "what's actually deployed?" line, sat at the foot of both rails
// (app-sidebar and account-sidebar) directly above the user dropdown.
//
// Not a menu item: it isn't an action, and the row stays a plain div so the text
// is selectable and can be copied into a bug report. `title` carries the
// unabbreviated sha and the raw ISO instant for when seven characters aren't
// enough. Hidden when the rail collapses to icons, for the same reason the
// search box is — there is no glyph that means "commit a1b2c3d".
//
// The sha itself is a link out to the commit when the build knows which remote
// it came from (lib/server/build-info derives the URL; nothing about the forge
// or the repository is written down here). It stays a bare span otherwise —
// an unstamped image, or one built from a repo with no remote, has nowhere to
// send you, and a dead link would be worse than plain text.
//
// No `"use client"`, which is not the same as being a server component: both
// rails that render this are client modules, so it is compiled into the client
// bundle either way. The directive marks a *boundary* — the module a server tree
// hands off at — and this is not one; it is imported from inside a client tree
// and nowhere else. Dropping it says that.
//
// The values are read on the server (lib/server/build-info) and arrive as props.
// The `import type` is erased at compile time, so the `server-only` module it
// names is never pulled into the browser bundle.
//
// `formatDateTime` pins a display timezone rather than using the viewer's, so
// the server and client renders agree and there is no hydration mismatch.
export function BuildStamp({ build }: { build: BuildInfo }) {
  const built = build.builtAt ? new Date(build.builtAt) : null;
  const builtLabel = built && !Number.isNaN(built.getTime()) ? formatDateTime(built) : null;
  // Only the *unexpected* mode is worth the pixels: a deployed image is
  // production by definition, so saying so every time is noise you'd stop
  // reading — which is exactly when it would fail to warn you. `development`
  // earns its place because it means the sha beside it can't be trusted as
  // "what's deployed". Printed in full: `NODE_ENV` is a two-value domain here
  // and abbreviating it only invents a second vocabulary to learn.
  const mode = build.mode === "production" ? null : build.mode;

  return (
    <div
      className="truncate px-2 text-[0.7rem] leading-tight text-muted-foreground group-data-[collapsible=icon]:hidden"
      title={[build.sha, build.builtAt, build.mode].filter(Boolean).join("\n")}
    >
      {build.commitUrl ? (
        <a
          href={build.commitUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono underline underline-offset-2 hover:text-foreground"
        >
          {build.short}
        </a>
      ) : (
        <span className="font-mono">{build.short ?? "unknown"}</span>
      )}
      {build.dirty ? <span> · modified</span> : null}
      {mode ? <span> · {mode}</span> : null}
      {builtLabel ? <span> · {builtLabel}</span> : null}
    </div>
  );
}
