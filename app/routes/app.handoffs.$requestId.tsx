import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { Badge, Banner, BlockStack, Button, Card, InlineStack, Link, Page, Text, TextField } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { callMcpTool } from "../bmai.server";
import { loadMerchantHandoff, actOnMerchantHandoff } from "../lib/merchantHandoff.server";
import { failClosedClientAction } from "../lib/clientAction";
import { AppRouteBoundary } from "../components/AppRouteError";
import { LocalTime } from "../components/LocalTime";
import { ConversationHistory } from "../components/ConversationHistory";

export const ErrorBoundary = AppRouteBoundary;
export const clientAction = failClosedClientAction;

const deps = {
  call: callMcpTool,
  tenantForShop: async (shop: string) => (await prisma.shopTenant.findUnique({ where: { shop }, select: { bmaiTenantId: true } }))?.bmaiTenantId ?? null,
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return loadMerchantHandoff(session.shop, params.requestId ?? "", deps);
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    return await actOnMerchantHandoff(session.shop, params.requestId ?? "", await request.formData(), deps);
  } catch {
    return { ok: false as const, intent: "", error: "The request could not be read. Refresh the conversation and try again." };
  }
};

export default function HandoffPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [message, setMessage] = useState("");
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.intent === "reply") setMessage("");
  }, [fetcher.data]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !busy && revalidator.state === "idle") void revalidator.revalidate();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [busy, revalidator]);

  const handoff = data.ok ? data.handoff : null;
  return (
    <Page>
      <TitleBar title="Customer conversation" />
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <Link url="/app/conversations">Back to Conversations</Link>
          <Button onClick={() => revalidator.revalidate()} loading={revalidator.state !== "idle"} disabled={busy}>Refresh</Button>
        </InlineStack>
        {!data.ok ? <Banner tone="critical" title="Conversation unavailable"><p>{data.error}</p></Banner> : null}
        {fetcher.data ? fetcher.data.ok
          ? <Banner tone="success"><p>{fetcher.data.message}</p></Banner>
          : <Banner tone="critical" title="Action not confirmed"><p>{fetcher.data.error}</p></Banner> : null}
        {handoff ? <>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between"><Text as="h1" variant="headingLg">{handoff.title}</Text><Badge>{handoff.status}</Badge></InlineStack>
              {handoff.summary ? <Text as="p">{handoff.summary}</Text> : null}
              <Text as="p" tone="subdued">Requested <LocalTime iso={handoff.requestedAt} /></Text>
              {handoff.status === "requested" || handoff.status === "acknowledged" ? <>
                <Text as="p">Claim this conversation to pause the assistant and answer the customer here.</Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="claim" /><input type="hidden" name="confirm" value="yes" />
                  <Button submit variant="primary" loading={busy}>Claim and pause assistant</Button>
                </fetcher.Form>
              </> : null}
              {handoff.status === "active" ? <Text as="p">Your team is handling this conversation. The assistant stays paused until you resolve it.</Text> : null}
              {handoff.status === "resolved" || handoff.status === "dismissed" ? <Text as="p">This request is closed. The history remains available below.</Text> : null}
            </BlockStack>
          </Card>
          {handoff.historyWarning ? <Banner tone="warning"><p>{handoff.historyWarning}</p></Banner> : null}
          <ConversationHistory messages={handoff.messages} />
          {handoff.status === "active" ? <Card><BlockStack gap="400">
            <fetcher.Form method="post">
              <BlockStack gap="300">
                <input type="hidden" name="intent" value="reply" /><input type="hidden" name="confirm" value="yes" />
                <TextField label="Reply to customer" name="message" value={message} onChange={setMessage} multiline={4} maxLength={4000} autoComplete="off" helpText="Your reply is sent to this customer's conversation." />
                <Button submit variant="primary" loading={busy} disabled={!message.trim()}>Send reply</Button>
              </BlockStack>
            </fetcher.Form>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="resolve" /><input type="hidden" name="confirm" value="yes" />
              <BlockStack gap="200"><Text as="p" tone="subdued">When the customer is helped, resolve the request so the assistant can answer their next message.</Text><Button submit disabled={busy}>Resolve and resume assistant</Button></BlockStack>
            </fetcher.Form>
          </BlockStack></Card> : null}
        </> : null}
      </BlockStack>
    </Page>
  );
}
