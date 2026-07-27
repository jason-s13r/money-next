// No `import "server-only"`: this is run by the worker (via lib/server/budget/run.ts)
// as well as being reachable in a request, and the worker is plain Node where
// `server-only` throws. It takes its scoped db as an argument for the same reason.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScopedDb } from "../db";
import { money } from "../money";
import { displayFxFor } from "./fx";
import { INFER_MONTHS } from "../../budget/detect";
import {
  catKey,
  dedupeProposedItems,
  parseModelContent,
  resolveProposedItems,
  type Catalog,
  type RawBudgetItem,
} from "../../budget/llm";
import type { BudgetProposal, ProposedItem } from "./infer";
import { proposeBudgetFromHistoryForWindows } from "./infer";

// Inferring a budget with a local LLM instead of hand-written pattern detection.
//
// The deterministic seeder (infer.ts) reads recurrence out of the numbers; this
// asks a model at `LLM_API` (Ollama's OpenAI-compatible endpoint) to read the same
// history and name the commitments. The model is never trusted: it only ever sees
// and returns *names*, and everything it says is mapped back to real ids and
// re-validated here before it becomes a `ProposedItem` — the identical envelope the
// deterministic path returns, so the whole downstream (create/re-infer, the
// field-by-field re-validation) is reused unchanged.
//
// History is batched by **category group**, not by time. Each group's whole span
// goes to the model in one self-contained call — so it sees every Woolworths at once
// and names a single weekly shop rather than one line per time slice, and two groups
// can never duplicate each other because their transactions are disjoint. A group
// too large for one call is split by sub-category. There is no running "model so far"
// threaded between calls: that was what let a weak model re-add the same commitment
// window after window.
//
// Availability decides which path runs: with no endpoint, or one that will not
// answer, the caller falls back to `proposeBudgetFromHistory`. So the button works
// with no model configured at all — it is just less clever.
//
// Local only. The endpoint is meant to be a model on the same machine (127.0.0.1);
// a household's whole transaction history is the payload, and it must not leave it.

/**
 * The most transactions to put in a single call. History is batched by category
 * group, not by time: each group's whole span goes to the model at once, so it sees
 * every Woolworths together and names one commitment rather than one per time slice.
 * A group with more than this many transactions is split by sub-category to stay near
 * the target — a smaller window a weak local model can actually reason over.
 */
const MAX_WINDOW_TX = clampInt(process.env.LLM_MAX_WINDOW_TX, 400, 50, 10_000);
/** How far back to read at all — never past what the deterministic path reads. */
const MAX_MONTHS = clampInt(process.env.LLM_MAX_MONTHS, INFER_MONTHS, 1, 36);
/** The model to ask for. Whatever the local runtime has pulled; overridable. */
const MODEL = process.env.LLM_MODEL?.trim() || "llama3.1";

/**
 * Where to write the full inference transcript — every message sent and every raw
 * reply — when set. Off by default, and for a reason the counts-only console log is
 * not: a transcript contains the transactions themselves (that is the whole point of
 * it), so it is opt-in and written only to a local path you name. Local machine only,
 * like the endpoint — this is a household's whole history on disk.
 */
const LOG_DIR = process.env.LLM_LOG_DIR?.trim() || null;

const LLM_TIMEOUT = clampInt(process.env.LLM_TIMEOUT, 300_000, 30_000, 600_000);
/** How many LLM windows to send in parallel. 1 keeps a small local model cool;
 *  raising it trades wall-clock for load on the endpoint. */
const MAX_CONCURRENCY = clampInt(process.env.LLM_MAX_CONCURRENCY, 1, 1, 16);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The endpoint origin, scheme filled in when the env var is bare `host:port`, and
 *  any trailing slash stripped. Null when unset — the signal to fall back. */
