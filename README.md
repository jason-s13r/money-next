# Money

A personal finance dashboard that mirrors your New Zealand bank accounts from [Akahu](https://akahu.nz) into a local Postgres database, then gives you fast, offline views of net worth, spending, income, and transactions.

Built with [Next.js](https://nextjs.org) 16, React 19, TypeScript, Tailwind CSS 4, Prisma 7, and Postgres.

## What it does

- **Dashboard** — net worth split into accessible, liquid, and locked balances; emergency and forecasted runway; a credit-facility meter; and a warning banner for uncategorised spending.
- **Income and spending breakdown** — compare periods (day, week, month, quarter, year, or NZ tax year) with stacked bars and a drillable table down to category, subcategory, and merchant.
- **Budgets** — plan expected income and spending as recurring items, or infer a starting budget from your own history (deterministically, or with an optional local LLM). A budget is a **base** — the ongoing plan — with optional seasonal **layers** that add on top only within their own window (a Christmas layer that applies each December). The budget-vs-actual view anchors on a base and folds in its active layers, comparing the plan against what actually happened.
- **Forecasts** — project a base budget and its active layers forward as named scenarios, drawn as forward runway lines on the dashboard.
- **Transactions** — recent, searchable, and filterable by account, category group, category, merchant, card suffix, or Akahu type. Each transaction has a detail page for editing merchant/category, linking transfers, and teaching automation rules.
- **Accounts** — list of connected accounts with balances, available funds, and transaction counts; per-account transaction history with running balances.
- **Rules** — a GoRules Zen decision graph that auto-enriches transactions (category, merchant, transfer linking). Rules are taught from a single classified transaction and run automatically on every sync.
- **Sync history** — audit log of every ingest run, with manual refresh and full historical sync buttons.

## Data model

The local Postgres mirror is the source of truth for the UI. Akahu ids are used as primary keys so re-syncing is idempotent.

Money is stored as `numeric(19, 4)` so sums are exact, and converted to plain numbers at the read boundary ([lib/server/money.ts](lib/server/money.ts)) — nothing above the query layer handles a `Decimal`.

Key tables:

- `Account`, `Connection` — mirrored from Akahu `/accounts`.
- `Transaction` — mirrored from Akahu `/transactions`, with nullable enrichment fields (merchant, category, conversion, card suffix, etc.).
- `Merchant`, `Category` — mirrored enrichment catalogs.
- `TransferGroup` — user-linked legs of internal transfers; excluded from income/spend metrics.
- `FxRate` — ECB reference rates from [frankfurter.dev](https://frankfurter.dev), used to value multi-currency transactions and balances.
- `BalanceSnapshot` — point-in-time balances captured on each sync.
- `Budget`, `BudgetItem` — a plan and its recurring line items. A budget is either a base (`baseBudgetId` null) or a layer that adds onto one; deleting a base cascades to its layers. Items carry provenance (`inferred`, `inferredSource`, `basis`) so a still-guessed figure is marked as such.
- `Forecast` — a named forward projection pinned to a single base budget.
- `BudgetInferenceRun` — the queue and audit log for background budget inference; drained by the same worker as syncs and rules (see [Sync](#sync)).
- `RuleDocument`, `RuleRun`, `RuleApplication` — decision graphs and an audit log of what they changed.
- `TransactionConflict` — raised when a user-set enrichment field diverges from a later Akahu sync.
- `SyncState`, `SyncRun` — incremental sync high-water mark and run history.

Categories follow the [NZFCC](https://nzfcc.org) standard. Spending groups are mapped to essential/discretionary in [lib/categories.ts](lib/categories.ts).

## Getting started

Requires Node.js `^20.19 || ^22.12 || >=24.0`, `pnpm`, and Docker or Podman for the local Postgres.

```bash
# 1. Install dependencies and generate the Prisma client
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env and add your Akahu credentials from https://my.akahu.nz
# DATABASE_URL defaults to the local Postgres started in step 3

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
the instance-wide `AKAHU_*` pair) connects one from the app, or from the shell
with `pnpm link:token`.

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
| `pnpm link:upgrade --apply` | Re-seal those to `TOKEN_PUBLIC_KEY`. Once no link reports `[symmetric]`, `TOKEN_ENCRYPTION_KEY` can come out of the worker and cron. |
| `pnpm unhook-bootstrap-ids` | Give the bootstrap workspace and link generated ids (retires the `ws_bootstrap` / `link_bootstrap` placeholders). Run once; idempotent. |

A token is verified against Akahu before `link:token` stores it — it calls
`/accounts` and prints what it can see, which is a better check than typing the
token twice.

## Project structure

```
app/                  Next.js App Router pages and server actions
lib/
  categories.ts       NZFCC spending groups and necessity mapping
  format.ts           Currency and date formatting
  periods.ts          Time bucketing (day/week/month/quarter/year/taxyear) in NZ time
  search-params.ts    Search-param helpers
  slug.ts             URL slug helpers
  server/
    akahu.ts          Akahu client setup
    currency.ts       Multi-currency conversion using cached ECB rates
    data.ts           Server data fetchers used by pages
    db.ts             Prisma client (Postgres via @prisma/adapter-pg)
    money.ts          Decimal -> number boundary for money columns
    fx.ts             ECB FX rate fetcher
    matching.ts       Similar-transaction and transfer-candidate matching
    nzfcc.ts          NZFCC category catalog fetcher
    rules.ts          GoRules Zen engine runner
    rule-learning.ts  Derive and edit learned rules in the decision graph
    sync.ts           Akahu ingest pipeline
    transfers.ts      Link/unlink transfer legs
    conflicts.ts      Reconcile user edits vs. later Akahu syncs
    budget/
      infer.ts        Deterministic budget inference from history
      llm.ts          Optional local-LLM inference (falls back to infer.ts)
      run.ts          Background inference run, drained by the worker
    metrics/
      balance.ts      Net-worth summaries
      spend.ts        Spending forecasts and review queue
      runway.ts       Emergency/forecasted runway math
      comparison.ts   Period-over-period income/spending breakdown
      budget/         Budget-vs-actual and forward projections (base + layers)
ui/                   React components (server and client)
prisma/               Schema and migrations
scripts/              Every `pnpm` command above (see the Commands section)
  ingest.ts           worker:sync — enqueues a sync run per active link
  worker.ts           worker:start — drains the queue and calls Akahu
  drain.ts            the queue machinery both share
```

## Key design notes

- **Offline-first reads.** The dashboard never calls Akahu during a page load. All reads hit the local database; sync is an explicit background job.
- **Multi-currency.** Balances and transactions are converted through EUR-based ECB rates cached in `FxRate`. The dashboard totals in whichever currency most of your active accounts are held in.
- **User ownership of enrichment.** When you manually set a category or merchant, it is marked `source: "user"` and later Akahu syncs will not overwrite it. If Akahu later disagrees, a `TransactionConflict` is raised for you to reconcile.
- **Transfer handling.** Akahu tags rows as `TRANSFER` but never links the legs. The app lets you manually link legs (same- or cross-currency), and can auto-link unambiguous opposite legs via rules.
- **NZ timezone.** Period bucketing uses `Pacific/Auckland`, because many transactions are stamped at midday UTC and land in a different NZ month.
- **Native addon.** `@gorules/zen-engine` is a native Node addon; it is kept out of the Next.js bundle via `serverExternalPackages` in [next.config.ts](next.config.ts).
- **Local-only budget inference.** Budget inference reads recurrence straight out of your numbers. If `LLM_API` points at a model on the same machine (Ollama's OpenAI-compatible endpoint), it also asks the model to name the commitments — but the model only ever sees and returns *names*, which are re-mapped to real ids and re-validated before anything is saved. With no endpoint, or one that won't answer, the button still works: it falls back to the deterministic seeder. The endpoint is meant to be `127.0.0.1` — a household's whole transaction history is the payload, and it must not leave the machine. The counts-only console log is safe; the full transcript (`LLM_LOG_DIR`) contains the transactions themselves and is opt-in for that reason.

## Environment variables

Copy `.env.example` to `.env` and fill in:

```env
DATABASE_URL="postgresql://money:money@127.0.0.1:5432/money?schema=public"
BETTER_AUTH_SECRET=        # openssl rand -base64 32; signs session tokens
BETTER_AUTH_URL=           # this app's own origin, e.g. http://localhost:3000
REQUIRE_MFA=               # optional; "true" forces TOTP enrolment before any data
APP_DB_PASSWORD=           # the `money_app` role, set by `pnpm db:roles`
SYNC_DB_PASSWORD=          # the `money_sync` role, likewise
AKAHU_APP_ID_TOKEN=        # from Akahu app settings
AKAHU_USER_ACCESS_TOKEN=   # from https://my.akahu.nz
TOKEN_ENCRYPTION_KEY=      # optional; the older symmetric scheme for stored tokens
TOKEN_PUBLIC_KEY=          # optional; from `pnpm link:keypair` — app included
TOKEN_PRIVATE_KEY=         # optional; worker and CLI only, never the app
ID_NAMESPACE=              # optional; labels ids this app mints. Defaults to "app"

# Budget inference (all optional; unset ⇒ deterministic seeder only)
LLM_API=                   # a local OpenAI-compatible endpoint, e.g. 127.0.0.1:11434 (Ollama). Local machine only.
LLM_API_KEY=               # bearer token, only if the endpoint wants one (Ollama does not)
LLM_MODEL=                 # model to ask for; defaults to "llama3.1"
LLM_LOG_DIR=               # opt-in transcript dir — contains transactions, so local only
LLM_TIMEOUT=               # per-call ms; default 300000, clamped 30000–600000
LLM_MAX_CONCURRENCY=       # windows sent in parallel; default 1, up to 16
LLM_MAX_MONTHS=            # how far back to read; default/cap is the deterministic window
LLM_MAX_WINDOW_TX=         # split a category group larger than this; default 400
```

The `AKAHU_*` pair is instance-wide, so it really serves one person's accounts. A
second workspace that wants its own bank connection connects one from the app, or
uses `pnpm link:token`; either way the token pair is stored on the bank link
itself. The app's connect form seals with `TOKEN_PUBLIC_KEY` and cannot read back
what it stored — only `TOKEN_PRIVATE_KEY` opens it, and that half belongs wherever
the sync worker and CLI run, never on the web app. `TOKEN_ENCRYPTION_KEY` is the
older symmetric scheme for the same rows; `pnpm link:upgrade --apply` converts
them so it can be retired. No key of either kind belongs in the database it opens.

`pnpm db:up` starts the Postgres in [compose.yaml](compose.yaml), whose credentials
match the string above. See [.env.example](.env.example) for the full annotated set.

## License

MIT
