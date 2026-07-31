import "server-only";
import {
  isStepCount,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

import type { ScopedDb } from "../db";
import { LLM_TIMEOUT, MAX_MONTHS, MAX_STEPS, MODEL, languageModel } from "./client";
import {
  availableTools,
  repairLooseToolCall,
  toolsForSdk,
  type Tool,
  type ToolContext,
} from "./tools";
import type { RunControl } from "./runs";
import { chatSystemPrompt, compactedPreamble, takenOverPreamble } from "../../chat/prompt";
import {
  appendMessage,
  elisionsFor,
  markElided,
  toModelMessages,
  type StoredMessage,
} from "./thread";

// One turn of the interactive chat: everything that happens between a person pressing
// send and the model having nothing left to say.
//
// The same loop as the headless budget inference (lib/server/budget/llm.ts), with the
// two differences that matter when somebody is watching. It streams, so tokens appear
// as they are produced rather than after a minute of silence. And every message is
// written to the database as it completes, not at the end — so closing the tab, or
// losing the connection, costs you the *view* of the turn and not the turn.
//
// That last point is why this does not listen to the *request's* abort signal. A
// disconnect means the browser went away; it does not mean the work is unwanted. What it
// does listen to is a `RunControl` (lib/server/chat/runs.ts), which is someone saying so
// deliberately — and which survives the request that started the turn, because the turn
// does. `MAX_STEPS` and the client timeout still bound a turn nobody is watching.
//
// **A stopped turn still leaves a conversation that can be continued.** That is a real
// constraint, not a nicety: the API rejects a thread in which an assistant asked for a
// tool and no result followed, so cancelling between the call and its answer has to
// write the answer anyway — see `cancelledResult`.

/** What the browser is told as a turn happens. One JSON object per line. */
export type TurnEvent =
  | { t: "delta"; text: string }
  /** The model reasoning, as distinct from speaking. Streamed but not stored: it is
   *  worth watching live and not worth keeping, and the model is not shown it again. */
  | { t: "thinking"; text: string }
  | { t: "tool_call"; id: string; name: string; args: string }
  | { t: "tool_result"; id: string; name: string; data: unknown }
  | { t: "message"; id: string; seq: number; role: string }
  | { t: "title"; title: string }
  | { t: "error"; message: string }
  | { t: "cancelled" }
  | { t: "done" };

export type RunTurnInput = {
  db: ScopedDb;
  threadId: string;
  ctx: ToolContext;
  tools: Tool[];
  emit: (event: TurnEvent) => void;
  control: RunControl;
  /** Which model to ask. Defaults to `LLM_MODEL`. */
  modelId?: string;
};

/** The result written for a tool call abandoned by a cancel, so the thread stays a
 *  conversation the API will accept next time it is continued. */
const cancelledResult = JSON.stringify({
  cancelled: "This call was stopped before it ran. Call it again if you still need it.",
});

/**
 * Run one turn to completion: model, tools, model again, until it stops calling tools.
 *
 * Returns normally on success and on a model-side failure alike — a failure is emitted
 * as an `error` event and recorded in the thread, because a conversation that loses its
 * last turn to an exception is worse than one that says what went wrong. Only a
 * programming error escapes.
 */
export async function runTurn({
  db,
  threadId,
  ctx,
  tools,
  emit,
  control,
  modelId = MODEL,
}: RunTurnInput): Promise<void> {
  const model = languageModel(modelId);
  if (!model) {
    emit({ t: "error", message: "No model is configured. Set LLM_API to a local endpoint." });
    return;
  }

  const offered = availableTools(tools, ctx.can);
  const sdkTools = toolsForSdk(offered, ctx);

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (control.cancelled.aborted) return emit({ t: "cancelled" });

    const { instructions, messages } = await conversationFor(db, threadId, ctx.now);
    const outcome = await runStep(model, instructions, messages, sdkTools, emit, control.step());

    if (outcome.failure) {
      console.error("  [chat] completion failed:", outcome.failure);
      emit({ t: "error", message: `The model failed to answer: ${outcome.failure}` });
      return;
    }

    // Whatever it managed to say before it was cut off is kept, not discarded: it is on
    // the screen already, and a bubble that vanishes on being interrupted reads as data
    // loss. Tool calls from an interrupted step are dropped instead — they were never
    // run, and an unanswered call is a thread the endpoint refuses.
    const calls = outcome.interrupted ? [] : outcome.calls;

    if (outcome.text || calls.length > 0) {
      const stored = await appendMessage(db, threadId, {
        role: "assistant",
        content: outcome.text || null,
        toolCalls:
          calls.length > 0
            ? calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.args },
              }))
            : undefined,
      });
      emit({ t: "message", id: stored.id, seq: stored.seq, role: "assistant" });
    }

    if (outcome.interrupted) {
      if (control.cancelled.aborted) return emit({ t: "cancelled" });
      // A steer: go round again, against a thread that now has the new instruction in
      // it. Nothing else is needed — every round rebuilds the conversation anyway.
      continue;
    }

    // Nothing asked for: the model has said its piece and the turn is over.
    if (calls.length === 0) return;

    // Every call gets a row. The SDK ran them as it streamed, so a result is usually
    // waiting; one that is missing was abandoned by a cancel landing mid-step, and still
    // needs answering, because a call with no result is a conversation that cannot be
    // continued.
    for (const call of calls) {
      const answered = Object.hasOwn(outcome.results, call.id);
      const result = outcome.results[call.id];

      const row = await appendMessage(db, threadId, {
        role: "tool",
        content: answered ? JSON.stringify(result) : cancelledResult,
        toolCallId: call.id,
        toolName: call.name,
      });
      emit({ t: "message", id: row.id, seq: row.seq, role: "tool" });
    }

    if (control.cancelled.aborted) return emit({ t: "cancelled" });
  }

  emit({
    t: "error",
    message: `Stopped after ${MAX_STEPS} steps without finishing. Ask again, more narrowly.`,
  });
}

