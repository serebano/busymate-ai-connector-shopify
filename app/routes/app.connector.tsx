import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Collapsible,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { callMcpTool, onAppInstalled } from "../bmai.server";
import { readRuntimeReadiness } from "../lib/runtimeReadiness";
import { connectorEndpoint } from "../lib/connector";
import { readTrainingState, runRetrain } from "../lib/retrain.server";
import { merchantError } from "../lib/merchantError";
import { trainingSummary } from "../lib/themeEmbed";
import { runConnectorAction } from "../lib/connectorAction.server";
import { LocalTime } from "../components/LocalTime";
import { failClosedClientAction, isTransportFailure } from "../lib/clientAction";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a failed action FETCH (network blip,
// app restarting) renders an error toast + revalidates — never the root 500
// page — and a route error recovers in-frame.
export const clientAction = failClosedClientAction;
export const ErrorBoundary = AppRouteBoundary;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop } });
  const training = readTrainingState(tenant);
  const runtime = tenant?.provisionState === "published" && tenant.bmaiTenantId
    ? await readRuntimeReadiness(tenant.bmaiTenantId, callMcpTool) : null;
  return {
    runtime,
    endpoint: connectorEndpoint(),
    connectorId: tenant?.connectorId ?? null,
    tenantId: tenant?.bmaiTenantId ?? null,
    provisionState: tenant?.provisionState ?? "pending",
    provisionError: tenant?.provisionError ?? null,
    provisionWarning: tenant?.provisionWarning ?? null,
    provisionedAt: tenant?.publishedAt ? new Date(tenant.publishedAt).toISOString() : null,
    training: { ...training, summary: trainingSummary(training.counts, training.fetched) },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // The action ALWAYS resolves to a JSON result the fetcher renders in-frame —
  // runConnectorAction catches a failing intent so it can never throw a 500 into
  // the embedded admin (#retrain-500). Both intents run synchronously and report
  // the REAL persisted state, never a fabricated success.
  return runConnectorAction(intent, {
    reprovision: async () => {
      // Idempotent re-run of the full lifecycle. NEVER PARK: an errored install is
      // retryable here rather than stuck.
      await onAppInstalled(session);
      const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop } });
      const runtime = tenant?.provisionState === "published" && tenant.bmaiTenantId
        ? await readRuntimeReadiness(tenant.bmaiTenantId, callMcpTool) : null;
      const ok = runtime?.state === "ready" && !tenant?.provisionWarning;
      const raw = tenant?.provisionError ?? tenant?.provisionWarning ?? (runtime?.state !== "ready" ? runtime?.detail : null) ?? null;
      return {
        ok,
        state: runtime?.state ?? tenant?.provisionState ?? "pending",
        // #2618 — plain language in the toast; the raw cause stays in "Technical details" + the log.
        error: ok ? null : merchantError("reprovision", session.shop, raw),
      };
    },
    retrain: async () => {
      // Synchronous: fetch → compress → publish → persist, then report the REAL state.
      const r = await runRetrain(session.shop);
      return {
        ok: r.ok,
        state: r.ok ? "trained" : "failed",
        error: r.ok ? null : merchantError("retrain", session.shop, r.error),
        trainedAt: r.state.trainedAt,
        counts: r.state.counts,
        summary: trainingSummary(r.state.counts, r.state.fetched),
      };
    },
  });
};

