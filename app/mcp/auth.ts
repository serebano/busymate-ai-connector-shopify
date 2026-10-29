import { verifyLaunchToken } from "../lib/identity";
import { connectorAudience } from "../lib/connector";
import { peekActorToken, verifyActorToken } from "./actorToken";
import { ACTOR_V3_HEADER, ACTOR_V3_JWKS_URL, base64urlDecode, peekActorV3Header, verifyActorV3 } from "./actorTokenV3";

export interface ConnectorCaller {
  shop: string;
  customerId: string | null; // identified launch subject, or null (guest)
  confirmed: boolean;
  /** How the caller was resolved: the verified Busymate AI actor token, or the legacy header. */
  actor: "bmai" | "header";
  /**
   * busymate-ai-src#3103 — which actor token version established the identity: 3 when a
   * verified ES256 `bmai.actor/3` token (Authorization or `X-Bmai-Actor`) decided it,
   * 2 for the HS256 token alone. Absent for the legacy header caller.
   */
  actorVersion?: 2 | 3;
  /** The v3 token's `jti` (for audit correlation). Never the token itself. */
  actorJti?: string;
}

/**
 * Injectable dependencies for `resolveCaller` — so the verifier is unit-testable
 * with NO database, NO env, and a fixed clock (mirrors the DI pattern in
 * `app/lib/provision.ts`). The real deps read Prisma + env (see `defaultDeps`).
 */
export interface ResolveCallerDeps {
  /** Map a verified (tenant_id, connector_id) → the installed shop, or null. */
  resolveShop: (tenantId: string, connectorId: string) => Promise<string | null>;
  /** The shared actor-token master secret (BMAI_SUPPORT_ACTOR_MASTER). */
  master: string;
  /** Expected actor-token `aud` = our MCP endpoint origin. */
  audience: string;
  /** Verification clock (seconds). Defaults to now. */
  now?: number;
  /** Whether the legacy `x-bmai-shop` header caller is accepted (dev/test only). */
  headerCallerAllowed: boolean;
  /**
   * busymate-ai-src#3103 — Busymate AI's PUBLIC actor key set (JWKS) for `bmai.actor/3`.
   * Optional: absent ⇒ v3 tokens are never accepted (v2 behaviour unchanged).
   */
  actorJwks?: () => Promise<{ keys: readonly unknown[] }>;
}

