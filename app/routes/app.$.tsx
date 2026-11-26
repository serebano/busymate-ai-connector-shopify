import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { BlockStack, Box, Button, Card, Layout, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { AppRouteBoundary } from "../components/AppRouteError";
import { NOT_FOUND_TITLE } from "../lib/adminPageTitle";

/**
 * An unknown path under /app (an old bookmark, a typo) stays INSIDE the app: the
 * nav and the title bar remain, and the one action goes back to Home. Without
 * this route the root error page replaced the embedded document and its only
 * link left the admin for the marketing site (inventory F10).
 */
export const ErrorBoundary = AppRouteBoundary;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return data(null, { status: 404 });
};

export default function AppNotFound() {
  return (
    <Page>
      <TitleBar title={NOT_FOUND_TITLE} />
      <Layout>
        <Layout.Section>
          <Card>
            <Box paddingBlock="600" paddingInline="400">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="h2" variant="headingMd" alignment="center">
                  This page does not exist
                </Text>
                <Text as="p" tone="subdued" alignment="center">
                  The link may be out of date. Your assistant and your store are not affected.
                </Text>
                <Button url="/app" variant="primary">Back to Home</Button>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
