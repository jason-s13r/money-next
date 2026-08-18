# Self-host: rootless podman Quadlet

The same stack as [`compose.prod.yaml`](../../compose.prod.yaml) — postgres, a
one-shot migrate, the app, a queue worker, and a scheduled sync — as user-level
systemd Quadlet units, all in **one pod**. Pod members share a network namespace,
so they reach each other on `127.0.0.1` with no user-defined network. Only the
pod publishes a host port (the app); Postgres stays private on loopback.

## Layout

| File | Purpose |
|------|---------|
| `money.pod` | the pod: shared netns + the only published port (`APP_PORT`) |
| `money-pgdata.volume` | Postgres data volume |
| `money-postgres.container` | Postgres 17 (loopback only, no published port) |
| `money-migrate.container` | one-shot `pnpm db:setup` (migrate + RLS roles), then exits |
| `money-app.container` | Next.js standalone |
| `money-worker.container` | drains the on-demand sync queue |
| `money-cron.container` | scheduled full sync loop |
| `money.env.example` | copy to `money.env`, fill in |
| `install.sh` | build images, render env, install units |
| `uninstall.sh` | tear it all down (units/config/pod; `--volume`/`--images`/`--all`) |

## Install

On the box (Fedora ships podman + Quadlet):

```bash
git clone <this-repo> && cd money-next/deploy/quadlet
cp money.env.example money.env      # fill in passwords, secret, Akahu tokens
./install.sh                        # builds images, installs units
loginctl enable-linger "$USER"      # survive logout / run at boot (once)
systemctl --user start money-app.service          # pulls in pod, postgres, migrate
systemctl --user start money-worker.service money-cron.service
```

Then create your first account. Registration is invite-only, so the very first
owner can't come from the UI — bootstrap it by exec'ing into a tooling container.
`money-app` is the minimal standalone image (no source, no `tsx`); the worker runs
the tooling image, but as the least-privileged `money_sync` role, which RLS bars
from the `User` table. So run it in the worker with the **owner** connection:

```bash
podman exec -it --env-file ~/.config/money/db-owner.env money-worker \
  money user create --email you@example.com --name "Your Name"
podman exec -it --env-file ~/.config/money/db-owner.env money-worker \
  money workspace create --owner you@example.com --name "Personal"
```

Two steps, not one: a user needs no workspace and a workspace needs a user, which
is what keeps the bootstrap acyclic (see `money user create --help`).

`-it` is required — the command reads the password from the terminal. After that,
everyone else arrives through an invite link. Link Akahu and the worker/cron will
populate transactions.

`install.sh` writes secrets to `~/.config/money/` and units to
`~/.config/containers/systemd/`. Re-run it after a `git pull` or an image
rebuild, then `systemctl --user restart money-app.service`.

## Uninstall

```bash
./uninstall.sh            # units, config, pod, containers — KEEPS data + images
./uninstall.sh --volume   # also delete the Postgres data volume (DELETES DATA)
./uninstall.sh --images   # also remove the built images
./uninstall.sh --all      # everything
```

It stops the services, `reset-failed`s them (so a wedged unit doesn't linger),
removes the unit files and `daemon-reload`s, then removes the pod — in that order,
so the pod's unit can't be left "satisfied" while the underlying pod is gone. The
data volume and images are kept unless you opt in. Your unrelated containers are
untouched.

## Reverse proxy / TLS

`APP_PORT` exposes plain HTTP. Put it behind a TLS reverse proxy (a Caddy quadlet
is the tidy option) and set `BETTER_AUTH_URL` in `money.env` to that external
origin — Better Auth judges same-origin against it.

## Bringing your dev data over (optional)

Your dev data lives in the Mac's `money-postgres` container volume (not the
`prisma/money.db` file). For a personal setup, starting fresh and re-syncing from
Akahu is simplest — you only lose local edits (custom merchants/categories, the
change log, your account + Akahu link).

To carry everything, use **`pg_dumpall`**, not a single-database dump — the RLS
roles (`money_app`, `money_sync`) are cluster-level and a per-db dump won't
include them, which breaks the role-password step.

```bash
# On the Mac (dev):
docker exec money-postgres pg_dumpall -U money > money-cluster.sql
scp money-cluster.sql lab:~

# On the lab, before the first migrate — start only postgres:
systemctl --user start money-postgres.service
podman exec -i money-postgres psql -U money -d postgres < ~/money-cluster.sql
systemctl --user start money-app.service   # migrate deploy is now a no-op
```

The dump resets the owner (`money`) password to the dev value, so set
`POSTGRES_PASSWORD` in `money.env` to your **dev** owner password, or the migrate
step can't authenticate.

## Troubleshooting

**`money-migrate` failed with a P1000 "provide valid database credentials"
error.** Inside the pod everything talks to Postgres over `127.0.0.1`, which the
postgres image's `pg_hba.conf` matches against a `trust` rule — the password
isn't checked at all — so a genuine password mismatch can't cause this here. It's
a startup race: on a *fresh* volume, Postgres needs a few seconds to run `initdb`,
and Quadlet's `After=` only waits for the container to *start*, not to be ready.
The postgres unit sets `Notify=healthy` to hold itself "not ready" until its
healthcheck passes, which closes the gap — but if you still hit it, just re-run
migrate once Postgres is up:

```bash
systemctl --user start money-migrate.service
```

Confirm the server is reachable and healthy with:

```bash
podman exec money-postgres psql -U money -d money -c 'select 1'
```

If you need a clean slate (no real data yet), reset the volume and reinstall:

```bash
systemctl --user stop money-app money-worker money-cron money-migrate money-postgres money-pod
systemctl --user reset-failed money-app money-worker money-cron money-migrate money-postgres money-pod
podman volume rm systemd-money-pgdata
./install.sh --no-build
systemctl --user start money-app.service money-worker.service money-cron.service
```

## Common commands

```bash
systemctl --user status money-migrate.service      # did setup succeed?
journalctl --user -u money-app.service -f          # app logs
journalctl --user -u money-cron.service -f         # sync logs
systemctl --user restart money-app.service
```
