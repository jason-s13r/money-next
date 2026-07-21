-- The bootstrap workspace shipped named "Money" (see the tenancy_models
-- migration) — the same word as the app itself, which reads as confusing in the
-- workspace switcher. Its slug was always "personal"; give it the matching
-- display name. Guarded on the original value so a workspace an operator has
-- since renamed by hand is left alone.
UPDATE "Workspace"
SET "name" = 'Personal'
WHERE "id" = 'ws_bootstrap' AND "name" = 'Money';
