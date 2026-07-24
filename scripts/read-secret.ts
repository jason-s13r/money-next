import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Read secrets from the terminal without echoing them.
 *
 * Shared by every script that takes a credential — `user:create` and
 * `user:password` (which mint or change a password) and `link:token` (which
 * stores an Akahu token) — because the subtlety below is exactly the kind of
 * thing that goes wrong twice if it is written down twice.
 *
 * Was `read-password.ts`; renamed when the Akahu token CLI arrived, since the
 * machinery is about *not echoing* rather than about passwords.
 */

/** What a prompt session can ask: secrets are not echoed, everything else is. */
export type Prompter = {
  /** Ask for something that must not appear on screen or in scrollback. */
  secret: (prompt: string) => Promise<string>;
  /** Ask something whose answer should echo — a confirmation, a name. */
  visible: (prompt: string) => Promise<string>;
};

/**
 * Open ONE readline session and hand `run` a way to ask questions on it.
 *
 * One interface for the whole session, which matters more than it looks: a fresh
 * interface per prompt buffers whatever else was already on stdin and throws it
 * away, so the second prompt sees EOF, its promise never settles, and node — with
 * nothing left to wait for — exits 0 having done nothing. That is silent success
 * on a piped stdin and works fine on a terminal, which is the worst possible
 * combination.
 *
 * Which is why a *whole flow* runs inside one call, not one prompt: `link:token`
 * asks for two tokens, calls Akahu, and then asks for confirmation, and opening a
 * second interface for that last question would walk straight back into the trap
 * this function exists to describe. Slow work inside the session is fine — the
 * interface is just sitting on stdin.
 */
export async function promptSession<T>(run: (io: Prompter) => Promise<T>): Promise<T> {
  // Refuse a non-terminal outright rather than misbehave on one. Reading a masked
  // secret needs a tty, and without this the failure is the nastiest kind:
  // `echo hunter2 | pnpm user:create` prints the prompts, creates nothing, and
  // exits 0, because the question never settles and node has nothing left to wait
  // for. Silent success is worse than an error.
  if (!stdin.isTTY) {
    throw new Error(
      "This script asks for a secret on the terminal, so it can't be piped or run " +
        "from CI. Run it interactively.",
    );
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  // `readline` has no silent mode: mute the output stream while the answer is
  // typed, and put it back afterwards.
  const io = rl as unknown as { output?: { write: (chunk: string) => void } };
  const original = io.output?.write.bind(io.output);
  let muted = false;
  if (io.output && original) {
    io.output.write = (chunk: string) => {
      if (!muted) original(chunk);
    };
  }

  const ask = async (prompt: string, mask: boolean) => {
    const answer = rl.question(prompt);
    muted = mask;
    const value = await answer;
    muted = false;
    // The masked prompt swallowed the user's newline along with their typing, so
    // put one back. A visible prompt echoed its own.
    if (mask) stdout.write("\n");
    return value;
  };

  try {
    return await run({
      secret: (prompt) => ask(prompt, true),
      visible: (prompt) => ask(prompt, false),
    });
  } finally {
    if (io.output && original) io.output.write = original;
    rl.close();
  }
}

/**
 * Ask for a password twice and require the two to match.
 *
 * `prompts` lets the caller word the two questions ("Password:"/"Again:" when
 * creating, "New password:"/"Again:" when resetting) without changing any of the
 * machinery that makes them safe.
 */
export async function readPasswordTwice(
  prompts: { first: string; second: string } = { first: "Password: ", second: "Again: " },
): Promise<string> {
  return promptSession(async (io) => {
    const password = await io.secret(prompts.first);
    const again = await io.secret(prompts.second);
    if (password !== again) throw new Error("Passwords didn't match.");
    if (!password) throw new Error("A password is required.");
    return password;
  });
}

/**
 * Ask for a pasted secret, inside an existing session.
 *
 * No confirmation prompt, deliberately: retyping guards against a *typo*, and
 * nobody types out an Akahu token — they paste it, so a second paste of the same
 * clipboard proves nothing. `pnpm link:token` checks the real thing instead, by
 * calling Akahu with the token before it stores it.
 *
 * Trailing whitespace is stripped, because selecting a token out of a web page
 * frequently brings a newline with it and the resulting 401 is baffling.
 */
export async function askPastedSecret(io: Prompter, prompt: string): Promise<string> {
  const value = (await io.secret(prompt)).trim();
  if (!value) throw new Error(`A value is required for "${prompt.trim()}"`);
  return value;
}

/** Yes/no, defaulting to no — the safe answer for anything that writes. */
export async function askYesNo(io: Prompter, question: string): Promise<boolean> {
  const answer = (await io.visible(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
