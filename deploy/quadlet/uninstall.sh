#!/usr/bin/env bash
# Tear down the money Quadlet stack installed by install.sh.
#
#   ./uninstall.sh              # remove units, config, pod, containers
#                               #   (KEEPS the data volume and built images)
#   ./uninstall.sh --volume     # also drop the Postgres data volume (DELETES DATA)
#   ./uninstall.sh --images      # also remove the built app/tooling images
#   ./uninstall.sh --all         # everything: units, config, volume, images
#
# Order matters, and mirrors the traps hit during setup:
#   1. stop the services (their --rm containers are removed on stop)
#   2. reset-failed so a prior "start request repeated too quickly" doesn't linger
#   3. remove the unit files, THEN daemon-reload so systemd forgets them
#   4. remove the pod — only after the units are gone, so the pod's unit can't be
#      considered "still satisfied" next install
#   5. remove secrets, then (opt-in) the data volume and images
set -euo pipefail

rm_volume=0
rm_images=0
for arg in "$@"; do
  case "$arg" in
    --volume) rm_volume=1 ;;
    --images) rm_images=1 ;;
    --all)    rm_volume=1; rm_images=1 ;;
    *) echo "unknown option: $arg (use --volume, --images, or --all)" >&2; exit 1 ;;
  esac
done

conf="$HOME/.config/money"
units="$HOME/.config/containers/systemd"
services=(money-app money-worker money-cron money-migrate money-postgres)

echo "==> Stopping services"
systemctl --user stop "${services[@]}" money-pod 2>/dev/null || true
# reset-failed also clears money-pod.service if it wedged.
systemctl --user reset-failed "${services[@]}" money-pod 2>/dev/null || true

echo "==> Removing Quadlet unit files"
rm -f "$units"/money.pod "$units"/money-pgdata.volume "$units"/money-*.container
systemctl --user daemon-reload

echo "==> Removing the podman pod"
podman pod rm -f money 2>/dev/null || true

echo "==> Removing generated secrets ($conf)"
rm -rf "$conf"

if [[ "$rm_volume" == 1 ]]; then
  echo "==> Removing the Postgres data volume (systemd-money-pgdata) — DELETING DATA"
  podman volume rm systemd-money-pgdata 2>/dev/null || true
else
  echo "==> Keeping data volume systemd-money-pgdata (pass --volume to delete it)"
fi

if [[ "$rm_images" == 1 ]]; then
  echo "==> Removing built images"
  podman rmi localhost/money-app:latest localhost/money-tooling:latest 2>/dev/null || true
else
  echo "==> Keeping built images (pass --images to remove them)"
fi

echo
echo "Done. Remaining money objects (should be empty unless intentionally kept):"
podman ps -a --filter name=money --format '  container: {{.Names}} ({{.Status}})' || true
podman volume ls --filter name=systemd-money-pgdata --format '  volume: {{.Name}}' || true
podman pod ls --filter name=money --format '  pod: {{.Name}}' || true
