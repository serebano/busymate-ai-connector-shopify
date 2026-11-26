import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Security floors for the production dependency tree (`npm audit --omit=dev`,
 * triaged 2026-11-26). Each entry is the first version without the advisory; the
 * lockfile must never resolve a lower one again (a regenerated lock or a new
 * dependency could silently pull an old copy back in).
 *   body-parser < 1.20.9  DoS via trailing bytes after a compressed body (express in @react-router/serve)
 *   qs          < 6.16.1  qs.stringify arrayFormat 'comma' DoS (express)
 *   vite        < 6.4.4   launch-editor command injection (dev server; in the prod tree via @react-router/fs-routes)
 *   effect      < 3.22.1  ReDoS in Schema.TemplateLiteral (prisma CLI -> @prisma/config; package.json override)
 * Known and accepted: minimatch 9.x via @react-router/fs-routes (build-time route
 * discovery only, no fix upstream).
 */
const FLOORS: Record<string, string> = {
  "body-parser": "1.20.9",
  qs: "6.16.1",
  vite: "6.4.4",
  effect: "3.22.1",
};

function cmp(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const lock = JSON.parse(readFileSync(join(__dirname, "..", "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string; dev?: boolean }>;
};

describe("production dependency security floors", () => {
  for (const [name, floor] of Object.entries(FLOORS)) {
    it(`${name} resolves at or above ${floor} everywhere`, () => {
      const hits = Object.entries(lock.packages).filter(([path]) =>
        path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
      );
      // vite 5.x is a dev-only copy (vitest); the floor applies to the non-dev tree.
      const relevant = hits.filter(([, meta]) => !meta.dev);
      expect(relevant.length).toBeGreaterThan(0);
      const below = relevant
        .filter(([, meta]) => meta.version && cmp(meta.version, floor) < 0)
        .map(([path, meta]) => `${path}@${meta.version}`);
      expect(below).toEqual([]);
    });
  }

  it("fails the floor check on an old version (denied path)", () => {
    expect(cmp("1.20.8", "1.20.9")).toBeLessThan(0);
    expect(cmp("6.16.0", "6.16.1")).toBeLessThan(0);
    expect(cmp("3.22.5", "3.22.1")).toBeGreaterThan(0);
  });
});
