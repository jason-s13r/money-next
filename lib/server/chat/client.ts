// No `import "server-only"`: this is reached from the worker (scripts/drain.ts →
// lib/server/budget/run.ts → the budget inference) as well as from a request (the
// chat turn endpoint), and the worker is plain Node where `server-only` throws.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

import { INFER_MONTHS } from "../../budget/detect";

// The connection to the local model, and the knobs both callers share.
//
// This started life inside lib/server/budget/llm.ts, where the only conversation was
// the budget inference's. There are two now — that one, still headless and run by the
// worker, and the interactive chat — and they must talk to the same endpoint with the
// same timeouts and the same idea of what "available" means, so it lives here rather
// than being copied.
//
// Local only. The endpoint is meant to be a model on the same machine (127.0.0.1); a
// household's whole transaction history is the payload, and it must not leave it.

/** The model to ask for. Whatever the local runtime has pulled; overridable. */
export const MODEL = process.env.LLM_MODEL?.trim() || "llama3.1";

/**
 * How many rounds of the tool loop before a conversation is cut off. A round is one
 * model turn plus whatever tools it asked for, so a household of twenty areas read
 * and proposed for is well inside the default; the cap is here to stop a model that
 * has started looping from talking to itself all afternoon.
 */
export const MAX_STEPS = clampInt(process.env.LLM_MAX_STEPS, 150, 4, 1_000);

/** How far back the tools may read at all — never past the deterministic path's. */
export const MAX_MONTHS = clampInt(process.env.LLM_MAX_MONTHS, INFER_MONTHS, 1, 36);

/**
 * The most transactions one tool result may hold. The model pages through anything
 * larger, which is the point: a window small enough for a weak local model to reason
 * over, chosen by the thing doing the reasoning.
 */
export const MAX_TOOL_ROWS = clampInt(
  process.env.LLM_MAX_TOOL_ROWS ?? process.env.LLM_MAX_WINDOW_TX,
  400,
  20,
  10_000,
);

export const LLM_TIMEOUT = clampInt(process.env.LLM_TIMEOUT, 300_000, 30_000, 600_000);

/** How long the "is anything there?" probe waits. Deliberately tiny compared to
 *  `LLM_TIMEOUT`: a wrong or dead `LLM_API` must cost a page load a couple of seconds,
 *  not a couple of minutes. */
const PROBE_TIMEOUT = 2_000;

export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The endpoint's OpenAI-compatible base, scheme filled in when the env var is bare
 *  `host:port`, trailing slash stripped, and `/v1` appended unless it is already
 *  there. Null when unset — the signal to fall back. */
export function baseUrl(): string | null {
  const raw = process.env.LLM_API?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  const origin = withScheme.replace(/\/+$/, "");
  return /\/v\d+$/.test(origin) ? origin : `${origin}/v1`;
}

/**
 * Whether `baseUrl()` resolves to a loopback or private address.
 *
 * The prompt is a household's whole transaction history, and it must not leave
 * the machine. An operator can point `LLM_API` at a remote endpoint by mistake
 * (or deliberately, for a hosted inference provider); this check enforces
 * loopback/private by default and allows an opt-out via `LLM_ALLOW_REMOTE=true`
 * for the legitimate remote case. Called at the start of `languageModel` and
 * `modelIds` — the two entry points that issue requests — so a misconfiguration
 * is caught before any prompt is sent.
 */
export function isLoopback(): boolean {
  if (process.env.LLM_ALLOW_REMOTE === "true") return true;
  const base = baseUrl();
  if (!base) return true; // null → no endpoint, not a remote one
  try {
    return isLocalHostname(new URL(base).hostname);
  } catch {
    return false; // an unparseable URL is not loopback
  }
}

/**
 * Whether a URL hostname names something on this machine or this network.
 *
 * Split out from `isLoopback` so it can be tested against a list of hostnames
 * without touching the environment, which is the only way the interesting cases
 * — the ones that *look* private and are not — get written down.
 *
 * The order is deliberate. An IPv4 literal is decided by its octets and nothing
 * else; anything that is not a literal is decided by its label count. Matching
 * the private ranges as a *prefix* of an arbitrary hostname is the trap here:
 * `10.evil.com` and `192.168.attacker.net` are ordinary registrable domains that
 * resolve wherever their owner points them, and a prefix test would have called
 * both of them local and handed over the household's transaction history.
 */
