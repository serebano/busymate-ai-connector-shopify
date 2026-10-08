import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { scheduleReingest } from "../lib/ingest";
import { handleScopesUpdate } from "../lib/scopesUpdate";
import { authenticateWebhookWithoutSession, offlineSessionId } from "../lib/webhookAuth";

// A scope grant keeps the existing offline session (no afterAuth), so this is
// where an existing store's assistant learns it can now read more: record the
// scopes and queue a re-train (app/lib/scopesUpdate.ts).
// HMAC only, no offline-session load (0.1.15): the scope set is written onto the
// offline session ROW by its deterministic id (`offline_<shop>`) — the library's
// loader would first refresh an expired token and answer 500 when that fails.
// `updateMany` so a shop with no session row is a no-op, never a throw. The
// re-train refreshes the token itself in the background (unauthenticated.admin).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticateWebhookWithoutSession(request);
  const sessionId = offlineSessionId(shop);
  const out = await handleScopesUpdate(
    { shop, webhookId, sessionId, current: (payload as { current?: unknown } | null)?.current },
    {
      updateSessionScope: async (id, scope) => {
        await prisma.session.updateMany({ where: { id, shop, isOnline: false }, data: { scope } });
      },
      scheduleReingest,
    },
  );
  console.log(
    `[scopes] ${shop}: ${out.scope ?? "(payload had no scopes)"}${out.sessionUpdated ? " (session updated)" : ""} → re-train ${
      out.retrain.scheduled ? "queued" : `skipped: ${out.retrain.reason}`
    }`,
  );
  return new Response();
};
