/**
 * app/scopes_update (#2110) — the pure core of the webhook route.
 *
 * When a merchant grants a changed scope set (e.g. the `read_legal_policies`
 * added for training), `@shopify/shopify-app-react-router` keeps the EXISTING
 * offline session: no token exchange, no afterAuth, so the install lifecycle and
 * its training never re-run on their own. This webhook is the one signal every
 * existing store emits when the new app version rolls out, so it does two things:
 *   1. records the new scope set on the session (the library reads it back), and
 *   2. queues a debounced re-train — the assistant can now read what it could not.
 * A re-train is idempotent (replace-by-key on the platform), so it always runs.
 */
export interface ScopesUpdateInput {
  shop: string;
  webhookId: string;
  /** The offline session the webhook resolved (null when the shop has none). */
  sessionId?: string | null;
  /** The webhook payload's `current` scopes (untrusted shape). */
  current?: unknown;
}

export interface ScopesUpdateDeps {
  updateSessionScope: (sessionId: string, scope: string) => Promise<void>;
  scheduleReingest: (shop: string, reason: "scopes", webhookId: string) => Promise<{ scheduled: boolean; reason?: string }>;
}

export interface ScopesUpdateOutcome {
  /** The normalized comma-joined scope set, or null when the payload was malformed. */
  scope: string | null;
  sessionUpdated: boolean;
  retrain: { scheduled: boolean; reason?: string };
}

export function normalizeScopes(current: unknown): string | null {
  if (!Array.isArray(current)) return null;
  const scopes = current.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
  return scopes.length ? scopes.join(",") : null;
}

export async function handleScopesUpdate(input: ScopesUpdateInput, deps: ScopesUpdateDeps): Promise<ScopesUpdateOutcome> {
  const scope = normalizeScopes(input.current);
  let sessionUpdated = false;
  if (scope && input.sessionId) {
    await deps.updateSessionScope(input.sessionId, scope);
    sessionUpdated = true;
  }
  const retrain = await deps.scheduleReingest(input.shop, "scopes", input.webhookId);
  return { scope, sessionUpdated, retrain };
}
