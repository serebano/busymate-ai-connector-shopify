/**
 * Mint the app's DURABLE bmai provisioning credential — a rotating OAuth refresh
 * token (DCR + PKCE) for a dedicated LEAST-PRIVILEGE provisioner identity. Run ONCE
 * per environment (and to rotate). See SETUP.md §4.
 *
 * The /authorize/resume consent accepts the service user's GoTrue session token
 * directly, so the whole flow is headless (no browser). VALUE-BLIND: prints only
 * non-secret status; the secret refresh token is written to OUT (default 0600 file),
 * never logged.
 *
 * The app needs ONE credential bound to the Busymate AI MCP resource:
 * ISSUER/RESOURCE=https://busymate.ai/mcp, VAR_PREFIX=BMAI_MGMT.
 *
 * Requires (owner-gated): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the bmai control
 * plane). Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — bmai auth admin API
 *   ISSUER            (default https://busymate.ai/mcp) — the OAuth issuer host
 *   RESOURCE          (default = ISSUER) — the RFC-8707 resource to bind the token to
 *   VAR_PREFIX        (default BMAI_MGMT) — output env var prefix
 *   OAUTH_ORIGIN      (default https://busymate.ai — an allowlisted origin)
 *   PROVISIONER_EMAIL (default bmai-shopify-provisioner@svc.example.com — set your own)
 *   OUT               (default ./bmai-cred.env — chmod 0600)
 *
 * Output file lines (append to the app host env, e.g. /etc/busymate-ai-shopify/env):
 *   <VAR_PREFIX>_CLIENT_ID=...
 *   <VAR_PREFIX>_REFRESH_TOKEN=...
 *
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MCP = process.env.ISSUER || "https://busymate.ai/mcp";
const RESOURCE = process.env.RESOURCE || MCP;
const VAR_PREFIX = process.env.VAR_PREFIX || "BMAI_MGMT";
const ORIGIN = process.env.OAUTH_ORIGIN || "https://busymate.ai";
const EMAIL = process.env.PROVISIONER_EMAIL || "bmai-shopify-provisioner@svc.example.com";
const OUT = process.env.OUT || "./bmai-cred.env";
const REDIRECT = "http://127.0.0.1:8765/cb";

if (!URL_ || !KEY) { console.error("set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (s) => createHash("sha256").update(s).digest();
const adminH = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };

async function main() {
  const password = b64url(randomBytes(24));

  // 1) Create-or-reuse the dedicated provisioner user (least privilege — no role).
  let userId = "";
  let r = await fetch(`${URL_}/auth/v1/admin/users`, { method: "POST", headers: adminH, body: JSON.stringify({ email: EMAIL, password, email_confirm: true, user_metadata: { purpose: "bmai-shopify-provisioner", ref: "busymate-ai-shopify" } }) });
  if (r.ok) userId = (await j(r)).id;
  else {
    for (let p = 1; p <= 20 && !userId; p++) {
      const u = (await j(await fetch(`${URL_}/auth/v1/admin/users?page=${p}&per_page=200`, { headers: adminH }))).users || [];
      if (!u.length) break;
      const f = u.find((x) => x.email === EMAIL);
      if (f) userId = f.id;
    }
    if (!userId) throw new Error(`create failed + not found: ${r.status}`);
    const up = await fetch(`${URL_}/auth/v1/admin/users/${userId}`, { method: "PUT", headers: adminH, body: JSON.stringify({ password, email_confirm: true }) });
    if (!up.ok) throw new Error(`password reset failed: ${up.status}`);
  }

  // 2) Password grant → GoTrue session (identifies the user to /authorize/resume).
  const sess = (await j(await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password }) }))).access_token;
  if (!sess) throw new Error("password grant failed");

  // 3) DCR register a public client (PKCE, loopback).
  const clientId = (await j(await fetch(`${MCP}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: `bmai-shopify-${VAR_PREFIX.toLowerCase()}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], application_type: "native" }) }))).client_id;
  if (!clientId) throw new Error("DCR register failed");

  // 4) PKCE + /authorize (manual redirect) → rid.
  const verifier = b64url(randomBytes(32));
  const au = new URL(`${MCP}/authorize`);
  au.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: b64url(sha256(verifier)), code_challenge_method: "S256", state: b64url(randomBytes(8)), scope: "mcp", resource: RESOURCE }).toString();
  r = await fetch(au, { redirect: "manual", headers: { origin: ORIGIN } });
  const next = new URL(r.headers.get("location")).searchParams.get("next") || "";
  const rid = new URLSearchParams(next.split("?")[1] || "").get("rid");
  if (!rid) throw new Error("no rid from /authorize");

  // 5) /authorize/resume (approve with the session) → single-use code.
  const resume = await j(await fetch(`${MCP}/authorize/resume`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ rid, access_token: sess, approve: true }) }));
  const code = new URL(resume.redirect).searchParams.get("code");
  if (!code) throw new Error(`no code: ${JSON.stringify(resume)}`);

  // 6) Exchange → access + refresh token.
  const tok = await j(await fetch(`${MCP}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE }).toString() }));
  if (!tok.refresh_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);

  writeFileSync(OUT, `${VAR_PREFIX}_CLIENT_ID=${clientId}\n${VAR_PREFIX}_REFRESH_TOKEN=${tok.refresh_token}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, userId, clientId, wroteTo: OUT }, null, 2));
}
main().catch((e) => { console.error("MINT_ERROR:", e.message); process.exit(1); });
