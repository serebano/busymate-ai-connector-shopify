import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enPolarisTranslations from "@shopify/polaris/locales/en.json";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { PolarisLink } from "../components/PolarisLink";
import { AppRouteErrorView } from "../components/AppRouteError";
import { EmbeddedNavigationContext } from "../components/EmbeddedNavigation";
import { AdminLoadingBar } from "../components/AdminLoadingBar";
import { describeTransportError } from "../lib/clientAction";
import { embeddedAppUrl, embeddedNavigationForShop } from "../lib/embeddedNavigation";
import { isRouteControlFlow, reloadEmbeddedFrame } from "../lib/layoutError";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "", navigation: embeddedNavigationForShop(session.shop) };
};

export default function App() {
  const { apiKey, navigation } = useLoaderData<typeof loader>();
  return (
    <AppProvider apiKey={apiKey}>
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
        <Outlet />
      </PolarisAppProvider>
      </EmbeddedNavigationContext.Provider>
    </AppProvider>
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
      <AppRouteErrorView message={describeTransportError(error)} onRetry={reloadEmbeddedFrame} />
    </PolarisAppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
