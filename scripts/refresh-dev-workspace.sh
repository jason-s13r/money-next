#!/usr/bin/env bash
#
# Refresh a dev workspace's data from a prod dump — data only, no identities.
#
# A full pg_restore drags prod's users, sessions, 2FA secrets and bank links
# across with it, and then dev logins break against dev's Better Auth secret and
# the Akahu ciphertext won't decrypt with dev's key. This copies the workspace's
# *contents* instead: transactions, budgets, merchants, labels, rules, the change
# log. Users, memberships, invites, bank links and the workspace row itself stay
# exactly as dev has them.
#
#   scripts/refresh-dev-workspace.sh                    # from ./prod-db.dump
#   scripts/refresh-dev-workspace.sh --dump ~/other.dump --slug personal
#   scripts/refresh-dev-workspace.sh --from-db money_prod --with-chat
#
# One transaction: it either lands whole or leaves dev untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONTAINER="${MONEY_PG_CONTAINER:-money-postgres}"
CLI="${MONEY_CONTAINER_CLI:-}"
PGUSER_="${MONEY_PG_USER:-money}"
TARGET_DB="${MONEY_DEV_DB:-money}"
SRC_DB="money_refresh_src"
DUMP="$ROOT/prod-db.dump"
FROM_DB=""
SLUG="personal"
WITH_CHAT=false
KEEP_SRC=false
ASSUME_YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump)      DUMP="$2"; shift 2 ;;
    --from-db)   FROM_DB="$2"; shift 2 ;;      # reuse an already-restored database
    --slug)      SLUG="$2"; shift 2 ;;
    --target)    TARGET_DB="$2"; shift 2 ;;
    --with-chat) WITH_CHAT=true; shift ;;      # default keeps dev's chat threads
    --keep-src)  KEEP_SRC=true; shift ;;
    -y|--yes)    ASSUME_YES=true; shift ;;
    -h|--help)   awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)           echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$CLI" ]]; then
  if command -v docker >/dev/null 2>&1; then CLI=docker
  elif command -v podman >/dev/null 2>&1; then CLI=podman
  else echo "neither docker nor podman found" >&2; exit 1; fi
fi

$CLI exec "$CONTAINER" true 2>/dev/null || { echo "container $CONTAINER is not running" >&2; exit 1; }

psql_() { $CLI exec -i "$CONTAINER" psql -U "$PGUSER_" -v ON_ERROR_STOP=1 "$@"; }

if [[ -n "$FROM_DB" ]]; then
  SRC_DB="$FROM_DB"
  KEEP_SRC=true
  SOURCE_DESC="database $SRC_DB"
else
  [[ -f "$DUMP" ]] || { echo "dump not found: $DUMP" >&2; exit 1; }
  SOURCE_DESC="$DUMP ($(date -r "$DUMP" '+%Y-%m-%d %H:%M'))"
fi

cat <<MSG

  source:    $SOURCE_DESC
  target:    $TARGET_DB (container $CONTAINER, via $CLI)
  workspace: $SLUG
  chat:      $([[ $WITH_CHAT == true ]] && echo "replaced from source" || echo "dev's kept")

  Replaces this workspace's financial + classification data in $TARGET_DB.
  Leaves users, sessions, memberships, invites, bank links and the workspace row alone.

MSG

if [[ $ASSUME_YES != true ]]; then
  [[ -t 0 ]] || { echo "non-interactive: pass --yes to proceed" >&2; exit 1; }
  read -r -p "proceed? [y/N] " reply
  [[ "$reply" == [yY]* ]] || { echo "aborted"; exit 1; }
fi

if [[ -z "$FROM_DB" ]]; then
  echo "==> loading dump into $SRC_DB"
  psql_ -d postgres -c "DROP DATABASE IF EXISTS $SRC_DB WITH (FORCE)" -c "CREATE DATABASE $SRC_DB" >/dev/null
  $CLI exec -i "$CONTAINER" pg_restore -U "$PGUSER_" -d "$SRC_DB" --no-owner --exit-on-error < "$DUMP"
fi

echo "==> refreshing $SLUG in $TARGET_DB"
psql_ -d "$TARGET_DB" -v src_db="$SRC_DB" -v slug="$SLUG" -v with_chat="$WITH_CHAT" -f - <<'SQL'
BEGIN;

SELECT set_config('refresh.slug', :'slug', true),
       set_config('refresh.with_chat', :'with_chat', true);

-- Read the source over FDW rather than a second psql: one connection, one
-- transaction, and the id remaps can be plain joins across the two databases.
CREATE EXTENSION IF NOT EXISTS postgres_fdw;
DROP SERVER IF EXISTS refresh_src CASCADE;
CREATE SERVER refresh_src FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (dbname :'src_db', host '/var/run/postgresql', port '5432', fetch_size '20000');
CREATE USER MAPPING FOR CURRENT_USER SERVER refresh_src OPTIONS (user 'money');
DROP SCHEMA IF EXISTS src CASCADE;
CREATE SCHEMA src;
IMPORT FOREIGN SCHEMA public FROM SERVER refresh_src INTO src;

