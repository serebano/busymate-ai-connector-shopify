import type { ReactNode } from "react";
import { BlockStack, Box, Text } from "@shopify/polaris";

/**
 * The one empty state used inside a card of the embedded admin: a short heading
 * that says what is missing and one subdued sentence that says what will appear
 * and how. No illustration (nothing to download, nothing to shift the layout).
 */
export function EmptyCardState({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Box paddingBlock="600" paddingInline="400">
      <BlockStack gap="100" inlineAlign="center">
        <Text as="h3" variant="headingSm" alignment="center">
          {heading}
        </Text>
        <Box maxWidth="32rem">
          <Text as="p" tone="subdued" alignment="center">
            {children}
          </Text>
        </Box>
      </BlockStack>
    </Box>
  );
}
