import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as PolarisAppProvider, Box, InlineStack, Link as PLink, Text } from "@shopify/polaris";
import enPolarisTranslations from "@shopify/polaris/locales/en.json";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { PolarisLink } from "../components/PolarisLink";
import { AppRouteErrorView } from "../components/AppRouteError";
import { EmbeddedNavigationContext } from "../components/EmbeddedNavigation";
import { AdminLoadingBar } from "../components/AdminLoadingBar";
import { AppBridgeNavigation } from "../components/AppBridgeNavigation";
import { describeTransportError } from "../lib/clientAction";
import { embeddedAppUrl, embeddedNavigationForShop } from "../lib/embeddedNavigation";
import { isRouteControlFlow, reloadEmbeddedFrame } from "../lib/layoutError";
import { adminDocumentTitle, adminPageTitle } from "../lib/adminPageTitle";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { navigation: embeddedNavigationForShop(session.shop) };
};

// Accessibility (WCAG 2.4.2, axe document-title): the embedded document names
// the page. No child route exports `meta`, so this one answers for all of them.
export const meta: MetaFunction = ({ location }) => [{ title: adminDocumentTitle(location.pathname) }];

export default function App() {
  const { navigation } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  // App Bridge itself loads ONCE, first in <head> (root.tsx); no AppProvider
  // here — it would load app-bridge.js a second time plus the unused
  // polaris.js web-components bundle (red-team F5).
  return (
    <>
      <AppBridgeNavigation />
      <EmbeddedNavigationContext.Provider value={navigation}>
      {/* linkComponent: Polaris <Link url>/<Button url> must stay client-side inside the
          admin iframe (app/components/PolarisLink.tsx) — a raw anchor reloads a bare URL
          the embedded auth cannot serve. */}
      <PolarisAppProvider i18n={enPolarisTranslations} linkComponent={PolarisLink}>
        <NavMenu>
          <Link to={embeddedAppUrl("/app", navigation)} rel="home">
            Home
          </Link>
          <Link to={embeddedAppUrl("/app/conversations", navigation)}>Conversations</Link>
          <Link to={embeddedAppUrl("/app/settings", navigation)}>Assistant settings</Link>
          <Link to={embeddedAppUrl("/app/connector", navigation)}>Store connection</Link>
          <Link to={embeddedAppUrl("/app/billing", navigation)}>Billing</Link>
        </NavMenu>
        <AdminLoadingBar />
        {/* The ONE main landmark and the page's level-one heading (axe
            landmark-one-main, region, page-has-heading-one). The visible title is
            the TitleBar in Shopify's chrome, outside this document, so the h1 is
            visually hidden: same words, no second title on screen. */}
        <main>
          <Text as="h1" visuallyHidden>{adminPageTitle(pathname)}</Text>
          <Outlet />
        </main>
        {/* F4 (red-team 2026-11-26): a support path on every admin page. */}
        <footer>
          <Box padding="400">
            <InlineStack align="center" gap="300">
              <Text as="span" tone="subdued">Help &amp; support:</Text>
              <PLink url="mailto:hi@busymate.ai" external>hi@busymate.ai</PLink>
              <PLink url="https://store.busymate.ai/legal/faq" external>FAQ</PLink>
            </InlineStack>
          </Box>
        </footer>
      </PolarisAppProvider>
      </EmbeddedNavigationContext.Provider>
    </>
  );
}

// Shopify needs Response headers on thrown boundaries to keep the app embedded.
//
// #idle-500 (app issue #29, Shopify review 2026-09-11 Req 2.1.1): the SDK's
// `boundary.error` renders ONLY thrown Responses (the session-token bounce) and
// re-throws everything else — so a transient failure of THIS layout's loader
// revalidation (an aborted single-fetch, a dropped connection, an undecodable
// body — all observed live as `AbortError` on `GET /app.data` right after a
// fetcher action) escaped to the root boundary and replaced the whole embedded
// document with the branded "500 Something went wrong" page. Non-control-flow
// errors now recover IN-FRAME: the merchant sees a banner with "Try again", which
// reloads the frame — a plain document reload re-enters the SDK's session-token
// bounce, so no stale token is ever reused. Child routes already do the same via
// `AppRouteBoundary`; this closes the layout-level gap.
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteControlFlow(error)) return boundary.error(error);
  return (
    <PolarisAppProvider i18n={enPolarisTranslations}>
      <main>
        <Text as="h1" visuallyHidden>Something went wrong</Text>
        <AppRouteErrorView message={describeTransportError(error)} onRetry={reloadEmbeddedFrame} />
      </main>
    </PolarisAppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
