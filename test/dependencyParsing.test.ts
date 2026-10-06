import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expressRequire = createRequire(require.resolve("express"));
const routesRequire = createRequire(require.resolve("@react-router/fs-routes"));
const minimatchRequire = createRequire(routesRequire.resolve("minimatch"));
const qs = expressRequire("qs") as {
  parse(input: string, options?: Record<string, unknown>): Record<string, unknown>;
  stringify(input: unknown): string;
};
const bracePath = minimatchRequire.resolve("brace-expansion");
const expand = minimatchRequire("brace-expansion") as (input: string) => string[];

// Resolve through the actual runtime/build consumers, rather than testing an
// unrelated root copy. These are compatibility controls, not app exploit claims.
describe("consumer-resolved query and route-pattern dependencies", () => {
  it("enforces comma array limits on bracket keys", () => {
    expect(() => qs.parse("a[]=1,2,3,4", {
      comma: true, arrayLimit: 3, throwOnLimitExceeded: true,
    })).toThrow(RangeError);
  });

  it("round-trips an untrusted constructor key with plain-object parsing", () => {
    const input = "x%5Bconstructor%5D%5BisBuffer%5D=y";
    const parsed = qs.parse(input, { plainObjects: true });
    expect(qs.stringify(parsed)).toBe(input);
  });

  it("preserves nested form values, encoding and default prototype protection", () => {
    const input = "shop=test.myshopify.com&tags%5B0%5D=one&tags%5B1%5D=two&note=a%20%26%20b";
    const parsed = qs.parse(input);
    expect(parsed).toEqual({ shop: "test.myshopify.com", tags: ["one", "two"], note: "a & b" });
    expect(qs.parse(qs.stringify(parsed))).toEqual(parsed);
    expect(qs.parse("x[constructor][isBuffer]=y")).toEqual({});
  });

  it("preserves ordinary route brace alternatives and ranges", () => {
    expect(expand("app.{tsx,ts}")).toEqual(["app.tsx", "app.ts"]);
    expect(expand("routes/{a,b}/{1..3}.tsx")).toEqual([
      "routes/a/1.tsx", "routes/a/2.tsx", "routes/a/3.tsx",
      "routes/b/1.tsx", "routes/b/2.tsx", "routes/b/3.tsx",
    ]);
  });

  it.each([
    ["nested groups", "'{'.repeat(4000) + 'a,b' + '}'.repeat(4000)"],
    ["comma parsing", "'{' + '{a},'.repeat(9000) + 'b}'"],
    ["repeated rewrite", "'{a}' + '}'.repeat(64000) + ',z}'"],
  ])("bounds hostile %s without stack exhaustion or an unbounded stall", (_name, expression) => {
    // A failing old dependency cannot crash or indefinitely stall the test worker.
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e",
      `const expand = require(${JSON.stringify(bracePath)}); const result = expand(${expression}); process.stdout.write(JSON.stringify({array:Array.isArray(result), length:result.length}));`,
    ], { timeout: 3000, encoding: "utf8", maxBuffer: 8192 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { array: boolean; length: number };
    expect(output.array).toBe(true);
    expect(output.length).toBeGreaterThan(0);
    expect(output.length).toBeLessThanOrEqual(10000);
  });
});
