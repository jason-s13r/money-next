import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Read secrets from the terminal without echoing them. Shared by every command
 * that takes a credential, because the subtlety below is exactly the kind of
 * thing that goes wrong twice if it is written down twice.
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
 * interface per prompt discards whatever else was on stdin, so the second prompt
 * sees EOF, its promise never settles, and node exits 0 having done nothing.
 *
 * So a whole *flow* runs inside one call, not one prompt — `money link token`
 * asks, calls Akahu, then asks again. Slow work inside the session is fine; the
 * interface is just sitting on stdin.
 */
export async function promptSession<T>(run: (io: Prompter) => Promise<T>): Promise<T> {
  // Refuse a non-terminal rather than misbehave on one: without this,
  // `echo hunter2 | money user create` prints the prompts, creates nothing and
  // exits 0. Silent success is worse than an error.
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
 * Ask for a password twice and require the two to match. `prompts` lets the
 * caller word the questions ("Password:" when creating, "New password:" when
 * resetting) without touching the machinery that makes them safe.
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
 * No confirmation prompt: retyping guards against a typo, and nobody types an
 * Akahu token — a second paste of the same clipboard proves nothing. The caller
 * checks the real thing against Akahu instead.
 *
 * Whitespace is stripped: selecting a token out of a web page often brings a
 * newline with it, and the resulting 401 is baffling.
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
