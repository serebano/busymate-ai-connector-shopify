import { useEffect } from "react";
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
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { PLANS, describePlan, planFor } from "../lib/plans";
import { LocalTime } from "../components/LocalTime";
import { managedPricingUrl, resolveBillingAccess } from "../lib/billingGate";
import { subscriptionStateFromInstallation, subscriptionStateFromPlanHandle } from "../lib/billingSync";
import { readBillingState, syncBillingState } from "../lib/billingState.server";
import { appGidFromEnv, fetchActiveSubscription, subscriptionStateFromPartnerApi } from "../lib/partnerApi";
import { listStuckDeliveries, meterShop } from "../lib/usageBilling";
import { measuredCycleResolutions } from "../lib/usageDisplay";
import { RESOLUTION_DEFINITION } from "../lib/resolutionDefinition";
import { failClosedClientAction } from "../lib/clientAction";
import { merchantError } from "../lib/merchantError";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a failed action FETCH renders an error
// toast (never the root 500 page), and a route error recovers in-frame.
export const clientAction = failClosedClientAction;
export const ErrorBoundary = AppRouteBoundary;

// The app handle from shopify.app.toml (`handle = "busymate-ai"`); the App
// Pricing plan-selection page lives at /store/<store>/charges/<handle>/pricing_plans.
const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "busymate-ai";

type AdminGraphql = (query: string) => Promise<Response>;

/**
 * Reconcile the LIVE plan state into BillingState (Req 1.2.1/1.2.2):
 *   1. the App Pricing redirect `plan_handle` (the merchant just picked a plan)
 *   2. the Partner API activeSubscription (the App Pricing truth — no webhooks)
 *   3. legacy `currentAppInstallation.activeSubscriptions` (Billing-API contracts)
 * Non-fatal: any failure leaves the stored state and is reported as `source`.
 */
async function reconcile(shop: string, graphql: AdminGraphql, planHandle: string | null) {
  let chosen: string | null = null;
  const fromRedirect = subscriptionStateFromPlanHandle(planHandle);
  if (fromRedirect) {
    await syncBillingState(shop, fromRedirect);
    chosen = fromRedirect.plan;
  }
  let source: "partner" | "legacy" | "stored" = "stored";
  let unverified: string | null = null;
  let trialEndsAt: string | null = null;
  let usageQuantity: number | null = null;
  const appGid = appGidFromEnv();
  try {
    const shopResp = await graphql(`#graphql
      query ShopId { shop { id } }`);
    const shopBody = (await shopResp.json()) as { data?: { shop?: { id?: string } } };
    const shopGid = shopBody.data?.shop?.id ?? null;
    if (appGid && shopGid) {
      const live = await fetchActiveSubscription({ appGid, shopGid });
      if (live.ok) {
        const state = subscriptionStateFromPartnerApi(live.subscription);
        // No contract right after a redirect ⇒ Shopify is still finalizing; keep pending.
        if (!(state.status === "inactive" && fromRedirect)) await syncBillingState(shop, state);
        source = "partner";
        trialEndsAt = state.trialEndsAt;
        usageQuantity = state.usageQuantity;
      } else {
        unverified = live.error;
      }
    } else {
      unverified = appGid ? "shop id unavailable" : "SHOPIFY_APP_ID/SHOPIFY_APP_GID not configured";
    }
    if (source !== "partner") {
      const resp = await graphql(`#graphql
        query ActiveSubscriptions { currentAppInstallation { activeSubscriptions { id name status } } }`);
      const body = (await resp.json()) as { data?: unknown };
      const legacy = subscriptionStateFromInstallation(body.data);
      if (legacy.status !== "inactive") {
        await syncBillingState(shop, legacy);
        source = "legacy";
      }
    }
  } catch (err) {
    unverified = unverified ?? (err instanceof Error ? err.message : String(err));
    console.warn(`[billing] reconcile failed shop=${shop}: ${unverified}`);
  }
  return { chosen, source, unverified, trialEndsAt, usageQuantity };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const planHandle = url.searchParams.get("plan_handle");
  const r = await reconcile(session.shop, (q) => admin.graphql(q), planHandle);
  // Opportunistic metering on the merchant's own visit (the timer is the primary trigger).
  const meter = await meterShop(session.shop).catch((err) => ({ error: err instanceof Error ? err.message : String(err), metered: 0, reportedUnits: 0, capped: false, cursor: null }));
  const billing = await readBillingState(session.shop);
  const access = resolveBillingAccess({ status: billing?.status, plan: billing?.plan, shop: session.shop, appHandle: APP_HANDLE });
  const plan = planFor(access.planId);
  // Dead-letter visibility (#19/#2835): a delivery the outbox moved to
  // "reconciliation" needs a human, not a silent auto-retry — surfaced here,
  // never hidden. See app/lib/meterOutbox.ts + docs/METER-OUTBOX.md.
  const stuckDeliveries = await listStuckDeliveries(session.shop).catch(() => []);
  return {
    plans: PLANS.map((p) => ({ id: p.id, name: p.name, blurb: describePlan(p), current: p.id === access.planId })),
    planId: access.planId,
    planName: plan.name,
    status: billing?.status ?? "inactive",
    tone: access.tone,
    mustSubscribe: access.mustSubscribe,
    planSelected: access.planSelected,
    reason: access.reason,
    pricingUrl: managedPricingUrl(session.shop, APP_HANDLE),
    chosen: r.chosen ? planFor(r.chosen).name : null,
    source: r.source,
    unverified: r.unverified,
    trialEndsAt: r.trialEndsAt,
    usage: {
      included: plan.includedResolutions,
      cycleResolutions: measuredCycleResolutions(billing?.lastMeteredCursor, meter.error),
      reportedUnits: r.usageQuantity,
      capped: meter.capped,
      meterError: meter.error ?? null,
    },
    stuckDeliveryCount: stuckDeliveries.length,
  };
};