function baseUrl(): string | null {
  const raw = process.env.LLM_API?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** Bearer header only when a key is set — Ollama wants none, a hosted gateway does. */
function authHeader(): Record<string, string> {
  const key = process.env.LLM_API_KEY?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * Whether the LLM path can be used at all: an endpoint is configured and answers.
 *
 * A short probe of the OpenAI-compatible `/v1/models`, guarded by a tight timeout
 * so a dead or wrong `LLM_API` costs a couple of seconds, not a hung request. Any
 * failure — unset, unreachable, non-2xx — reads as "not available" and the caller
 * takes the deterministic path.
 */
export async function isLlmAvailable(): Promise<boolean> {
  const base = baseUrl();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: authHeader(),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type ChatMessage = { role: "system" | "user"; content: string };

/** One chat completion, JSON-constrained, deterministic. Throws on a non-2xx or a
 *  timeout, which `inferViaLLM` lets propagate so the caller can fall back. */
async function chat(messages: ChatMessage[], base: string): Promise<string> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({
      model: MODEL,
      messages,
      // Zero temperature: the same history should propose the same budget twice.
      temperature: 0,
      // Ask for a JSON object; every path below still parses defensively, because
      // "asked for JSON" is not "got valid JSON" with a local model.
      response_format: { type: "json_object" },
      stream: false,
    }),
    // Generous: a small local model chews through a window slowly, and this runs
    // server-side off a button press, not in a hot path.
    signal: AbortSignal.timeout(LLM_TIMEOUT),
  });
  if (!res.ok) {
    // The status line alone ("400 Bad Request") says nothing about *why* — the
    // reason a server like ollama or llama.cpp gives (an unknown field, a model
    // that won't load, an unsupported option) is in the body. Read it, keep it to
    // one line, and cap it so a stray HTML error page can't swamp the log.
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
    throw new Error(`LLM ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

// --- Gather history, batch by group, resolve. ------------------------------

/** The transaction fields the model is given. The group is stated once per window,
 *  not repeated on every row, so it is not carried here. */
type TxRow = {
  date: string;
  amount: number;
  type: string;
  category: string | null;
  merchant: string | null;
  account: string | null;
  description: string;
  reference: string | null;
  particulars: string | null;
  code: string | null;
  /** Last digits of the card used, when there was one. A payee that covers several
   *  commitments (two mobile lines on one account) often differs only here. */
  cardSuffix: string | null;
};

/** One call's worth of history: transactions from a single group (and, when a group
 *  was split, a single sub-category), with the labels needed to focus the prompt. */
type Window = {
  groupId: string;
  groupName: string;
  /** Set when the window is exactly one sub-category, so it can be stamped rather
   *  than left to the model to choose. Null for a whole-group or packed window. */
  categoryName: string | null;
  /** The categories present, offered to the model as the only names it may use.
   *  Empty when the window is a single stamped category or has none. */
  categoryNames: string[];
  txns: TxRow[];
};

const SYSTEM_PROMPT = `You are a personal-finance assistant that builds a budget from a household's bank transactions.

You are given every transaction from a single spending area over the last ${MAX_MONTHS} months.
Identify the ongoing commitments set of named budget items.

Rules:
- Aim for one item per distinct commitment. A merchant may have multiple commitments, eg same service provider billed separately for home internet and several mobile phones.
- Group a run of transactions by their merchant or payee where there is a clear one; that shared payee is usually the commitment.
- Do not invent spending the transactions do not show.
- If a service provider was replaced by a new one — the old one stops and a similar new one begins — treat the current provider as the single ongoing commitment.
- Ignore commitments that clearly stopped and are no longer ongoing.
- Bias to higher spending, especially when grouping expense transactions into a single item.
- Bias to lower earning, especially when combining disperate miscellaneous income sources into a single item.

For each item: "direction" is "income" or "expense"; "amount" is the typical amount of a SINGLE occurrence in the household's display currency; "frequency" is one of once|day|week|month|quarter|year; "interval" is a whole number of those steps; "anchorDate" is a representative YYYY-MM-DD it falls on; "category" is one of the allowed category names, or omitted if none fits; "merchant" is the payee if there is a clear one; "basis" is a short note on the evidence.

ONLY output JSON to avoid causing parse errors. DO NOT use markdown or any other text.
Reply with raw JSON only: {"items":[{"name","direction","amount","frequency","interval","anchorDate","category","merchant","basis"}]}.`;

/**
 * Worker log line for the inference, indented under the `=== budget inference ===`
 * header scripts/drain.ts prints. Counts and date ranges only — the transactions
 * themselves go to the model but must not go to this log. The opt-in transcript
 * (`LLM_LOG_DIR`) is where the full conversation, contents and all, may be kept.
 */
const log = (message: string) => console.log(`  [llm] ${message}`);

/** Per-window chat log plus the run directory used to build combined.log at the end. */
type Transcript = {
  dir: string;
  write: (windowFile: string, section: string) => Promise<void>;
  combine: (sections: string[]) => Promise<void>;
};

/**
 * Open a transcript directory for one run under `LLM_LOG_DIR`, or return null when
 * logging is off. Each window gets its own `chat-{category}.log`, and after all
 * windows finish they are concatenated into `combined.log`. A crash mid-run still
 * leaves the per-window files, which is exactly when the transcript earns its keep.
 * The files hold transaction contents; they are local debugging artifacts.
 */
async function openTranscript(now: Date): Promise<Transcript | null> {
  if (!LOG_DIR) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = path.join(LOG_DIR, "budget-inferences", `inference-${stamp}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });

  return {
    dir,
    write: async (windowFile, section) => {
      await appendFile(path.join(dir, windowFile), section);
    },
    combine: async (windowFiles) => {
      const combined: string[] = [];
      for (const file of windowFiles) {
        try {
          combined.push(await readFile(path.join(dir, file), "utf8"));
        } catch {
          // A window that errored before writing anything is simply omitted.
        }
      }
      await writeFile(path.join(dir, "combined.log"), combined.join("\n"));
    },
  };
}

