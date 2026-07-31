-- A budget is addressed by its id, not by a slug.
--
-- The slug was a URL-safe copy of the name, and a copy is the problem: it was taken
-- at creation and never moved again, so it went stale the first time a budget was
-- renamed ("Christmas" living at /budgets/default-budget), and duplicating one
-- produced `-2`/`-3` suffixes that named nothing a person had chosen. A budget is not
-- a public page and its URL is not shared or indexed — nothing was bought with the
-- readability, and the cuid the row already has is stable across every rename and
-- every copy.
--
-- Nothing to preserve: no other table referenced the slug, and any bookmark held on
-- one was already pointing at whatever the budget used to be called.
--
-- `Forecast` keeps its own slug; this is only about budgets.

-- DropIndex
DROP INDEX "Budget_workspaceId_slug_key";

-- AlterTable
ALTER TABLE "Budget" DROP COLUMN "slug";
