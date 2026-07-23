import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Ask for a password twice on the terminal, without echoing it.
 *
 * Shared by every `pnpm user:*` script that mints or changes a credential
 * (create-user, set-password), because the subtlety below is exactly the kind of
 * thing that goes wrong twice if it is written down twice.
 *
 * One readline interface for both prompts, which matters more than it looks: a
 * fresh interface per prompt buffers whatever else was already on stdin and
 * throws it away, so the second prompt sees EOF, its promise never settles, and
 * node — with nothing left to wait for — exits 0 having done nothing. That is
 * silent success on a piped stdin and works fine on a terminal, which is the
 * worst possible combination.
 *
 * `prompts` lets the caller word the two questions ("Password:"/"Again:" when
 * creating, "New password:"/"Again:" when resetting) without changing any of
 * the machinery that makes them safe.
 */
export async function readPasswordTwice(
  prompts: { first: string; second: string } = { first: "Password: ", second: "Again: " },
): Promise<string> {
  // Refuse a non-terminal outright rather than misbehave on one. Reading a
  // masked password needs a tty, and without this the failure is the nastiest
  // kind: `echo hunter2 | pnpm user:create` prints the prompts, creates nothing,
  // and exits 0, because the question never settles and node has nothing left to
  // wait for. Silent success is worse than an error.
  if (!stdin.isTTY) {
    throw new Error(
      "This script asks for a password on the terminal, so it can't be piped or run " +
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

  const ask = async (prompt: string) => {
    const answer = rl.question(prompt);
    muted = true;
    const value = await answer;
    muted = false;
    stdout.write("\n");
    return value;
  };

  try {
    const password = await ask(prompts.first);
    const again = await ask(prompts.second);
    if (password !== again) throw new Error("Passwords didn't match.");
    if (!password) throw new Error("A password is required.");
    return password;
  } finally {
    if (io.output && original) io.output.write = original;
    rl.close();
  }
}
