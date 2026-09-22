-- AlterTable
ALTER TABLE "FieldChange" ADD COLUMN     "carriedSource" TEXT;

-- Reattribute the rows an account merge wrote.
--
-- `applySupersession` stamped every row it wrote `source = 'user'`, to keep the
-- carried value's standing in the `user > rule > akahu` ladder. That conflated
-- who wrote the row with whose claim it carries, and the history panel — which
-- reads `source` for the former — presented a script's writes as a person's.
--
-- Keyed on `Account."supersededAt"` rather than on the rows looking unattributed.
-- "A `user` row with no actor" is the tempting predicate and it is wrong twice
-- over: `actorUserId` is `ON DELETE SET NULL`, so removing a member launders
-- their edits into that shape, and a dev refresh nulls the actor for every
-- account it cannot map by email. Both would be silently relabelled as a merge's
-- work. A merge writes its log rows in the same transaction that stamps
-- `supersededAt`, so that timestamp is the one signal that actually identifies
-- them; the window absorbs the ordering within the batch.
--
-- `carriedSource` is set to `user` rather than left null because that is what
-- these rows already assert: the old code wrote `user` for *every* carry, whether
-- the value it moved was a person's or a rule's, and precedence has been reading
-- it that way since. Preserving the claim keeps the ladder behaving exactly as it
-- does today; narrowing it would silently demote links this instance currently
-- treats as user-authored. New rows record the real authority.
--
-- Does nothing on an instance that has never merged an account, which is the
-- correct outcome there and the reason this is safe to run anywhere.
UPDATE "FieldChange" fc
   SET source = 'supersession',
       "carriedSource" = 'user'
 WHERE fc.source = 'user'
   AND fc."actorUserId" IS NULL
   AND fc."ruleRunId" IS NULL
   AND fc."syncRunId" IS NULL
   AND EXISTS (
     SELECT 1 FROM "Account" a
      WHERE a."supersededAt" IS NOT NULL
        AND a."workspaceId" = fc."workspaceId"
        AND fc."createdAt" BETWEEN a."supersededAt" - interval '10 seconds'
                               AND a."supersededAt" + interval '10 seconds'
   );
