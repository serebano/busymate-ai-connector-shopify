import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * App Store listing copy — the Shopify listing rules, enforced in-repo
 * (busymate-devtools#2110; App Store requirements 4.2.3 / 4.3.3 / 4.4.1).
 *
 * `listing/<locale>.json` is what a human pastes into the Partner Dashboard's
 * Introduction / App details / Features fields. Shopify rejects listings that put
 * pricing outside "Pricing details" (4.2.3 — the editor's own REVIEW TIP flagged
 * the word "pay") or statistics/data such as a language count in the copy (4.3.3,
 * 4.4.1). The Aug-2026 draft carried both ("in 14 languages", "You pay only…"), so
 * this test pins the rule for every locale:
 *   - the partner-form fields (intro, details, feature_bullets) carry NO numerals
 *     and (en) NO pricing words — pricing lives ONLY in `pricing_summary`
 *   - the en field lengths fit the Partner form limits (intro ≤100, details ≤500,
 *     3–5 features ≤80 each, tagline/subtitle ≤62)
 *   - all 14 Tier-1 locales exist with the same keys, REAL translations (not the
 *     English placeholder), and the same support URLs as en (the live legal pages)
 */
const ROOT = process.cwd();
const LISTING = join(ROOT, "listing");
const TIER1 = ["en", "es", "pt-BR", "fr", "de", "it", "ru", "ro", "tr", "ar", "zh-Hans", "hi", "ja", "ko"];

type Listing = {
  _locale: string;
  app_name: string;
  tagline: string;
  intro: string;
  details: string;
  feature_bullets: string[];
  pricing_summary: string;
  privacy_url: string;
  faq_url: string;
};

const read = (locale: string): Listing => JSON.parse(readFileSync(join(LISTING, `${locale}.json`), "utf8"));
const en = read("en");

/** ASCII + Arabic-Indic + Persian + Devanagari digits — a "language count" in any script. */
const NUMERAL = /[0-9٠-٩۰-۹०-९]/;
/** Pricing vocabulary Shopify's editor flags outside Pricing details (4.2.3). */
const PRICING_WORD = /\b(pay|pays|paid|price|prices|pricing|cost|costs|bill|billed|billing|cap|capped|trial|free|usd|per month)\b|\$/i;

const partnerFields = (l: Listing) => [l.intro, l.details, ...l.feature_bullets];

describe("listing copy — Partner-form fields (all locales)", () => {
  it("ships exactly the 14 Tier-1 locale files", () => {
    const files = readdirSync(LISTING).filter((f) => f.endsWith(".json") && f !== "pricing.json").map((f) => f.replace(/\.json$/, ""));
    expect(files.sort()).toEqual([...TIER1].sort());
  });

  for (const locale of TIER1) {
    describe(locale, () => {
      const l = read(locale);

      it("has the same keys as en and the right _locale", () => {
        expect(Object.keys(l).sort()).toEqual(Object.keys(en).sort());
        expect(l._locale).toBe(locale);
        expect(l.app_name).toBe("Busymate AI");
      });

      it("carries no numerals in intro / details / features (4.3.3 — no statistics or data)", () => {
        for (const s of partnerFields(l)) {
          expect(s, `${locale}: "${s.slice(0, 60)}"`).not.toMatch(NUMERAL);
        }
      });

      it("has 3–5 feature bullets", () => {
        expect(l.feature_bullets.length).toBeGreaterThanOrEqual(3);
        expect(l.feature_bullets.length).toBeLessThanOrEqual(5);
      });

      it("links the same live legal pages as en", () => {
        expect(l.privacy_url).toBe(en.privacy_url);
        expect(l.faq_url).toBe(en.faq_url);
      });

      if (locale !== "en") {
        it("is a real translation, not the English placeholder", () => {
          expect(l.intro).not.toBe(en.intro);
          expect(l.details).not.toBe(en.details);
          expect(l.tagline).not.toBe(en.tagline);
          expect(l.feature_bullets).not.toEqual(en.feature_bullets);
        });
      }
    });
  }
});

describe("listing copy — en (the source the Partner form is filled from)", () => {
  it("fits the Partner Dashboard field limits", () => {
    expect(en.intro.length).toBeLessThanOrEqual(100);
    expect(en.details.length).toBeLessThanOrEqual(500);
    expect(en.tagline.length).toBeLessThanOrEqual(62);
    for (const b of en.feature_bullets) expect(b.length, b).toBeLessThanOrEqual(80);
  });

  it("keeps pricing words out of intro / details / features (4.2.3 — only in Pricing details)", () => {
    for (const s of partnerFields(en)) {
      const m = s.match(PRICING_WORD);
      expect(m, `pricing word "${m?.[0]}" in: "${s}"`).toBeNull();
    }
  });

  it("points support links at the live store.busymate.ai legal pages", () => {
    expect(en.privacy_url).toBe("https://store.busymate.ai/legal/shopify-privacy");
    expect(en.faq_url).toBe("https://store.busymate.ai/legal/faq");
  });

  it("pricing_summary is the ONLY field allowed to talk about plans (and stays voice/enterprise-free)", () => {
    expect(en.pricing_summary).toMatch(/plan/i);
    expect(en.pricing_summary).not.toMatch(/voice|enterprise/i);
  });
});
