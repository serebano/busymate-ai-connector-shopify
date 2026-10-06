/**
 * bmai actor-token verifier — the multi-tenant, host-derived HS256 verifier.
 *
 * Busymate AI (busymate.ai) mints a deliberately narrow, ≤5-minute HS256 "actor token"
 * and presents it as the MCP `Authorization: Bearer` on a delegated `tools/call`
 * so a tool runs scoped to ONE storefront visitor (`sub`). This module verifies
 * that token.
 *
 * PURE + DEPENDENCY-FREE: `node:crypto` only, NO Prisma, NO env reads. Everything
 * it needs (the master secret, the expected audience, the clock) is passed in, so
 * it is unit-testable with no database and no secrets. The Prisma
 * (tenant,connector)→shop lookup lives in `app/mcp/auth.ts`.
 *
 * MULTI-TENANT DERIVATION — the one difference from the single-partner kit
 * (`whitelabel/partner-kit/src/bmai-identity.mjs`): this host serves MANY shops,
 * so it holds ONE master secret and DERIVES the per-(tenant,connector) verifier
 * secret at verify time — a byte-for-byte mirror of Busymate AI's
 * `deriveSupportActorSecret` (`v2/apps/agent/agent/lib/supportActorToken.ts`):
 *
 *   secret = HMAC-SHA256(master, "bmai-support-actor:v2\n" + tenantId + "\n" + connectorId)
 *
 * so a compromised white-label integration can never mint actor credentials for
 * another tenant/connector. Every failure ⇒ `null` (fail-closed, never throws).
 *
 * SECRET DISCIPLINE: never logs a key, secret, or token.
 *
 */
import crypto from "node:crypto";

/** Busymate AI's fixed issuer for the actor token. */
export const ACTOR_ISSUER = "https://busymate.ai";
/** kid stamped on Busymate AI's HS256 actor-token header. */
export const ACTOR_KID = "bmai-support-v2";
export const ACTOR_ALG = "HS256";
export const ACTOR_TYP = "JWT";
/** Actor tokens are narrow: Busymate AI mints them ≤5 min. Reject anything longer. */
export const ACTOR_MAX_TTL_SECONDS = 300;
/** Derivation label — byte-for-byte identical to the Busymate AI signer. */
export const ACTOR_DERIVATION_LABEL = "bmai-support-actor:v2\n";
/** The master (and, by construction, every derived secret) must be ≥32 bytes. */
export const MIN_MASTER_SECRET_LEN = 32;
/** Accepted clock skew for iat/nbf (seconds). */
const CLOCK_SKEW_SECONDS = 10;

/** The unverified tenant/connector binding peeked from a would-be actor token. */
export interface ActorTokenPeek {
  tenantId: string;
  connectorId: string;
}

/** The verified subject + session identity carried by a valid actor token. */
export interface ActorClaims {
  sub: string;
  /** Signed visitor class; a nonempty subject is not proof of customer identity. */
  actorKind: "anonymous" | "identified";
  supportSessionId: string;
  jti: string;
  tenantId: string;
  connectorId: string;
  /**
   * #2132 — the platform's SIGNED confirmation: Busymate AI mints `confirmed: true`
   * only for a confirm-gated call the customer released through the approval card
   * (v2 `createSupportActorToken` → `confirmed: supportAccess.confirm`). This is the
   * confirm acknowledgement for the actor-token path; a bare header is never enough.
   */
  confirmed: boolean;
}

export interface VerifyActorTokenOptions {
  /** The shared master secret (BMAI_SUPPORT_ACTOR_MASTER = Busymate AI's V2_SUPPORT_ACTOR_TOKEN_SECRET). */
  master: string;
  /** Expected `aud` = our MCP endpoint origin (`new URL(<app>/mcp).origin`). */
  audience: string;
  /** Verification clock (seconds). Injectable for tests; defaults to now. */
  now?: number;
  /** Expected issuer. Defaults to the canonical Busymate AI issuer. */
  issuer?: string;
  /** Expected kid. Defaults to the canonical actor kid. */
  kid?: string;
}

/** True iff `master` is a usable ≥32-byte secret (never throws in `derive`). */
export function masterSecretUsable(master: unknown): master is string {
  return typeof master === "string" && master.length >= MIN_MASTER_SECRET_LEN;
}

