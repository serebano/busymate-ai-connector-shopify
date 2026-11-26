import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { describeRouteError } from "./lib/routeError";
import { embeddedHomeFromSearch } from "./lib/embeddedNavigation";

// Expose the Shopify API key so App Bridge can initialize from the document head.
export const loader = () => ({ apiKey: process.env.SHOPIFY_API_KEY || "" });

/**
 * The document shell, shared by the app and the ErrorBoundary (React Router
 * renders both inside Layout). Reads the root loader data defensively: when the
 * loader itself failed there is none, and the error page must still render.
 */
export function Layout({ children }: { children: ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const apiKey = data?.apiKey ?? "";
  return (
    <html lang="en">
      <head>
        {/*
          App Bridge (v4) MUST be the FIRST script in <head> for embedded apps —
          @shopify/app-bridge-react hooks are a thin layer over this global, and
          Built-for-Shopify checks that it loads from the Shopify CDN before any
          other script. data-api-key initializes it.
        */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Branded, theme-aware error page (404 / 500 / anything thrown). Replaces React
// Router's default boundary, which printed "Unhandled Thrown Response … Hey
// developer" with a stack on the public host (#2110). Self-contained styles —
// the error path must not depend on any other asset loading.
const errorStyles = `
  :root { --bm-bg:#ffffff; --bm-fg:#0a0a0a; --bm-muted:#6b6b6b; --bm-accent:#0b7a4b; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bm-bg:#0a0a0a; --bm-fg:#fafafa; --bm-muted:#a3a3a3; --bm-accent:#3ecf8e; } }
  body { margin:0; background:var(--bm-bg); color:var(--bm-fg); font-family: Inter, system-ui, -apple-system, sans-serif; }
  .bm-error { min-height:100dvh; display:grid; place-items:center; padding:1.5rem; box-sizing:border-box; text-align:center; }
  .bm-error h1 { font-size:1.5rem; font-weight:600; margin:0 0 .5rem; }
  .bm-error p { color:var(--bm-muted); max-width:34rem; margin:0 auto 1.25rem; line-height:1.5; }
  .bm-error .code { font-variant-numeric: tabular-nums; color:var(--bm-muted); font-size:.875rem; margin-bottom:.75rem; }
  .bm-error a { color:var(--bm-accent); text-decoration:underline; text-underline-offset:.15em; font-weight:500; }
`;

export function ErrorBoundary() {
  const view = describeRouteError(useRouteError());
  // Inside the embedded admin (/app/…) the way out is the app's own Home, never
  // the marketing site (inventory F10); the public host keeps the site link.
  const { pathname, search } = useLocation();
  const inApp = /^\/app(?:\/|$)/.test(pathname);
  const home = inApp ? embeddedHomeFromSearch(search) : null;
  return (
    <>
      <title>{`${view.title} — Busymate AI`}</title>
      <style dangerouslySetInnerHTML={{ __html: errorStyles }} />
      <main className="bm-error">
        <div>
          <div className="code">{view.status}</div>
          <h1>{view.title}</h1>
          <p>{view.message}</p>
          {home ? <a href={home}>Back to Home</a> : inApp ? null : <a href="https://busymate.ai">busymate.ai</a>}
        </div>
      </main>
    </>
  );
}
