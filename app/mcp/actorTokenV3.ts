/**
 * VENDORED, byte-for-byte below this header, from busymate-ai-src
 * `packages/mcp-registry/src/actorV3/token.ts` (busymate-ai-src#3103; re-copied for the
 * #3156 guest binding, which also brings #3353's host-context claim checks) — the ONE
 * module the platform signs `bmai.actor/3` with. Do not edit here: re-copy it.
 * `test/actorTokenV3.test.ts` + `test/guestBinding.test.ts` pin the platform's public
 * conformance vectors (actor and binding), so a
 * drift between this copy and the signer fails the suite. Replaced by the
 * published verifier package (`@busymate/ai-verify`) when it ships.
 */
/**
 * `bmai.actor/3` — the platform-signed ES256 ACTOR TOKEN (auto-auth P2,
 * busymate-ai-src#3103; PLAN §5.1).
 *
 * WHAT. The per-call credential a tenant's MCP verifies to learn "the platform
 * verified this customer as `sub` at identity provider `idp`, for tool `tool`".
 * It replaces the HS256 v2 token (`supportActorToken.ts`) after a 90-day
 * dual-sign window. The customer installs NO shared secret: they verify against
 * the public key set at `https://busymate.ai/.well-known/bmai-actor-jwks.json`.
 *
 * ONE MODULE, TWO RUNTIMES. This file is IMPORT-FREE and uses only Web Crypto,
 * `TextEncoder` and `btoa`/`atob`, so the Node agent (through `@v2/mcp-registry`)
 * and the Deno Edge functions (a relative `.ts` import, the `originMcp.ts` /
 * `perUserToolAccess.ts` precedent) run the SAME claim builder, signer and
 * verifier. There is no second copy of the claim rules anywhere.
 *
 * CONTRACT COUPLING. The v3 claim schema's home is `packages/identity-contract`
 * (`actor.ts`, P1). Until that package lands, the constants below are the one
 * place they live; when it does, they are re-exported from it unchanged.
 *
 * SECURITY RULES BAKED IN.
 *   - Identified visitors only: `actor_kind` is the literal "identified" and the
 *     builder refuses an empty subject or provider. An anonymous visitor is never
 *     given a v3 token (the caller sends no identity token at all). Its public
 *     call may carry the guest BINDING instead (#3156, bottom of this file): own
 *     `typ`, no subject, never an identity.
 *   - `aud` must be an exact origin (scheme://host[:port], no path).
 *   - Lifetime `exp - iat` <= 120 s; verifiers allow 10 s of clock skew.
 *   - The verifier pins `alg` and `typ` from constants and NEVER chooses an
 *     algorithm from the header (alg-confusion class); the key is chosen by
 *     `kid` from the published set only.
 *   - Never log a token, a key or a claim value from this module.
 */

export const ACTOR_V3_VERSION = "bmai.actor/3";
export const ACTOR_V3_ISSUER = "https://busymate.ai";
export const ACTOR_V3_ALG = "ES256";
export const ACTOR_V3_TYP = "bmai-actor+jwt";
/** What the platform mints: `exp = iat + ACTOR_V3_TTL_SECONDS`. */
export const ACTOR_V3_TTL_SECONDS = 120;
/** What a verifier accepts at most for `exp - iat`. */
export const ACTOR_V3_MAX_TTL_SECONDS = 120;
export const ACTOR_V3_CLOCK_SKEW_SECONDS = 10;
/** The dual-sign transport header (lower-case, as HTTP/2 sends it). */
export const ACTOR_V3_HEADER = "x-bmai-actor";
export const ACTOR_V3_JWKS_PATH = "/.well-known/bmai-actor-jwks.json";
export const ACTOR_V3_JWKS_URL = `${ACTOR_V3_ISSUER}${ACTOR_V3_JWKS_PATH}`;
export const ACTOR_V3_ACTOR_KIND = "identified";

