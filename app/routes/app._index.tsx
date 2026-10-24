import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { shopToSlug } from "../lib/tenantSlug";
import { callMcpTool, onAppInstalled, repairTenantInBackground, storefrontPublicForShop } from "../bmai.server";
import { hostedWebFor } from "../lib/storefrontPassword";
import { awaitRuntimeSettled, readRuntimeReadiness } from "../lib/runtimeReadiness";
import { merchantError } from "../lib/merchantError";
import { readStorefrontFrameable } from "../lib/embedFrameable";
import { homeActivation } from "../lib/homeActivation";
import { useActivationRecheck } from "../lib/useActivationRecheck";
import { isSettingUp, useSetupPoll } from "../lib/useSetupPoll";
import { publishedTenantRepair } from "../lib/tenantRepair";
import { readTrainingState } from "../lib/retrain.server";
import { resolveBillingAccess } from "../lib/billingGate";
import { reconcileBilling } from "../lib/billingReconcile.server";
import { planFor } from "../lib/plans";
import { failClosedClientAction } from "../lib/clientAction";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a failed action FETCH renders an error
// toast (never the root 500 page), and a route error recovers in-frame.
export const clientAction = failClosedClientAction;
export const ErrorBoundary = AppRouteBoundary;
import {
  EMBED_STEPS,
  buildSetupChecklist,
  detectStorefrontEmbed,
  embedSetupPresentation,
  readThemeEmbed,
  type EmbedStatus,
  themeEditorActivateUrl,
  themeEditorAppEmbedsUrl,
  trainingSummary,
} from "../lib/themeEmbed";

