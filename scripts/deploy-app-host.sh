#!/usr/bin/env bash
set -euo pipefail

revision=${1:-}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'A full release commit SHA is required' >&2; exit 1; }
for name in DEPLOY_HOST DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS; do
  [[ -n "${!name:-}" ]] || { echo "Missing required deploy secret: $name" >&2; exit 1; }
done
# No shell options, ports or commands can be injected through the SSH destination.
[[ "$DEPLOY_HOST" =~ ^([a-zA-Z0-9_-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || {
  echo 'Invalid deploy host destination' >&2; exit 1;
}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
umask 077
key_dir=$(mktemp -d)
trap 'rm -rf -- "$key_dir"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$key_dir/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$key_dir/known_hosts"
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
echo "Deploying app-server commit $revision; Shopify extension/config is a separate release."
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$key_dir/known_hosts" -o ConnectTimeout=15 \
  -o ConnectionAttempts=1 -i "$key_dir/key" -- "$DEPLOY_HOST" \
  bash -s -- "$revision" < "$script_dir/deploy-app-host-remote.sh"
