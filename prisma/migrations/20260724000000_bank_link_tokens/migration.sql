-- Phase 8: Akahu credentials move from the environment onto the bank link.
--
-- Until now there was exactly one Akahu pair for the whole instance, read from
-- AKAHU_APP_ID_TOKEN / AKAHU_USER_ACCESS_TOKEN by whichever ingest step happened
-- to need it. That is the single fact behind every "the default workspace is
-- transitional" caveat in docs/multi-user.md: the token belonged to one tenant,
-- so the tenancy model was multi-workspace while the *data source* was not.
--
-- Four columns close that gap:
--
--   * `tokenSource` — `env` (the instance-wide pair, unchanged behaviour) or
--     `stored` (the encrypted columns here). Phase 10 adds `oauth`, which uses
--     the same two columns by a different route. A source name rather than a
--     boolean because how a credential arrived decides what may be done with it.
--
--   * `appTokenCipher` / `userTokenCipher` — AES-256-GCM ciphertext. The key is
--     TOKEN_ENCRYPTION_KEY, held in the environment of the sync worker and the
--     `pnpm link:token` CLI and NOT in the web app's, and never in this database.
--     That is T19's pre-committed mitigation: a leaked dump is inert because the
--     thing that opens it was never in the dump.
--
--   * `tokenUpdatedAt` — when the pair was last set, which `updatedAt` cannot
--     answer once anything else on the row can move it.
--
-- Existing rows default to `env`, which is exactly what they were doing before
-- this migration, so the bootstrap link keeps syncing with no operator action.
--
-- No grant changes. BankLink's DML is granted table-level to both runtime roles
-- (rls_backstop), so the new columns are covered. Column-level REVOKE of the two
-- cipher columns from money_app was considered and rejected: money_app does not
-- hold the key, so the ciphertext is inert in its hands anyway, and a per-column
-- grant turns any future full-model read of BankLink into a 42501 that only
-- appears in production (dev and tests connect as the owner, whom RLS and column
-- grants alike do not restrict). A loud failure in the one environment that
-- cannot afford one is a poor trade for no additional secrecy.
ALTER TABLE "BankLink" ADD COLUMN "tokenSource" TEXT NOT NULL DEFAULT 'env';
ALTER TABLE "BankLink" ADD COLUMN "appTokenCipher" TEXT;
ALTER TABLE "BankLink" ADD COLUMN "userTokenCipher" TEXT;
ALTER TABLE "BankLink" ADD COLUMN "tokenUpdatedAt" TIMESTAMPTZ(3);
