/**
 * The test that catches the *next* server action somebody writes.
 *
 *   pnpm test
 *
 * A server action is a public POST endpoint. Not "like" one — it is one: Next
 * gives it a stable id, and anything on the internet can call it with any
 * arguments it likes. The only thing standing between a viewer and
 * `removeMember` is the `requireRole` line at the top of the function, and the
 * failure mode of forgetting that line is silence. Nothing 500s, no test goes
 * red, the page looks right; the action just works for everyone.
 *
 * threat-model.md asked for this by name (T10): with fifteen-odd mutating
 * actions, "we check them all" is a claim about a list nobody is keeping. So
 * this keeps it. Every exported action either has a gate, or is named below with
 * a reason someone had to type out.
 *
 * It is a text scan, not a type check, for the same reason the schema test in
 * isolation.test.ts is: the property is about code that *hasn't been written
 * yet*, and a new file with a missing line is exactly what a compiler has no
 * opinion about.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

/**
 * Actions allowed to skip `requireRole`, and why.
 *
 * Every entry here is a place where "what is your role in this workspace?" is
 * the wrong question, not one where the answer is inconvenient. That distinction
 * is the whole value of the list — an exemption added because a gate was
 * annoying would read exactly like these do, so the reason has to survive
 * someone asking about it in review.
 */
const EXEMPT: Record<string, string> = {
  // ── Nobody is signed in yet, by definition ──────────────────────────────
  "app/login/actions.ts:signIn":
    "the action that creates a session cannot require one",
  "app/login/two-factor/actions.ts:verify":
    "second factor, mid-login: the session is half-built and has no workspace",

  // ── You, about your own credential ──────────────────────────────────────
  "app/enrol-mfa/actions.ts:start":
    "enrolling your own authenticator; gated on your password, not a workspace",
  "app/enrol-mfa/actions.ts:confirm":
    "same — and it must work before you have any membership at all",

  // ── The invite flow: you are not in a workspace, that is the point ───────
  "app/invite/[id]/actions.ts:signUpFromInvite":
    "creates the account the invite named; the invite row is the authority, " +
      "and the email is read from it rather than the form",
  "app/invite/[id]/actions.ts:acceptInvite":
    "the membership does not exist until this succeeds; Better Auth checks the " +
      "session's email against the invite, and the redemption is single-use",

  // ── A read ──────────────────────────────────────────────────────────────
  "app/w/[workspace]/transactions/[transactionId]/actions/transfer.ts:searchTransferCandidates":
    "reads, changes nothing, and goes through getDb() — membership *is* read " +
      "access in this app, which is why reading is not a statement in roles.ts",
};

/** Files that are actually `"use server"` modules, not files that mention it. */
function actionFiles(): string[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      // `--untracked`, for the reason isolation.test.ts spells out: a new file
      // is unsearchable until it is committed, which is precisely the window in
      // which the mistake is being made.
      ["grep", "-l", "--untracked", "-F", '"use server"', "--", "*.ts", "*.tsx"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    const { status, stdout } = error as { status?: number; stdout?: string };
    if (status !== 1) throw error;
    out = stdout ?? "";
  }

  return out
    .split("\n")
    .filter(Boolean)
    .filter((file) => {
      // The directive only makes a module a server module when it is the first
      // statement. rules/types.ts merely talks about it in a comment, and
      // catching that file would teach the reader to add exemptions for
      // functions that aren't actions.
      const source = readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");
      return /^\s*"use server";/m.test(source.split("\n").slice(0, 3).join("\n"));
    });
}

/** Exported async functions, as `name` → the source between it and the next export. */
function exportedActions(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const parts = source.split(/^export async function /m).slice(1);

  for (const part of parts) {
    const name = part.split(/[\s(<]/)[0];
    // Up to the next top-level export, which is a good-enough body: the gate we
    // are looking for is the first statement, and anything that pushed it past
    // the next export would be a function long enough to be its own problem.
    const end = part.search(/^export /m);
    found.set(name, end === -1 ? part : part.slice(0, end));
  }

  return found;
}

describe("every server action is gated", () => {
  const files = actionFiles();

  test("there are action files to check", () => {
    // If the grep or the directive check ever silently matches nothing, every
    // assertion below passes vacuously — the isolation tests learned this the
    // hard way with `\b`. A test that cannot fail reads like a guarantee.
    assert.ok(files.length >= 8, `only found ${files.length} action modules — the scan is broken`);
  });

  for (const file of files) {
    const source = readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");

    for (const [name, body] of exportedActions(source)) {
      const key = `${file}:${name}`;

      test(key, () => {
        if (body.includes("requireRole(")) {
          assert.ok(
            !(key in EXEMPT),
            `${key} is listed as exempt but calls requireRole — delete the exemption, ` +
              `it is now describing something that isn't true.`,
          );
          return;
        }

        assert.ok(
          key in EXEMPT,
          `${key} is an exported server action with no requireRole gate, which makes it ` +
            `callable by anyone on the internet who can guess the workspace in the URL. ` +
            `Add the gate — or, if it genuinely cannot have one, add it to EXEMPT in this ` +
            `file with the reason.`,
        );
      });
    }
  }
});

describe("server modules export only async functions", () => {
  /**
   * Next's rule, and it is not a style preference: every export of a `"use
   * server"` module becomes a callable endpoint, so a non-function export has no
   * meaning and Next refuses the whole module.
   *
   * Worth a test because of *when* it fails. Not at build — `next build`
   * succeeds, the page renders, typecheck is clean — but at module evaluation on
   * the first POST, as a 500 with a digest. So the surface looks finished and
   * dies the moment anyone uses it, which is exactly what happened here: a
   * `NO_ERROR` const exported alongside the actions, caught by a human clicking
   * a role dropdown after every automated check had gone green.
   *
   * `export type` is fine — erased before Next ever sees it.
   */
  for (const file of actionFiles()) {
    test(file, () => {
      const source = readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");

      const offenders = source
        .split("\n")
        .filter((line) => /^export /.test(line))
        .filter((line) => !/^export (async function|type\b|\{[^}]*\}\s*from)/.test(line))
        .map((line) => line.trim());

      assert.deepEqual(
        offenders,
        [],
        `${file} is a "use server" module, so every export is an endpoint and Next ` +
          `requires them all to be async functions. These aren't: ${offenders.join(" | ")}. ` +
          `This throws at runtime on the first POST, not at build. Move them to a sibling ` +
          `types.ts — see app/w/[workspace]/rules/types.ts.`,
      );
    });
  }
});

describe("the exemption list stays honest", () => {
  test("every exemption names an action that still exists", () => {
    // The rot that matters: an action gets renamed or deleted, its exemption
    // stays, and the next action to take that name inherits a pass nobody meant
    // to give it.
    const live = new Set<string>();
    for (const file of actionFiles()) {
      const source = readFileSync(new URL(file, new URL("..", import.meta.url)), "utf8");
      for (const name of exportedActions(source).keys()) live.add(`${file}:${name}`);
    }

    const stale = Object.keys(EXEMPT).filter((key) => !live.has(key));
    assert.deepEqual(
      stale,
      [],
      `these exemptions name actions that no longer exist: ${stale.join(", ")}`,
    );
  });
});
