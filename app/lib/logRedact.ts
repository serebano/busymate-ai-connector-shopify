/**
 * Request-log redaction (#3718 P1). The host's access log (`react-router-serve`'s
 * morgan "tiny" line, i.e. the systemd journal) printed every embedded-admin URL
 * verbatim: Shopify's session `id_token` JWT, the launch `hmac` and `session`,
 * OAuth `code`s and App Proxy `signature`s. Those are short-lived credentials,
 * but a log is persisted and shared (the 5.1.2 diagnosis copied journal lines
 * into evidence files). The log keeps the path and the harmless parameters
 * (`shop`, `host`, `embedded`, `locale`, …) and replaces each credential value.
 */

/** Query keys whose VALUES are credentials or customer identifiers. */
export const SENSITIVE_QUERY_KEYS: readonly string[] = [
  "id_token",
  "hmac",
  "session",
  "code",
  "signature",
  "token",
  "access_token",
  "logged_in_customer_id",
];

const SENSITIVE = new Set(SENSITIVE_QUERY_KEYS);

/** `/app?hmac=abc&shop=x` → `/app?hmac=REDACTED&shop=x`. Never throws. */
export function redactUrl(url: string | undefined | null): string {
  if (!url) return "";
  const q = url.indexOf("?");
  if (q < 0) return url;
  const path = url.slice(0, q);
  let query = url.slice(q + 1);
  let hash = "";
  const h = query.indexOf("#");
  if (h >= 0) {
    hash = query.slice(h);
    query = query.slice(0, h);
  }
  const parts = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // a malformed key is still judged on its raw spelling
    }
    return SENSITIVE.has(key.toLowerCase()) && eq >= 0 ? `${rawKey}=REDACTED` : pair;
  });
  return `${path}?${parts.join("&")}${hash}`;
}
