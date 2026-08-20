-- A tax year the household defines, and a per-transaction override of which one
-- a row belongs to.
--
-- `lib/periods.ts` already had a `taxyear` bucket, but 1 April – 31 March was
-- written into the function: correct for NZ and wrong everywhere else, and not a
-- thing an instance could say otherwise about. These two columns move that from
-- a constant to a setting. Only the start is stored — a tax year is a year, so
-- the close is the day before the next opens, and a second column could only
-- disagree with the first.
--
-- Defaults reproduce today's behaviour exactly (1 April), so every existing
-- workspace keeps the buckets it already had and no backfill is needed.
--
-- No grant change: `Workspace` DML is granted table-level to money_app and SELECT
-- to money_sync (rls_backstop migration), and a table-level grant covers columns
-- added later. `Workspace` carries no RLS policy of its own — it is the row the
-- scope is *named by*, reached through `authDb` by an id the session proved.
ALTER TABLE "Workspace"
  ADD COLUMN "taxYearStartMonth" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "taxYearStartDay" INTEGER NOT NULL DEFAULT 1;

-- Which tax year a transaction is *for*, when that is not the one its date falls
-- in. Held as the calendar year the tax year ends in, matching the `FY####`
-- period key.
--
-- The case this exists for is the transaction that is about a tax year rather
-- than in it: a terminal tax payment or an IRD refund settling a year that has
-- already closed. The date is right — the money moved when it moved — and the
-- year it implies is not, so a tax-year total built from dates alone reports the
-- payment against the wrong year every time.
--
-- Nullable with no default and no backfill: null means "the year the date says",
-- which is what every existing row means and what nearly every future row will.
--
-- No RLS change either: `tenant_isolation` on "Transaction" keys off
-- `workspaceId`, which this does not touch.
ALTER TABLE "Transaction" ADD COLUMN "taxYear" INTEGER;

-- Read by one query: the comparison builder's "which rows were pushed into this
-- window's tax years?", which has to reach rows whose date sits outside the
-- window it overfetched. Workspace-first, like every other index here.
CREATE INDEX "Transaction_workspaceId_taxYear_idx" ON "Transaction"("workspaceId", "taxYear");
