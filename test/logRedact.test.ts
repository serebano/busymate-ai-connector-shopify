import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { redactUrl, SENSITIVE_QUERY_KEYS } from "../app/lib/logRedact";
import { installRequestLogRedaction } from "../app/lib/requestLogRedaction.server";

/**
 * #3718 P1 — the host's access log printed Shopify's `id_token`, `hmac` and
 * `session` on every embedded-admin request. The log keeps the path and the
 * harmless parameters and replaces every credential value.
 */
describe("redactUrl", () => {
  it("replaces the embedded-admin credentials and keeps the shop", () => {
    const url = "/app?embedded=1&hmac=abc123&host=YWRtaW4&id_token=eyJhbGciOi.x.y&locale=en&session=s3cr3t&shop=demo.myshopify.com&timestamp=1";
    const out = redactUrl(url);
    expect(out).toBe("/app?embedded=1&hmac=REDACTED&host=YWRtaW4&id_token=REDACTED&locale=en&session=REDACTED&shop=demo.myshopify.com&timestamp=1");
    expect(out).not.toMatch(/eyJ|abc123|s3cr3t/);
  });

  it("covers OAuth codes, App Proxy signatures and customer ids; case- and encoding-insensitive keys", () => {
    expect(redactUrl("/auth/callback?code=c0de&state=st&shop=x")).toBe("/auth/callback?code=REDACTED&state=st&shop=x");
    expect(redactUrl("/apps/busymate-ai/identity?logged_in_customer_id=42&signature=sig")).toBe("/apps/busymate-ai/identity?logged_in_customer_id=REDACTED&signature=REDACTED");
    expect(redactUrl("/x?ID_TOKEN=a&id%5Ftoken=b")).toBe("/x?ID_TOKEN=REDACTED&id%5Ftoken=REDACTED");
  });

  it("leaves a URL without a query, a bare flag, and a fragment intact", () => {
    expect(redactUrl("/app")).toBe("/app");
    expect(redactUrl("/app?embedded")).toBe("/app?embedded");
    expect(redactUrl("/app?hmac=1#frag")).toBe("/app?hmac=REDACTED#frag");
    expect(redactUrl(undefined)).toBe("");
  });

  it("never throws on a malformed escape", () => {
    expect(() => redactUrl("/x?%E0%A4%A=1&hmac=2")).not.toThrow();
    expect(redactUrl("/x?%E0%A4%A=1&hmac=2")).toBe("/x?%E0%A4%A=1&hmac=REDACTED");
  });

  it("names every credential the diagnosis found in the journal", () => {
    for (const key of ["id_token", "hmac", "session"]) expect(SENSITIVE_QUERY_KEYS).toContain(key);
  });
});

describe("installRequestLogRedaction — the host's morgan access line", () => {
  it("overrides morgan's :url token, so the 'tiny' line react-router-serve writes is redacted", () => {
    expect(installRequestLogRedaction()).toBe(true);
    const morgan = createRequire(import.meta.url)("morgan") as { compile(format: string): (tokens: unknown, req: unknown, res: unknown) => string } & Record<string, unknown>;
    const line = morgan.compile(":method :url")(morgan, { method: "GET", originalUrl: "/app?id_token=eyJ.secret&shop=x", url: "/app?id_token=eyJ.secret&shop=x" }, {});
    expect(line).toBe("GET /app?id_token=REDACTED&shop=x");
  });
});
