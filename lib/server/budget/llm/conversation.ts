import { generateText, isStepCount, type LanguageModel, type ModelMessage } from "ai";

import {
  LLM_TIMEOUT,
  MAX_STEPS,
} from "../../chat/client";
import {
  repairLooseToolCall,
  toolsForSdk,
  type Area,
  type Tool,
  type ToolContext,
} from "../../chat/tools";
import { listSpendingAreas, getTransactions, readTransactions } from "../../chat/tools/read";

import type { ProposedItem } from "../infer";
import type { InferenceLog } from "../inference-log";

import { SYSTEM_PROMPT } from "./prompt";
import { log } from "./log";
import { proposeItems, salvageFromText } from "./propose";
import { elideServedRows } from "./elide";

/**
 * The tool-calling loop: one conversation that builds the whole budget.
 *
 * Each round is a completion, then whatever tools it asked for, answered and fed
 * back. It ends when the model calls `finish`, when it stops calling tools and every
 * area has been proposed for, or when the step cap is hit — whichever comes first.
 * A model that replies with nothing to do while areas remain is nudged with the list
 * of them, twice; past that it is taken at its word and the rest is left to the
 * deterministic fallback.
 *
 * Only a transport failure escapes: a tool call that is malformed, names an area
 * that does not exist, or proposes an item that will not resolve is answered with
 * the error, in the conversation, where the model can act on it. That discipline lives
 * in `toolsForSdk`; the two tools defined below are the ones specific to this run.
 *
 * `generateText` rather than the chat's `streamText`, and `isStepCount(1)` for the same
 * reason the chat uses it: the SDK would happily run the tool loop itself, and the loop
 * has to stay out here, because eliding a finished area's transactions means reaching
 * into the conversation *between* rounds. Nobody is watching a worker run *live*, so
 * there is nothing to stream to — but each round is written to `into` as it completes,
 * which is how it can be read afterwards, or while it is still going.
 */