/** The messages sent for one window, verbatim — the point is to see exactly what the
 *  model saw. Written before the call, so a window that hangs still leaves its input. */
function renderSent(heading: string, messages: ChatMessage[]): string {
  const sent = messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  return `\n\n========== ${heading} ==========\n${sent}\n`;
}

/** The model's raw reply for the window just sent, written once it comes back. */
function renderReply(reply: string, seconds: string): string {
  return `\n---------- reply (${seconds}s) ----------\n${reply}\n`;
}

/**
 * Read history, batch it by category group, and return the same `BudgetProposal`
 * the deterministic seeder does.
 *
 * Throws if the endpoint is unset or fails mid-run; callers wrap this in a
 * try/`isLlmAvailable` and fall back to `proposeBudgetFromHistory`, so a model that
 * dies halfway never leaves the button broken.
 */
export async function inferViaLLM(
  db: ScopedDb,
  now: Date = new Date(),
): Promise<BudgetProposal> {
  const base = baseUrl();
  if (!base) throw new Error("LLM_API is not configured");
  const baseUrlValue: string = base;

  const cutoff = new Date(now.getTime() - MAX_MONTHS * 30.44 * 86_400_000);

  // The same transfer exclusion the deterministic path and the rest of the app use:
  // a transfer is neither income nor spending. Every category and type is otherwise
  // in scope — only an uncategorised row is dropped, since it carries no group to
  // file a budget under.
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
      categoryGroupId: { not: null },
    },
    orderBy: { date: "desc" },
    select: {
      date: true,
      amount: true,
      type: true,
      categoryGroupId: true,
      categoryGroup: { select: { name: true } },
      categoryId: true,
      category: { select: { name: true } },
      merchant: { select: { name: true } },
      account: { select: { name: true, currency: true } },
      description: true,
      reference: true,
      particulars: true,
      code: true,
      cardSuffix: true,
    },
  });

  const { currency, toDisplay } = await displayFxFor(db);

  // Amounts are converted to the display currency up front, so the model reasons in
  // one currency and its output amounts need no per-row rate applied back. Rows are
  // bucketed by their group (and their sub-category, for the split) as they are read.
  const byGroup = new Map<
    string,
    { name: string; rows: { categoryId: string; categoryName: string | null; tx: TxRow }[] }
  >();
  let count = 0;
  let oldest = Infinity;
  for (const r of rows) {
    if (!r.categoryGroupId || !r.categoryGroup) continue;
    count++;
    oldest = Math.min(oldest, r.date.getTime());
    const tx: TxRow = {
      date: r.date.toISOString().slice(0, 10),
      amount: Math.round(toDisplay(money(r.amount), r.account.currency, r.date) * 100) / 100,
      type: r.type,
      category: r.category?.name ?? null,
      merchant: r.merchant?.name ?? null,
      account: r.account.name ?? null,
      description: r.description,
      reference: r.reference,
      particulars: r.particulars,
      code: r.code,
      cardSuffix: r.cardSuffix,
    };
    const group = byGroup.get(r.categoryGroupId) ?? { name: r.categoryGroup.name, rows: [] };
    group.rows.push({ categoryId: r.categoryId ?? "", categoryName: r.category?.name ?? null, tx });
    byGroup.set(r.categoryGroupId, group);
  }

  const monthsOfHistory =
    count === 0 ? 0 : Math.min(MAX_MONTHS, Math.round((now.getTime() - oldest) / (30.44 * 86_400_000)));
  const envelope = { monthsOfHistory, transactions: count, currency };

  if (count === 0) return { items: [], ...envelope };

  const catalog = await loadCatalog(db);
  const windows = buildWindows(byGroup);

  const header =
    `model ${MODEL} at ${base} — ${count} txns over ~${monthsOfHistory}mo in ${byGroup.size} ` +
    `groups, ≤${MAX_WINDOW_TX}/window (${windows.length} windows), currency ${currency}`;
  log(header);

  const transcript = await openTranscript(now);
  if (transcript) {
    log(`transcript → ${transcript.dir}`);
  }

  // Each window is one self-contained call: all of one group's history (or one
  // sub-category of it). The group — and, for a split, the sub-category — is stamped
  // onto whatever the model returns, so a model that names the wrong group cannot
  // file spending where it does not belong.
  const all: ProposedItem[] = [];
  const failedWindows: Window[] = [];
  const windowFiles: string[] = [];

  async function runWindow(window: Window, index: number): Promise<void> {
    const focus = window.categoryName ? `${window.groupName} · ${window.categoryName}` : window.groupName;
    const heading = `window ${index}/${windows.length} ${focus}`;
    log(`${heading}: sending ${window.txns.length} txns…`);

    const windowFile = `chat-${safeFileName(focus)}.log`;
    windowFiles[index - 1] = windowFile;

    const messages = promptFor(window);
    // The input goes down before the call, the reply after — so a window that hangs
    // or errors is still in the transcript with everything that was sent to it.
    await transcript?.write(windowFile, renderSent(heading, messages));

    let content: string;
    let seconds: string;
    try {
      const startedAt = Date.now();
      content = await chat(messages, baseUrlValue);
      seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`${heading}: failed — ${reason}`);
      failedWindows.push(window);
      await transcript?.write(windowFile, `\n---------- failed ----------\n${reason}\n`);
      return;
    }

    await transcript?.write(windowFile, renderReply(content, seconds!));

    // Record the raw model reply verbatim in the worker log too when a window fails
    // to parse, so the console log (which may be the only artifact) still contains
    // the exact text that caused the parse error. The transcript already has it, but
    // it is opt-in; this makes every deployment self-debugging for bad JSON.
    const raw = parseModelContent(content).map((item) => stampGroup(item, window));
    if (raw.length === 0 && content.trim().length > 0) {
      log(`${heading}: reply did not parse — ${content.replace(/\s+/g, " ").slice(0, 500)}`);
    }
    const resolved = resolveProposedItems(raw, catalog, now);
    if (resolved.length > 0) {
      all.push(...resolved);
      log(`${heading}: ${resolved.length} items in ${seconds!}s`);
    } else {
      log(`${heading}: nothing usable in ${seconds!}s`);
    }
  }

  await runWithConcurrency(windows, MAX_CONCURRENCY, runWindow);

  // For any window that timed out or errored, fall back to the deterministic
  // detector for just that window's transactions. This keeps the successful LLM
  // results while still producing a full proposal when the endpoint struggles.
  if (failedWindows.length > 0) {
    log(`${failedWindows.length} window(s) failed — falling back to deterministic detection for those groups`);
    const fallback = await proposeBudgetFromHistoryForWindows(db, now, failedWindows);
    all.push(...fallback.items);
  }

  // Collapse any repeats the model still left within a window, then biggest first —
  // matching the deterministic proposal's order, the rows worth checking on top.
  const items = dedupeProposedItems(all).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  log(`resolved ${items.length} budget items across ${byGroup.size} groups`);
  if (transcript) {
    const lines = items.map((i) => `  ${i.name} — ${i.amount} ${i.cadence}`).join("\n");
    await transcript.write("combined.log", `# budget inference — ${now.toISOString()}\n${header}\n`);
    await transcript.combine(windowFiles);
    await transcript.write("combined.log", `\n\n========== resolved ${items.length} budget items ==========\n${lines}\n`);
  }
  return { items, ...envelope };
}

