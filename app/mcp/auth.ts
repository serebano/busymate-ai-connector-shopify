import { verifyLaunchToken } from "../lib/identity";
import { connectorAudience } from "../lib/connector";
import { peekActorToken, verifyActorToken } from "./actorToken";

export interface ConnectorCaller {
  shop: string;
  customerId: string | null; // identified launch subject, or null (guest)
  confirmed: boolean;
  /** How the caller was resolved: the verified Busymate AI actor token, or the legacy header. */
  actor: "bmai" | "header";
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