export default function ConnectorPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [showTech, setShowTech] = useState(false);
  const busy = (intent: string) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;

  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const d = fetcher.data;
      if (d.intent === "retrain")
        shopify.toast.show(d.ok ? `Trained on ${"summary" in d && d.summary ? d.summary : "your store"}` : (d.error ?? "Training didn't finish. Please try again."), { isError: !d.ok });
      if (d.intent === "reprovision") shopify.toast.show(d.ok ? "Store connection is live" : (d.error ?? "Your store connection isn't live yet. Please try again."), { isError: !d.ok });
      // The REQUEST failed (network blip / app restart) — the server may still have
      // finished the work, so refresh the loader to show the real state (#retrain-500).
      if (isTransportFailure(d)) revalidate();
    }
  }, [fetcher.state, fetcher.data, shopify, revalidate]);

  const connected = Boolean(data.connectorId) && data.runtime?.state === "ready" && !data.provisionWarning;
  return (
    <Page>
      <TitleBar title="Store connection" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineGrid columns="1fr auto" alignItems="center">
                  <Text as="h2" variant="headingMd">
                    Store connection
                  </Text>
                  {connected ? (
                    <Badge tone="success">Connected</Badge>
                  ) : data.provisionState === "error" ? (
                    <Badge tone="critical">Error</Badge>
                  ) : (
                    <Badge tone="attention">Not connected</Badge>
                  )}
                </InlineGrid>
                <Text as="p" tone="subdued">
                  The connection lets the assistant look up a signed-in shopper&apos;s own orders and, with confirmation,
                  update an address, start a return, cancel or refund. It uses the permissions you approved on install
                  and nothing more.
                </Text>
                <Text as="p">
                  Last set up: <LocalTime iso={data.provisionedAt} fallback="never" />
                </Text>
                {data.provisionError ? (
                  <Text as="p" tone="critical">
                    {data.provisionError}
                  </Text>
                ) : null}
                {data.provisionWarning ? (
                  <Text as="p" tone="caution">
                    {data.provisionWarning}
                  </Text>
                ) : null}
                {data.runtime && data.runtime.state !== "ready" ? (
                  <Text as="p" tone="caution">{data.runtime.detail}</Text>
                ) : null}
                <InlineStack gap="300">
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="reprovision" />
                    <Button submit variant={connected ? "secondary" : "primary"} loading={busy("reprovision")}>
                      {connected ? "Reconnect" : "Retry connection"}
                    </Button>
                  </fetcher.Form>
                  <Button onClick={() => setShowTech((v) => !v)} disclosure={showTech ? "up" : "down"} variant="plain">
                    Technical details
                  </Button>
                </InlineStack>
                <Collapsible open={showTech} id="connector-technical-details">
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued">
                      Endpoint: <code>{data.endpoint}</code>
                    </Text>
                    <Text as="p" tone="subdued">
                      Connection id: <code>{data.connectorId ?? "—"}</code> · Assistant id: <code>{data.tenantId ?? "—"}</code> ·
                      State: <code>{data.provisionState}</code>
                    </Text>
                    <Text as="p" tone="subdued">
                      Registered with Busymate AI as this store&apos;s private connector; order actions are scoped to the
                      signed-in shopper and confirm-gated.
                    </Text>
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineGrid columns="1fr auto" alignItems="center">
                  <Text as="h2" variant="headingMd">
                    Training data
                  </Text>
                  {data.training.error ? (
                    <Badge tone="critical">Failed</Badge>
                  ) : data.training.trainedAt ? (
                    <Badge tone="success">Trained</Badge>
                  ) : (
                    <Badge tone="attention">Not trained yet</Badge>
                  )}
                </InlineGrid>
                <Text as="p" tone="subdued">
                  The assistant answers only from your products, pages and store policies. Re-train after big catalogue
                  or policy changes; product updates re-train automatically.
                </Text>
                <Text as="p">
                  Last trained: <LocalTime iso={data.training.trainedAt} fallback="never" />
                  {data.training.summary ? ` · trained on ${data.training.summary}` : ""}
                  {data.training.truncated ? " · the catalogue was trimmed to fit the assistant's knowledge limit (most important items first)" : ""}
                </Text>
                {data.training.error ? (
                  <Text as="p" tone="critical">
                    {data.training.error}
                  </Text>
                ) : null}
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="retrain" />
                  <Button submit variant="primary" loading={busy("retrain")} disabled={!data.tenantId}>
                    Re-train on my store
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
