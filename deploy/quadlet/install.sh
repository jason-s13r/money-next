#!/usr/bin/env bash
# Install the money self-host stack as rootless podman Quadlet units.
#
#   cp money.env.example money.env   # then fill it in
#   ./install.sh                     # build images + install units
#   ./install.sh --no-build          # skip the image build (units/env only)
#
# What it does:
#   - builds the app (runner) and tooling (build) images, unless --no-build
#   - copies money.env to ~/.config/money/money.env (chmod 600)
#   - derives the three per-role DATABASE_URL env files from the passwords
#   - installs the Quadlet units to ~/.config/containers/systemd/money/
#   - runs `systemctl --user daemon-reload`
#
# It does NOT start anything — see the printed next steps.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
build=1
[[ "${1:-}" == "--no-build" ]] && build=0

env_src="$here/money.env"
if [[ ! -f "$env_src" ]]; then
  echo "error: $env_src not found. Copy money.env.example to money.env and fill it in." >&2
  exit 1
fi

# Load the values we need to compose the DATABASE_URLs.
set -a; . "$env_src"; set +a
for var in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB APP_DB_PASSWORD SYNC_DB_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "error: $var is empty in money.env" >&2
    exit 1
  fi
done

if [[ "$build" == 1 ]]; then
  # Stamp the app image with the commit and build time. The app reads these back
  # at runtime and prints them at the foot of the sidebar (lib/server/build-info),
  # which is how you tell whether a restart actually picked up the rebuild. Both
  # ARGs sit in the last Dockerfile stage, so a new sha costs no cache. `+dirty`
  # marks a build made from an uncommitted tree — the sha alone would be a lie.
  git_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$git_sha" && -n "$(git -C "$repo_root" status --porcelain 2>/dev/null)" ]]; then
    git_sha="$git_sha+dirty"
  fi
  built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Where this build came from, so the sidebar can link the sha to the commit.
  # The branch's own remote (branch.<name>.remote) is the honest answer to that,
  # falling back to origin for a detached HEAD or a branch that tracks nothing.
  # Passed in git's spelling, ssh or https; the app derives the web URL from it.
  git_branch="$(git -C "$repo_root" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  git_remote_name="$(git -C "$repo_root" config "branch.$git_branch.remote" 2>/dev/null || true)"
  git_remote="$(git -C "$repo_root" remote get-url "${git_remote_name:-origin}" 2>/dev/null || true)"

  echo "==> Building images from $repo_root (${git_sha:-no git}, $built_at)"
  podman build --target runner \
    --build-arg "GIT_SHA=$git_sha" \
    --build-arg "BUILT_AT=$built_at" \
    --build-arg "GIT_REMOTE=$git_remote" \
    -t localhost/money-app:latest "$repo_root"
  podman build --target build  -t localhost/money-tooling:latest "$repo_root"
fi

conf="$HOME/.config/money"
units="$HOME/.config/containers/systemd/money"
mkdir -p "$conf" "$units"

echo "==> Writing secrets to $conf"
install -m 600 "$env_src" "$conf/money.env"

# Members share the pod's loopback, so they reach Postgres at 127.0.0.1. That
# hits the postgres image's pg_hba `trust` rule for loopback, so the password
# isn't actually verified — but we still supply the right one per role so the
# URLs are correct if pg_hba is ever tightened.
host="127.0.0.1"
# Percent-encode a credential for use in the URL's userinfo. A password is an
# opaque string, not a URL component: a literal '@', ':', '/', '?', '#', '%' or
# space in it makes the DATABASE_URL unparseable, and Prisma rejects it at
# connect time as ERR_INVALID_URL — a failure that surfaces three layers away as
# a redacted Server Component error. Encode everything outside the RFC 3986
# unreserved set. ASCII only, which passwords here should be.
urlencode() {
  local s="$1" out="" c i
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}
db_url() { printf 'postgresql://%s:%s@%s:5432/%s?schema=public' "$(urlencode "$1")" "$(urlencode "$2")" "$host" "$POSTGRES_DB"; }
umask 077
printf 'DATABASE_URL=%s\n' "$(db_url "$POSTGRES_USER" "$POSTGRES_PASSWORD")" > "$conf/db-owner.env"
printf 'DATABASE_URL=%s\n' "$(db_url money_app "$APP_DB_PASSWORD")"          > "$conf/db-app.env"
printf 'DATABASE_URL=%s\n' "$(db_url money_sync "$SYNC_DB_PASSWORD")"        > "$conf/db-sync.env"

echo "==> Installing Quadlet units to $units"
# Quadlet passes [Container] EnvironmentFile= to podman as --env-file, so systemd
# does NOT expand %h there — resolve it to an absolute path here. Likewise
# PublishPort (on money.pod) is not env-expanded, so bake APP_PORT in.
app_port="${APP_PORT:-3000}"
for unit in "$here"/money.pod "$here"/money-pgdata.volume "$here"/*.container; do
  sed -e "s|%h|$HOME|g" \
      -e "s|^PublishPort=3000:3000$|PublishPort=${app_port}:3000|" \
      "$unit" > "$units/$(basename "$unit")"
done

echo "==> systemctl --user daemon-reload"
systemctl --user daemon-reload

cat <<'EOF'

Done. Next steps:

  # keep user services running across logout / at boot (run once, ever):
  loginctl enable-linger "$USER"

  # start the stack (app pulls in the pod, postgres, and migrate):
  systemctl --user start money-app.service
  systemctl --user start money-worker.service money-cron.service

  # watch it come up:
  systemctl --user status money-migrate.service
  journalctl --user -u money-app.service -f

The admin CLI (money user, money workspace, money link, money sync, …) lives in the
tooling image, not the app image, so it runs inside money-worker. Several commands
prompt for a secret, hence -it. Worth an alias in ~/.bashrc:

  alias moneycli='podman exec -it --env-file ~/.config/money/db-owner.env money-worker money'

  moneycli                     # every command, grouped
  moneycli user create --email you@example.com --name "Your Name"
  moneycli link token --list

Tab completion — re-run after any upgrade that adds a command:

  podman exec -i --env-file ~/.config/money/db-owner.env money-worker \
    money completion bash > ~/.bashrc.d/moneycli.sh


An older alias ending in `pnpm` keeps working — `moneycli money:cli user create` —
so upgrading the box and re-sourcing your shell profile are not the same step.

The owner connection is what makes one alias cover every command: money-worker runs
as money_sync, which has SELECT on Workspace and no access to User or Session at
all, so anything touching the control plane needs the env-file override. `link token`
is the exception that would rather have the container's own money_sync identity —
drop the --env-file for that one if you care to.

To reinstall after a `git pull` or an image rebuild:
  ./install.sh && systemctl --user restart money-app.service
EOF
