import { useEffect, useReducer, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Banner,
  BlockStack,
  Card,
  Form,
  FormLayout,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { SaveBar, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { setTenantBranding } from "../bmai.server";
import { retrainForMerchant } from "../lib/ingest";
import { ASSISTANT_NAME_MAX, PRODUCT_NAME_MAX, brandingFieldErrors, saveBrandingAndRepublish } from "../lib/brandingSave";
import { formReducer, initialFormState, isDirty } from "../lib/unsavedChanges";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { brandedAssistantName, effectiveAssistantName, isPlatformPersonaName } from "../lib/assistantName";
import { readTenantBranding } from "../lib/tenantRead.server";
import { failClosedClientAction } from "../lib/clientAction";
import { merchantError } from "../lib/merchantError";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a failed action FETCH renders an error
// banner in the page (never the root 500 page), and a route error recovers in-frame.
export const clientAction = failClosedClientAction;
export const ErrorBoundary = AppRouteBoundary;


/** A sane display-name default: the store's name, else the shop domain without the suffix. */
export function defaultDisplayName(shop: string, shopName?: string | null): string {
  const n = (shopName ?? "").trim();
  return n || shop.replace(/\.myshopify\.com$/i, "");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop } });
  let shopName: string | null = null;
  try {
    const resp = await admin.graphql(`#graphql
      query ShopName { shop { name } }`);
    const body = (await resp.json()) as { data?: { shop?: { name?: string } } };
    shopName = body.data?.shop?.name ?? null;
  } catch {
    shopName = null;
  }
  // The SAVED branding comes from the tenant (get_tenant via MCP) — never a
  // hard-coded placeholder that hides what shoppers actually see.
  const saved = await readTenantBranding(tenant?.bmaiTenantId);
  const fallbackDisplay = defaultDisplayName(session.shop, shopName);
  // Older installs were seeded with the raw myshopify domain — offer the store name instead.
  const displayName = saved.ok && saved.productName && saved.productName !== session.shop ? saved.productName : fallbackDisplay;
  if (!saved.ok) console.warn(`[admin] settings could not read branding for ${session.shop}: ${saved.error}`);
  return {
    // #2618 follow-up — show the name SHOPPERS see: the platform renders an unset
    // name or its own persona "your mate" as "<Store display name> AI".
    assistantName: effectiveAssistantName(saved.ok ? saved.assistantName : null, displayName),
    displayName,
    provisioned: Boolean(tenant?.bmaiTenantId),
    loadError: !saved.ok,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop } });
  const typedAssistantName = String(form.get("assistantName") ?? "").trim();
  const productName = String(form.get("displayName") ?? "");
  // "your mate" is Busymate AI's own assistant; on a store the platform shows it
  // as "<Store> AI". Save that explicitly so Settings and the chat always agree.
  const persona = isPlatformPersonaName(typedAssistantName) && productName.trim() !== "";
  const assistantName = persona ? brandedAssistantName(productName) : typedAssistantName;
  // #2132 C: set_tenant_branding via MCP (no backdoor) AND re-publish the runtime —
  // the storefront widget renders the PUBLISHED revision (brand synthesized from
  // the tenant row at publish time), so a save that does not publish never
  // reaches shoppers. The re-publish is the training publish (origins +
  // knowledge_sources); a failed publish is reported, never a silent green.
  const res = await saveBrandingAndRepublish(
    session.shop,
    tenant?.bmaiTenantId,
    { productName, assistantName },
    { setBranding: (shop, tenantId, branding) => setTenantBranding(shop, tenantId, branding), republish: (shop) => retrainForMerchant(shop) },
  );
  // #2618 — the merchant reads one plain sentence; the raw cause goes to the log.
  return {
    ok: res.ok,
    error: res.ok ? null : merchantError("branding", session.shop, res.error),
    // Built for Shopify 4.2.4: a validation failure is shown next to its field.
    fieldErrors: res.fieldErrors ?? null,
    displayName: productName.trim(),
    published: res.published,
    assistantName: assistantName.trim(),
    notice: persona && res.ok
      ? `Saved. "${typedAssistantName}" is Busymate AI's own assistant, so your store's assistant is called "${assistantName.trim()}". You can rename it any time.`
      : res.ok && res.queued
        ? "Assistant settings saved. Your storefront shows the new names within a minute or two, as soon as the training in progress finishes."
        : null,
  };
};

