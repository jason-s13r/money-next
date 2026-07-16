-- Trigram indexes backing the free-text transaction search.
--
-- Postgres' LIKE is case-sensitive, so every `contains` in the search paths uses
-- Prisma's `mode: "insensitive"`, which compiles to ILIKE '%term%'. A leading
-- wildcard makes a btree index useless, and ILIKE cannot use one at all — so
-- without pg_trgm these searches are always a sequential scan.
--
-- Every column the search ORs over is indexed, not just `description`. Postgres
-- can only combine the branches of an OR into a BitmapOr when it has an index
-- for *each* one; leave a single branch unindexed and the planner falls back to
-- scanning the whole table anyway, which would make the other indexes dead
-- weight that only costs write time.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs each migration inside a
-- transaction, and CONCURRENTLY cannot run in one. It takes a brief write lock,
-- which is not a concern at this table's size.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The columns `searchTransactions` and `searchTransferCandidates` match on: the
-- raw bank description, plus the fields a bank splits a payment's identity
-- across.
CREATE INDEX "Transaction_description_trgm_idx" ON "Transaction" USING GIN ("description" gin_trgm_ops);
CREATE INDEX "Transaction_particulars_trgm_idx" ON "Transaction" USING GIN ("particulars" gin_trgm_ops);
CREATE INDEX "Transaction_code_trgm_idx" ON "Transaction" USING GIN ("code" gin_trgm_ops);
CREATE INDEX "Transaction_reference_trgm_idx" ON "Transaction" USING GIN ("reference" gin_trgm_ops);
CREATE INDEX "Transaction_otherAccount_trgm_idx" ON "Transaction" USING GIN ("otherAccount" gin_trgm_ops);

-- The enriched names, matched through a relation filter rather than a column.
CREATE INDEX "Merchant_name_trgm_idx" ON "Merchant" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Category_name_trgm_idx" ON "Category" USING GIN ("name" gin_trgm_ops);
