import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { Banner, BlockStack, Button, InlineStack, Link, Page } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { callMcpTool } from "../bmai.server";
import { loadMerchantConversation } from "../lib/merchantHandoff.server";
import { AppRouteBoundary } from "../components/AppRouteError";
import { ConversationHistory } from "../components/ConversationHistory";

export const ErrorBoundary = AppRouteBoundary;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return loadMerchantConversation(session.shop, params.sessionId ?? "", {
    call: callMcpTool,
    tenantForShop: async (shop) => (await prisma.shopTenant.findUnique({ where: { shop }, select: { bmaiTenantId: true } }))?.bmaiTenantId ?? null,
  });
};

export default function TranscriptPage() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return <Page><TitleBar title="Conversation history" /><BlockStack gap="400">
    <InlineStack align="space-between"><Link url="/app/conversations">Back to Conversations</Link><Button onClick={() => revalidator.revalidate()} loading={revalidator.state !== "idle"}>Refresh</Button></InlineStack>
    {!data.ok ? <Banner tone="critical" title="Conversation unavailable"><p>{data.error}</p></Banner> : <>
      {data.truncated ? <Banner tone="warning"><p>Some earlier messages are unavailable. The available conversation history appears below.</p></Banner> : null}
      <ConversationHistory messages={data.messages} />
    </>}
  </BlockStack></Page>;
}
