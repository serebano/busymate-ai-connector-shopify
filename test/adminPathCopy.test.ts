import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review2 D7 (2026-11-26) — the admin menu is "Settings → Apps" (Sales channels is its own item);
 * "Settings → Apps and sales channels" sends a reviewer to a label that no longer exists.
 */
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));

describe("Review2 D7 — merchant copy names the current admin path", () => {
  it("no admin page, extension locale, listing or doc says 'Apps and sales channels'", () => {
    const hits = ["app", "extensions", "listing", "docs"]
      .flatMap(files)
      .filter((f) => /\.(tsx?|json|md|liquid)$/.test(f))
      .filter((f) => /apps\s+and\s+sales\s+channels/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
  it("Billing points to Settings → Apps → Busymate AI", () => {
    const billing = readFileSync("app/routes/app.billing.tsx", "utf8");
    expect(billing).toMatch(/Settings → Apps → Busymate AI/);
  });
});