export async function runConversation({
  model,
  ctx,
  into,
}: {
  model: LanguageModel;
  ctx: ToolContext;
  into: InferenceLog | null;
}): Promise<{
  items: ProposedItem[];
  coveredAreas: Set<string>;
  name: string | null;
  stopped: boolean;
}> {
  const { areas, monthsOfHistory } = await ctx.history();

  const items: ProposedItem[] = [];
  const coveredAreas = new Set<string>();
  let name: string | null = null;
  let stopped = false;
  const servedRows = new Map<string, string[]>();
  let proposeCalls = 0;
  let nudges = 0;
  let finished = false;

  const pendingElision: Area[] = [];

  const trackingGetTransactions: Tool = {
    ...getTransactions,
    async handler(args, context, { toolCallId }) {
      const read = await readTransactions(args, context);
      if (read.area) {
        const served = servedRows.get(read.area.groupId) ?? [];
        servedRows.set(read.area.groupId, [...served, toolCallId]);
      }
      return read.result;
    },
  };

  const proposeItemsTool: Tool = {
    name: "propose_items",
    description:
      "Commit the ongoing commitments you found in one spending area. Answers with what was accepted and what was rejected, and why. Call once per area, after you have read it.",
    parameters: {
      type: "object",
      properties: {
        area: {
          type: "string",
          description: "The spending area these items belong to, exactly as it was named.",
        },
        items: {
          type: "array",
          description: "The commitments. One entry per distinct commitment.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "What the household would call this commitment, eg 'Weekly shop'.",
              },
              direction: { type: "string", enum: ["income", "expense"] },
              amount: {
                type: "number",
                description:
                  "The typical amount of a SINGLE occurrence, positive, in the household's display currency.",
              },
              frequency: {
                type: "string",
                enum: ["once", "day", "week", "month", "quarter", "year"],
              },
              interval: {
                type: "integer",
                description: "A whole number of those steps, eg 2 with 'week' for fortnightly.",
              },
              anchorDate: {
                type: "string",
                description: "A representative YYYY-MM-DD the commitment falls on.",
              },
              category: {
                type: "string",
                description: "One of the area's category names, or omitted when none of them fits.",
              },
              merchant: { type: "string", description: "The payee, when there is a clear one." },
              basis: { type: "string", description: "A short note on the evidence for this." },
            },
            required: ["name", "direction", "amount", "frequency", "anchorDate"],
          },
        },
      },
      required: ["area", "items"],
    },
    async handler(args, context) {
      const { byName } = await context.history();
      const outcome = proposeItems(args, byName, context.catalog, context.now, ++proposeCalls);
      if (outcome.area && outcome.accepted.length > 0) {
        items.push(...outcome.accepted);
        coveredAreas.add(outcome.area.groupId);
        pendingElision.push(outcome.area);
        log(
          `${outcome.area.name}: ${outcome.accepted.length} items accepted` +
            `${outcome.rejected.length > 0 ? `, ${outcome.rejected.length} rejected` : ""}`,
        );
      }
      return outcome.result;
    },
  };

  const finishTool: Tool = {
    name: "finish",
    description:
      "Call when every spending area has been proposed for and the budget is done. Name it here — you are the only thing that has seen what went into it.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "What to call this budget, as the household would: what it covers, in two or three words. Not a date, and not the word 'default'.",
        },
        summary: { type: "string", description: "One line on what the budget covers." },
      },
      required: ["name"],
    },
    handler(args) {
      finished = true;
      const named = typeof args.name === "string" ? args.name.trim() : "";
      if (named) name = named.slice(0, 80);
      return { ok: true };
    },
  };

  const tools = toolsForSdk(
    [listSpendingAreas, trackingGetTransactions, proposeItemsTool, finishTool],
    ctx,
  );

  const brief =
    `Build this household's budget. There are ${areas.size} spending areas and ` +
    `~${monthsOfHistory} months of history; amounts are all in ${ctx.currency}. ` +
    `Start with list_spending_areas.`;
  const messages: ModelMessage[] = [{ role: "user", content: brief }];
  await into?.asked(brief);

  for (let step = 1; step <= MAX_STEPS && !finished; step++) {
    const said = await into?.heard();
    if (said && said.length > 0) {
      for (const line of said) messages.push({ role: "user", content: line });
      log(`picked up ${said.length} message(s) from the person watching at step ${step}`);
    }

    if (await into?.stopRequested()) {
      stopped = true;
      const note =
        `Stopped at your request after ${step - 1} step(s), with ` +
        `${coveredAreas.size}/${areas.size} areas proposed for. Building the budget from that.`;
      log(note);
      await into?.note(note);
      break;
    }

    const startedAt = Date.now();
    const reply = await generateText({
      model,
      instructions: SYSTEM_PROMPT,
      messages,
      tools,
      stopWhen: isStepCount(1),
      repairToolCall: repairLooseToolCall,
      timeout: LLM_TIMEOUT,
      temperature: 0,
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    messages.push(...reply.responseMessages);

    await into?.said(
      reply.text,
      reply.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        input: call.input,
      })),
    );
    const answers = new Map(reply.toolResults.map((r) => [r.toolCallId, r.output as unknown]));
    for (const call of reply.toolCalls) {
      await into?.answered(
        { id: call.toolCallId, name: call.toolName },
        answers.has(call.toolCallId)
          ? answers.get(call.toolCallId)
          : { error: "This call did not run — the arguments did not match the tool's schema." },
      );
    }

    if (reply.toolCalls.length === 0) {
      const salvaged = salvageFromText(reply.text, ctx.catalog, ctx.now, ++proposeCalls);
      if (salvaged.length > 0) {
        items.push(...salvaged);
        for (const item of salvaged) coveredAreas.add(item.groupId);
        const note = `${salvaged.length} items salvaged from a text reply that called no tool`;
        log(`step ${step}: ${note} in ${seconds}s`);
        await into?.note(note);
      }

      const remaining = [...areas.values()].filter((a) => !coveredAreas.has(a.groupId));
      if (remaining.length === 0 || nudges >= 2) break;
      nudges++;
      const naming = remaining.slice(0, 12).map((a) => a.name).join(", ");
      const nudge =
        `${remaining.length} spending area(s) still have no budget items: ${naming}` +
        `${remaining.length > 12 ? ", …" : ""}. Read the next one with get_transactions and ` +
        `call propose_items for it, or call finish if there is genuinely nothing to budget there.`;
      messages.push({ role: "user", content: nudge });
      await into?.asked(nudge);
      continue;
    }

    let closed: Area | undefined;
    while ((closed = pendingElision.shift())) {
      await into?.elide(elideServedRows(messages, servedRows, closed));
    }
  }

  if (!finished && !stopped) {
    const note = `conversation ended without finish (${coveredAreas.size}/${areas.size} areas proposed for)`;
    log(note);
    await into?.note(note);
  }
  return { items, coveredAreas, name, stopped };
}
