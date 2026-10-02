import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetStoreListingCache,
  getStoreListing,
  storePageUrl,
  STORE_API_URL,
  STORE_APP_SLUG,
} from "../app/lib/storeListing.server";

// The public landing renders FROM the canonical store record (single source of
// truth). These tests pin the read contract: published-only anon read, TTL
// cache, and the fail-open ladder (last good value → committed snapshot).

const ROW = {
  slug: STORE_APP_SLUG,
  name: "Busymate AI",
  tagline: "Grounded, order-aware AI support for your store",
  privacy_url: "https://store.busymate.ai/legal/privacy",
};

function fetchOk(row: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => [row] });
}

beforeEach(() => {
  _resetStoreListingCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getStoreListing", () => {
  it("returns the record from the public store_apps read (published-only, anon)", async () => {
    const f = fetchOk(ROW);
    vi.stubGlobal("fetch", f);
    const listing = await getStoreListing();
    expect(listing).toEqual(ROW);
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain(`slug=eq.${STORE_APP_SLUG}`);
    expect(url).toContain("status=eq.published"); // only a published record renders
    const init = f.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.apikey).toBeTruthy(); // anon/publishable key, not service-role
  });

  it("caches within the TTL — a second call does not refetch", async () => {
    const f = fetchOk(ROW);
    vi.stubGlobal("fetch", f);
    await getStoreListing();
    await getStoreListing();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("falls back to the committed snapshot when the API is unreachable (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const listing = await getStoreListing();
    expect(listing.name).toBe("Busymate AI");
    expect(listing.tagline).toBeTruthy(); // never a blank page
    expect(listing.slug).toBe(STORE_APP_SLUG);
  });

  it("the committed snapshot matches the listing copy (same tagline + privacy URL as listing/en.json)", async () => {
    // The snapshot is a copy of the canonical record; listing/en.json is drift-checked
    // against that record — so the two must agree or the fallback landing would show
    // a different privacy link than the App Store listing (busymate-devtools#2110).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const listing = await getStoreListing();
    const en = JSON.parse(readFileSync("listing/en.json", "utf8"));
    expect(listing.tagline).toBe(en.tagline);
    expect(listing.privacy_url).toBe(en.privacy_url);
  });

  it("falls back to the snapshot on a non-ok response and on an empty row set", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => [] }));
    expect((await getStoreListing()).name).toBe("Busymate AI");
    _resetStoreListingCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    expect((await getStoreListing()).tagline).toBeTruthy();
  });

  it("serves an UPDATED record after the cache is reset (record edit propagates)", async () => {
    vi.stubGlobal("fetch", fetchOk(ROW));
    await getStoreListing();
    _resetStoreListingCache(); // stands in for the TTL expiring
    const edited = { ...ROW, tagline: "New tagline from the record" };
    vi.stubGlobal("fetch", fetchOk(edited));
    expect((await getStoreListing()).tagline).toBe("New tagline from the record");
  });
});

describe("storePageUrl", () => {
  it("derives the busymate.ai store page from the record slug", () => {
    expect(storePageUrl(ROW)).toBe(
      `https://busymate.ai/store/apps/${STORE_APP_SLUG}`
    );
  });
});

// 2026-10-02 P3 cutover: store_apps moved to Busymate AI's own project. The default
// read host must be api.busymate.ai — the devtools host (api.busymate.net) is retired.
describe("store record host", () => {
  it("defaults to the Busymate AI project, never the retired devtools host", async () => {
    if (process.env.BUSYMATE_STORE_API_URL) return; // an explicit override is the operator's call
    expect(STORE_API_URL).toBe("https://api.busymate.ai/rest/v1");
    const f = fetchOk(ROW);
    vi.stubGlobal("fetch", f);
    await getStoreListing();
    expect(String(f.mock.calls[0][0])).toMatch(/^https:\/\/api\.busymate\.ai\/rest\/v1\/store_apps\?/);
    expect(String(f.mock.calls[0][0])).not.toContain("busymate.net");
  });
});
