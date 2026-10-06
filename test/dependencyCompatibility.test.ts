import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromFile } from "@prisma/config";
import { describe, expect, it } from "vitest";

// Resolve through the actual consumer: a second, unused root copy must not make
// these checks pass while Prisma still loads an affected dependency.
const require = createRequire(import.meta.url);
const prismaRequire = createRequire(require.resolve("@prisma/config"));
const { deepmerge } = prismaRequire("deepmerge-ts") as typeof import("deepmerge-ts");
const expressRequire = createRequire(require.resolve("express"));
const proxyaddr = expressRequire("proxy-addr") as {
  compile(subnet: string): (ip: string) => boolean;
};

describe("locked dependency compatibility", () => {
  it("preserves ordinary configuration merging without mutating inputs", () => {
    const base = { migrations: { path: "migrations" }, list: ["base"] };
    const override = { migrations: { seed: "node seed.mjs" }, list: ["override"] };
    expect(deepmerge(base, override)).toEqual({
      migrations: { path: "migrations", seed: "node seed.mjs" },
      list: ["base", "override"],
    });
    expect(base).toEqual({ migrations: { path: "migrations" }, list: ["base"] });
    expect(override).toEqual({ migrations: { seed: "node seed.mjs" }, list: ["override"] });
  });

  it("terminates circular object merging and preserves the cycle", () => {
    type Cyclic = { value: string; self?: Cyclic };
    const first: Cyclic = { value: "first" };
    const second: Cyclic = { value: "second" };
    first.self = first;
    second.self = second;
    const merged = deepmerge(first, second);
    expect(merged.value).toBe("second");
    expect(merged.self).toBe(merged);
    expect(first.value).toBe("first");
  });

  it("loads a real Prisma config and normalizes its paths without database access", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "shopify-prisma-config-")));
    try {
      await writeFile(join(directory, "prisma.config.mjs"),
        'export default { schema: "./schema.prisma", migrations: { path: "./migrations" } };');
      const result = await loadConfigFromFile({ configRoot: directory });
      expect(result.error).toBeUndefined();
      expect(result.config?.schema).toBe(join(directory, "schema.prisma"));
      expect(result.config?.migrations?.path).toBe(join(directory, "migrations"));
      expect(result.resolvedPath).toBe(join(directory, "prisma.config.mjs"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not trust arbitrary IPv4 addresses through a malformed mapped subnet", () => {
    expect(proxyaddr.compile("::ffff:10.0.0.0/8")("203.0.113.7")).toBe(false);
    const valid = proxyaddr.compile("10.0.0.0/8");
    expect(valid("10.2.3.4")).toBe(true);
    expect(valid("203.0.113.7")).toBe(false);
  });
});
