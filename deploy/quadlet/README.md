# Self-host with rootless Podman Quadlet

The same stack as [`compose.prod.yaml`](../../compose.prod.yaml), as user-level systemd units in **one pod**. Pod members share a network namespace, so they reach each other on `127.0.0.1`. Only the app's port is published; Postgres stays private on loopback.

Tested on Fedora, which ships Podman and Quadlet already.

## Install

```bash
git clone https://github.com/jason-s13r/money-next.git
cd money-next/deploy/quadlet

# 1. Fill in passwords, auth secret, Akahu tokens
cp money.env.example money.env

# 2. Build images and install the units (starts nothing)
./install.sh

# 3. Keep user services running after logout and at boot (once, ever)
loginctl enable-linger "$USER"

# 4. Start it (money-app pulls in the pod, postgres and migrate)
systemctl --user start money-app.service
systemctl --user start money-worker.service money-cron.service

# 5. Watch it come up
systemctl --user status money-migrate.service
journalctl --user -u money-app.service -f
```

`install.sh` writes secrets to `~/.config/money/` and units to `~/.config/containers/systemd/money/`. Re-run it after a `git pull` or a rebuild, then restart:

```bash
./install.sh && systemctl --user restart money-app.service
```

Use `./install.sh --no-build` to update units and env only, skipping the image build.

## Create the first account

Sign-up is invite-only, so the first owner cannot come from the UI. Add this alias to `~/.bashrc`:

```bash
alias moneycli='podman exec -it --env-file ~/.config/money/db-owner.env money-worker money'
```

Then:

```bash
moneycli user create --email you@example.com --name "Your Name"
moneycli workspace create --owner you@example.com --name "Personal"
```

Two commands, not one: a user needs no workspace and a workspace needs a user, which is what keeps the bootstrap acyclic.

Everyone after that arrives through an invite link from `/w/<slug>/members`.

**Why the alias looks like that:**

- The CLI lives in the tooling image, not the app image — so it runs inside `money-worker`.
- `money-worker` connects as `money_sync`, which RLS bars from `User` and `Session`. The `--env-file` swaps in the owner connection so control-plane commands work.
- `-it` is required: several commands prompt for a secret on the terminal.

Tab completion (re-run after any upgrade that adds a command):

```bash
podman exec -i --env-file ~/.config/money/db-owner.env money-worker \
  money completion bash > ~/.bashrc.d/moneycli.sh
```

## What's installed

| File | What it is |
| --- | --- |
| `money.pod` | The pod: shared netns, and the only published port (`APP_PORT`). |
| `money-postgres.container` | Postgres 17, loopback only. |
| `money-migrate.container` | One-shot `pnpm db:setup` (migrate + RLS roles), then exits. |
| `money-app.container` | Next.js standalone. |
| `money-worker.container` | Drains the sync and budget-inference queues. |
| `money-cron.container` | Queues a sync every `SYNC_INTERVAL_SECONDS` (default 6h). |

`money-cron` only **queues**. Without `money-worker` running, syncs pile up and nothing happens — a no-op that looks exactly like a working one.

`money-worker` is the only container holding `TOKEN_PRIVATE_KEY`, `TOKEN_ENCRYPTION_KEY` and `SMTP_PASSWORD`; the app and cron units blank them.

## Everyday commands

```bash
systemctl --user status money-migrate.service    # did setup succeed?
journalctl --user -u money-app.service -f        # app logs
journalctl --user -u money-cron.service -f       # sync logs
systemctl --user restart money-app.service
moneycli sync --watch                            # sync now and follow it
moneycli workspace list                          # workspaces, members, bank links
```

## TLS

`APP_PORT` serves plain HTTP. Put a TLS reverse proxy in front (a Caddy quadlet is the tidy option) and set `BETTER_AUTH_URL` in `money.env` to that external origin — Better Auth judges same-origin against it.

Staying on plain HTTP on a trusted LAN? Set `INSECURE_HTTP=1`, or the CSP and HSTS headers will make the origin unreachable.

**Need a clean slate (no real data yet).**

```bash
systemctl --user stop money-app money-worker money-cron money-migrate money-postgres money-pod
systemctl --user reset-failed money-app money-worker money-cron money-migrate money-postgres money-pod
podman volume rm systemd-money-pgdata
./install.sh --no-build
systemctl --user start money-app.service money-worker.service money-cron.service
```

## Uninstall

```bash
./uninstall.sh            # units, config, pod, containers — KEEPS data and images
./uninstall.sh --volume   # also delete the Postgres volume (DELETES DATA)
./uninstall.sh --images   # also remove the built images
./uninstall.sh --all      # everything
```

Order matters and the script handles it: stop, `reset-failed`, remove units, `daemon-reload`, then remove the pod — so the pod's unit can't be left "satisfied" while the pod is gone. Your unrelated containers are untouched.
