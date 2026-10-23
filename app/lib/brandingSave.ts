/**
 * Assistant-settings save (#2132 FAIL C) — the ONE branding write path.
 *
 * `set_tenant_branding` only updates the tenant ROW; the storefront widget
 * renders the PUBLISHED runtime revision, whose `brand` the platform
 * synthesizes from that row AT PUBLISH TIME (`publish_tenant_runtime`
 * composeConfig). A branding save that does not re-publish therefore never
 * reaches shoppers — the widget kept greeting "Hi, I'm bro" after a rename.
 *
 * So a save is: set branding → re-publish. The re-publish is the training
 * publish (`retrainNow`: origins + `knowledge_sources`), because a publish
 * without `knowledge_sources` DROPS the store knowledge from the revision.
 * Fail-closed: a failed publish is reported as "saved, but not live" — never a
 * silent green toast over a stale widget.
 *
 * Pure: every side effect is injected so the seam is unit-testable.
 */
export interface BrandingInput {
  productName: string;
  assistantName: string;
}

export interface BrandingSaveDeps {
  /** `set_tenant_branding` via the bmai seam (app/bmai.server.ts). */
  setBranding: (shop: string, tenantId: string, branding: BrandingInput) => Promise<{ ok: boolean; error?: string }>;
  /** The training publish (app/lib/ingest.ts `retrainNow`) — origins + knowledge + the NEW brand. */
  republish: (shop: string) => Promise<{ ok: boolean; error?: string; revision?: number }>;
}

export interface BrandingSaveResult {
  ok: boolean;
  error: string | null;
  /** True once the new names are in a PUBLISHED revision (what shoppers see). */
  published: boolean;
  revision: number | null;
}

export const ASSISTANT_NAME_MAX = 40;
export const PRODUCT_NAME_MAX = 80;

/** Validate the two names; null when valid, else the merchant-facing error. */
export function validateBranding(input: { assistantName: string; productName: string }): string | null {
  const assistantName = input.assistantName.trim();
  const productName = input.productName.trim();
  if (!assistantName || !productName) return "Both names are required.";
  if (assistantName.length > ASSISTANT_NAME_MAX || productName.length > PRODUCT_NAME_MAX) {
    return `Names are too long (${ASSISTANT_NAME_MAX} / ${PRODUCT_NAME_MAX} characters).`;
  }
  return null;
}

export async function saveBrandingAndRepublish(
  shop: string,
  tenantId: string | null | undefined,
  branding: BrandingInput,
  deps: BrandingSaveDeps,
): Promise<BrandingSaveResult> {
  if (!tenantId) return { ok: false, error: "no provisioned tenant for this shop yet", published: false, revision: null };
  const invalid = validateBranding(branding);
  if (invalid) return { ok: false, error: invalid, published: false, revision: null };

  const set = await deps.setBranding(shop, tenantId, { productName: branding.productName.trim(), assistantName: branding.assistantName.trim() });
  if (!set.ok) return { ok: false, error: set.error ?? "set_tenant_branding failed", published: false, revision: null };

  const pub = await deps.republish(shop);
  if (!pub.ok) {
    // The raw publish cause is logged, never shown (#2618: no machinery in a merchant toast).
    console.warn(`[admin] branding saved but republish failed for ${shop}: ${pub.error ?? "publish failed"}`);
    return {
      ok: false,
      error: "Your names are saved, but the storefront assistant couldn't be updated yet, so shoppers still see the previous names. Please Save again in a minute, or use Store connection → Re-train.",
      published: false,
      revision: null,
    };
  }
  return { ok: true, error: null, published: true, revision: typeof pub.revision === "number" ? pub.revision : null };
}