/** "Refresh" — re-run the reconcile on demand (e.g. after cancelling in Manage apps). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const r = await reconcile(session.shop, (q) => admin.graphql(q), null);
  const billing = await readBillingState(session.shop);
  return { ok: !r.unverified, status: billing?.status ?? "inactive", plan: billing?.plan ?? "free", source: r.source, error: r.unverified ? merchantError("billing", session.shop, r.unverified) : null };
};

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const refresh = useFetcher<typeof action>();

  useEffect(() => {
    if (data.chosen) shopify.toast.show(`Plan selected: ${data.chosen}`);
  }, [data.chosen, shopify]);
  useEffect(() => {
    if (refresh.state === "idle" && refresh.data) {
      shopify.toast.show(refresh.data.ok ? "Plan status refreshed" : (refresh.data.error ?? "We couldn't confirm your plan with Shopify right now. Please try again."), { isError: !refresh.data.ok });
    }
  }, [refresh.state, refresh.data, shopify]);

  // Shopify's plan-selection page must be opened top-level (it is an admin page,
  // not embeddable in the app iframe).
  const openPricing = () => window.open(data.pricingUrl, "_top");
  const onFree = data.planId === "free";
  // No App Pricing contract on Shopify ⇒ the merchant has not selected a plan yet
  // (Shopify's Manage apps says "No plan selected"; the $0 Free plan is a real
  // contract once selected). Say exactly that — never "You're on the Free plan".
  const noPlan = !data.planSelected;

  return (
    <Page>
      <TitleBar title="Billing" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {data.stuckDeliveryCount > 0 ? (
              <Banner tone="critical" title="A billing delivery needs review">
                <p>
                  {data.stuckDeliveryCount === 1 ? "One usage report" : `${data.stuckDeliveryCount} usage reports`} could not be
                  reconciled automatically after your plan or billing state changed mid-delivery. It is not being retried
                  silently — contact support so we can resolve it by hand.
                </p>
              </Banner>
            ) : null}
            {data.tone === "warning" ? (
              <Banner tone="warning" title="Billing needs attention" action={{ content: "Resolve billing", onAction: openPricing }}>
                <p>{data.reason}. Your storefront assistant keeps working while you sort it out.</p>
              </Banner>
            ) : data.status === "pending" ? (
              <Banner tone="info" title={`Confirming your ${data.planName} plan with Shopify`}>
                <p>This usually takes a moment. Refresh if the plan does not update.</p>
              </Banner>
            ) : noPlan ? (
              <Banner tone="info" title="No plan selected yet" action={{ content: "Choose a plan", onAction: openPricing }}>
                <p>
                  Pick a plan on Shopify&apos;s secure pricing page — the Free plan is $0 and takes one click; paid plans
                  start with a 14-day free trial. Your selection then shows in your Shopify admin under Settings → Apps
                  and sales channels → Busymate AI → Billing. Until you choose, the assistant works at Free-plan limits (25
                  AI resolutions a month, then conversations route to your team).
                </p>
              </Banner>
            ) : onFree ? (
              <Banner tone="info" title="You're on the Free plan" action={{ content: "Choose a plan", onAction: openPricing }}>
                <p>
                  25 AI resolutions a month, then conversations route to your team. Pick a paid plan on Shopify&apos;s
                  secure pricing page any time — paid plans start with a 14-day free trial.
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <InlineGrid columns="1fr auto" alignItems="center">
                  <Text as="h2" variant="headingMd">
                    {noPlan ? "Your plan: none selected (Free-plan limits)" : `Your plan: ${data.planName}`}
                  </Text>
                  <Badge tone={data.status === "active" ? "success" : data.status === "frozen" ? "critical" : "info"}>
                    {data.status === "active" ? (data.trialEndsAt ? "Trial" : "Active") : noPlan ? "No plan selected" : data.status}
                  </Badge>
                </InlineGrid>
                <Text as="p" tone="subdued">
                  {describePlan(planFor(data.planId))}
                  {data.trialEndsAt ? (
                    <>
                      {" · trial ends "}
                      <LocalTime iso={data.trialEndsAt} dateOnly />
                    </>
                  ) : null}
                </Text>
                <Text as="p" tone="subdued">
                  {data.usage.cycleResolutions === null
                    ? `Usage shows here after the first hourly update. Your plan includes ${data.usage.included} resolutions per billing cycle`
                    : `This billing cycle: ${data.usage.cycleResolutions} of ${data.usage.included} included resolutions used`}
                  {data.usage.reportedUnits !== null ? ` · ${data.usage.reportedUnits} extra resolutions billed by Shopify` : ""}
                  {data.usage.capped ? " · monthly cap reached — no further overage this month" : ""}.
                </Text>
                <Text as="p" tone="subdued">
                  {RESOLUTION_DEFINITION}
                </Text>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={openPricing}>
                    {noPlan || onFree ? "Choose a plan" : "Manage plan"}
                  </Button>
                  <refresh.Form method="post">
                    <Button submit loading={refresh.state !== "idle"}>
                      Refresh status
                    </Button>
                  </refresh.Form>
                </InlineStack>
                <Text as="p" tone="subdued">
                  All charges are billed through Shopify App Pricing on your Shopify invoice. You can also change or
                  cancel from Settings → Apps and sales channels in your Shopify admin.
                </Text>
                {data.unverified ? (
                  <Text as="p" tone="caution">
                    Live plan status could not be verified with Shopify ({data.unverified}); showing the last known
                    state ({data.source}).
                  </Text>
                ) : null}
                {data.usage.meterError ? (
                  <Text as="p" tone="subdued">
                    Usage sync: {data.usage.meterError}.
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Plans
                </Text>
                <Text as="p" tone="subdued">
                  Every plan includes a monthly number of AI resolutions — conversations the assistant resolves without
                  your team. Paid plans charge per extra resolution up to that plan&apos;s monthly cap; after the cap,
                  no further overage is charged that month. The storefront assistant is never switched off.
                </Text>
                <BlockStack gap="200">
                  {data.plans.map((p) => (
                    <Box key={p.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200" background={p.current ? "bg-surface-secondary" : "bg-surface"}>
                      <InlineGrid columns="1fr auto" alignItems="center">
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingSm">
                            {p.name}
                          </Text>
                          <Text as="p" tone="subdued">
                            {p.blurb}
                          </Text>
                        </BlockStack>
                        {p.current ? <Badge tone="success">Current</Badge> : null}
                      </InlineGrid>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