/**
 * Turn each group's transactions into the windows sent to the model.
 *
 * A group at or under the target is one window. A larger one is split by
 * sub-category and the sub-buckets packed greedily back up to the target, so a group
 * of many small categories is a few calls rather than one per category — while a
 * single sub-category over the target stands alone (there is nothing finer to split
 * it by, so it is sent oversized rather than dropped).
 */
function buildWindows(
  byGroup: Map<
    string,
    { name: string; rows: { categoryId: string; categoryName: string | null; tx: TxRow }[] }
  >,
): Window[] {
  const windows: Window[] = [];

  for (const [groupId, group] of byGroup) {
    if (group.rows.length <= MAX_WINDOW_TX) {
      windows.push({
        groupId,
        groupName: group.name,
        categoryName: null,
        categoryNames: distinctCategories(group.rows),
        txns: group.rows.map((r) => r.tx),
      });
      continue;
    }

    const bySub = new Map<string, { name: string | null; txns: TxRow[] }>();
    for (const r of group.rows) {
      const sub = bySub.get(r.categoryId) ?? { name: r.categoryName, txns: [] };
      sub.txns.push(r.tx);
      bySub.set(r.categoryId, sub);
    }

    // Largest sub-buckets first, so packing is stable and predictable.
    const subs = [...bySub.values()].sort((a, b) => b.txns.length - a.txns.length);
    let current: Window | null = null;
    const flush = () => {
      if (current) windows.push(current);
      current = null;
    };

    for (const sub of subs) {
      if (sub.txns.length >= MAX_WINDOW_TX) {
        windows.push({
          groupId,
          groupName: group.name,
          categoryName: sub.name,
          categoryNames: sub.name ? [sub.name] : [],
          txns: sub.txns,
        });
        continue;
      }
      if (current && current.txns.length + sub.txns.length > MAX_WINDOW_TX) flush();
      if (!current) {
        current = { groupId, groupName: group.name, categoryName: null, categoryNames: [], txns: [] };
      }
      current.txns.push(...sub.txns);
      if (sub.name) current.categoryNames.push(sub.name);
    }
    flush();
  }

  // A packed window that ended up holding one category is a single-category window
  // after all — stamp it, so the model needn't (and cannot mis-) choose.
  for (const w of windows) {
    if (w.categoryName === null && w.categoryNames.length === 1) w.categoryName = w.categoryNames[0];
  }
  return windows;
}

