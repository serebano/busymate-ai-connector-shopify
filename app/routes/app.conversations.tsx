import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  Layout,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { listTenantConversations, listTenantInterventionsAll } from "../lib/tenantRead.server";
import { LocalTime } from "../components/LocalTime";
import { AppRouteBoundary } from "../components/AppRouteError";

// Embedded-frame contract (#retrain-500): a route error recovers in-frame, never
// the root 500 page.
export const ErrorBoundary = AppRouteBoundary;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const tenant = await prisma.shopTenant.findUnique({ where: { shop: session.shop }, select: { bmaiTenantId: true, slug: true } });
  const [conversations, handoffs] = await Promise.all([
    listTenantConversations(tenant?.bmaiTenantId, 25),
    listTenantInterventionsAll(tenant?.bmaiTenantId),
  ]);
  return {
    provisioned: Boolean(tenant?.bmaiTenantId),
    conversations,
    handoffs,
    servingHost: tenant?.slug ? `https://${tenant.slug}.busymate.ai` : null,
  };
};

export default function ConversationsPage() {
  const data = useLoaderData<typeof loader>();
  const convs = data.conversations.rows;
  const open = data.handoffs.rows.filter((handoff) => ["requested", "acknowledged", "active"].includes(handoff.status));
  const closed = data.handoffs.rows.filter((handoff) => ["resolved", "dismissed"].includes(handoff.status));
  return (
    <Page>
      <TitleBar title="Conversations" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!data.provisioned ? (
              <Banner tone="warning" title="Your assistant is still being set up">
                <p>Conversations appear here once provisioning completes (see Home).</p>
              </Banner>
            ) : null}
            {data.handoffs.error ? (
              <Banner tone="critical" title="Could not load handoffs">
                <p>{data.handoffs.error}</p>
              </Banner>
            ) : null}
            {data.conversations.error ? (
              <Banner tone="critical" title="Could not load conversations">
                <p>{data.conversations.error}</p>
              </Banner>
            ) : null}

            <Card padding="0">
              <BlockStack gap="0">
                <div style={{ padding: "var(--p-space-400)" }}>
                  <InlineGrid columns="1fr auto" alignItems="center">
                    <Text as="h2" variant="headingMd">
                      Open human handoffs
                    </Text>
                    <Badge tone={open.length ? "attention" : "success"}>{`${open.length} open`}</Badge>
                  </InlineGrid>
                </div>
                {open.length === 0 ? (
                  <div style={{ padding: "0 var(--p-space-400) var(--p-space-400)" }}>
                    <Text as="p" tone="subdued">
                      No shopper is waiting for a human right now. When the assistant is not confident it offers a
                      handoff; open a request here to read the conversation, claim it, and reply to the customer.
                    </Text>
                  </div>
                ) : (
                  <IndexTable
                    resourceName={{ singular: "handoff", plural: "handoffs" }}
                    itemCount={open.length}
                    selectable={false}
                    headings={[{ title: "Requested" }, { title: "Status" }, { title: "Reason" }, { title: "Conversation" }]}
                  >
                    {open.map((h, i) => (
                      <IndexTable.Row id={h.id} key={h.id} position={i}>
                        <IndexTable.Cell><LocalTime iso={h.requestedAt} /></IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone="attention">{h.status}</Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>{h.reason ?? "—"}</IndexTable.Cell>
                        <IndexTable.Cell>
                          <Link url={`/app/handoffs/${encodeURIComponent(h.id)}`}>Open conversation</Link>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>

            {closed.length ? <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Recent completed handoffs</Text>
                <Text as="p" tone="subdued">Read the customer and team messages after a request is closed.</Text>
                {closed.map((handoff) => <InlineGrid columns="1fr auto" key={handoff.id}>
                  <BlockStack gap="100">
                    <Link url={`/app/handoffs/${encodeURIComponent(handoff.id)}`}>{handoff.reason ?? "Customer conversation"}</Link>
                    <Text as="p" tone="subdued"><LocalTime iso={handoff.requestedAt} /></Text>
                  </BlockStack>
                  <Badge>{handoff.status}</Badge>
                </InlineGrid>)}
              </BlockStack>
            </Card> : null}

            <Card padding="0">
              <BlockStack gap="0">
                <div style={{ padding: "var(--p-space-400)" }}>
                  <InlineGrid columns="1fr auto" alignItems="center">
                    <Text as="h2" variant="headingMd">
                      Recent conversations
                    </Text>
                    <Text as="p" tone="subdued">Read customer conversations here in Shopify.</Text>
                  </InlineGrid>
                </div>
                {convs.length === 0 ? (
                  <EmptyState heading="No conversations yet" image="">
                    <p>
                      Once the storefront assistant is on, every shopper conversation is listed here with its start and
                      last-activity time.
                    </p>
                  </EmptyState>
                ) : (
                  <IndexTable
                    resourceName={{ singular: "conversation", plural: "conversations" }}
                    itemCount={convs.length}
                    selectable={false}
                    headings={[{ title: "Started" }, { title: "Last activity" }, { title: "Status" }, { title: "Conversation" }]}
                  >
                    {convs.map((c, i) => (
                      <IndexTable.Row id={c.sessionId} key={c.sessionId} position={i}>
                        <IndexTable.Cell><LocalTime iso={c.startedAt} /></IndexTable.Cell>
                        <IndexTable.Cell><LocalTime iso={c.lastActiveAt} /></IndexTable.Cell>
                        <IndexTable.Cell>{c.live ? <Badge tone="success">Live</Badge> : <Badge>Ended</Badge>}</IndexTable.Cell>
                        <IndexTable.Cell>
                          <Link url={`/app/transcripts/${encodeURIComponent(c.sessionId)}`}>Read assistant chat</Link>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                What is collected
              </Text>
              <Text as="p" tone="subdued">
                Shopper messages and the assistant&apos;s replies, the signed-in shopper&apos;s Shopify customer id (for
                their own orders only), and any handoff request. Order data is read live from Shopify and not stored by
                the app. Shoppers can ask you to export or erase their data; Shopify&apos;s privacy webhooks carry that
                out automatically.
              </Text>
              {data.servingHost ? (
                <Link url={data.servingHost} target="_blank">
                  Open your assistant
                </Link>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