export interface ActorV3Claims {
  readonly iss: typeof ACTOR_V3_ISSUER;
  readonly aud: string;
  readonly sub: string;
  readonly idp: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly support_session_id: string;
  readonly actor_kind: typeof ACTOR_V3_ACTOR_KIND;
  readonly confirmed: boolean;
  readonly tool: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
  /** #3353 — the host account context, echoed byte-identical from the verified launch; omitted when absent. */
  readonly host_account?: string;
  readonly host_env?: "live" | "sandbox";
  readonly host_user?: string;
}

/** #3353 — the verified host account context of the session (identity contract `LaunchContext`). */
export interface ActorV3HostContext {
  readonly account?: string;
  readonly env?: string;
  readonly user?: string;
}

export interface ActorV3Input {
  /** The EXACT connector origin, e.g. `https://mcp.acme.com`. */
  readonly audience: string;
  /** The verified launch subject (never `anonymous:*`). */
  readonly subject: string;
  /** The identity provider row id that verified `subject`. */
  readonly identityProviderId: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly sessionId: string;
  /** True only for a policy-confirmed call the approval gate released. */
  readonly confirmed: boolean;
  /** The tool this token authorizes (one call, one tool). */
  readonly tool: string;
  /** #3353 — the session's verified host context; each present key becomes its `host_*` claim. */
  readonly hostContext?: ActorV3HostContext | null;
  readonly nowSeconds?: number;
  readonly jti?: string;
}

/** Web Crypto key type without a DOM lib or a Node import (one file, two runtimes). */
export type ActorV3CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface ActorV3SigningKey {
  readonly kid: string;
  readonly privateKey: ActorV3CryptoKey;
}

/** A public JWK as published in the JWKS (`d` is never present). */
export interface ActorV3PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: typeof ACTOR_V3_ALG;
  readonly use: "sig";
}

export interface ActorV3Expectation {
  readonly audience: string;
  readonly tenantId?: string;
  readonly connectorId?: string;
  readonly nowSeconds?: number;
}

// ── encoding (no Buffer: Deno and Node share this file) ──────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonPart(value: unknown): string {
  return base64urlEncode(enc.encode(JSON.stringify(value)));
}

/**
 * #3353 — the host-context value rule. The identity contract (`LAUNCH_CONTEXT_ID_RE`,
 * `LAUNCH_CONTEXT_ENVS`, `isLaunchContextValue`) is its home; this import-free module keeps a
 * byte-identical copy, pinned to the contract by `hostContextParity.test.ts`.
 */
export const ACTOR_V3_HOST_ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;
export const ACTOR_V3_HOST_ENVS: readonly string[] = ["live", "sandbox"];
export function isActorV3HostValue(key: "account" | "env" | "user", value: unknown): value is string {
  if (typeof value !== "string") return false;
  return key === "env" ? ACTOR_V3_HOST_ENVS.includes(value) : ACTOR_V3_HOST_ID_RE.test(value);
}
const HOST_CLAIMS = [["account", "host_account"], ["env", "host_env"], ["user", "host_user"]] as const;