-- Merge, not replace: dev's other workspaces reference these same rows.
CREATE FUNCTION pg_temp.merge_rows(tbl text, filter text) RETURNS void AS $fn$
DECLARE rel oid; cols text; pks text; upd text;
BEGIN
  rel := format('public.%I', tbl)::regclass;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) INTO pks
    FROM pg_constraint f
    JOIN LATERAL unnest(f.conkey) WITH ORDINALITY k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = rel AND a.attnum = k.attnum
   WHERE f.conrelid = rel AND f.contype = 'p';

  SELECT string_agg(format('%I = EXCLUDED.%I', a.attname, a.attname), ', ' ORDER BY a.attnum) INTO upd
    FROM pg_attribute a
   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
     AND NOT a.attnum = ANY (SELECT unnest(f.conkey) FROM pg_constraint f
                              WHERE f.conrelid = rel AND f.contype = 'p');

  EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM src.%I s WHERE %s ON CONFLICT (%s) DO %s',
                 tbl, cols, cols, tbl, filter, pks,
                 CASE WHEN upd IS NULL THEN 'NOTHING' ELSE 'UPDATE SET ' || upd END);
END
$fn$ LANGUAGE plpgsql;

DO $refresh$
DECLARE
  ws_slug   text    := current_setting('refresh.slug');
  with_chat boolean := current_setting('refresh.with_chat')::boolean;

  -- Identity and connection state belong to whichever instance you are on.
  never   text[] := ARRAY['BankLink', 'Invite', 'Membership'];
  -- Instance-wide reference data: merged, never wiped, since the other
  -- workspaces on this dev box point at the same rows.
  globals text[] := ARRAY['Connection', 'CategoryGroup', 'Category', 'FxRate'];
  ignored text[] := ARRAY['User', 'Session', 'AuthAccount', 'Verification', 'TwoFactor',
                          'Workspace', 'EmailOutbox', '_prisma_migrations'];

  src_ws text; dst_ws text; owner_id text;
  tenant text[]; copied text[]; stray text[];
  rel oid; t text; cols text; sel text; pks text; upd text; expr text;
  rec record; n bigint;