/**
 * Derive the per-(tenant,connector) verifier secret from the master. A
 * byte-for-byte mirror of Busymate AI's `deriveSupportActorSecret`. Returns the raw
 * 32-byte digest. Throws only if the master is unusable — callers on the verify
 * path guard with `masterSecretUsable` first so verification stays fail-closed.
 */
export function deriveSupportActorSecret(
  master: string,
  tenantId: string,
  connectorId: string,
): Buffer {
  if (!masterSecretUsable(master)) {
    throw new Error("support actor master secret is unconfigured");
  }
  return crypto
    .createHmac("sha256", master)
    .update(ACTOR_DERIVATION_LABEL)
    .update(tenantId)
    .update("\n")
    .update(connectorId)
    .digest();
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isActorHeader(header: Record<string, unknown> | null, kid: string): boolean {
  return (
    !!header &&
    header.alg === ACTOR_ALG &&
    header.typ === ACTOR_TYP &&
    header.kid === kid
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Peek the UNVERIFIED (tenant_id, connector_id) binding from a would-be actor
 * token, WITHOUT trusting it. Returns `null` unless the token is a 3-part JWT
 * whose header pins {alg:HS256, typ:JWT, kid} and whose payload carries non-empty
 * string tenant_id + connector_id. Used by `auth.ts` to resolve the shop before
 * the (real) signature verification.
 */
export function peekActorToken(token: string, kid: string = ACTOR_KID): ActorTokenPeek | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]);
  if (!isActorHeader(header, kid)) return null;
  const payload = decodeJson(parts[1]);
  if (!payload) return null;
  const { tenant_id: tenantId, connector_id: connectorId } = payload;
  if (!nonEmptyString(tenantId) || !nonEmptyString(connectorId)) return null;
  return { tenantId, connectorId };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify the narrow HS256 actor token. Derives the per-(tenant,connector) secret
 * from the master (so the tenant/connector are pinned by the SIGNATURE, not a
 * bare claim), then pins issuer, audience, sub, support_session_id, jti, the
 * numeric iat/nbf/exp window, and the ≤5-minute TTL. Returns `ActorClaims` or
 * `null`. FAIL-CLOSED: an unset/short master, a bad signature, or any failed pin
 * ⇒ `null`; it never throws and never accepts on doubt.
 */
export function verifyActorToken(token: string, opts: VerifyActorTokenOptions): ActorClaims | null {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const issuer = opts.issuer ?? ACTOR_ISSUER;
  const kid = opts.kid ?? ACTOR_KID;
  const audience = String(opts.audience || "");
  if (!masterSecretUsable(opts.master) || !audience) return null;

  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!isActorHeader(header, kid) || !payload) return null;

  const { tenant_id: tenantId, connector_id: connectorId } = payload;
  if (!nonEmptyString(tenantId) || !nonEmptyString(connectorId)) return null;

  // Derive the per-(tenant,connector) verifier secret, base64url round-trip to
  // mirror the partner-kit verifier exactly, then timing-safe HMAC-compare.
  let secret: Buffer;
  try {
    const secretText = deriveSupportActorSecret(opts.master, tenantId, connectorId).toString("base64url");
    secret = Buffer.from(secretText, "base64url");
  } catch {
    return null;
  }
  if (secret.length < MIN_MASTER_SECRET_LEN) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest("base64url");
  if (!timingSafeEqualStr(expected, signaturePart)) return null;

  // Claim pins (mirror the canonical verifyBmaiActorToken).
  const { sub, actor_kind: actorKind, support_session_id: supportSessionId, jti, iss, aud, iat, nbf, exp } = payload;
  if (
    iss !== issuer ||
    aud !== audience ||
    !nonEmptyString(sub) ||
    (actorKind !== "anonymous" && actorKind !== "identified") ||
    !nonEmptyString(supportSessionId) ||
    !nonEmptyString(jti) ||
    typeof iat !== "number" ||
    typeof nbf !== "number" ||
    typeof exp !== "number" ||
    iat > now + CLOCK_SKEW_SECONDS ||
    nbf > now + CLOCK_SKEW_SECONDS ||
    exp <= now ||
    exp - iat > ACTOR_MAX_TTL_SECONDS
  ) {
    return null;
  }

  return { sub, actorKind, supportSessionId, jti, tenantId, connectorId, confirmed: payload.confirmed === true };
}
