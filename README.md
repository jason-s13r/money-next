# Money

A personal finance dashboard that mirrors your New Zealand bank accounts from [Akahu](https://akahu.nz) into a local Postgres database, then gives you fast, offline views of net worth, spending, income, and transactions.

Built with [Next.js](https://nextjs.org) 16, React 19, TypeScript, Tailwind CSS 4, Prisma 7, and Postgres.

## What it does

- **Dashboard** — net worth split into accessible, liquid, and locked balances; emergency and forecasted runway; a credit-facility meter; and a warning banner for uncategorised spending.
- **Income and spending breakdown** — compare periods (day, week, month, quarter, year, or NZ tax year) with stacked bars and a drillable table down to category, subcategory, and merchant.
- **Money flow** — the same period as a Sankey, left to right: who paid you, what that income was, the groups it went out through, what it was spent on, and who finally received it. A "Savings" node absorbs a surplus or funds a deficit so the two sides balance, and anything too small to name folds into an "Other" bucket that still goes on to name its merchants.
- **Budgets** — plan expected income and spending as recurring items, or infer a starting budget from your own history (deterministically, or with an optional local LLM). A budget is a **base** — the ongoing plan — with optional seasonal **layers** that add on top only within their own window (a Christmas layer that applies each December). The budget-vs-actual view anchors on a base and folds in its active layers, comparing the plan against what actually happened.
- **Forecasts** — a base budget flagged as a forecast is walked forward day by day, together with its active layers, and drawn as a forward runway line on the dashboard.
- **Chat** — ask the local model about your money, in a thread it can read from and (with permission) write budgets, categories, labels and rules through. Threads are private to their author.
- **Transactions** — a searchable recent list, plus a listing of its own keyed by account, category group, category, merchant, label, card suffix, or Akahu type, all rendering through the same table. Bulk actions apply a category, merchant or label to a whole selection. Each transaction has a detail page for editing merchant/category, linking transfers, tagging, teaching automation rules, and reading its own change history. Pending (not-yet-settled) rows are mirrored alongside the settled ones.
- **Uncategorised queue** — everything the sync and the rules could not file, as a working list.
- **Merchants and labels** — an index of every merchant that tags at least one transaction (with the ones you minted yourself flagged), and of your own free-text labels, each with its own listing.
- **Accounts** — list of connected accounts with balances, available funds, and transaction counts; per-account transaction history with running balances.
- **Rules** — a GoRules Zen decision graph that auto-enriches transactions (category, merchant, transfer linking). Rules are taught from a single classified transaction and run automatically on every sync.
- **Sync history** — audit log of every ingest run, with manual refresh and full historical sync buttons.
- **Workspaces and members** — data lives in a workspace; people are invited into one with an owner/editor/viewer role, and Postgres Row-Level Security is what actually keeps one workspace out of another's rows.

## Data model

The local Postgres mirror is the source of truth for the UI. Akahu ids are used as primary keys so re-syncing is idempotent.

Money is stored as `numeric(19, 4)` so sums are exact, and converted to plain numbers at the read boundary ([lib/server/money.ts](lib/server/money.ts)) — nothing above the query layer handles a `Decimal`.

Every tenant table carries a `workspaceId` column — a plain column, not a
relation, because the RLS policy is a predicate on a column and cannot follow a
relation to find one.

Key tables:

- `Workspace`, `Membership`, `Invite` — the tenant, who is in it and with what role, and the invite links that put them there.
- `User`, `Session`, `AuthAccount`, `Verification`, `TwoFactor` — Better Auth's tables: accounts, sessions, password/reset state, and TOTP enrolment.
- `BankLink` — one workspace's connection to Akahu, holding either a pointer to the instance-wide `AKAHU_*` pair (`tokenSource: "env"`) or its own encrypted token pair.
- `Account`, `Connection` — mirrored from Akahu `/accounts`.
- `Transaction` — mirrored from Akahu `/transactions`, with nullable enrichment fields (merchant, category, conversion, card suffix, etc.).
- `PendingTransaction` — the not-yet-settled rows, replaced wholesale for a workspace on each sync rather than reconciled; they have no stable Akahu id to key on.
- `Merchant`, `Category`, `CategoryGroup` — mirrored enrichment catalogs. A group is stored once and referenced, not copied onto every row.
- `Label`, `TransactionLabel` — your own free-text tags, and their join to transactions. The join is explicit rather than an implicit Prisma m-n so it can carry its own `workspaceId` for RLS.
- `TransferGroup` — user-linked legs of internal transfers; excluded from income/spend metrics.
- `FxRate` — ECB reference rates from [frankfurter.dev](https://frankfurter.dev), used to value multi-currency transactions and balances.
- `BalanceSnapshot` — point-in-time balances captured on each sync.
- `Budget`, `BudgetItem` — a plan and its recurring line items. A budget is either a base (`baseBudgetId` null) or a layer that adds onto one; deleting a base cascades to its layers. A base with `forecast` set is one of the forward projections drawn on the dashboard — this replaced a separate `Forecast` table, whose name and colour now come from the budget itself. Items carry provenance (`inferred`, `inferredSource`, `basis`) so a still-guessed figure is marked as such.
- `BudgetInferenceRun` — the queue and audit log for background budget inference; drained by the same worker as syncs and rules (see [Sync](#sync)).
- `RuleDocument`, `RuleRun` — decision graphs and the runs over them.
- `FieldChange` — append-only log of every change to a transaction's category, merchant or transfer link, with what made it (`akahu` | `user` | `rule`) and who or which run. Supersedes `RuleApplication`, which only logged the rules engine's third of that.
- `TransactionConflict` — raised when a user-set enrichment field diverges from a later Akahu sync.
- `ChatThread`, `ChatMessage` — conversations with the local model, including the transcript an unattended budget inference writes as it runs.
- `SyncState`, `SyncRun` — incremental sync high-water mark and run history.

Categories follow the [NZFCC](https://nzfcc.org) standard. Spending groups are mapped to essential/discretionary in [lib/categories.ts](lib/categories.ts).

## Getting started

Requires Node.js `^20.19 || ^22.12 || >=24.0`, `pnpm`, and Docker or Podman for the local Postgres.

```bash
# 1. Install dependencies and generate the Prisma client
pnpm install

# 2. Configure environment
cp .env.example .env
# Set, at minimum:
#   BETTER_AUTH_SECRET          openssl rand -base64 32
#   APP_DB_PASSWORD             \ any two values; step 4 applies them to the
#   SYNC_DB_PASSWORD            / money_app and money_sync roles
#   AKAHU_APP_ID_TOKEN          \ from https://my.akahu.nz
#   AKAHU_USER_ACCESS_TOKEN     /
# DATABASE_URL already points at the local Postgres started in step 3.

# 3. Start Postgres (Docker or Podman)
pnpm db:up

# 4. Create the schema, then give the RLS runtime roles their passwords
pnpm db:setup          # = db:deploy + db:roles; in dev, `pnpm db:migrate` first

# 5. Create the first account and its workspace
#    Registration is invite-only, so the first user cannot come from the app.
pnpm user:create --email you@example.com --name "Sam"
pnpm workspace:create --owner you@example.com --name "Personal"

# 6. Pull your accounts and transactions from Akahu
#    (--drain does the work here; without it the sync is queued for `pnpm worker:start`)
pnpm worker:sync --drain

# 7. Start the dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in.

Everyone after the first user arrives through an invite link from
`/w/<slug>/members`. A workspace that wants its own bank connection (rather than
the instance-wide `AKAHU_*` pair) connects one from the app — which needs
`TOKEN_PUBLIC_KEY` set, from `pnpm link:keypair` — or from the shell with
`pnpm link:token`.

Nothing syncs and no budget is inferred unless a worker is draining the queues, so
either keep `pnpm worker:start` running alongside `pnpm dev`, or pass `--drain` to
`pnpm worker:sync` as step 6 does. The chat and the LLM budget inference need
`LLM_API` pointed at a local model; without one the budget button falls back to
the deterministic seeder and `/chat` says no model is reachable.

## Commands

Every script below takes `--help` and answers it without a database or any
environment variables set — the machine whose operator is reading `--help` is
usually the one that isn't configured yet.

### Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Next.js dev server. |
| `pnpm build` | Production build. |
| `pnpm start` | Serve the production build. |
| `pnpm lint` | Run ESLint. |
| `pnpm typecheck` | Run `tsc --noEmit`. |
| `pnpm test` | Run the `tests/*.test.ts` suite (`node --test`, needs a database — RLS isolation connects as `money_app`). |

### Database

| Command | Purpose |
| --- | --- |
| `pnpm db:up` | Start the local Postgres from `compose.yaml`. |
| `pnpm db:down` | Stop it. |
| `pnpm db:migrate` | Run Prisma migrations in dev. |
| `pnpm db:deploy` | Deploy migrations in production. |
| `pnpm db:roles` | Give the RLS runtime roles (`money_app`, `money_sync`) LOGIN and the passwords from `APP_DB_PASSWORD` / `SYNC_DB_PASSWORD`. Idempotent; re-run whenever they rotate. |
| `pnpm db:setup` | `db:deploy` then `db:roles`, in one step. |
| `pnpm db:studio` | Open Prisma Studio. |
| `pnpm db:generate` | Regenerate the Prisma client (also runs on `pnpm install`). |

### Sync

| Command | Purpose |
| --- | --- |
| `pnpm worker:sync` | Queue an incremental sync for every active bank link (safe to re-run, cron-friendly). |
| `pnpm worker:sync --full` | Queue a re-fetch of the whole history window. |
| `pnpm worker:sync --days 90` | Queue an explicit lookback window. |
| `pnpm worker:sync --workspace <slug\|id>` | Queue for one workspace instead of all of them. |
| `pnpm worker:sync --watch` | Queue, then stay attached and report until the runs finish. |
| `pnpm worker:sync --drain` | Queue, then run the queue down in this process (no worker needed). Mutually exclusive with `--watch`. |
| `pnpm worker:start` | Drain the queues forever — the process that actually calls Akahu. |
| `pnpm worker:start --once` | Drain what's queued now, then exit. |

`worker:sync` only enqueues: nothing syncs unless a worker is draining somewhere,
so a stack with no `worker:start` wants `--drain`. `db:sync` and `db:worker` are
deprecated aliases that print a warning and forward to these two.

The same worker also drains **budget inference** runs. Inferring a budget talks to
a local LLM (or the deterministic fallback), which is too slow to hold a request
open for, so the web app enqueues a `BudgetInferenceRun` when you press the button
and `worker:start` runs it in the background — a stack that infers budgets needs a
worker draining for the same reason a syncing one does.

### Users

Registration is invite-only and there is no site-admin surface, so these live in
the shell. Passwords are always prompted for, never passed as a flag.

| Command | Purpose |
| --- | --- |
| `pnpm user:create --email <email> --name "<name>"` | Create an account. `--workspace <slug\|id>` places them straight away, `--role <owner\|editor\|viewer>` (default `viewer`) sets how. Only needed for the first account; everyone else arrives by invite. |
| `pnpm user:list` | Every account with its memberships and roles, flagging those with no membership and no second factor. |
| `pnpm user:rename --email <email> --name "<new name>"` | Change a display name, for an operator who can't sign in as them. |
| `pnpm user:password --email <email>` | Set a password directly — the first owner, or when the reset-link flow itself is broken. Minimum 12 characters. |
| `pnpm user:delete --email <email>` | Delete an account, its memberships and its sessions. Refused if they are the only owner of a workspace. Prompts first. |

### Workspaces

| Command | Purpose |
| --- | --- |
| `pnpm workspace:create --owner <email>` | Create a workspace owned by an existing user. `--name "<name>"` (default `"<their first name>'s Personal"`) and `--slug <slug>` are optional; a taken slug gets a short suffix. |
| `pnpm workspace:list` | Every workspace with its members, roles and bank links — and where each link's Akahu credentials come from. Prints no secrets. |
| `pnpm workspace:member --workspace <slug\|id> --email <email> --role <role>` | Add an existing user to an existing workspace. Adds only — change a role or remove someone at `/w/<slug>/members`. |
| `pnpm workspace:delete --workspace <slug\|id>` | Delete a workspace and every row in it, cascading and irreversible. Requires the slug typed back. |

### Bank links and tokens

| Command | Purpose |
| --- | --- |
| `pnpm link:token --list` | List bank links and where each one's Akahu credentials come from (`env`, `stored`, and which encryption scheme). |
| `pnpm link:token --workspace <slug\|id> --name "<name>"` | Create a bank link with its own stored Akahu token pair. |
| `pnpm link:token --link <id>` | Replace a link's stored token pair. |
| `pnpm link:token --link <id> --source env` | Revert a link to the instance-wide `AKAHU_*` pair. |
| `pnpm link:keypair` | Print a fresh `TOKEN_PUBLIC_KEY` / `TOKEN_PRIVATE_KEY` pair for the app's connect-a-bank form. Writes nothing — where each half goes is a deployment decision. Run once per instance. |
| `pnpm link:upgrade` | Report which stored tokens still use the symmetric scheme. |
| `pnpm link:upgrade --apply` | Re-seal those to `TOKEN_PUBLIC_KEY`. Once no link reports `[symmetric]`, `TOKEN_ENCRYPTION_KEY` can come out of the worker and the CLI environment. |
| `pnpm unhook-bootstrap-ids` | Give the bootstrap workspace and link generated ids (retires the `ws_bootstrap` / `link_bootstrap` placeholders). Run once; idempotent. |

A token is verified against Akahu before `link:token` stores it — it calls
`/accounts` and prints what it can see, which is a better check than typing the
token twice.

## Deployment

Two supported shapes, both running the whole stack in containers with Postgres
published nowhere:

- **Compose** — [compose.prod.yaml](compose.prod.yaml): postgres, a one-shot
  `migrate`, the `app`, a `worker` draining the queues, and a `cron` that enqueues
  a sync every `SYNC_INTERVAL_SECONDS`. `docker compose -f compose.prod.yaml up -d --build`.
- **Rootless Podman Quadlet** — [deploy/quadlet/](deploy/quadlet/): the same five
  services as user-level systemd units in one pod, installed by `install.sh`. See
  [its README](deploy/quadlet/README.md).

Both split the database identity three ways — the schema owner runs migrations,
the app connects as `money_app`, the worker and cron as `money_sync` — and both
deliberately blank `TOKEN_ENCRYPTION_KEY` and `TOKEN_PRIVATE_KEY` on the app and
cron services, leaving the worker the only one that can open a stored token. The
web role has not called Akahu since it started enqueuing runs for the worker, so
it holds ciphertext it cannot open; the connect-a-bank form seals with
`TOKEN_PUBLIC_KEY` and cannot read back what it stored.

The `cron` service only enqueues. With no worker running, syncs and budget
inferences queue up and never happen.

## Project structure

```
app/                  App Router pages and server actions. Everything tenant-scoped
                      lives under app/w/[workspace]/; /account, /login and /invite
                      do not.
proxy.ts              Next.js proxy (middleware): session gate, workspace routing,
                      and the nonce'd Content-Security-Policy
lib/
  categories.ts       NZFCC spending groups and necessity mapping
  format.ts           Currency and date formatting
  periods.ts          Time bucketing (day/week/month/quarter/year/taxyear) in NZ time
  sankey.ts           Money-flow layout (hand-rolled — fixed columns)
  ids.ts              Minting app-namespaced ids (see ID_NAMESPACE)
  budget/             Recurrence, month math and projection shared by client and server
  chat/               Thread shaping, context elision, and slash commands
  server/
    akahu.ts          Akahu client setup
    seal.ts           Sealing/opening stored Akahu tokens (asymmetric + legacy AES)
    secrets.ts        Reading secrets from the environment or a file
    money.ts          Decimal -> number boundary for money columns
    currency.ts       Multi-currency conversion using cached ECB rates
    fx.ts             ECB FX rate fetcher
    changes.ts        Writing the FieldChange log
    enrichment.ts     Applying a category/merchant to transactions
    labels.ts         Creating, renaming and applying labels
    workspace.ts      Resolving the current workspace from the route
    queue.ts          Enqueuing runs; run-queue.ts claims, retries and reaps them
    build-info.ts     Which commit is serving (stamped into the runner image)
    db/               Prisma client, and scopedDb() — the workspace-bound client
                      every query goes through, with RLS beneath it
    auth/             Better Auth setup, sessions, roles and memberships
    ingest/           The Akahu ingest pipeline: accounts, transactions, pending,
                      the NZFCC and FX catalogs, and conflict reconciliation
    queries/          Server data fetchers used by pages
    matching/         Similar-transaction and transfer-candidate matching
    rules/            GoRules Zen graphs: engine/ runs them, learning/ derives them
                      from a single classified transaction
    budget/           infer.ts (deterministic seeding), llm/ (the headless model
                      conversation), run.ts (the run the worker drains)
    chat/             client.ts (the shared model connection), run.ts (a detached
                      turn), tools/ (the registry both conversations use)
    metrics/          balance, runway, comparison (incl. the Sankey), spend, and
                      budget/ for budget-vs-actual and forward projections
ui/                   React components (server and client)
components/ui/        shadcn primitives
prisma/               Schema and migrations
deploy/quadlet/       Rootless Podman self-host: units, install.sh, money.env.example
scripts/              Every `pnpm` command above (see the Commands section)
  ingest.ts           worker:sync — enqueues a sync run per active link
  worker.ts           worker:start — drains the queues
  drain.ts            the queue machinery both share
tests/                node --test suite; isolation.test.ts connects as money_app
                      and proves RLS holds
```

## Key design notes

- **Offline-first reads.** The dashboard never calls Akahu during a page load. All reads hit the local database; sync is an explicit background job.
- **Multi-currency.** Balances and transactions are converted through EUR-based ECB rates cached in `FxRate`. The dashboard totals in whichever currency most of your active accounts are held in.
- **User ownership of enrichment.** When you manually set a category or merchant, it is marked `source: "user"` and later Akahu syncs will not overwrite it. If Akahu later disagrees, a `TransactionConflict` is raised for you to reconcile.
- **Transfer handling.** Akahu tags rows as `TRANSFER` but never links the legs. The app lets you manually link legs (same- or cross-currency), and can auto-link unambiguous opposite legs via rules.
- **NZ timezone.** Period bucketing uses `Pacific/Auckland`, because many transactions are stamped at midday UTC and land in a different NZ month.
- **Native addon.** `@gorules/zen-engine` is a native Node addon; it is kept out of the Next.js bundle via `serverExternalPackages` in [next.config.ts](next.config.ts).
- **Row-Level Security.** Every query in the app goes through `scopedDb(workspaceId)`, which sets `app.workspace_id` for the transaction; Postgres policies do the filtering. The app connects as `money_app` and the worker as `money_sync`, both non-owner roles RLS actually applies to — the schema owner runs migrations and nothing else. [tests/isolation.test.ts](tests/isolation.test.ts) connects as `money_app` and asserts the isolation holds rather than trusting the query layer. Roles (`owner`/`editor`/`viewer`) are declared as capabilities in [lib/server/auth/roles.ts](lib/server/auth/roles.ts), not a string ordering, because the capabilities do not nest: `sync.run` is an editor power a viewer arguably wants and an owner might withhold.
- **Local-only AI.** Two things talk to the model, and both talk to the same one: the budget inference, and the chat. `LLM_API` points at an OpenAI-compatible endpoint on the same machine — Ollama's, typically — reached through the AI SDK's `@ai-sdk/openai-compatible` provider. They share a registry of tools ([lib/server/chat/tools/](lib/server/chat/tools/)) defined once as plain objects with hand-written JSON schemas, because the models this talks to are small enough that a faithful generated schema confuses them. The reads cover the spending map, transactions and search, accounts, budgets, labels and rules; the writes are split into two permission scopes — `budget` (create and edit budgets, layers and items) and `enrichment` (categorise, set a merchant, tag, write and apply rules) — and a caller is only ever offered the ones their role holds, then refused again at the call. Not MCP: every tool is a Prisma call that has to run under the caller's own `scopedDb(workspaceId)` with RLS beneath it, so the tools live in-process and the authorization is the caller's, with nothing to carry across a wire.

  **Budget inference** builds a whole budget in one headless conversation: the model reads the map, pages through an area, calls `propose_items` to commit what it found there, and `finish` when it has been through them all. `propose_items` resolves each row against the real catalog on the spot and answers with what was rejected and why, so the model corrects itself mid-conversation. With no endpoint, or one that won't answer, the button still works: it falls back to the deterministic seeder, as does any area the model never got to.

  **Chat** (`/chat`) is the same loop with you in it, streamed over a route handler at `/w/<slug>/chat/<id>/turn` — newline-delimited JSON read by a `fetch` reader, no WebSocket and no custom server. Every message is persisted as it completes, so closing the tab costs you the view of a turn and not the turn. Threads are **private to their author**, which is the one thing in this app membership of a workspace does not entitle you to; RLS only knows the workspace, so the `userId` filter that enforces it is application code and lives in one module. A viewer gets a chat that reads and explains and is never offered a tool that writes. There is **one composer**, used by the new-chat page, a conversation and a run's log alike; which controls it shows is a matter of which handlers it is given, so choosing the model is offered before the first question is asked and Compact only where there is something to summarise. What it writes stays labelled: a figure a model arrived at in conversation is stored `inferredSource: "ai"` with the reason it gave, so the budget page badges it exactly as a seeded one — but not `inferred`, because it was agreed out loud and a re-infer must not overwrite it.

  The model only ever sees and returns *names*, re-mapped to real ids and re-validated before anything is saved. The endpoint is meant to be `127.0.0.1` — a household's whole transaction history is the payload, and it must not leave the machine — and that is enforced, not just advised: `LLM_API` is resolved and checked for a loopback or private address before any request is issued, and a public one is refused unless `LLM_ALLOW_REMOTE=true` says otherwise deliberately. Both kinds of run keep their transcript in the same place: a chat's transcript is its thread, and an unattended inference writes one too, a thread marked `ChatThread.unattended` that fills in as the worker works and is linked from "Being created" on the budgets page. It is private to whoever asked for the run, like any other thread, and it replaces the opt-in log files this used to write.

  **A background run can be talked to, and its log carried on.** The run is in the worker, so there is no registry to reach it through and no signal to send it — the thread both processes can see is the whole channel. Typing on a log's page appends a message the loop drains at the top of its next round; stopping asks it (`BudgetInferenceRun.stopRequestedAt`) to build the budget from what it has proposed so far, and the areas it never reached are named rather than quietly filled in by the deterministic seeder. Both land between steps, not during one, which is the honest bound on anything crossing a process boundary through a database. Once the run is over the log can be **continued** in place: `unattended` clears, `continuedAt` marks where the worker stopped writing and a person started talking, and the model is told as much each turn — its tools have changed, and the budget it was proposing has already been saved.

## Environment variables

Copy `.env.example` to `.env` and fill in:

Required:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres. Defaults to the local one `pnpm db:up` starts. |
| `BETTER_AUTH_SECRET` | Signs session tokens. `openssl rand -base64 32`; no default on purpose. |
| `BETTER_AUTH_URL` | This app's own origin — the URL you actually browse to, not a container's internal address. |
| `APP_DB_PASSWORD` | The `money_app` role's password, applied by `pnpm db:roles`. |
| `SYNC_DB_PASSWORD` | The `money_sync` role's, likewise. |
| `AKAHU_APP_ID_TOKEN` | From Akahu app settings. |
| `AKAHU_USER_ACCESS_TOKEN` | From [my.akahu.nz](https://my.akahu.nz). |

Optional:

| Variable | Purpose |
| --- | --- |
| `REQUIRE_MFA` | `"true"` forces TOTP enrolment before any data. |
| `INSECURE_HTTP` | `1` for a plain-http LAN deployment: drops `upgrade-insecure-requests` from the CSP and suppresses HSTS, both of which would otherwise make an http-only origin unreachable. |
| `TOKEN_PUBLIC_KEY` | From `pnpm link:keypair`. Seals a stored Akahu token; the app gets this half. |
| `TOKEN_PRIVATE_KEY` | Opens one. Worker and CLI only, never the app. |
| `TOKEN_ENCRYPTION_KEY` | The older symmetric scheme for the same rows. Retireable via `pnpm link:upgrade --apply`. |
| `ID_NAMESPACE` | Prefixes ids this app mints. Defaults to `app`. |
| `LLM_API` | A local OpenAI-compatible endpoint, e.g. `127.0.0.1:11434` (Ollama). Unset ⇒ deterministic seeder only, and `/chat` reports no model. |
| `LLM_API_KEY` | Bearer token, only if the endpoint wants one (Ollama does not). |
| `LLM_MODEL` | Model to ask for; defaults to `llama3.1`. |
| `LLM_ALLOW_REMOTE` | `"true"` to permit a non-local `LLM_API`. Read the note below first. |
| `LLM_TIMEOUT` | Per-call ms; default 300000, clamped 30000–600000. |
| `LLM_MAX_MONTHS` | How far back the tools may read; default and cap are the deterministic window. |
| `LLM_MAX_TOOL_ROWS` | Most transactions one tool result may hold; default 400. |
| `LLM_MAX_STEPS` | Tool-loop rounds before a run or chat turn is cut off; default 150. |
| `LLM_CONTEXT_TOOL_BUDGET` | Chars of tool output a chat still carries; default 60000. |
| `WORKER_POLL_SECONDS` | Queue short-poll interval; default 5. |
| `WORKER_MAX_ATTEMPTS` | Tries before a run is failed for good; default 3. |
| `WORKER_BACKOFF_SECONDS` | Base of the retry backoff; default 30. |
| `WORKER_STALE_MINUTES` | When a `running` row is reaped as abandoned; default 15. |
| `SYNC_WATCH_POLL_SECONDS` | How often `worker:sync --watch` re-reads; default 2. |

Compose and the quadlet units additionally read `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `APP_PORT` and `SYNC_INTERVAL_SECONDS` from the same file; `next dev`
ignores them.

The `AKAHU_*` pair is instance-wide, so it really serves one person's accounts. A
second workspace that wants its own bank connection connects one from the app, or
uses `pnpm link:token`; either way the token pair is stored on the bank link
itself. The app's connect form seals with `TOKEN_PUBLIC_KEY` and cannot read back
what it stored — only `TOKEN_PRIVATE_KEY` opens it, and that half belongs wherever
the sync worker and CLI run, never on the web app. `TOKEN_ENCRYPTION_KEY` is the
older symmetric scheme for the same rows; `pnpm link:upgrade --apply` converts
them so it can be retired. No key of either kind belongs in the database it opens.

`LLM_API` is checked for a loopback or private address before anything is sent to
it, because what gets sent is the household's transaction history. A single-label
hostname, a `.local`/`.internal`/`.localhost` name, or an RFC 1918 address all
pass; anything internet-routable is refused unless `LLM_ALLOW_REMOTE=true`. In the
Podman deployment every container shares one network namespace, so a model on the
*host* is `host.containers.internal`, not `127.0.0.1`.

`pnpm db:up` starts the Postgres in [compose.yaml](compose.yaml), whose credentials
match the default `DATABASE_URL`. See [.env.example](.env.example) for the full
annotated set, and [deploy/quadlet/money.env.example](deploy/quadlet/money.env.example)
for the self-host one.

## License

MIT
