#!/usr/bin/env bash
set -euo pipefail
revision=${1:-}
checkout=${2:-/opt/busymate-ai-shopify}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release revision' >&2; exit 1; }
[[ "$checkout" = /* ]] || { echo 'Checkout must be an absolute path' >&2; exit 1; }
# This is the existing SETUP3b root runbook: app commands execute as deploy.
[[ $(id -u) = 0 ]] || { echo 'Host runbook requires an authorized root SSH identity' >&2; exit 1; }
cd -- "$checkout"
exec 9>.git/bmai-app-host-deploy.lock
flock -n 9 || { echo 'Another app host deployment holds the checkout' >&2; exit 1; }
run_deploy() { sudo -n -u deploy -- "$@"; }
git_deploy() { run_deploy git -c "safe.directory=$checkout" "$@"; }
[[ -z $(git_deploy status --porcelain) ]] || { echo 'Refusing a dirty host checkout' >&2; exit 1; }
previous=$(git_deploy rev-parse HEAD)
echo "Previous rollback commit: $previous"
git_deploy fetch origin
[[ $(git_deploy cat-file -t "$revision") = commit ]] || { echo 'Requested revision is not a commit' >&2; exit 1; }
git_deploy merge-base --is-ancestor "$revision" origin/main || {
  echo 'Requested revision is not protected-main history' >&2; exit 1;
}
git_deploy checkout --detach "$revision"
run_deploy npm ci
run_deploy npx prisma generate
run_deploy npx prisma migrate deploy
run_deploy env "BMAI_APP_BUILD_REVISION=$revision" npm run build
systemctl restart busymate-ai-shopify
# A running unit is insufficient. Require the public service's compiled revision.
for attempt in {1..30}; do
  if response=$(curl -fsS --connect-timeout 10 --max-time 15 \
    "https://store.busymate.ai/api/bmai/status?release=$revision") && \
    run_deploy node scripts/verify-release.mjs "$revision" <<< "$response"; then
    echo "Verified live app-server commit: $revision"
    exit 0
  fi
  sleep 2
done
echo "Live revision verification failed; rollback commit remains $previous" >&2
exit 1
