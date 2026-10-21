#!/usr/bin/env bash
# migrate-rename.sh — move the busymate-ai-shopify app host from its old
# bmai-shopify-app unit/path names to the renamed ones, safely.
#
# Context: the repo was renamed on GitHub (serebano/bmai-shopify-app ->
# serebano/busymate-ai-shopify, owner order 2026-09-18) and this repo's own
# unit/path references were renamed in the same change (docs/ops/
# rename-migration-2026-09.md). This script performs the matching, one-time
# migration of the LIVE host artifacts:
#   systemd unit  bmai-shopify-app.service   -> busymate-ai-shopify.service
#   install path  /opt/bmai-shopify-app      -> /opt/busymate-ai-shopify
#   env dir       /etc/bmai-shopify-app      -> /etc/busymate-ai-shopify
#
# Safe by construction:
#   - Default (no flags) is PLAN-ONLY: prints every command it would run and
#     exits 0 without touching anything. Nothing happens without --apply.
#   - NEVER deletes. A move is `mv OLD NEW` followed by `ln -s NEW OLD`, so the
#     old path keeps working (as a symlink) for anything not yet updated.
#   - Idempotent: safe to re-run. Each step checks current state first and
#     skips if already done (already a symlink, unit already installed, etc).
#   - Auto-rollback: if the new unit does not answer its health check within
#     HEALTH_TIMEOUT seconds of --apply, this script re-enables + restarts the
#     OLD unit before exiting non-zero (the symlinks mean the old unit still
#     serves the current code, so this is a safe restart, not a code revert).
#   - --rollback: manual rollback path — stop/disable the new unit, re-enable
#     + start the old one. Does not touch the symlinks or files.
#
# All real paths are overridable by environment variable so this script can be
# exercised end-to-end in a temp dir with a stubbed `systemctl`/`curl` on PATH
# (see scripts/ops/test-migrate-rename.sh) without root or a real host.
#
# Usage:
#   scripts/ops/migrate-rename.sh              # print the plan, do nothing
#   scripts/ops/migrate-rename.sh --apply      # perform the migration
#   scripts/ops/migrate-rename.sh --rollback   # revert to the old unit/paths
#
# This script makes NO network calls other than the local health check, and
# NEVER runs over SSH — it is meant to be copied to / run ON the app host by
# whoever performs the migration (the ship lane), never invoked remotely by
# an agent.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (overridable for tests)
# ---------------------------------------------------------------------------
OLD_NAME="${OLD_NAME:-bmai-shopify-app}"
NEW_NAME="${NEW_NAME:-busymate-ai-shopify}"

OPT_ROOT="${OPT_ROOT:-/opt}"
ETC_ROOT="${ETC_ROOT:-/etc}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"

OLD_OPT_DIR="${OPT_ROOT}/${OLD_NAME}"
NEW_OPT_DIR="${OPT_ROOT}/${NEW_NAME}"
OLD_ENV_DIR="${ETC_ROOT}/${OLD_NAME}"
NEW_ENV_DIR="${ETC_ROOT}/${NEW_NAME}"

OLD_UNIT="${UNIT_DIR}/${OLD_NAME}.service"
NEW_UNIT="${UNIT_DIR}/${NEW_NAME}.service"

# The unit file this script installs as NEW_UNIT. Defaults to the copy that
# ships in this repo, resolved relative to the script's own location so it
# works regardless of cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
SOURCE_UNIT_FILE="${SOURCE_UNIT_FILE:-${REPO_ROOT}/deploy/systemd/${NEW_NAME}.service}"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3970/api/bmai/status}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"

MODE="plan"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --rollback) MODE="rollback" ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (use --apply, --rollback, or nothing for a plan)" >&2
      exit 2
      ;;
  esac
done