/**
 * The thread as the model should see it right now: what it is, then everything said
 * since the last compaction, with older tool output elided down to the context budget.
 *
 * Rebuilt every round rather than once per turn, which is what makes steering land
 * mid-turn — and why the instructions come back from here too. The system prompt is not
 * stored: storing it would freeze every old thread on the wording it was opened with,
 * and this one changes as the tools do. It also cannot be prepended to the messages, as
 * the SDK refuses a system message found among the others.
 */
async function conversationFor(
  db: ScopedDb,
  threadId: string,
  now: Date,
): Promise<{ instructions: string; messages: ModelMessage[] }> {
  const thread = await db.chatThread.findFirst({
    where: { id: threadId },
    select: { summary: true, summarizedThroughSeq: true, continuedAt: true },
  });

  const rows = (await db.chatMessage.findMany({
    where: {
      threadId,
      // A compacted thread starts part-way through itself. The rows before the cut are
      // still there and still on the person's screen; the model gets the summary instead,
      // in its instructions.
      ...(thread?.summarizedThroughSeq != null
        ? { seq: { gt: thread.summarizedThroughSeq } }
        : {}),
    },
    orderBy: { seq: "asc" },
    select: {
      id: true,
      seq: true,
      role: true,
      content: true,
      toolCalls: true,
      toolCallId: true,
      toolName: true,
      elided: true,
    },
  })) as StoredMessage[];

  const elide = elisionsFor(rows);
  await markElided(db, elide);

  const summary = thread?.summary;
  return {
    instructions:
      chatSystemPrompt(MAX_MONTHS, now) +
      // A thread taken over from a background run opens on hundreds of messages the
      // model has no other way to place — including calls to tools it will not be
      // offered. It is told what it is looking at, every turn, for as long as the
      // thread lives: the takeover does not stop being where this conversation
      // started just because it has been talked in since.
      (thread?.continuedAt ? takenOverPreamble() : "") +
      (summary ? compactedPreamble(summary) : ""),
    messages: toModelMessages(rows, new Set(elide)),
  };
}