/** The distinct category names in a bucket, order-stable, for the prompt's allow-list. */
function distinctCategories(rows: { categoryName: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.categoryName) seen.add(r.categoryName);
  return [...seen];
}

/** The two messages for one window: the fixed rules, and this group's history with
 *  the group named and its categories offered as the only ones the model may use. */
function promptFor(window: Window): ChatMessage[] {
  const lines = [`These transactions are all from the "${window.groupName}" spending area.`];
  if (window.categoryName) {
    lines.push(`They are all in the "${window.categoryName}" category; use that category for every item.`);
  } else if (window.categoryNames.length > 0) {
    lines.push(`Allowed category names: ${window.categoryNames.join(", ")}.`);
  }
  lines.push(`Transactions (JSON):\n${JSON.stringify(window.txns)}`);
  lines.push("Return the budget items as JSON.");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n\n") },
  ];
}

/** Stamp the window's known group (and single category, if any) onto a model row, so
 *  resolution files it where its transactions actually came from rather than where a
 *  hallucinated group/category name would send it. */
function stampGroup(item: RawBudgetItem, window: Window): RawBudgetItem {
  return {
    ...item,
    group: window.groupName,
    category: window.categoryName ?? item.category,
  };
}

/** Make a string safe for a filename: alphanumerics, spaces, dashes and dots only. */
function safeFileName(name: string): string {
  return name
    .replace(/[^\w\s.-]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

/** Run an async task for each item, keeping at most `concurrency` in flight. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (concurrency <= 1) {
    let index = 0;
    for (const item of items) await task(item, ++index);
    return;
  }

  return new Promise((resolve, reject) => {
    let index = 0;
    let running = 0;
    let done = false;

    const next = () => {
      if (done) return;
      if (index >= items.length) {
        if (running === 0) resolve();
        return;
      }

      const currentIndex = index++;
      running++;
      task(items[currentIndex], currentIndex + 1)
        .then(() => {
          running--;
          next();
        })
        .catch((error) => {
          done = true;
          reject(error);
        });

      if (running < concurrency) next();
    };

    next();
  });
}

/** Build the name→id lookups from the catalog and this workspace's merchants. */
async function loadCatalog(db: ScopedDb): Promise<Catalog> {
  const [groups, categories, merchants] = await Promise.all([
    db.categoryGroup.findMany({ select: { id: true, name: true } }),
    db.category.findMany({ select: { id: true, name: true, groupId: true } }),
    db.merchant.findMany({ select: { id: true, name: true } }),
  ]);

  return {
    groups: new Map(groups.map((g) => [g.name.toLowerCase(), { id: g.id, name: g.name }])),
    categories: new Map(
      categories
        .filter((c): c is typeof c & { groupId: string } => c.groupId !== null)
        .map((c) => [catKey(c.groupId, c.name), { id: c.id, name: c.name }]),
    ),
    merchants: new Map(merchants.map((m) => [m.name.toLowerCase(), { id: m.id, name: m.name }])),
  };
}