/** One id for the page's contextual save bar (App Bridge addresses it by id). */
export const SETTINGS_SAVE_BAR_ID = "assistant-settings-save-bar";

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [form, dispatch] = useReducer(
    formReducer<{ assistantName: string; displayName: string }>,
    { assistantName: data.assistantName, displayName: data.displayName },
    initialFormState,
  );
  const saving = fetcher.state !== "idle";
  // Built for Shopify 4.1.5: unsaved edits show Shopify's contextual save bar, which
  // also holds the admin's own navigation until the merchant saves or discards.
  const dirty = data.provisioned && isDirty(form.values, form.saved);
  useLeaveGuard(dirty && !saving, SETTINGS_SAVE_BAR_ID);

  const handled = useRef<unknown>(null);
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      // The server may normalise the names (trim, "your mate" → "<Store> AI"): show what was saved.
      dispatch({ type: "saved", values: { assistantName: result.assistantName ?? "", displayName: result.displayName ?? "" } });
      shopify.toast.show(result.notice ?? "Assistant settings saved and published to your storefront", { duration: result.notice ? 8000 : 5000 });
    } else {
      // Errors stay on the page until the next attempt (4.2.4): by the field when one
      // field explains it, otherwise in a banner above the form. Never a toast that fades.
      dispatch({
        type: "failed",
        errors: result.fieldErrors ?? undefined,
        formError: result.error ?? "We couldn't save your assistant settings. Please try again.",
      });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const save = () => {
    if (saving || !data.provisioned) return;
    const errors = brandingFieldErrors({ assistantName: form.values.assistantName, productName: form.values.displayName });
    if (Object.keys(errors).length) return dispatch({ type: "invalid", errors });
    dispatch({ type: "submit" });
    void fetcher.submit(form.values, { method: "post" });
  };
  const discard = () => dispatch({ type: "discard" });

  return (
    <Page>
      <TitleBar title="Assistant settings" />
      <SaveBar id={SETTINGS_SAVE_BAR_ID} open={dirty}>
        {/* App Bridge reads these two buttons: `variant="primary"` is Save, the other is Discard. */}
        <button {...{ variant: "primary" }} onClick={save} disabled={saving} {...(saving ? { loading: "" } : {})}>
          Save
        </button>
        <button onClick={discard} disabled={saving}>
          Discard
        </button>
      </SaveBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!data.provisioned ? (
              <Banner tone="warning" title="Your assistant is still being set up">
                <p>You can change these names once setup completes (see Home).</p>
              </Banner>
            ) : data.loadError ? (
              <Banner tone="info" title="Showing defaults">
                <p>We couldn&apos;t load your saved names just now, so the form shows defaults. Saving replaces them.</p>
              </Banner>
            ) : null}
            {form.formError ? (
              <Banner tone="critical" title="Your changes weren't saved">
                <p>{form.formError}</p>
              </Banner>
            ) : null}
            <Card>
              {/* Enter in a field saves, the same as Save in the save bar. */}
              <Form onSubmit={save}>
                <FormLayout>
                  <Text as="h2" variant="headingMd">
                    Branding
                  </Text>
                  <TextField
                    label="Assistant name"
                    name="assistantName"
                    autoComplete="off"
                    value={form.values.assistantName}
                    onChange={(value) => dispatch({ type: "edit", field: "assistantName", value })}
                    maxLength={ASSISTANT_NAME_MAX}
                    showCharacterCount
                    error={form.errors.assistantName}
                    disabled={!data.provisioned}
                    helpText={`How the assistant introduces itself to shoppers in chat, for example "${brandedAssistantName(form.values.displayName || "Your store")}".`}
                    requiredIndicator
                  />
                  <TextField
                    label="Store display name"
                    name="displayName"
                    autoComplete="off"
                    value={form.values.displayName}
                    onChange={(value) => dispatch({ type: "edit", field: "displayName", value })}
                    maxLength={PRODUCT_NAME_MAX}
                    showCharacterCount
                    error={form.errors.displayName}
                    disabled={!data.provisioned}
                    helpText="Your store's name as shown to shoppers in the assistant."
                    requiredIndicator
                  />
                </FormLayout>
              </Form>
            </Card>
          </BlockStack>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Launcher label
              </Text>
              <Text as="p" tone="subdued">
                The &quot;Ask us&quot; launcher text on your storefront is translated automatically for each storefront
                language. To override it for your store, edit the AI support chat app embed in your theme editor.
              </Text>
              <Text as="h3" variant="headingSm">
                What the assistant can do
              </Text>
              <Text as="p" tone="subdued">
                Everyone: product and policy questions, and asking for a person. Signed-in shoppers: their own order
                status and tracking; with their confirmation, cancelling an unfulfilled order or changing its shipping
                address. Anything else goes to your team in Conversations.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