/** What one round of the loop produced. */
type StepOutcome = {
  /** What the model said out loud, assembled from the deltas. */
  text: string;
  calls: { id: string; name: string; args: string }[];
  /** Results by call id. A call missing from here was never run. */
  results: Record<string, unknown>;
  /** Cut short by a stop or a steer rather than finishing. */
  interrupted: boolean;
  /** Set when the model itself failed. Ends the turn. */
  failure?: string;
};

/**
 * One round: a completion, streamed, with its tools run as they are called.
 *
 * `isStepCount(1)` is the load-bearing setting. The SDK will happily run the whole tool
 * loop itself, and this deliberately stops it after a single model turn so the loop
 * stays out here — because out here is where the thread is re-read from the database
 * between rounds, which is what makes steering land mid-turn and elision apply to a
 * conversation that is still growing.
 *
 * Reasoning is separated from speech by the middleware in ./client, so a local model
 * thinking out loud in `<think>` tags arrives here as `reasoning-delta` and is sent on
 * as something the UI can show as thinking rather than as words the model said.
 *
 * The system prompt goes in `instructions`, not at the head of `messages`: the SDK
 * rejects a system message found among the others outright, on the grounds that where a
 * provider wants it differs and guessing gets it wrong.
 */
async function runStep(
  model: LanguageModel,
  instructions: string,
  messages: ModelMessage[],
  tools: ToolSet,
  emit: (event: TurnEvent) => void,
  signal: AbortSignal,
): Promise<StepOutcome> {
  const outcome: StepOutcome = { text: "", calls: [], results: {}, interrupted: false };

  const result = streamText({
    model,
    instructions,
    messages,
    tools,
    stopWhen: isStepCount(1),
    // A small model that fenced or double-encoded its arguments meant the right call;
    // see `repairLooseToolCall`. Anything else is left to fail as the model's mistake.
    repairToolCall: repairLooseToolCall,
    abortSignal: signal,
    timeout: LLM_TIMEOUT,
    // Warmer than the inference's 0. That run wants the same budget from the same
    // history twice; a conversation wants to not repeat itself word for word when
    // asked something a second time.
    temperature: 0.2,
  });

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          outcome.text += part.text;
          emit({ t: "delta", text: part.text });
          break;

        case "reasoning-delta":
          emit({ t: "thinking", text: part.text });
          break;

        case "tool-call": {
          const args = JSON.stringify(part.input ?? {});
          outcome.calls.push({ id: part.toolCallId, name: part.toolName, args });
          emit({ t: "tool_call", id: part.toolCallId, name: part.toolName, args });
          break;
        }

        case "tool-result":
          outcome.results[part.toolCallId] = part.output;
          emit({ t: "tool_result", id: part.toolCallId, name: part.toolName, data: part.output });
          break;

        case "tool-error": {
          // A tool the model called wrongly — bad arguments, or a name that does not
          // exist. It is told so in the conversation, where it can fix it next round,
          // which is the same rule `runTool` follows for a handler that throws.
          const data = { error: String(part.error) };
          outcome.results[part.toolCallId] = data;
          emit({ t: "tool_result", id: part.toolCallId, name: part.toolName, data });
          break;
        }

        case "abort":
          outcome.interrupted = true;
          break;

        case "error":
          outcome.failure = String(part.error);
          break;
      }
    }
  } catch (error) {
    // The signal is the arbiter, not the error's type: an abort surfaces differently
    // depending on how far the request had got, and every one of those means the same
    // thing here.
    if (signal.aborted) outcome.interrupted = true;
    else outcome.failure = error instanceof Error ? error.message : String(error);
  }

  if (signal.aborted) outcome.interrupted = true;
  return outcome;
}
