-- Record what a conflict is holding: a user's value, or a rule's.
--
-- The sync now defends `rule`-owned fields as well as `user`-owned ones, so a
-- conflict can be raised on behalf of either, and the reader is owed the
-- difference: "you set this" and "your rule set this" call for different fixes.
--
-- Unlike the field change log's migration next door, Prisma's generated DDL is
-- the whole story here. `DEFAULT 'user'` backfills the 91 existing rows, and that
-- is not a guess: until this change the sync protected nothing but user-owned
-- fields, so a user is the only thing any existing conflict could have been
-- raised on behalf of.

-- AlterTable
ALTER TABLE "TransactionConflict" ADD COLUMN     "heldSource" TEXT NOT NULL DEFAULT 'user';
