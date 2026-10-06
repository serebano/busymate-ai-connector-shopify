import { masterSecretUsable } from "../mcp/actorToken";
import { connectorAudience } from "../lib/connector";
import { launchIdentityConfigured } from "../lib/identity";
import { APP_BUILD_REVISION } from "../lib/buildRevision";

/**
 * `/api/bmai/status` — an UNAUTHENTICATED health/capability probe for the bmai
 * connector integration. Returns public revision/capability metadata, never a secret value: whether
 * this host CAN verify Busymate AI's actor tokens and mint identified-launch JWTs, plus
 * the audience it pins. Used to confirm a deploy provisioned the secrets before
 * Busymate AI starts delegating.
 *
 */
export const loader = async () => {
  return Response.json({
    ok: true,
    revision: APP_BUILD_REVISION,
    // true iff BMAI_SUPPORT_ACTOR_MASTER is present and ≥32 bytes → the app can
    // derive per-(tenant,connector) secrets and verify actor tokens.
    actorVerifier: masterSecretUsable(process.env.BMAI_SUPPORT_ACTOR_MASTER),
    // true iff the ES256 launch signing key is configured.
    launchIdentity: launchIdentityConfigured(),
    // the MCP endpoint origin used for actor-token `aud` pinning.
    audience: connectorAudience(),
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  });
};