/** Process-wide JWKS cache: 5 min, plus at most one refetch a minute on an unknown kid. */
let jwksCache: { at: number; value: { keys: readonly unknown[] } } | null = null;
export function actorJwksFetcher(
  url: string = process.env.BMAI_ACTOR_JWKS_URL || ACTOR_V3_JWKS_URL,
  fetchImpl: typeof fetch = fetch,
): (kid?: string) => Promise<{ keys: readonly unknown[] }> {
  return async (kid?: string) => {
    const age = jwksCache ? Date.now() - jwksCache.at : Infinity;
    const known = !kid || jwksCache?.value.keys.some((k) => (k as { kid?: unknown })?.kid === kid);
    if (jwksCache && (age < 300_000 && known || age < 60_000)) return jwksCache.value;
    const res = await fetchImpl(url, { headers: { accept: "application/jwk-set+json, application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`actor jwks ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    jwksCache = { at: Date.now(), value: { keys: Array.isArray(body.keys) ? body.keys : [] } };
    return jwksCache.value;
  };
}

/** Test seam. */
export function resetActorJwksCache(): void {
  jwksCache = null;
}

/** The UNVERIFIED tenant/connector binding of a would-be v3 token (shop lookup only). */
function peekV3Binding(token: string): { tenantId: string; connectorId: string } | null {
  if (!peekActorV3Header(token)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(token.split(".")[1] ?? ""))) as Record<string, unknown>;
    const { tenant_id: tenantId, connector_id: connectorId } = payload;
    return typeof tenantId === "string" && tenantId && typeof connectorId === "string" && connectorId ? { tenantId, connectorId } : null;
  } catch {
    return null;
  }
}

/**
 * Verify a `bmai.actor/3` token (ES256 against the public JWKS) and resolve its shop.
 * FAIL-CLOSED: any failure ⇒ null. A v3 token is identified by construction.
 */
async function resolveV3Caller(token: string, deps: ResolveCallerDeps): Promise<ConnectorCaller | null> {
  if (!deps.actorJwks) return null;
  const binding = peekV3Binding(token);
  if (!binding) return null;
  const shop = await deps.resolveShop(binding.tenantId, binding.connectorId);
  if (!shop) return null;
  const claims = await verifyActorV3(token, await deps.actorJwks().catch(() => ({ keys: [] })), {
    audience: deps.audience,
    tenantId: binding.tenantId,
    connectorId: binding.connectorId,
    ...(deps.now !== undefined ? { nowSeconds: deps.now } : {}),
  });
  if (!claims) return null;
  return { shop, customerId: claims.sub, confirmed: claims.confirmed, actor: "bmai", actorVersion: 3, actorJti: claims.jti };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Is the legacy `x-bmai-shop` header caller path allowed? OFF in production
 * (fail-closed on the verified actor token only), ON in dev/test. An explicit
 * `BMAI_ALLOW_HEADER_CALLER` (1/true/on or 0/false/off) always wins.
 */
export function headerCallerAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.BMAI_ALLOW_HEADER_CALLER || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return env.NODE_ENV !== "production";
}

/** Real production deps: Prisma (tenant,connector)→shop + env master/audience. */
function defaultDeps(): ResolveCallerDeps {
  return {
    resolveShop: async (tenantId, connectorId) => {
      // Lazy import so importing auth.ts (e.g. from the transport tests) does not
      // instantiate PrismaClient; only the real resolve path touches the DB.
      const { default: prisma } = await import("../db.server");
      const row = await prisma.shopTenant.findFirst({
        where: { bmaiTenantId: tenantId, connectorId },
        select: { shop: true },
      });
      return row?.shop ?? null;
    },
    master: process.env.BMAI_SUPPORT_ACTOR_MASTER || "",
    audience: connectorAudience(),
    headerCallerAllowed: headerCallerAllowed(),
    actorJwks: actorJwksFetcher(),
  };
}

/**
 * Resolve the connector caller from the request.
 *
 * PRIMARY (production): the `Authorization: Bearer <actor token>` Busymate AI mints per
 * delegated `tools/call` — a narrow ≤5-min HS256 token. We peek its
 * (tenant_id, connector_id), resolve the installed shop from the DB, then
 * HMAC-verify with the secret DERIVED from the master for exactly that
 * (tenant,connector). A token that peeks as an actor token but fails verification
 * is REFUSED (fail-closed) — it is never downgraded to a header.
 *
 * FALLBACK (dev/test only, gated by `BMAI_ALLOW_HEADER_CALLER`): the legacy
 * `x-bmai-shop` (+ optional `x-bmai-identity` ES256 launch JWT) header path. OFF
 * in production, so production trusts the verified actor token ONLY.
 *
 * FAIL-CLOSED: no valid actor token and no allowed header caller ⇒ null.
 *
 */
export async function resolveCaller(
  request: Request,
  deps: ResolveCallerDeps = defaultDeps(),
): Promise<ConnectorCaller | null> {
  const token = bearerToken(request);
  // busymate-ai-src#3103 — a v3 token in Authorization (the MCP declared `actor: 3`):
  // verified on its own, fail-closed, never downgraded to v2 or a header.
  if (token && peekActorV3Header(token)) return resolveV3Caller(token, deps);
  const v3Header = request.headers.get(ACTOR_V3_HEADER)?.trim() || null;
  if (!token && v3Header && peekActorV3Header(v3Header)) return resolveV3Caller(v3Header, deps);
  if (token) {
    const peek = peekActorToken(token);
    if (peek) {
      // This IS an actor token → verify it and fail closed. Never fall through
      // to the header path on a bad token.
      const shop = await deps.resolveShop(peek.tenantId, peek.connectorId);
      if (!shop) return null;
      const claims = verifyActorToken(token, {
        master: deps.master,
        audience: deps.audience,
        now: deps.now,
      });
      if (!claims || claims.tenantId !== peek.tenantId || claims.connectorId !== peek.connectorId) {
        return null;
      }
      // busymate-ai-src#3103 dual-sign: v2 authenticated the call; a v3 token beside it
      // upgrades the identity ONLY when it verifies AND names the same shop binding and,
      // for an identified v2 actor, the same subject. A bad v3 header never breaks v2.
      if (v3Header && peekActorV3Header(v3Header)) {
        const v3 = await resolveV3Caller(v3Header, deps);
        const v2Customer = claims.actorKind === "identified" ? claims.sub : null;
        if (v3 && v3.shop === shop && (v2Customer === null || v2Customer === v3.customerId)) {
          return { ...v3, confirmed: claims.confirmed && v3.confirmed };
        }
      }
      return {
        shop,
        // Anonymous tokens have a synthetic nonempty sub, not a customer ID.
        customerId: claims.actorKind === "identified" ? claims.sub : null,
        // #2132: the platform signals a released confirm gate INSIDE the signed
        // actor token (`confirmed: true`), not via a header — before this, every
        // confirm-gated write (cancel_order, create_refund, …) answered
        // "Confirmation required" even after the customer approved it in chat.
        confirmed: claims.confirmed,
        actor: "bmai",
        actorVersion: 2,
      };
    }
    // Bearer present but not an actor-shaped token → fall through (dev only).
  }

  // ── Legacy header caller (dev/test only; OFF in production) ─────────────────
  if (!deps.headerCallerAllowed) return null;
  const shop = request.headers.get("x-bmai-shop");
  if (!shop) return null;

  const identityJwt = request.headers.get("x-bmai-identity");
  let customerId: string | null = null;
  if (identityJwt) {
    const claims = await verifyLaunchToken(identityJwt).catch(() => null);
    if (claims?.sub && claims.shop === shop) customerId = claims.sub;
  }

  return {
    shop,
    customerId,
    confirmed: request.headers.get("x-bmai-confirmed") === "1",
    actor: "header",
  };
}