export function isLocalHostname(host: string): boolean {
  // `new URL().hostname` brackets an IPv6 literal; accept both spellings since
  // this is exported and callers may hand over either.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "::1") return true;
  // Any other IPv6 literal is out of scope: unique-local (fc00::/7) and
  // link-local (fe80::/10) exist, but nothing in this project's deployment story
  // reaches the model over IPv6, and guessing at half a parser is worse than
  // making the operator set LLM_ALLOW_REMOTE.
  if (bare.includes(":")) return false;

  const octets = bare.split(".");
  const isIpv4 =
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);

  if (isIpv4) {
    const [a, b] = octets.map(Number);
    return (
      a === 127 || // loopback, the whole /8
      a === 0 || // 0.0.0.0 and the rest of "this network"
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // link-local
    );
  }

  // A single-label hostname — `localhost`, `homelab`, a Docker compose service
  // name — is inherently local: it resolves via the hosts file or a local
  // resolver and is never internet-routable. This covers the common self-hosted
  // case where the model runs on another machine on the same LAN, addressed by
  // name rather than IP. `.localhost` and `.local` are reserved for the same
  // purpose (RFC 6761, RFC 6762) and are safe to add to that.
  const lower = bare.toLowerCase().replace(/\.$/, "");
  return (
    !lower.includes(".") ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  );
}

/** Ollama and llama.cpp want no key at all; a hosted-style endpoint behind a proxy
 *  might. Sent when there is one, omitted when there is not. */
function authHeaders(): Record<string, string> {
  const key = process.env.LLM_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * The endpoint's model list, or a throw — the two things the callers below need to tell
 * apart.
 *
 * A hand-rolled fetch rather than a client library, because this is the only request in
 * the app the AI SDK does not make for us, and pulling a whole provider SDK back in for
 * one GET of `/v1/models` is not a trade worth making. The tight `AbortSignal.timeout`
 * is the point of the function as much as the parsing is.
 */
async function modelIds(): Promise<string[]> {
  const base = baseUrl();
  if (!base) throw new Error("LLM_API is not configured");
  if (!isLoopback()) throw new Error("LLM_API points at a non-local address. Set LLM_ALLOW_REMOTE=true to allow it.");

  const response = await fetch(`${base}/models`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(PROBE_TIMEOUT),
  });
  if (!response.ok) throw new Error(`${base}/models answered ${response.status}`);

  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? []).map((model) => model.id).filter((id): id is string => !!id);
}

/**
 * A model to talk to, by name, ready to be handed to `streamText`.
 *
 * Two things are wrapped around the bare endpoint here, and both are about small local
 * models rather than about the SDK:
 *
 *   - **Reasoning is extracted from `<think>` tags.** A hosted model returns its
 *     thinking in a field of its own; a local one usually just says it out loud at the
 *     top of the answer, wrapped in a tag, and without this the tag and everything in it
 *     lands in the conversation as if the model had said it to the person. The
 *     middleware lifts it out into reasoning parts, which is what lets the UI show the
 *     thinking as thinking — and what makes it elidable later, since nobody wants a
 *     thread's context spent on the model's throat-clearing from an hour ago.
 *
 *   - **The name is a parameter, not a constant.** `LLM_MODEL` is still the default, but
 *     a thread may pin its own; a runtime with three models pulled should not need an
 *     environment variable and a restart to try the other two.
 *
 * Null when no endpoint is configured — the signal to fall back.
 */
export function languageModel(model: string = MODEL): LanguageModel | null {
  const baseURL = baseUrl();
  if (!baseURL) return null;
  if (!isLoopback()) {
    console.error(
      "[chat] LLM_API points at a non-local address. The prompt carries the household's transaction history; " +
        "set LLM_ALLOW_REMOTE=true only if you intend a remote inference endpoint.",
    );
    return null;
  }

  const provider = createOpenAICompatible({
    name: "local",
    baseURL,
    apiKey: process.env.LLM_API_KEY?.trim() || "no-key-required",
  });

  return wrapLanguageModel({
    model: provider(model),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/**
 * The models the endpoint will actually serve, for choosing between.
 *
 * Straight from `/v1/models` rather than a list of our own: what is available is
 * whatever has been pulled onto the machine, which is not something this app can know
 * and not something it should make someone retype. Empty on any failure — an
 * unreachable endpoint is handled by `isLlmAvailable`, and a picker with nothing in it
 * is a picker that quietly does not appear.
 */
export async function availableModels(): Promise<string[]> {
  try {
    return (await modelIds()).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Whether the LLM path can be used at all: an endpoint is configured and answers.
 *
 * A short probe of `/v1/models`, guarded by a tight timeout so a dead or wrong
 * `LLM_API` costs a couple of seconds, not a hung request. Any failure — unset,
 * unreachable, non-2xx — reads as "not available". The budget inference takes the
 * deterministic path on a false; the chat page says the model is unreachable rather
 * than offering a conversation that cannot happen.
 */
export async function isLlmAvailable(): Promise<boolean> {
  try {
    await modelIds();
    return true;
  } catch {
    return false;
  }
}