function nonEmpty(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** True when `value` is exactly an http(s) origin: no path, query, fragment or credentials. */
export function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

function randomJti(): string {
  return crypto.randomUUID();
}

// ── claims ───────────────────────────────────────────────────────────────────

/** Build the v3 claim set. Throws on anything that would make a wrong token. */
export function buildActorV3Claims(input: ActorV3Input): ActorV3Claims {
  if (!isExactOrigin(input.audience)) throw new Error("actor v3: audience must be an exact origin");
  if (!nonEmpty(input.subject) || input.subject.startsWith("anonymous:")) {
    throw new Error("actor v3: an identified subject is required");
  }
  if (!nonEmpty(input.identityProviderId)) throw new Error("actor v3: identity provider is required");
  if (!nonEmpty(input.tenantId) || !nonEmpty(input.connectorId) || !nonEmpty(input.sessionId)) {
    throw new Error("actor v3: tenant, connector and session are required");
  }
  if (!nonEmpty(input.tool, 256)) throw new Error("actor v3: tool is required");
  // #3353 — echo the verified host context; a value that fails the contract rule is a wrong token.
  const host: Record<string, string> = {};
  for (const [key, claim] of HOST_CLAIMS) {
    const value = input.hostContext?.[key];
    if (value === undefined) continue;
    if (!isActorV3HostValue(key, value)) throw new Error("actor v3: host context is malformed");
    host[claim] = value;
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    iss: ACTOR_V3_ISSUER,
    aud: input.audience,
    sub: input.subject,
    idp: input.identityProviderId,
    tenant_id: input.tenantId,
    connector_id: input.connectorId,
    support_session_id: input.sessionId,
    actor_kind: ACTOR_V3_ACTOR_KIND,
    confirmed: input.confirmed === true,
    tool: input.tool,
    iat: now,
    nbf: now,
    exp: now + ACTOR_V3_TTL_SECONDS,
    jti: input.jti ?? randomJti(),
    ...host,
  };
}

/**
 * The ONE claim check every v3 verifier runs (Edge, Node, tests). Returns the
 * typed claims or `null`. Signature verification is the caller's job and must
 * happen FIRST (`verifyActorV3` does both, in that order).
 */
export function validateActorV3Claims(payload: unknown, expect: ActorV3Expectation): ActorV3Claims | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const now = expect.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (p.iss !== ACTOR_V3_ISSUER) return null;
  if (typeof p.aud !== "string" || p.aud !== expect.audience) return null;
  if (!nonEmpty(p.sub) || p.sub.startsWith("anonymous:")) return null;
  if (!nonEmpty(p.idp)) return null;
  if (!nonEmpty(p.tenant_id) || (expect.tenantId !== undefined && p.tenant_id !== expect.tenantId)) return null;
  if (!nonEmpty(p.connector_id) || (expect.connectorId !== undefined && p.connector_id !== expect.connectorId)) return null;
  if (!nonEmpty(p.support_session_id)) return null;
  if (p.actor_kind !== ACTOR_V3_ACTOR_KIND) return null;
  if (typeof p.confirmed !== "boolean") return null;
  if (!nonEmpty(p.tool, 256)) return null;
  if (!nonEmpty(p.jti)) return null;
  const { iat, nbf, exp } = p;
  if (typeof iat !== "number" || typeof nbf !== "number" || typeof exp !== "number") return null;
  if (!Number.isInteger(iat) || !Number.isInteger(nbf) || !Number.isInteger(exp)) return null;
  if (iat > now + ACTOR_V3_CLOCK_SKEW_SECONDS || nbf > now + ACTOR_V3_CLOCK_SKEW_SECONDS) return null;
  if (exp <= now - ACTOR_V3_CLOCK_SKEW_SECONDS) return null;
  if (exp <= iat || exp - iat > ACTOR_V3_MAX_TTL_SECONDS) return null;
  // #3353 — host context claims are optional, and shape-checked when present (fail closed).
  for (const [key, claim] of HOST_CLAIMS) {
    if (p[claim] !== undefined && !isActorV3HostValue(key, p[claim])) return null;
  }
  return p as unknown as ActorV3Claims;
}

// ── keys ─────────────────────────────────────────────────────────────────────

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;

function pemBody(pem: string, label: string): Uint8Array<ArrayBuffer> {
  const re = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`);
  const match = re.exec(pem);
  if (!match?.[1]) throw new Error(`actor v3: expected a ${label} PEM`);
  const b64 = match[1].replace(/\s+/g, "");
  return base64urlDecode(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

/**
 * Import a P-256 PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`) as the signing key.
 * Extractable ONLY so the public half can be derived for the JWKS; the private
 * JWK is never returned by this module.
 */
export async function importActorV3PrivateKey(pkcs8Pem: string): Promise<ActorV3CryptoKey> {
  const der = pemBody(pkcs8Pem, "PRIVATE KEY");
  return crypto.subtle.importKey("pkcs8", der, EC, true, ["sign"]);
}

/** The PUBLIC JWK of a signing key, as published. Drops `d` by construction. */
export async function actorV3PublicJwk(privateKey: ActorV3CryptoKey, kid: string): Promise<ActorV3PublicJwk> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("actor v3: not a P-256 key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: ACTOR_V3_ALG, use: "sig" };
}

// ── sign ─────────────────────────────────────────────────────────────────────