log() { printf '[migrate-rename] %s\n' "$*"; }
plan() { printf '[plan] %s\n' "$*"; }
run() {
  # In plan mode, print the command instead of running it.
  if [ "$MODE" = "plan" ]; then
    plan "$*"
  else
    log "+ $*"
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

move_with_compat_symlink() {
  # move_with_compat_symlink OLD NEW — idempotent: if OLD is already a
  # symlink (a prior run completed) or NEW already exists with OLD absent,
  # this is a no-op. Never deletes anything.
  local old="$1" new="$2"
  if [ -L "$old" ]; then
    log "already migrated: $old is a symlink -> $(readlink "$old" 2>/dev/null || true)"
    return 0
  fi
  if [ -e "$new" ] && [ ! -e "$old" ]; then
    log "already migrated: $new exists and $old is gone"
    return 0
  fi
  if [ ! -e "$old" ]; then
    log "nothing to move: $old does not exist (fresh host? skipping)"
    return 0
  fi
  if [ -e "$new" ]; then
    echo "refusing to move $old -> $new: $new already exists and is not a symlink target of $old" >&2
    return 1
  fi
  run mv -- "$old" "$new"
  run ln -s -- "$new" "$old"
}

install_new_unit() {
  if [ ! -f "$SOURCE_UNIT_FILE" ]; then
    echo "source unit file not found: $SOURCE_UNIT_FILE" >&2
    return 1
  fi
  if [ -f "$NEW_UNIT" ] && cmp -s "$SOURCE_UNIT_FILE" "$NEW_UNIT" 2>/dev/null; then
    log "already installed: $NEW_UNIT matches $SOURCE_UNIT_FILE"
    return 0
  fi
  run mkdir -p -- "$UNIT_DIR"
  run cp -- "$SOURCE_UNIT_FILE" "$NEW_UNIT"
}

reload_and_switch_units() {
  run systemctl daemon-reload
  # Disable+stop the old unit first so both are never "active" at once, then
  # enable+start the new one. If the old unit does not exist (fresh host),
  # these are best-effort and ignored.
  if [ "$MODE" = "apply" ]; then
    systemctl stop "${OLD_NAME}.service" 2>/dev/null || true
    systemctl disable "${OLD_NAME}.service" 2>/dev/null || true
  else
    plan "systemctl stop ${OLD_NAME}.service (best-effort)"
    plan "systemctl disable ${OLD_NAME}.service (best-effort)"
  fi
  run systemctl enable "${NEW_NAME}.service"
  run systemctl start "${NEW_NAME}.service"
}

health_check() {
  local deadline elapsed=0
  if [ "$MODE" = "plan" ]; then
    plan "curl -fsS $HEALTH_URL (poll up to ${HEALTH_TIMEOUT}s)"
    return 0
  fi
  log "health-checking $HEALTH_URL (up to ${HEALTH_TIMEOUT}s)"
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -fsS -o /dev/null "$HEALTH_URL" 2>/dev/null; then
      log "healthy: $HEALTH_URL"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done
  return 1
}

rollback_to_old_unit() {
  # A rollback is only possible while the OLD unit file still exists. On a host
  # that has already completed the migration — or was provisioned fresh under
  # the new name — it is gone, and the first version of this function stopped
  # the NEW unit and then died on the unguarded `systemctl start <old>` under
  # `set -euo pipefail`: the service went down and nothing brought it back.
  # A rollback target that does not exist is not a rollback, so refuse loudly
  # and leave the running service untouched.
  if [ ! -f "$OLD_UNIT" ]; then
    echo "[migrate-rename] CANNOT ROLL BACK: $OLD_UNIT does not exist." >&2
    echo "[migrate-rename] Leaving ${NEW_NAME}.service exactly as it is — NOT stopping it." >&2
    echo "[migrate-rename] This host has no old unit to return to; investigate by hand." >&2
    return 1
  fi
  log "rolling back to ${OLD_NAME}.service"
  systemctl stop "${NEW_NAME}.service" 2>/dev/null || true
  systemctl disable "${NEW_NAME}.service" 2>/dev/null || true
  systemctl enable "${OLD_NAME}.service" 2>/dev/null || true
  systemctl start "${OLD_NAME}.service"
  systemctl daemon-reload
}

print_cleanup_note() {
  cat <<EOF

--------------------------------------------------------------------------
After ~7 days of stable operation on ${NEW_NAME}.service, it is safe to
remove (NOT done automatically — this script never deletes):
  - the disabled old unit file:  ${OLD_UNIT}
  - the compatibility symlinks:  ${OLD_OPT_DIR}, ${OLD_ENV_DIR}
    (only once nothing still references the old paths — grep the host for
    "${OLD_NAME}" first: crontabs, other unit files, shell history/aliases,
    log-rotation configs, monitoring checks)
--------------------------------------------------------------------------
EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  log "mode: $MODE"
  log "old name: ${OLD_NAME}  new name: ${NEW_NAME}"

  if [ "$MODE" = "rollback" ]; then
    if ! rollback_to_old_unit; then
      exit 1
    fi
    log "rollback complete"
    exit 0
  fi

  # 1. install the new unit
  install_new_unit

  # 2. move the working dir + env dir, compat symlink left at the old path
  move_with_compat_symlink "$OLD_OPT_DIR" "$NEW_OPT_DIR"
  move_with_compat_symlink "$OLD_ENV_DIR" "$NEW_ENV_DIR"

  # 3 + 4. reload systemd, switch which unit is active, then health-check
  reload_and_switch_units

  if [ "$MODE" = "plan" ]; then
    health_check
    print_cleanup_note
    log "plan complete — nothing was changed. Re-run with --apply to perform it."
    exit 0
  fi

  if ! health_check; then
    echo "[migrate-rename] UNHEALTHY after ${HEALTH_TIMEOUT}s — auto-rolling back" >&2
    if rollback_to_old_unit; then
      echo "[migrate-rename] rolled back to ${OLD_NAME}.service — migration FAILED" >&2
    else
      echo "[migrate-rename] migration FAILED and could NOT be rolled back automatically" >&2
    fi
    exit 1
  fi

  log "migration complete: ${NEW_NAME}.service is active and healthy"
  print_cleanup_note
}

main "$@"
