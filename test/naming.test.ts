import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PUBLIC-NAMING ENFORCEMENT (HARD owner rule).
 *
 * Merchant- and customer-facing copy must say "Busymate AI" and "your mate" — NEVER
 * the retired/internal codenames "bro", "eve" or "bmai" (owner order 2026-09-07,
 * busymate-devtools#2585: "bro" is retired in favour of the ordinary noun "your
 * mate"). Internal architecture is documented with the codenames in CODE COMMENTS
 * (allowed); this test scans only the surfaces a merchant or shopper actually reads:
 *   - the App Store listing copy (listing/**.json)
 *   - the storefront extension locales (extensions/**\/locales/*.json)
 *   - the extension's Theme-editor schema strings (blocks/*.liquid, comments stripped)
 *   - the embedded admin UI text (app/routes/app*.tsx + _index.tsx, code stripped)
 *
 * A regression here ships a codename to a merchant — bounce it.
 */
const ROOT = process.cwd();
const FORBIDDEN = /\b(bro|eve|bmai)\b/i;

function walk(dir: string, pred: (p: string) => boolean, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

/** Collect every string value in a parsed JSON tree. */
function jsonStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) value.forEach((v) => jsonStrings(v, acc));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => jsonStrings(v, acc));
  return acc;
}

/** Strip TS/JS/JSX comments + import/module-specifier lines, leaving rendered copy. */
function stripCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ") // JSX comments
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line) && !/\bfrom\s+["']/.test(line))
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Strip Liquid comment blocks. */
function stripLiquid(src: string): string {
  return src.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ");
}

function assertClean(label: string, text: string) {
  const m = text.match(FORBIDDEN);
  expect(m, `${label} leaks the codename "${m?.[0]}" — say "Busymate AI"/"your mate" instead`).toBeNull();
}

describe("public naming (no codenames in merchant-facing copy)", () => {
  it("refuses each retired name while preserving the public name and ordinary word boundaries", () => {
    for (const name of ["bro", "BRO", "eve", "bmai"]) {
      expect(() => assertClean("negative copy fixture", `Meet ${name}, your assistant`)).toThrow();
    }
    expect(() => assertClean("public copy fixture", "Busymate AI: your mate, with proven knowledge")).not.toThrow();
  });
  it("App Store listing copy is codename-free", () => {
    const files = walk(join(ROOT, "listing"), (p) => p.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const s of jsonStrings(JSON.parse(readFileSync(f, "utf8")))) assertClean(f, s);
    }
  });

  it("storefront extension locales are codename-free", () => {
    const files = walk(join(ROOT, "extensions"), (p) => p.includes("/locales/") && p.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const s of jsonStrings(JSON.parse(readFileSync(f, "utf8")))) assertClean(f, s);
    }
  });

  it("extension Theme-editor schema strings are codename-free", () => {
    const files = walk(join(ROOT, "extensions"), (p) => p.endsWith(".liquid"));
    for (const f of files) assertClean(f, stripLiquid(readFileSync(f, "utf8")));
  });

  it("embedded admin UI text is codename-free", () => {
    // Only the embedded-admin UI routes (app*.tsx + the public landing), not the
    // webhook handlers (which are not merchant-facing).
    const files = walk(join(ROOT, "app", "routes"), (p) => {
      const b = basename(p);
      return b.endsWith(".tsx") && (b === "app.tsx" || b.startsWith("app.") || b === "_index.tsx");
    });
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) assertClean(f, stripCode(readFileSync(f, "utf8")));
  });
});
