# Host migration: `bmai-shopify-app` → `busymate-ai-shopify` (2026-09)

## Why

The repo was renamed on GitHub 2026-09-18 (owner order): `serebano/bmai-shopify-app`
→ `serebano/busymate-ai-shopify`. GitHub's redirect keeps clones/links working, but
it is not a reference — the repo's own text was updated in
`chore: rename self-references bmai-shopify-app -> busymate-ai-shopify` (701e11a)
and the follow-up `chore/rename-all-references` branch, which additionally renamed
every **live-infra** reference still using the old name:

- systemd unit file `deploy/systemd/bmai-shopify-app.service` → `busymate-ai-shopify.service`
  (`Description=`, `WorkingDirectory=`, `EnvironmentFile=`)
- `SETUP.md`, `CHECKLIST.md`, `docs/DATA-RETENTION.md`, `app/routes/api.billing.meter.tsx`,
  `deploy/nginx/shopify.busymate.ai.conf`, `.github/workflows/deploy.yml`,
  `scripts/{mint-provision-credential,retrain-shops,verify-provision}` — every
  comment/instruction naming `/opt/bmai-shopify-app`, `/etc/bmai-shopify-app/env`,
  or the `bmai-shopify-app` systemd unit
- `package-lock.json` (`name` fields, drifted from `package.json`, already
  `busymate-ai-shopify`)

**None of this touches the live host.** The host (`busymate-v2-lon1`) still runs
the OLD unit/paths until someone runs the migration below.

**Left unchanged, intentionally** (Shopify-side identifiers the Partner
dashboard keys on — see the repo CLAUDE.md / 701e11a for the full reasoning):
`shopify.app.toml` `name`/`handle`, the app's public URL host
(`shopify.busymate.ai`), the `STORE_APP_SLUG`/`APP_SLUG` constant
(`busymate-ai-shopify` — the App Store listing slug, already correct), OAuth
redirect URLs, webhook URLs.

## What changes on the host

| | Old | New |
|---|---|---|
| systemd unit | `bmai-shopify-app.service` | `busymate-ai-shopify.service` |
| install path | `/opt/bmai-shopify-app` | `/opt/busymate-ai-shopify` |
| env dir | `/etc/bmai-shopify-app/env` | `/etc/busymate-ai-shopify/env` |

The public host/domain (`shopify.busymate.ai`), the port (`3970`), the nginx
vhost file, and every secret VALUE are **unchanged**.

## How to run it

The script is `scripts/ops/migrate-rename.sh`. It is safe by construction:

- **Plan-only by default.** Run it with no flags first and read the output —
  nothing is touched.
- **Never deletes.** A "move" is `mv OLD NEW` + `ln -s NEW OLD`, so the old
  path keeps resolving (as a symlink) to the same data. Nothing that exists
  today is destroyed by this script, ever.
- **Idempotent.** Safe to re-run; each step checks current state and skips
  what's already done.
- **Auto-rollback.** After starting the new unit it health-checks
  `http://127.0.0.1:3970/api/bmai/status` for up to 30s (`HEALTH_TIMEOUT`). If
  it never goes healthy, the script re-enables + restarts the OLD unit and
  exits non-zero — the migration fails safe.
- **`--rollback`** is also available as an explicit, standalone command if the
  auto-rollback path is ever needed manually after the fact.

```bash
# On the app host (busymate-v2-lon1), from a checkout of the repo at the SHA
# that includes this migration + the renamed deploy/systemd unit file:

# 1. See the plan — does nothing.
sudo scripts/ops/migrate-rename.sh

# 2. Apply it.
sudo scripts/ops/migrate-rename.sh --apply

# Rollback (only if needed after the fact — --apply already auto-rolls-back
# on a failed health check):
sudo scripts/ops/migrate-rename.sh --rollback
```

Every path is overridable by environment variable (`OLD_NAME`, `NEW_NAME`,
`OPT_ROOT`, `ETC_ROOT`, `UNIT_DIR`, `SOURCE_UNIT_FILE`, `HEALTH_URL`,
`HEALTH_TIMEOUT`, `HEALTH_INTERVAL`) — this is also how
`scripts/ops/test-migrate-rename.sh` exercises the whole thing inside a temp
directory with a stubbed `systemctl`/`curl`, with no root and no real host.

## Ordering relative to merging `chore/rename-all-references`

This is a **repo-text-only** PR; nothing on the host depends on it landing
before the migration runs, and nothing about the migration depends on the PR
being merged first. Recommended order, to minimize the window where the repo
text and the live host disagree:

1. Merge `chore/rename-all-references` to `main` (the ship lane does this —
   this lane does not merge).
2. On the host, `git fetch && git checkout <merged sha>` inside the OLD
   `/opt/bmai-shopify-app` checkout (this still works after step 3 below via
   the compatibility symlink, or before it, either way).
3. Run `sudo scripts/ops/migrate-rename.sh` (plan) then `--apply` from that
   checkout.
4. Verify: `systemctl status busymate-ai-shopify`, `curl -s
   https://store.busymate.ai/api/bmai/status`.
5. Update the deploy secrets/paths anywhere else the OLD path is hardcoded
   outside this repo (cron, monitoring, log-rotation, shell profiles on
   `deploy`'s account) — grep the host for `bmai-shopify-app` and fix what
   this script's symlinks don't cover.
6. After ~7 days of stable operation, remove the disabled old unit file and
   the compatibility symlinks (the script prints the exact paths on every
   run) — never automated, always a manual, deliberate cleanup step.

If instead the migration must run **before** the merge (e.g. an incident),
that's also safe: the OLD unit continues running the OLD code from the OLD
path (now backed by the same files, just also reachable at the new path via
symlink) until the merged SHA is checked out and the app is rebuilt — the
migration only renames the unit/paths, it does not deploy new code.

## Devtools repo references

A read-only grep of `busymate-devtools` `origin/main` (via an existing
devtools worktree — never the boss checkout) for the exact unit/path strings
(`bmai-shopify-app.service`, `/opt/bmai-shopify-app`, `/etc/bmai-shopify-app`)
found only 2 hits, both in dated journal/ship-log entries recording what was
done at the time (`notes/journal/supabase.md:9406`,
`notes/ship-log/build-supabase-718.md:42`) — historical, not live. `deploy/`,
`infra/`, and `notes/runbooks/` have none.

Devtools already carries its own fail-closed ratchet for the broader repo
rename, `repo/no-old-shopify-repo-name` (#3326, refs #2381,
`scripts/lib/no-old-shopify-repo-name.mjs`) — a shrink-only allowlist over
every `bmai-shopify-app` mention across journals/ship-logs/program-notes/3
already-applied migration comments, separate from and complementary to this
host-unit migration. No devtools branch/issue was needed for this task.
