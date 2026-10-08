import { BlockStack, Card, InlineStack, Text } from "@shopify/polaris";
import { LocalTime } from "./LocalTime";
import type { HandoffMessage } from "../lib/merchantHandoff.server";

export function ConversationHistory({ messages }: { messages: readonly HandoffMessage[] }) {
  return <Card><BlockStack gap="400">
    <Text as="h2" variant="headingMd">Conversation history</Text>
    {messages.length === 0 ? <Text as="p" tone="subdued">No messages are available yet. Refresh to check for new messages.</Text> : messages.map((row) => (
      <BlockStack gap="100" key={row.id}>
        <InlineStack gap="200"><Text as="h3" fontWeight="semibold">{row.author}</Text><Text as="p" tone="subdued"><LocalTime iso={row.at} /></Text></InlineStack>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.body}</div>
      </BlockStack>
    ))}
  </BlockStack></Card>;
}