BEGIN
  SELECT id INTO src_ws FROM src."Workspace" WHERE slug = ws_slug;
  IF src_ws IS NULL THEN RAISE EXCEPTION 'source has no workspace %', ws_slug; END IF;
  SELECT id INTO dst_ws FROM "Workspace" WHERE slug = ws_slug;
  IF dst_ws IS NULL THEN RAISE EXCEPTION 'target has no workspace % — create it first', ws_slug; END IF;

  SELECT m."userId" INTO owner_id FROM "Membership" m
   WHERE m."workspaceId" = dst_ws AND m.role = 'owner' ORDER BY m."userId" LIMIT 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'target workspace % has no owner', ws_slug; END IF;

  -- A table is tenant data iff it carries workspaceId, so a new model joins the
  -- refresh by existing rather than by being listed here.
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO tenant
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
   WHERE c.table_schema = 'public' AND c.column_name = 'workspaceId'
     AND tb.table_type = 'BASE TABLE';

  copied := ARRAY(SELECT x FROM (SELECT unnest(tenant) x EXCEPT SELECT unnest(never)) q ORDER BY x);
  IF NOT with_chat THEN
    copied := ARRAY(SELECT x FROM (SELECT unnest(copied) x
                    EXCEPT SELECT unnest(ARRAY['ChatThread', 'ChatMessage'])) q ORDER BY x);
  END IF;

  -- Anything unclassified is new since this script was written: stop rather than
  -- guess whether it is data or identity.
  SELECT array_agg(x ORDER BY x) INTO stray FROM (
    SELECT table_name::text x FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    EXCEPT SELECT unnest(tenant) EXCEPT SELECT unnest(globals) EXCEPT SELECT unnest(ignored)
  ) q;
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'unclassified table(s): % — add them to this script', array_to_string(stray, ', ');
  END IF;

  -- Ids are per-instance, so every reference to a person or a bank link is
  -- rewritten to dev's own row: users matched by email, links by id then name.
  CREATE TEMP TABLE user_map ON COMMIT DROP AS
    SELECT su.id AS src_id, du.id AS dst_id
      FROM src."User" su JOIN "User" du ON lower(du.email) = lower(su.email);

  CREATE TEMP TABLE link_map ON COMMIT DROP AS
    SELECT sl.id AS src_id,
           coalesce((SELECT d.id FROM "BankLink" d WHERE d.id = sl.id AND d."workspaceId" = dst_ws),
                    (SELECT d.id FROM "BankLink" d WHERE d."workspaceId" = dst_ws AND d.name = sl.name LIMIT 1),
                    (SELECT d.id FROM "BankLink" d WHERE d."workspaceId" = dst_ws LIMIT 1)) AS dst_id
      FROM src."BankLink" sl WHERE sl."workspaceId" = src_ws;
  IF EXISTS (SELECT 1 FROM link_map WHERE dst_id IS NULL) THEN
    RAISE EXCEPTION 'no bank link in target workspace % to map source links onto', ws_slug;
  END IF;

  -- Load order would otherwise have to be a topological sort (Budget even
  -- references itself). Suspending FK triggers costs nothing here because every
  -- constraint is re-checked by hand before this transaction commits.
  SET LOCAL session_replication_role = replica;

  FOREACH t IN ARRAY globals LOOP
    PERFORM pg_temp.merge_rows(t, 'true');
  END LOOP;
  -- Merchants with no workspace are shared the same way.
  PERFORM pg_temp.merge_rows('Merchant', format('s.%I IS NULL', 'workspaceId'));

  FOREACH t IN ARRAY copied LOOP
    EXECUTE format('DELETE FROM %I WHERE %I = $1', t, 'workspaceId') USING dst_ws;
  END LOOP;

  FOREACH t IN ARRAY copied LOOP
    rel := format('public.%I', t)::regclass;

    cols := NULL;
    sel := NULL;
    FOR rec IN
      SELECT a.attname, a.attnotnull,
             (SELECT p.relname FROM pg_constraint f JOIN pg_class p ON p.oid = f.confrelid
               WHERE f.conrelid = rel AND f.contype = 'f' AND f.conkey[1] = a.attnum LIMIT 1) AS parent,
             pg_get_serial_sequence(format('public.%I', t), a.attname) IS NOT NULL AS generated,
             EXISTS (SELECT 1 FROM pg_constraint f
                      WHERE f.contype = 'f' AND f.confrelid = rel AND f.confkey[1] = a.attnum) AS referenced
        FROM pg_attribute a
       WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum
    LOOP
      -- Counter-assigned ids are per-instance: the other dev workspaces already
      -- hold these numbers, so let the target mint its own.
      IF rec.generated THEN
        IF rec.referenced THEN
          RAISE EXCEPTION '%.% is generated and referenced by a foreign key — needs an id remap', t, rec.attname;
        END IF;
        CONTINUE;
      END IF;

      IF rec.parent = 'Workspace' OR rec.attname = 'workspaceId' THEN
        expr := quote_literal(dst_ws);
      ELSIF rec.parent = 'User' THEN
        expr := format('(SELECT m.dst_id FROM user_map m WHERE m.src_id = s.%I)', rec.attname);
        IF rec.attnotnull THEN expr := format('coalesce(%s, %L)', expr, owner_id); END IF;
      ELSIF rec.parent = 'BankLink' THEN
        expr := format('(SELECT m.dst_id FROM link_map m WHERE m.src_id = s.%I)', rec.attname);
      ELSIF rec.parent = ANY (tenant) AND NOT rec.parent = ANY (copied) THEN
        -- Points at a table this run is skipping (chat, when excluded).
        IF rec.attnotnull THEN
          RAISE EXCEPTION '%.% requires %, which this run skips', t, rec.attname, rec.parent;
        END IF;
        expr := 'NULL';
      ELSE
        expr := format('s.%I', rec.attname);
      END IF;
      cols := concat_ws(', ', cols, quote_ident(rec.attname));
      sel  := concat_ws(', ', sel, expr);
    END LOOP;

    EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM src.%I s WHERE s.%I = %L',
                   t, cols, sel, t, 'workspaceId', src_ws);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '% <- % rows', rpad(t, 20), n;
  END LOOP;

  -- Ids came across verbatim, so the identity counters have to catch up.
  FOR rec IN
    SELECT c.relname AS tbl, a.attname AS col,
           pg_get_serial_sequence(format('public.%I', c.relname), a.attname) AS seq
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND pg_get_serial_sequence(format('public.%I', c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, coalesce((SELECT max(%I) FROM %I), 0) + 1, false)',
                   rec.seq, rec.col, rec.tbl);
  END LOOP;

  SET LOCAL session_replication_role = origin;
END
$refresh$;

-- Every FK in the database, re-checked by hand: the guarantee the suspended
-- triggers would have given, and it also catches dev rows orphaned by the wipe.
DO $validate$
DECLARE rec record; bad bigint;
BEGIN
  FOR rec IN
    SELECT f.conname, f.conrelid::regclass AS child, ca.attname AS ccol,
           f.confrelid::regclass AS parent, pa.attname AS pcol
      FROM pg_constraint f
      JOIN pg_attribute ca ON ca.attrelid = f.conrelid AND ca.attnum = f.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = f.confrelid AND pa.attnum = f.confkey[1]
     WHERE f.contype = 'f' AND f.connamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('SELECT count(*) FROM %s c LEFT JOIN %s p ON c.%I = p.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL',
                   rec.child, rec.parent, rec.ccol, rec.pcol, rec.ccol, rec.pcol) INTO bad;
    IF bad > 0 THEN
      RAISE EXCEPTION 'dangling reference: % row(s) in %.% (%)', bad, rec.child, rec.ccol, rec.conname;
    END IF;
  END LOOP;
END
$validate$;

DROP SCHEMA src CASCADE;
DROP SERVER refresh_src CASCADE;
COMMIT;
SQL

if [[ $KEEP_SRC != true ]]; then
  psql_ -d postgres -c "DROP DATABASE IF EXISTS $SRC_DB WITH (FORCE)" >/dev/null
fi

echo "==> done"
