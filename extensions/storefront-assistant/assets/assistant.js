/**
 * Storefront mount for the Busymate AI white-label widget.
 *
 * Loads the platform embed (`/embed/v1.js`) via @busymate/whitelabel-sdk's
 * mountBusymateAI contract. getIdentity hits the app's App Proxy /identity route,
 * which mints a short-lived ES256 launch JWT scoped to the logged-in Shopify
 * customer (guests → null → anonymous chat still works).
 *
 * i18n: the launcher label, its accessible name (aria-label) and title arrive on
 * this script's data-* attributes, already translated by the theme block
 * (`locales/*.json` via the Liquid `t` filter), and are forwarded to the embed.
 *
 * HARDENING (Shopify review 5.1.2, 2026-09-24 — "the block no longer shows after
 * closing and reopening the admin and the store"):
 *   • `document.currentScript` is null when a host re-executes or re-inserts the
 *     script (the Theme Editor re-renders sections); fall back to the tag itself.
 *   • In the Theme Editor (`Shopify.designMode`) re-mount after a section
 *     re-render if the launcher is gone — never a second launcher (the loader
 *     mounts once per <script> element, so every inject is guarded on its layer).
 *   • `/embed/v1.js` failing to load (a 502 during a platform restart blanked
 *     the button on every store) is retried with backoff; if it still fails, a
 *     plain "Ask us" link to the hosted assistant keeps the storefront usable,
 *     and is removed the moment the real launcher loads.
 *
 * Zero-dependency inline mount matching the SDK's window.BusymateAI +
 * <script data-assistant> contract, so the storefront pulls a single asset.
 */
(function () {
  "use strict";
  var SELF = 'script[data-slug][src*="/assets/assistant.js"]';
  var el = document.currentScript || document.querySelector(SELF);
  if (!el) return;
  var slug = el.getAttribute("data-slug") || "";
  // The same slug grammar the platform loader enforces — anything else never mounts.
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return;
  var origin = (el.getAttribute("data-origin") || "https://busymate.ai").replace(/\/+$/, "");
  var label = el.getAttribute("data-label") || "";
  var ariaLabel = el.getAttribute("data-aria-label") || label;
  var title = el.getAttribute("data-title") || label;
  var locale = el.getAttribute("data-locale") || "";
  var loggedIn = el.getAttribute("data-logged-in") === "true";

  var LOADER_URL = origin + "/embed/v1.js";
  /** Backoff between loader attempts; the fallback link appears after the last. */
  var RETRY_MS = [1500, 5000, 15000];
  // The App Proxy path the merchant configures (Proxy URL → this app's /identity).
  // Shopify appends logged_in_customer_id + a verifiable signature server-side.
  var IDENTITY_URL = "/apps/busymate-ai/identity";

  // Never clobber the API object a mounted loader already extended (a re-run of
  // this script after the launcher mounted must keep the live widget's methods).
  var api = (window.BusymateAI = window.BusymateAI || {});
  api.getIdentity = function () {
    if (!loggedIn) return Promise.resolve(null); // guest → anonymous chat
    return fetch(IDENTITY_URL, { method: "POST", credentials: "include" })
      .then(function (r) {
        return r.ok && r.status !== 204 ? r.json() : null; // { token, nonce } | null
      })
      .catch(function () {
        return null;
      });
  };

  var state = (window.__busymateShopify = window.__busymateShopify || {});
  var mine = state[slug] || (state[slug] = { attempt: 0, loading: false, timer: 0 });

  function launcherMounted() {
    return !!document.querySelector('[data-support-chat="' + slug + '"]');
  }

  function removeFallback() {
    var node = document.querySelector('[data-bm-fallback="' + slug + '"]');
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function showFallback() {
    if (launcherMounted() || document.querySelector('[data-bm-fallback="' + slug + '"]')) return;
    var link = document.createElement("a");
    link.setAttribute("data-bm-fallback", slug);
    link.href = origin + "/support/" + encodeURIComponent(slug) + (locale ? "?locale=" + encodeURIComponent(locale) : "");
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = label || "Ask us";
    if (ariaLabel) link.setAttribute("aria-label", ariaLabel);
    if (title) link.title = title;
    link.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:13px 18px;border-radius:999px;" +
      "background:#111827;color:#fff;font:600 14px ui-sans-serif,system-ui,sans-serif;text-decoration:none;" +
      "box-shadow:0 8px 30px #0003";
    (document.body || document.documentElement).appendChild(link);
  }

  function inject() {
    mine.timer = 0;
    if (mine.loading || launcherMounted()) return;
    mine.loading = true;
    var s = document.createElement("script");
    s.src = LOADER_URL;
    s.async = true;
    s.setAttribute("data-assistant", slug);
    s.setAttribute("data-bm-shopify", "1");
    if (label) s.setAttribute("data-label", label);
    if (ariaLabel) s.setAttribute("data-aria-label", ariaLabel);
    if (title) s.setAttribute("data-title", title);
    if (locale) s.setAttribute("data-locale", locale);
    s.onload = function () {
      mine.loading = false;
      mine.attempt = 0;
      removeFallback();
    };
    s.onerror = function () {
      mine.loading = false;
      if (s.parentNode) s.parentNode.removeChild(s);
      if (mine.attempt < RETRY_MS.length) {
        mine.timer = setTimeout(inject, RETRY_MS[mine.attempt]);
        mine.attempt += 1;
      } else {
        showFallback();
      }
    };
    document.head.appendChild(s);
  }

  /** Mount unless the launcher (or an in-flight load, or a scheduled retry) exists. */
  function ensure() {
    if (launcherMounted() || mine.loading || mine.timer) return;
    mine.attempt = 0;
    inject();
  }

  ensure();

  // Theme Editor: a section re-render can drop the launcher layer; put it back.
  if (window.Shopify && window.Shopify.designMode && !state.__designListener) {
    state.__designListener = true;
    document.addEventListener("shopify:section:load", function () {
      setTimeout(function () {
        var entries = window.__busymateShopify || {};
        for (var key in entries) {
          if (key !== "__designListener" && entries[key] && typeof entries[key].ensure === "function") entries[key].ensure();
        }
      }, 0);
    });
  }
  mine.ensure = ensure;
})();
