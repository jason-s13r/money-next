import { MODEL, isLlmAvailable } from "@/lib/server/chat/client";
import { getChatThreads } from "@/lib/server/queries/chat";
import { Link } from "@/ui/chrome/workspace-context";
import { NewChat } from "./new-chat";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// The thread list.
//
// Only your own threads are here, and that is not a filter applied on the way out —
// `getChatThreads` is the only way to ask, and it takes the current user as read. See
// the note on `ChatThread` in the schema for why a chat is the one thing in this app
// that membership of a workspace does not entitle you to.

export const metadata = { title: "Chat" };

export default async function ChatPage() {
  // Both in parallel: the probe is a couple of seconds at worst against a dead
  // endpoint, and there is no reason to make the list wait behind it.
  const [threads, available] = await Promise.all([getChatThreads(), isLlmAvailable()]);

  return (
    <main className="mx-auto w-full max-w-3xl p-2">
      <h1 className="mt-4 mb-1 text-lg font-semibold">Chat</h1>
      <p className="mb-4 text-sm text-muted">
        Ask about your money. The model runs on your own machine and reads your
        transactions through tools — nothing is sent anywhere else.
      </p>

      {available ? (
        // `MODEL` rather than a call to the endpoint: it is an environment variable, so
        // the composer can name the model that will answer without waiting on anything.
        <NewChat defaultModel={MODEL} />
      ) : (
        <p
          role="alert"
          className="rounded-lg border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-sm"
        >
          No model is reachable. Set <code className="font-mono">LLM_API</code> to a local
          OpenAI-compatible endpoint (Ollama&rsquo;s, for instance) and reload.
        </p>
      )}

      {threads.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-xs text-muted">Your conversations</h2>
          <ul className="flex flex-col divide-y divide-border">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  href={`/chat/${thread.id}`}
                  className="flex items-baseline justify-between gap-4 py-3 hover:opacity-80"
                >
                  <span className="min-w-0 truncate">{thread.title}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {/* A log of a background run reads like a conversation and is not one
                        — say so here, where the only other clue would be the title. */}
                    {thread.unattended ? "log · " : null}
                    {thread.running ? "working…" : `${thread.messages} messages`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
