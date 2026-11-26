import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isRouteControlFlow, reloadEmbeddedFrame } from "../app/lib/layoutError";
import { reportRouteFailure } from "../app/lib/routeDiagnostics";

/**
 * #idle-500 (app issue #29 — Shopify review 2026-09-11, Req 2.1.1).
 *
 * Observed live on the review store: a fetcher action on Home was followed by the
 * layout revalidation `GET /app.data` failing with `AbortError` (`aborted: true`),
 * and the embedded document was replaced by the root "500 Something went wrong"
 * page — the layout's ErrorBoundary delegated EVERYTHING to the SDK's
 * `boundary.error`, which re-throws any non-Response error to the root.
 *
 * Contract under test: only thrown Responses / route error responses (Shopify's
 * session-token bounce, redirects, 4xx) reach `boundary.error`; every other error
 * recovers in-frame with a reload retry; and a client-aborted request is logged as
 * `route_aborted`, never counted as a 500.
 */
describe("layout error classification", () => {
  it("treats thrown Responses and route error responses as control flow", () => {
    expect(isRouteControlFlow(new Response(null, { status: 401 }))).toBe(true);
    expect(isRouteControlFlow({ status: 404, statusText: "Not Found", data: null, internal: true, error: undefined })).toBe(true);
  });
  it("treats AbortError, network TypeError and plain Error as recoverable in-frame failures", () => {
    expect(isRouteControlFlow(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isRouteControlFlow(new TypeError("Failed to fetch"))).toBe(false);
    expect(isRouteControlFlow(new Error("turbo-stream decode"))).toBe(false);
    expect(isRouteControlFlow(undefined)).toBe(false);
  });
  it("retries with a document reload of the embedded frame (re-enters the session-token bounce)", () => {
    const reload = vi.fn();
    reloadEmbeddedFrame({ location: { reload } as unknown as Location });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(() => reloadEmbeddedFrame(undefined)).not.toThrow();
  });
});

describe("app/routes/app.tsx layout boundary wiring", () => {
  const src = readFileSync(join(process.cwd(), "app/routes/app.tsx"), "utf8");
  it("hands only control-flow errors to the SDK boundary and recovers the rest in-frame", () => {
    expect(src).toMatch(/if \(isRouteControlFlow\(error\)\) return boundary\.error\(error\);/);
    expect(src).toMatch(/<AppRouteErrorView message=\{describeTransportError\(error\)\} onRetry=\{reloadEmbeddedFrame\} \/>/);
    // The bare delegation that re-threw every loader failure to the root page is gone.
    expect(src).not.toMatch(/return boundary\.error\(useRouteError\(\)\);/);
  });
  it("wraps the in-frame view in a Polaris provider (the layout that mounted one is the route that errored)", () => {
    expect(src).toMatch(/<PolarisAppProvider i18n=\{enPolarisTranslations\}>\s*<main>\s*<Text as="h1" visuallyHidden>[^<]+<\/Text>\s*<AppRouteErrorView/);
  });
});

describe("client-aborted requests are not 500s", () => {
  it("logs route_aborted at info level when the request signal was aborted", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const request = new Request("https://app.example/app.data?shop=private", { signal: controller.signal });
    controller.abort();
    reportRouteFailure("route_failed", request, new DOMException("aborted", "AbortError"));
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][1]))).toEqual({ event: "route_aborted", method: "GET", path: "/app.data", status: 500, errorClass: "AbortError", aborted: true });
    info.mockRestore(); error.mockRestore();
  });
  it("still logs a real failure as route_failed at error level", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reportRouteFailure("route_failed", new Request("https://app.example/app.data"), new TypeError("boom"));
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0][1])).event).toBe("route_failed");
    info.mockRestore(); error.mockRestore();
  });
});
