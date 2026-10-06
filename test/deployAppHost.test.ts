import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { transformSync } from "esbuild";
import { verifyRelease } from "../scripts/verify-release.mjs";

const SHA = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bmai-shopify41-"));
  fixtures.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "scripts"));
  copyFileSync("scripts/verify-release.mjs", join(root, "scripts/verify-release.mjs"));
  const command = (name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  command("id", "echo 0");
  command("flock", "exit 0");
  command("sleep", "exit 0");
  command("sudo", 'shift 4; exec "$@"');
  command("git", `shift 2
echo "git $*" >> "$CALL_LOG"
case "$1" in
 status) printf '%s' "\${DIRTY:-}";;
 rev-parse) echo '${PREVIOUS}';;
 cat-file) echo commit;;
 merge-base) [[ "\${OFF_MAIN:-}" != 1 ]];;
esac`);
  command("npm", `echo "npm $* revision=\${BMAI_APP_BUILD_REVISION:-}" >> "$CALL_LOG"
[[ "\${BUILD_FAIL:-}" != 1 || "$1" != run ]]`);
  command("npx", 'echo "npx $*" >> "$CALL_LOG"');
  command("systemctl", 'echo "systemctl $*" >> "$CALL_LOG"');
  command("curl", `echo "curl" >> "$CALL_LOG"
printf '{"ok":true,"revision":"%s"}' "\${LIVE_REV:-${SHA}}"`);
  command("node", 'exec "$REAL_NODE" "$@"');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: join(root, "calls"), REAL_NODE: process.execPath };
  return { root, env, command, calls: () => { try { return readFileSync(env.CALL_LOG, "utf8"); } catch { return ""; } } };
}

describe("exact app host release", () => {
  it("runs the real remote script sequence and requires the public compiled revision", () => {
    const f = fixture();
    const run = spawnSync("bash", ["scripts/deploy-app-host-remote.sh", SHA, f.root], { env: f.env, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Previous rollback commit: ${PREVIOUS}`);
    expect(run.stdout).toContain(`Verified live app-server commit: ${SHA}`);
    expect(f.calls()).toContain(`checkout --detach ${SHA}`);
    expect(f.calls()).toContain(`npm run build revision=${SHA}`);
    expect(f.calls().indexOf("npx prisma migrate deploy")).toBeLessThan(f.calls().indexOf("npm run build"));
    expect(f.calls().indexOf("npm run build")).toBeLessThan(f.calls().indexOf("systemctl restart"));
  });
  it("a failed build never restarts or reports deployment success", () => {
    const f = fixture();
    const run = spawnSync("bash", ["scripts/deploy-app-host-remote.sh", SHA, f.root], { env: { ...f.env, BUILD_FAIL: "1" }, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(f.calls()).not.toContain("systemctl");
    expect(run.stdout).not.toContain("Verified live");
  });
  it.each([{ DIRTY: " M app/file.ts" }, { OFF_MAIN: "1" }])("refuses dirty or non-main host state before checkout", (control) => {
    const f = fixture();
    const run = spawnSync("bash", ["scripts/deploy-app-host-remote.sh", SHA, f.root], { env: { ...f.env, ...control }, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(f.calls()).not.toContain("checkout");
    expect(f.calls()).not.toContain("npm");
  });
  it("a healthy but stale public server remains a failed release", () => {
    const f = fixture();
    const run = spawnSync("bash", ["scripts/deploy-app-host-remote.sh", SHA, f.root], { env: { ...f.env, LIVE_REV: PREVIOUS }, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`rollback commit remains ${PREVIOUS}`);
    expect(run.stdout).not.toContain("Verified live");
  });
  it("missing credentials fail before SSH; invalid revision/destination cannot become shell code", () => {
    const f = fixture();
    f.command("ssh", 'echo called >> "$CALL_LOG"');
    for (const [sha, secretEnv] of [
      [SHA, {}], ["$(echo injected)", {}],
      [SHA, { DEPLOY_HOST: "--proxy-command=malicious", DEPLOY_SSH_KEY: "fixture-key", DEPLOY_KNOWN_HOSTS: "fixture-pin" }],
    ] as const) {
      const run = spawnSync("bash", ["scripts/deploy-app-host.sh", sha], {
        env: { ...f.env, DEPLOY_HOST: "", DEPLOY_SSH_KEY: "", DEPLOY_KNOWN_HOSTS: "", ...secretEnv }, encoding: "utf8",
      });
      expect(run.status).not.toBe(0);
      expect(f.calls()).toBe("");
      expect(run.stderr).not.toContain("fixture-key");
    }
  });
  it("uses pinned SSH hosts, private temporary key files, and clears secret environment before transport", () => {
    const f = fixture();
    f.command("ssh", `key=''; known=''; prior=''
for arg in "$@"; do
  [[ "$prior" != -i ]] || key="$arg"
  case "$arg" in UserKnownHostsFile=*) known="\${arg#UserKnownHostsFile=}";; esac
  prior="$arg"
done
[[ -n "$key" && -n "$known" && -z "\${DEPLOY_SSH_KEY:-}" && -z "\${DEPLOY_KNOWN_HOSTS:-}" ]]
[[ $(cat "$key") = fixture-key && $(cat "$known") = fixture-pin ]]
"$REAL_NODE" -e 'const fs=require("node:fs");if((fs.statSync(process.argv[1]).mode&511)!==384)process.exit(1)' "$key"
cat >/dev/null
printf '%s' "$key" > "$CALL_LOG"`);
    const run = spawnSync("bash", ["scripts/deploy-app-host.sh", SHA], {
      env: { ...f.env, DEPLOY_HOST: "root@example.test", DEPLOY_SSH_KEY: "fixture-key", DEPLOY_KNOWN_HOSTS: "fixture-pin" }, encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).not.toContain("fixture-key");
    expect(() => readFileSync(f.calls())).toThrow(); // EXIT trap removed only this call's temp key.
  });
});

describe("release status proof", () => {
  it("accepts only an exact healthy revision, refuses absent/stale/malformed proof without echoing it", () => {
    expect(() => verifyRelease(SHA, JSON.stringify({ ok: true, revision: SHA }))).not.toThrow();
    for (const text of ["not JSON private data", JSON.stringify({ ok: true }), JSON.stringify({ ok: true, revision: PREVIOUS }), JSON.stringify({ ok: false, revision: SHA }), "x".repeat(65537)]) {
      expect(() => verifyRelease(SHA, text)).toThrow();
    }
    expect(() => verifyRelease("HEAD", "{}")).toThrow();
  });
  it("the compiled revision remains fixed when the running environment changes", async () => {
    const code = transformSync(readFileSync("app/lib/buildRevision.ts", "utf8"), {
      loader: "ts", format: "esm", define: { "process.env.BMAI_APP_BUILD_REVISION": JSON.stringify(SHA) },
    }).code;
    const prior = process.env.BMAI_APP_BUILD_REVISION;
    process.env.BMAI_APP_BUILD_REVISION = PREVIOUS;
    try {
      const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
      expect(module.APP_BUILD_REVISION).toBe(SHA);
    } finally {
      if (prior === undefined) delete process.env.BMAI_APP_BUILD_REVISION;
      else process.env.BMAI_APP_BUILD_REVISION = prior;
    }
  });
});
