import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { Banner, BlockStack, Page } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { callMcpTool } from "../bmai.server";
import { loadMerchantConversation } from "../lib/merchantHandoff.server";
import { AppRouteBoundary } from "../components/AppRouteError";
import { ConversationHistory } from "../components/ConversationHistory";
import { ConversationTitleBar } from "../components/ConversationTitleBar";

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
  return (
    <Page>
      <ConversationTitleBar title="Conversation history" onRefresh={() => void revalidator.revalidate()} refreshing={revalidator.state !== "idle"} />
      <BlockStack gap="400">
        {!data.ok ? (
          <Banner tone="critical" title="Conversation unavailable">
            <p>{data.error}</p>
          </Banner>
        ) : (
          <>
            {data.truncated ? (
              <Banner tone="warning">
                <p>Some earlier messages are unavailable. The available conversation history appears below.</p>
              </Banner>
            ) : null}
            <ConversationHistory messages={data.messages} />
          </>
        )}
      </BlockStack>
    </Page>
  );
}
