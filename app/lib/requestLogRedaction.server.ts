/**
 * Install the request-log redaction (#3718 P1) into the access logger the host
 * runs. `react-router-serve` logs every request with morgan's "tiny" format,
 * whose `:url` token is looked up on the ONE shared morgan module at request
 * time; `morgan.token(name, fn)` redefines a token (documented behaviour), so
 * overriding `url` here — at server-bundle load, before any request is served —
 * redacts every access-log line without replacing the server. Idempotent.
 */
import { createRequire } from "node:module";
import { redactUrl } from "./logRedact";

interface MorganLike {
  token(name: string, fn: (req: { originalUrl?: string; url?: string }) => string): unknown;
}

let installed = false;

export function installRequestLogRedaction(load: () => MorganLike = () => createRequire(import.meta.url)("morgan") as MorganLike): boolean {
  if (installed) return true;
  try {
    load().token("url", (req) => redactUrl(req.originalUrl || req.url));
    installed = true;
  } catch {
    // No morgan in this runtime (tests, `shopify app dev`): nothing logs URLs there.
  }
  return installed;
}

installRequestLogRedaction();
