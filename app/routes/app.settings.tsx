import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { setTenantBranding } from "../bmai.server";
import { retrainNow } from "../lib/ingest";
import { saveBrandingAndRepublish } from "../lib/brandingSave";
import { brandedAssistantName, effectiveAssistantName, isPlatformPersonaName } from "../lib/assistantName";
import { readTenantBranding } from "../lib/tenantRead.server";
import { failClosedClientAction } from "../lib/clientAction";
import { merchantError } from "../lib/merchantError";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a failed action FETCH renders an error
// toast (never the root 500 page), and a route error recovers in-frame.
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
    { setBranding: (shop, tenantId, branding) => setTenantBranding(shop, tenantId, branding), republish: retrainNow },
  );
  // #2618 — the merchant reads one plain sentence; the raw cause goes to the log.
  return {
    ok: res.ok,
    error: res.ok ? null : merchantError("branding", session.shop, res.error),
    published: res.published,
    assistantName: assistantName.trim(),
    notice: persona && res.ok
      ? `Saved. "${typedAssistantName}" is Busymate AI's own assistant, so your store's assistant is called "${assistantName.trim()}". You can rename it any time.`
      : null,
  };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [assistantName, setAssistantName] = useState(data.assistantName);
  const [displayName, setDisplayName] = useState(data.displayName);
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.ok) {
        if (fetcher.data.assistantName) setAssistantName(fetcher.data.assistantName);
        shopify.toast.show(fetcher.data.notice ?? "Assistant settings saved and published to your storefront", { duration: fetcher.data.notice ? 8000 : 5000 });
      }
      else shopify.toast.show(fetcher.data.error ?? "We couldn't save your assistant settings. Please try again.", { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <Page>
      <TitleBar title="Assistant settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!data.provisioned ? (
              <Banner tone="warning" title="Your assistant is still being set up">
                <p>Settings can be saved once provisioning completes (see Home).</p>
              </Banner>
            ) : data.loadError ? (
              <Banner tone="info" title="Showing defaults">
                <p>We couldn&apos;t load your saved names just now, so the form shows defaults. Saving replaces them.</p>
              </Banner>
            ) : null}
            <Card>
              <fetcher.Form method="post">
                <FormLayout>
                  <Text as="h2" variant="headingMd">
                    Branding
                  </Text>
                  <TextField
                    label="Assistant name"
                    name="assistantName"
                    autoComplete="off"
                    value={assistantName}
                    onChange={setAssistantName}
                    maxLength={40}
                    helpText={`How the assistant introduces itself to shoppers in chat, for example "${brandedAssistantName(displayName || "Your store")}".`}
                    requiredIndicator
                  />
                  <TextField
                    label="Store display name"
                    name="displayName"
                    autoComplete="off"
                    value={displayName}
                    onChange={setDisplayName}
                    maxLength={80}
                    helpText="Your store's name as shown to shoppers in the assistant."
                    requiredIndicator
                  />
                  <Button submit variant="primary" loading={saving} disabled={!data.provisioned}>
                    Save
                  </Button>
                  {fetcher.data && !fetcher.data.ok && fetcher.data.error ? (
                    <Text as="p" tone="critical">
                      {fetcher.data.error}
                    </Text>
                  ) : null}
                </FormLayout>
              </fetcher.Form>
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
                language. To override it for your store, edit the Busymate AI assistant app embed in your theme editor.
              </Text>
              <Text as="h3" variant="headingSm">
                What the assistant can do
              </Text>
              <Text as="p" tone="subdued">
                Everyone: product and policy questions. Signed-in shoppers: their own order status and tracking. With
                confirmation and a cap: address changes, returns, cancellations and refunds.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
