/**
 * The Connector page's action logic, decoupled from the Shopify request seam so
 * it can be exercised in a unit test (#retrain-500).
 *
 * THE CONTRACT: an embedded-admin action MUST resolve to a plain JSON result the
 * fetcher can render in-frame — NEVER throw. A thrown value in a React Router
 * action propagates to the ErrorBoundary, which in this embedded app renders the
 * branded "Something went wrong" (500) page inside the iframe — a Shopify review
 * failure (Req 2.1.1 / 2.1.3: no web 500s). `runConnectorAction` catches every
 * intent so a failing re-train / re-provision reports `{ ok:false, error }` and
 * the merchant sees an error TOAST, not a 500. The route stays a thin wrapper
 * that only supplies the session-bound dependencies.
 */

export interface RetrainCounts {
  products: number | null;
  pages: number | null;
  policies: number | null;
}

export interface ReprovisionResult {
  ok: boolean;
  state: string;
  error: string | null;
  /** Set up fine; the runtime is still taking the new revision (a normal few-second hand-over). */
  activating?: boolean;
}

export interface RetrainResultShape {
  ok: boolean;
  state: string;
  error: string | null;
  /** Accepted while a training pass is already running (it publishes the request). */
  queued?: boolean;
  trainedAt: string | null;
  counts: RetrainCounts;
  summary: string | null;
}

export interface ConnectorActionDeps {
  reprovision: () => Promise<ReprovisionResult>;
  retrain: () => Promise<RetrainResultShape>;
}

export type ConnectorActionResult =
  | ({ intent: "reprovision" } & ReprovisionResult)
  | ({ intent: "retrain" } & RetrainResultShape)
  | { intent: string; ok: false; state: string; error: string };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runConnectorAction(intent: string, deps: ConnectorActionDeps): Promise<ConnectorActionResult> {
  try {
    if (intent === "reprovision") {
      return { intent: "reprovision", ...(await deps.reprovision()) };
    }
    if (intent === "retrain") {
      return { intent: "retrain", ...(await deps.retrain()) };
    }
    return { intent, ok: false, state: "unknown", error: "unknown action" };
  } catch (err) {
    // Fail CLOSED to a rendered error state — never let the action throw a 500
    // into the embedded frame.
    return { intent, ok: false, state: "failed", error: errText(err) };
  }
}