async function signTyped(claims: object, key: ActorV3SigningKey, typ: string): Promise<string> {
  if (!nonEmpty(key.kid, 128)) throw new Error("actor v3: kid is required");
  const header = jsonPart({ alg: ACTOR_V3_ALG, typ, kid: key.kid });
  const unsigned = `${header}.${jsonPart(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(SIG, key.privateKey, enc.encode(unsigned)));
  return `${unsigned}.${base64urlEncode(sig)}`;
}

export async function signActorV3(claims: ActorV3Claims, key: ActorV3SigningKey): Promise<string> {
  return signTyped(claims, key, ACTOR_V3_TYP);
}

/** Build + sign in one step (the mint path). */
export async function mintActorV3(input: ActorV3Input, key: ActorV3SigningKey): Promise<{ token: string; jti: string; kid: string }> {
  const claims = buildActorV3Claims(input);
  return { token: await signActorV3(claims, key), jti: claims.jti, kid: key.kid };
}

// ── verify ───────────────────────────────────────────────────────────────────

function peekTyped(token: string, typ: string): { kid: string } | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || !parts[0]) return null;
  try {
    const header = JSON.parse(dec.decode(base64urlDecode(parts[0]))) as Record<string, unknown>;
    if (header.alg !== ACTOR_V3_ALG || header.typ !== typ || !nonEmpty(header.kid, 128)) return null;
    return { kid: header.kid };
  } catch {
    return null;
  }
}

/** The unverified header, or null when the token is not shaped like a v3 token. */
export function peekActorV3Header(token: string): { kid: string } | null {
  return peekTyped(token, ACTOR_V3_TYP);
}

/** The signature-checked payload of a token of exactly `typ`, or null. Never throws. */
async function verifiedPayload(token: string, jwks: { readonly keys: readonly unknown[] }, typ: string): Promise<unknown> {
  try {
    const head = peekTyped(token, typ);
    if (!head) return null;
    const jwk = jwks.keys.find((k): k is ActorV3PublicJwk =>
      !!k && typeof k === "object" && (k as { kid?: unknown }).kid === head.kid &&
      (k as { kty?: unknown }).kty === "EC" && (k as { crv?: unknown }).crv === "P-256");
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      EC,
      false,
      ["verify"],
    );
    const [h, p, s] = token.split(".") as [string, string, string];
    const sig = base64urlDecode(s);
    if (sig.length !== 64) return null;
    const ok = await crypto.subtle.verify(SIG, publicKey, sig, enc.encode(`${h}.${p}`));
    if (!ok) return null;
    return JSON.parse(dec.decode(base64urlDecode(p))) as unknown;
  } catch {
    return null;
  }
}

/**
 * Verify a v3 token against a published key set. Signature FIRST, then the
 * shared claim check. Any failure ⇒ `null`; never throws.
 */
export async function verifyActorV3(
  token: string,
  jwks: { readonly keys: readonly unknown[] },
  expect: ActorV3Expectation,
): Promise<ActorV3Claims | null> {
  const payload = await verifiedPayload(token, jwks, ACTOR_V3_TYP);
  return payload === null ? null : validateActorV3Claims(payload, expect);
}

// ── guest binding (busymate-ai-src#3156) ─────────────────────────────────────
//
// A guest's PUBLIC tool call on a v3 workspace carries no identity token. A
// connector shared by many workspaces (one URL, no static header) still has to
// know WHICH workspace and connector row the call is for, from something it can
// verify. The binding is that: ES256 with the same published keys, its own
// `typ` (so no actor verifier can ever read it as an identity), and exactly the
// claims below. No `sub`, `idp`, session, `confirmed` or host context: it names
// a connector, never a person, and never authorizes a write. A verifier treats
// the caller as a guest (public tools only, unconfirmed).

export const ACTOR_V3_BINDING_TYP = "bmai-binding+jwt";
/** The transport header (lower-case). Sent alone: a guest call has no `Authorization`. */
export const ACTOR_V3_BINDING_HEADER = "x-bmai-binding";
export const ACTOR_V3_BINDING_KIND = "anonymous";

export interface ActorV3BindingClaims {
  readonly iss: typeof ACTOR_V3_ISSUER;
  readonly aud: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly actor_kind: typeof ACTOR_V3_BINDING_KIND;
  readonly tool: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
}

/** The ONLY claims a binding may carry; anything else (a `sub`, a session …) is a refusal. */
const BINDING_CLAIMS: ReadonlySet<string> = new Set(["iss", "aud", "tenant_id", "connector_id", "actor_kind", "tool", "iat", "nbf", "exp", "jti"]);

export interface ActorV3BindingInput {
  readonly audience: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly tool: string;
  readonly nowSeconds?: number;
  readonly jti?: string;
}

/** Build the binding claim set. Throws on anything that would make a wrong token. */
export function buildActorV3BindingClaims(input: ActorV3BindingInput): ActorV3BindingClaims {
  if (!isExactOrigin(input.audience)) throw new Error("actor v3 binding: audience must be an exact origin");
  if (!nonEmpty(input.tenantId) || !nonEmpty(input.connectorId)) throw new Error("actor v3 binding: tenant and connector are required");
  if (!nonEmpty(input.tool, 256)) throw new Error("actor v3 binding: tool is required");
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    iss: ACTOR_V3_ISSUER,
    aud: input.audience,
    tenant_id: input.tenantId,
    connector_id: input.connectorId,
    actor_kind: ACTOR_V3_BINDING_KIND,
    tool: input.tool,
    iat: now,
    nbf: now,
    exp: now + ACTOR_V3_TTL_SECONDS,
    jti: input.jti ?? randomJti(),
  };
}

/** The binding claim check (signature first: `verifyActorV3Binding`). Returns the claims or null. */
export function validateActorV3BindingClaims(payload: unknown, expect: ActorV3Expectation): ActorV3BindingClaims | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (Object.keys(p).some((k) => !BINDING_CLAIMS.has(k))) return null;
  const now = expect.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (p.iss !== ACTOR_V3_ISSUER) return null;
  if (typeof p.aud !== "string" || p.aud !== expect.audience) return null;
  if (!nonEmpty(p.tenant_id) || (expect.tenantId !== undefined && p.tenant_id !== expect.tenantId)) return null;
  if (!nonEmpty(p.connector_id) || (expect.connectorId !== undefined && p.connector_id !== expect.connectorId)) return null;
  if (p.actor_kind !== ACTOR_V3_BINDING_KIND) return null;
  if (!nonEmpty(p.tool, 256) || !nonEmpty(p.jti)) return null;
  const { iat, nbf, exp } = p;
  if (!Number.isInteger(iat) || !Number.isInteger(nbf) || !Number.isInteger(exp)) return null;
  const [i, n, e] = [iat as number, nbf as number, exp as number];
  if (i > now + ACTOR_V3_CLOCK_SKEW_SECONDS || n > now + ACTOR_V3_CLOCK_SKEW_SECONDS) return null;
  if (e <= now - ACTOR_V3_CLOCK_SKEW_SECONDS) return null;
  if (e <= i || e - i > ACTOR_V3_MAX_TTL_SECONDS) return null;
  return p as unknown as ActorV3BindingClaims;
}

/** The unverified header, or null when the token is not shaped like a binding. */
export function peekActorV3BindingHeader(token: string): { kid: string } | null {
  return peekTyped(token, ACTOR_V3_BINDING_TYP);
}

/** Build + sign a binding (the mint path). */
export async function mintActorV3Binding(input: ActorV3BindingInput, key: ActorV3SigningKey): Promise<{ token: string; jti: string; kid: string }> {
  const claims = buildActorV3BindingClaims(input);
  return { token: await signTyped(claims, key, ACTOR_V3_BINDING_TYP), jti: claims.jti, kid: key.kid };
}

/** Verify a binding against the published key set. Signature FIRST, then the claims. Never throws. */
export async function verifyActorV3Binding(
  token: string,
  jwks: { readonly keys: readonly unknown[] },
  expect: ActorV3Expectation,
): Promise<ActorV3BindingClaims | null> {
  const payload = await verifiedPayload(token, jwks, ACTOR_V3_BINDING_TYP);
  return payload === null ? null : validateActorV3BindingClaims(payload, expect);
}