const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "busymate-ai";
/** The Busymate AI platform that serves the storefront chat (the extension's `data-origin`). */
const PLATFORM_ORIGIN = process.env.BMAI_EMBED_ORIGIN || "https://busymate.ai";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  // src#2624 reviewer F24 — the plan is Shopify's, read live on every Home load
  // (after a reinstall Shopify has cancelled the old subscription; Home must ask
  // for a plan again instead of showing the cached one). Non-fatal.
  await reconcileBilling(shop, (q) => admin.graphql(q), null, { enrich: false }).catch(() => null);
  const tenant = await prisma.shopTenant.findUnique({ where: { shop }, include: { billing: true } });
  const slug = tenant?.slug ?? shopToSlug(shop);
  const training = readTrainingState(tenant);
  const access = resolveBillingAccess({ status: tenant?.billing?.status, plan: tenant?.billing?.plan, shop, appHandle: APP_HANDLE });
  // Scope-free embed detection from the public storefront (unknown on a
  // password-protected store — the written steps cover that case).
  const provisionState = tenant?.provisionState ?? "pending";
  // Both reads are independent network round-trips (the public storefront and the
  // Busymate AI integration record); run them concurrently so the Home loader —
  // which every fetcher action revalidates — finishes in one round-trip, not two
  // (#idle-500: a long revalidation is the window in which an abort lands).
  // #3718 — the third read: can the chat actually be FRAMED on the Online Store
  // and in the Theme Editor right now (the platform's own frame-ancestors answer)?
  const published = provisionState === "published" && Boolean(tenant?.bmaiTenantId);
  // busymate-ai-src#2704 — the fourth read: is the storefront public? A
  // password-protected store has no public assistant page (only the widget).
  const [themeEmbed, runtime, frameable, storefrontPublic] = await Promise.all([
    readThemeEmbed((q) => admin.graphql(q)),
    published && tenant?.bmaiTenantId
      ? readRuntimeReadiness(tenant.bmaiTenantId, callMcpTool) : Promise.resolve(null),
    published ? readStorefrontFrameable({ platformOrigin: PLATFORM_ORIGIN, shop, slug }) : Promise.resolve(null),
    storefrontPublicForShop(shop).catch(() => null),
  ]);
  const publicPage = hostedWebFor(storefrontPublic);
  const live = runtime?.state === "ready";
  // src#2624 reviewer F25 — the theme is the truth (read_themes); the public
  // storefront check is only the fallback. No stored confirmation any more.
  const embed: EmbedStatus = themeEmbed ?? (await detectStorefrontEmbed(shop));
  const embedConfirmed = false;
  // #3718 — an ORPHANED tenant (the platform answered that it is gone) is
  // repaired in the background right here, gated per shop; Home shows it as
  // activating and re-checks until the chat can be framed.
  if (published && tenant?.bmaiTenantId) {
    const repair = publishedTenantRepair({ readiness: runtime, tenantUnreachableAt: tenant.tenantUnreachableAt, wantedHostedWeb: storefrontPublic === null ? null : publicPage });
    if (repair) repairTenantInBackground(shop, repair);
  }
  // Offer "Turn on the storefront assistant" once the chat will open: the
  // platform's frameability answer decides when it answered (a `true` enables it
  // even while the readiness read is unverified or still pending); only a
  // definite "not yet" holds it. Keep checking while it is held.
  // Audit 2026-10-02 (reviewer screencast 2): a tenant that is not published yet
  // — the first paint lands while afterAuth is still publishing — is ACTIVATING:
  // the CTA is held and Home re-checks by itself instead of offering a frame the
  // browser will refuse and sitting on "Provisioning" until a manual reload.
  // 0.1.15 (reinstall): `recheck` is separate from the hold — Home keeps
  // re-checking while the runtime is not yet ready even when the CTA is already
  // offered on the platform's frameable:true, so the "Activating" badge and the
  // "Assistant provisioned" step never sit stale until a manual reload.
  const { embedReady, activating, recheck } = homeActivation({ provisionState, published, runtime: runtime?.state ?? null, frameable });
  const steps = buildSetupChecklist({
    provisionState,
    connectorReady: live && Boolean(tenant?.connectorId) && !tenant?.provisionWarning,
    embed,
    embedConfirmed,
    trainedAt: training.trainedAt,
    trainError: training.error,
    counts: training.counts,
    fetched: training.fetched,
    truncated: training.truncated,
    planId: access.planId,
    hasSubscription: tenant?.billing?.status === "active" || tenant?.billing?.status === "pending",
    planSelected: access.planSelected,
  });
  if (provisionState === "published" && !live) {
    const step = steps.find(s => s.id === "provisioned")!;
    step.done = false;
    step.failed = runtime?.state === "error";
    step.detail = runtime?.detail ?? "Your assistant's live status could not be verified.";
  }
  return {
    shop,
    planSelected: access.planSelected,
    servingHost: `${slug}.busymate.ai`,
    publicPage,
    provisionState: provisionState === "published" ? (live ? "published" : `runtime-${runtime?.state ?? "unverified"}`) : provisionState,
    provisionError: tenant?.provisionError ?? null,
    provisionWarning: tenant?.provisionWarning ?? null,
    connectorReady: live && Boolean(tenant?.connectorId) && !tenant?.provisionWarning,
    training: { ...training, summary: trainingSummary(training.counts, training.fetched) },
    embed,
    embedConfirmed,
    steps,
    embedSteps: EMBED_STEPS,
    activateUrl: themeEditorActivateUrl(shop),
    appEmbedsUrl: themeEditorAppEmbedsUrl(shop),
    planName: planFor(access.planId).name,
    live,
    embedReady,
    activating,
    recheck,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "retry") {
    // Idempotent re-run of the provisioning lifecycle (NEVER PARK an errored install).
    await onAppInstalled(session);
  }
  const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop } });
  const tenantId = tenant?.bmaiTenantId;
  // A fresh publish leaves the runtime `pending` for a few seconds — wait it out
  // (bounded) rather than report the normal hand-over as "still not live".
  const runtime = tenant?.provisionState === "published" && tenantId
    ? await awaitRuntimeSettled(() => readRuntimeReadiness(tenantId, callMcpTool), { timeoutMs: intent === "retry" ? 25_000 : 0 }) : null;
  const ok = runtime?.state === "ready";
  const raw = tenant?.provisionError ?? (!ok ? runtime?.detail : null) ?? null;
  return { ok, state: runtime?.state ?? tenant?.provisionState ?? "pending", error: ok ? null : merchantError("reprovision", session.shop, raw) };
};

