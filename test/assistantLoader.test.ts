/**
 * The theme app extension's storefront loader (extensions/storefront-assistant/
 * assets/assistant.js), executed for real in a `vm` context over a minimal fake
 * DOM — Shopify review 5.1.2 (2026-09-24): "the block no longer shows after the
 * admin and the store are closed and reopened", and a 502 on /embed/v1.js blanked
 * the launcher on every storefront.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(process.cwd(), "extensions/storefront-assistant/assets/assistant.js"), "utf8");

type Attrs = Record<string, string>;
class FakeEl {
  tagName: string;
  attrs: Attrs = {};
  parentNode: FakeParent | null = null;
  style = { cssText: "" };
  textContent = "";
  href = "";
  target = "";
  rel = "";
  title = "";
  src = "";
  async = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return k in this.attrs ? this.attrs[k] : null;
  }
}
class FakeParent {
  children: FakeEl[] = [];
  appendChild(el: FakeEl) {
    el.parentNode = this;
    this.children.push(el);
    return el;
  }
  removeChild(el: FakeEl) {
    this.children = this.children.filter((c) => c !== el);
    el.parentNode = null;
    return el;
  }
}

/** `tag[a]`, `[a="v"]`, `[a*="v"]` chains — the only shapes the loader queries. */
function matches(el: FakeEl, selector: string): boolean {
  const tag = selector.match(/^([a-z]+)/)?.[1];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const value = (k: string) => (k === "src" ? el.src || el.attrs.src : el.attrs[k]);
  for (const [, name, op, want] of selector.matchAll(/\[([a-z-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
    const have = value(name);
    if (have === undefined || have === null) return false;
    if (op === "=" && have !== want) return false;
    if (op === "*=" && !String(have).includes(want)) return false;
  }
  return true;
}

function makeWorld(opts: { currentScript?: boolean; attrs?: Attrs; designMode?: boolean; busymateAI?: object } = {}) {
  const head = new FakeParent();
  const body = new FakeParent();
  const listeners: Record<string, Array<() => void>> = {};
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const tag = new FakeEl("script");
  tag.src = "https://cdn.shopify.com/extensions/01a061be/busymate-ai-6/assets/assistant.js";
  Object.assign(tag.attrs, {
    "data-slug": "shop-demo",
    "data-origin": "https://busymate.ai",
    "data-label": "Ask us",
    "data-aria-label": "Chat with us",
    "data-title": "Our assistant",
    "data-locale": "en",
    "data-logged-in": "false",
    ...(opts.attrs ?? {}),
  });
  body.appendChild(tag);
  const all = () => [...head.children, ...body.children];
  const document = {
    currentScript: opts.currentScript === false ? null : tag,
    head,
    body,
    documentElement: body,
    createElement: (t: string) => new FakeEl(t),
    querySelector: (sel: string) => all().find((el) => matches(el, sel)) ?? null,
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const window: Record<string, unknown> = {
    document,
    Shopify: opts.designMode ? { designMode: true } : undefined,
    BusymateAI: opts.busymateAI,
  };
  const context = vm.createContext({
    window,
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ token: "t" }) }),
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ ms, fn });
      return timers.length;
    },
    Promise,
    encodeURIComponent,
  });
  const run = () => vm.runInContext(SOURCE, context);
  const loaders = () => head.children.filter((el) => (el.src || "").endsWith("/embed/v1.js"));
  const fallback = () => all().find((el) => el.attrs["data-bm-fallback"]);
  /** What a successful /embed/v1.js does: paint its layer, then fire onload. */
  const loadOk = (el: FakeEl) => {
    const layer = new FakeEl("div");
    layer.setAttribute("data-support-chat", el.attrs["data-assistant"]);
    body.appendChild(layer);
    el.onload?.();
  };
  const fireTimer = () => timers.shift()?.fn();
  const emit = (type: string) => (listeners[type] ?? []).forEach((fn) => fn());
  return { window, head, body, run, loaders, fallback, loadOk, timers, fireTimer, emit, tag };
}

