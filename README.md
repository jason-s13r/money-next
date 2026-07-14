# Money

A personal finance dashboard that mirrors your New Zealand bank accounts from [Akahu](https://akahu.nz) into a local SQLite database, then gives you fast, offline views of net worth, spending, income, and transactions.

Built with [Next.js](https://nextjs.org) 16, React 19, TypeScript, Tailwind CSS 4, Prisma 7, and SQLite via `better-sqlite3`.

## What it does

- **Dashboard** — net worth split into accessible, liquid, and locked balances; emergency and forecasted runway; a credit-facility meter; and a warning banner for uncategorised spending.
- **Income and spending breakdown** — compare periods (day, week, month, quarter, year, or NZ tax year) with stacked bars and a drillable table down to category, subcategory, and merchant.
- **Transactions** — recent, searchable, and filterable by account, category group, category, merchant, card suffix, or Akahu type. Each transaction has a detail page for editing merchant/category, linking transfers, and teaching automation rules.
- **Accounts** — list of connected accounts with balances, available funds, and transaction counts; per-account transaction history with running balances.
- **Rules** — a GoRules Zen decision graph that auto-enriches transactions (category, merchant, transfer linking). Rules are taught from a single classified transaction and run automatically on every sync.
- **Sync history** — audit log of every ingest run, with manual refresh and full historical sync buttons.

## Data model

The local SQLite mirror is the source of truth for the UI. Akahu ids are used as primary keys so re-syncing is idempotent.

Key tables:

- `Account`, `Connection` — mirrored from Akahu `/accounts`.
- `Transaction` — mirrored from Akahu `/transactions`, with nullable enrichment fields (merchant, category, conversion, card suffix, etc.).
- `Merchant`, `Category` — mirrored enrichment catalogs.
- `TransferGroup` — user-linked legs of internal transfers; excluded from income/spend metrics.
- `FxRate` — ECB reference rates from [frankfurter.dev](https://frankfurter.dev), used to value multi-currency transactions and balances.
- `BalanceSnapshot` — point-in-time balances captured on each sync.
- `RuleDocument`, `RuleRun`, `RuleApplication` — decision graphs and an audit log of what they changed.
- `TransactionConflict` — raised when a user-set enrichment field diverges from a later Akahu sync.
- `SyncState`, `SyncRun` — incremental sync high-water mark and run history.

Categories follow the [NZFCC](https://nzfcc.org) standard. Spending groups are mapped to essential/discretionary in [lib/categories.ts](lib/categories.ts).

## Getting started

Requires Node.js `^20.19 || ^22.12 || >=24.0` and `pnpm`.

```bash
# 1. Install dependencies and generate the Prisma client
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env and add your Akahu credentials from https://my.akahu.nz
# DATABASE_URL defaults to file:./money.db

# 3. Create the database and run migrations
pnpm db:migrate

# 4. Pull your accounts and transactions from Akahu
pnpm db:sync

# 5. Start the dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Everyday commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Next.js dev server. |
| `pnpm build` | Production build. |
| `pnpm typecheck` | Run `tsc --noEmit`. |
| `pnpm lint` | Run ESLint. |
| `pnpm db:sync` | Incremental sync from Akahu (safe to re-run, cron-friendly). |
| `pnpm db:sync --full` | Re-fetch the whole history window. |
| `pnpm db:sync --days 90` | Sync an explicit lookback window. |
| `pnpm db:migrate` | Run Prisma migrations in dev. |
| `pnpm db:deploy` | Deploy migrations in production. |
| `pnpm db:studio` | Open Prisma Studio. |
| `pnpm db:generate` | Regenerate the Prisma client. |

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
    db.ts             Prisma + better-sqlite3 client
    fx.ts             ECB FX rate fetcher
    matching.ts       Similar-transaction and transfer-candidate matching
    nzfcc.ts          NZFCC category catalog fetcher
    rules.ts          GoRules Zen engine runner
    rule-learning.ts  Derive and edit learned rules in the decision graph
    sync.ts           Akahu ingest pipeline
    transfers.ts      Link/unlink transfer legs
    conflicts.ts      Reconcile user edits vs. later Akahu syncs
    metrics/
      balance.ts      Net-worth summaries
      spend.ts        Spending forecasts and review queue
      runway.ts       Emergency/forecasted runway math
      comparison.ts   Period-over-period income/spending breakdown
ui/                   React components (server and client)
prisma/               Schema and migrations
scripts/ingest.ts     Cron-friendly sync entry point
```

## Key design notes

- **Offline-first reads.** The dashboard never calls Akahu during a page load. All reads hit local SQLite; sync is an explicit background job.
- **Multi-currency.** Balances and transactions are converted through EUR-based ECB rates cached in `FxRate`. The dashboard totals in whichever currency most of your active accounts are held in.
- **User ownership of enrichment.** When you manually set a category or merchant, it is marked `source: "user"` and later Akahu syncs will not overwrite it. If Akahu later disagrees, a `TransactionConflict` is raised for you to reconcile.
- **Transfer handling.** Akahu tags rows as `TRANSFER` but never links the legs. The app lets you manually link legs (same- or cross-currency), and can auto-link unambiguous opposite legs via rules.
- **NZ timezone.** Period bucketing uses `Pacific/Auckland`, because many transactions are stamped at midday UTC and land in a different NZ month.
- **Native addon.** `@gorules/zen-engine` is a native Node addon; it is kept out of the Next.js bundle via `serverExternalPackages` in [next.config.ts](next.config.ts).

## Environment variables

Copy `.env.example` to `.env` and fill in:

```env
DATABASE_URL="file:./money.db"
AKAHU_APP_ID_TOKEN=        # from Akahu app settings
AKAHU_USER_ACCESS_TOKEN=   # from https://my.akahu.nz
```

## License

MIT
