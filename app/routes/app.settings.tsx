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
import { DEFAULT_ASSISTANT_NAME } from "../lib/assistantName";
import { readTenantBranding } from "../lib/tenantRead.server";
import { failClosedClientAction } from "../lib/clientAction";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a failed action FETCH renders an error
// toast (never the root 500 page), and a route error recovers in-frame.
export const clientAction = failClosedClientAction;
export const ErrorBoundary = AppRouteBoundary;

export { DEFAULT_ASSISTANT_NAME };

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
  return {
    assistantName: (saved.ok && saved.assistantName) || DEFAULT_ASSISTANT_NAME,
    // The provisioning default is the raw myshopify domain — offer the store name instead.
    displayName: saved.ok && saved.productName && saved.productName !== session.shop ? saved.productName : fallbackDisplay,
    provisioned: Boolean(tenant?.bmaiTenantId),
    loadError: saved.ok ? null : saved.error,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop } });
  const assistantName = String(form.get("assistantName") ?? "");
  const productName = String(form.get("displayName") ?? "");
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
  return { ok: res.ok, error: res.error, published: res.published };
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
      if (fetcher.data.ok) shopify.toast.show("Assistant settings saved and published to your storefront");
      else shopify.toast.show(fetcher.data.error ?? "Could not save", { isError: true });
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
                <p>The saved names could not be loaded ({data.loadError}). Saving will overwrite them.</p>
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
                    helpText="How the assistant introduces itself in chat (default: your mate)."
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