describe("storefront loader (assistant.js)", () => {
  it("injects the platform loader once with the tenant slug, labels and locale", () => {
    const w = makeWorld();
    w.run();
    expect(w.loaders()).toHaveLength(1);
    const s = w.loaders()[0];
    expect(s.src).toBe("https://busymate.ai/embed/v1.js");
    expect(s.attrs["data-assistant"]).toBe("shop-demo");
    expect(s.attrs["data-label"]).toBe("Ask us");
    expect(s.attrs["data-aria-label"]).toBe("Chat with us");
    expect(s.attrs["data-title"]).toBe("Our assistant");
    expect(s.attrs["data-locale"]).toBe("en");
    expect(s.async).toBe(true);
  });

  it("falls back to its own tag when document.currentScript is null (a re-inserted/re-executed script)", () => {
    const w = makeWorld({ currentScript: false });
    w.run();
    expect(w.loaders()).toHaveLength(1);
    expect(w.loaders()[0].attrs["data-assistant"]).toBe("shop-demo");
  });

  it("never mounts for a slug the platform grammar refuses", () => {
    for (const bad of ["", "Shop_Demo", "-x", "a"]) {
      const w = makeWorld({ attrs: { "data-slug": bad } });
      w.run();
      expect(w.loaders(), bad).toHaveLength(0);
    }
  });

  it("keeps a mounted widget's API object and only adds getIdentity (guest → anonymous)", async () => {
    const api = { open: () => "live" };
    const w = makeWorld({ busymateAI: api });
    w.run();
    const current = w.window.BusymateAI as { open: () => string; getIdentity: () => Promise<unknown> };
    expect(current).toBe(api);
    expect(current.open()).toBe("live");
    expect(await current.getIdentity()).toBeNull();
  });

  it("a signed-in shopper's identity comes from the App Proxy route", async () => {
    const w = makeWorld({ attrs: { "data-logged-in": "true" } });
    w.run();
    const current = w.window.BusymateAI as { getIdentity: () => Promise<unknown> };
    expect(await current.getIdentity()).toEqual({ token: "t" });
  });

  it("does not inject a second loader when the launcher is already on the page (script re-run)", () => {
    const w = makeWorld();
    w.run();
    w.loadOk(w.loaders()[0]);
    w.run();
    w.run();
    expect(w.loaders()).toHaveLength(1);
  });

  it("does not inject twice while the first load is still in flight", () => {
    const w = makeWorld();
    w.run();
    w.run();
    expect(w.loaders()).toHaveLength(1);
  });

  it("retries a failed /embed/v1.js load with backoff, then shows an 'Ask us' link to the hosted assistant", () => {
    const w = makeWorld();
    w.run();
    for (const wait of [1500, 5000, 15000]) {
      const s = w.loaders()[0];
      s.onerror?.();
      expect(w.loaders(), "the failed tag is removed").toHaveLength(0);
      expect(w.timers[0]?.ms).toBe(wait);
      w.fireTimer();
      expect(w.loaders(), "a fresh attempt is injected").toHaveLength(1);
    }
    w.loaders()[0].onerror?.();
    const link = w.fallback();
    expect(link).toBeTruthy();
    expect(link!.href).toBe("https://busymate.ai/support/shop-demo?locale=en");
    expect(link!.textContent).toBe("Ask us");
    expect(link!.target).toBe("_blank");
    expect(link!.rel).toBe("noopener");
    expect(link!.attrs["aria-label"]).toBe("Chat with us");
  });

  it("removes the fallback link as soon as the real launcher loads", () => {
    const w = makeWorld({ designMode: true });
    w.run();
    for (let i = 0; i < 4; i += 1) {
      w.loaders()[0].onerror?.();
      if (i < 3) w.fireTimer();
    }
    expect(w.fallback()).toBeTruthy();
    w.emit("shopify:section:load");
    w.fireTimer(); // the listener defers to a macrotask
    expect(w.loaders()).toHaveLength(1);
    w.loadOk(w.loaders()[0]);
    expect(w.fallback()).toBeFalsy();
  });

  it("Theme Editor: re-mounts after a section re-render dropped the launcher, and never duplicates a live one", () => {
    const w = makeWorld({ designMode: true });
    w.run();
    w.loadOk(w.loaders()[0]);
    // A re-render that KEEPS the launcher: nothing new.
    w.emit("shopify:section:load");
    w.fireTimer();
    expect(w.loaders()).toHaveLength(1);
    // A re-render that DROPS it (layer + loader tag gone): mounted again.
    for (const el of [...w.body.children]) if (el.attrs["data-support-chat"]) w.body.removeChild(el);
    for (const el of [...w.head.children]) w.head.removeChild(el);
    w.emit("shopify:section:load");
    w.fireTimer();
    expect(w.loaders()).toHaveLength(1);
  });

  it("outside the Theme Editor it registers no section listener", () => {
    const w = makeWorld();
    w.run();
    w.loadOk(w.loaders()[0]);
    for (const el of [...w.body.children]) if (el.attrs["data-support-chat"]) w.body.removeChild(el);
    w.emit("shopify:section:load");
    expect(w.timers).toHaveLength(0);
  });
});