function stateBadge(state: string) {
  if (state === "published") return <Badge tone="success">Live</Badge>;
  if (state === "runtime-pending") return <Badge tone="info" progress="partiallyComplete">Activating</Badge>;
  if (state === "runtime-orphaned") return <Badge tone="attention">Repairing</Badge>;
  if (state === "runtime-unverified") return <Badge tone="warning">Status unavailable</Badge>;
  if (state === "runtime-error") return <Badge tone="critical">Activation failed</Badge>;
  if (state === "error") return <Badge tone="critical">Needs attention</Badge>;
  if (state === "suspended") return <Badge tone="warning">Suspended</Badge>;
  // src#2624 final — the first seconds after install read as progress, never a stuck state.
  return <Badge tone="info" progress="partiallyComplete">Setting up</Badge>;
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const embedSetup = embedSetupPresentation(data.embed, data.embedConfirmed);
  const retry = useFetcher<typeof action>();
  const done = data.steps.filter((s) => s.done).length;
  // #3718 — while the runtime is not yet ready (held CTA or not), re-check by
  // itself: every 5 s for 5 minutes, then every 30 s for as long as it is still
  // not ready (never a silent stop). The "taking longer" banner with Retry setup
  // shows only while the CTA is HELD past 5 minutes (`activating && slow`).
  const slow = useActivationRecheck(data.recheck);
  // src#2624 final — right after install the setup takes a few seconds: re-read
  // every 1.5 s while it is still being set up (bounded), so Home flips to Live
  // as soon as it is, instead of waiting for the 5 s activation loop.
  useSetupPoll(isSettingUp(data.provisionState));
  return (
    <Page>
      <TitleBar title="Busymate AI" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {data.provisionError ? (
              <Banner tone="critical" title="Provisioning needs attention">
                <BlockStack gap="200">
                  <Text as="p">{data.provisionError}</Text>
                  <retry.Form method="post">
                    <input type="hidden" name="intent" value="retry" />
                    <Button submit variant="primary" loading={retry.state !== "idle"}>
                      Retry setup
                    </Button>
                  </retry.Form>
                  {retry.data && !retry.data.ok ? (
                    <Text as="p" tone="critical">
                      {retry.data.error ?? "Your assistant isn't live yet. Please try again in a minute."}
                    </Text>
                  ) : null}
                </BlockStack>
              </Banner>
            ) : null}
            {!data.provisionError && data.provisionWarning ? (
              <Banner tone="warning" title="Order tools are not live yet">
                <Text as="p">{data.provisionWarning}</Text>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <InlineGrid columns="1fr auto" alignItems="center">
                  <Text as="h2" variant="headingMd">
                    Set up your AI assistant
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" tone="subdued">
                      {done}/{data.steps.length} done
                    </Text>
                    {stateBadge(data.provisionState)}
                  </InlineStack>
                </InlineGrid>
                <Text as="p" tone="subdued">
                  Busymate AI adds your store&apos;s own AI assistant to your storefront, named after your store (rename it in
                  Assistant settings). It answers
                  only from your products, pages and policies, in your shoppers&apos; languages, and takes order actions
                  only with confirmation.
                </Text>
                <List type="number">
                  {data.steps.map((s) => (
                    <List.Item key={s.id}>
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Text as="span" fontWeight="semibold">
                          {s.title}
                        </Text>
                        {s.failed ? (
                          <Badge tone="critical">Failed</Badge>
                        ) : s.done ? (
                          <Badge tone="success">Done</Badge>
                        ) : (
                          <Badge tone="attention">To do</Badge>
                        )}
                      </InlineStack>
                      <Text as="p" tone="subdued">
                        {s.detail}
                      </Text>
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineGrid columns="1fr auto" alignItems="center">
                  <Text as="h2" variant="headingMd">
                    {embedSetup.heading}
                  </Text>
                  {data.embed === "on" ? (
                    <Badge tone="success">On</Badge>
                  ) : data.embed === "off" ? (
                    <Badge tone="attention">Off</Badge>
                  ) : data.embed === "password" ? (
                    <Badge tone="info">Password-protected store</Badge>
                  ) : null}
                </InlineGrid>
                <Text as="p" tone="subdued">
                  {embedSetup.detail}
                </Text>
                {data.activating && !slow ? (
                  <Banner tone="info" title="Your assistant is being activated">
                    <Text as="p">
                      This usually takes less than a minute. This page checks again by itself and enables the button
                      as soon as the assistant can be shown on your storefront and in the theme editor.
                    </Text>
                  </Banner>
                ) : null}
                {data.activating && slow ? (
                  <Banner tone="warning" title="Activation is taking longer than usual">
                    <BlockStack gap="200">
                      <Text as="p">
                        This page keeps checking every 30 seconds and enables the button by itself. You can also run
                        setup again now.
                      </Text>
                      <retry.Form method="post">
                        <input type="hidden" name="intent" value="retry" />
                        <Button submit loading={retry.state !== "idle"}>
                          Retry setup
                        </Button>
                      </retry.Form>
                    </BlockStack>
                  </Banner>
                ) : null}
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    url={data.embedReady ? data.activateUrl : undefined}
                    target="_top"
                    disabled={!data.embedReady}
                  >
                    {embedSetup.button}
                  </Button>
                  {embedSetup.button !== "Open App embeds" ? (
                    <Button url={data.embedReady ? data.activateUrl : undefined} target="_top" disabled={!data.embedReady}>
                      Open App embeds
                    </Button>
                  ) : null}
                </InlineStack>
                <Box>
                  <Text as="h3" variant="headingSm">
                    Or do it by hand
                  </Text>
                  <List type="number">
                    {data.embedSteps.map((step) => (
                      <List.Item key={step}>{step}</List.Item>
                    ))}
                  </List>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Your assistant
                </Text>
                {data.publicPage ? (
                  <Text as="p" tone="subdued">
                    {data.live ? "Serving at " : "Will serve at "}
                    <Link url={`https://${data.servingHost}`} target="_blank">
                      {data.servingHost}
                    </Link>
                  </Text>
                ) : (
                  <Text as="p" tone="subdued">
                    Your store is password-protected, so your assistant has no public page. Shoppers who enter your
                    storefront password chat with it on your store. Its page opens when you remove the password.
                  </Text>
                )}
                {data.live && data.publicPage ? (
                  <Button url={`https://${data.servingHost}`} target="_blank">
                    Open assistant
                  </Button>
                ) : null}
                <retry.Form method="post">
                  <input type="hidden" name="intent" value="refresh" />
                  <Button submit loading={retry.state !== "idle"}>Refresh status</Button>
                </retry.Form>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Store connection
                </Text>
                <Text as="p" tone="subdued">
                  {data.connectorReady
                    ? "Connected — the assistant can look up a signed-in shopper's own orders."
                    : "Not connected yet — order lookups are unavailable until the connection registers. Retry from the Store connection page."}
                </Text>
                <Link url="/app/connector">Manage store connection</Link>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Training
                </Text>
                <Text as="p" tone="subdued">
                  {data.training.error
                    ? `Training failed: ${data.training.error}`
                    : data.training.summary
                      ? `Trained on ${data.training.summary}.`
                      : "Not trained yet — the assistant learns your products, policies and pages when setup completes."}
                </Text>
                <Link url="/app/connector">Re-train</Link>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Billing
                </Text>
                <Text as="p" tone="subdued">
                  {data.planSelected ? (
                    <>
                      You&apos;re on the <strong>{data.planName}</strong> plan.
                    </>
                  ) : (
                    <>
                      <strong>No plan selected yet</strong> — choose the $0 Free plan or a paid plan on Shopify&apos;s pricing
                      page; Free-plan limits apply until you do.
                    </>
                  )}{" "}
                  Plans include a monthly number of AI resolutions; paid plans charge per extra resolution up to a monthly
                  cap. The assistant is never switched off for billing.
                </Text>
                <Link url="/app/billing">{data.planSelected ? "Manage plan" : "Choose a plan"}</Link>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
