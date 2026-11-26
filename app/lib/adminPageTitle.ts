/**
 * The page name of every embedded admin route — ONE table for the document
 * `<title>` (WCAG 2.4.2) and the page's level-one heading (WCAG 1.3.1 / 2.4.6).
 *
 * The visible title lives in Shopify's admin chrome (App Bridge `TitleBar`), not
 * in the embedded document, so without this the frame had an empty `<title>` and
 * no `h1` (axe: document-title, page-has-heading-one). `app/routes/app.tsx`
 * reads it for its `meta` and for the visually hidden `h1` it renders above the
 * routed page; `test/adminPageTitle.test.ts` keeps it equal to each route's
 * `TitleBar` title.
 */
export const APP_NAME = "Busymate AI";
export const NOT_FOUND_TITLE = "Page not found";

const TITLES: readonly (readonly [RegExp, string])[] = [
  [/^\/app\/?$/, APP_NAME],
  [/^\/app\/conversations\/?$/, "Conversations"],
  [/^\/app\/(?:conversations\/)?transcripts\/[^/]+\/?$/, "Conversation history"],
  [/^\/app\/(?:conversations\/)?handoffs\/[^/]+\/?$/, "Customer conversation"],
  [/^\/app\/settings\/?$/, "Assistant settings"],
  [/^\/app\/connector\/?$/, "Store connection"],
  [/^\/app\/billing\/?$/, "Billing"],
];

/** The page's own name: what the TitleBar shows and the `h1` says. */
export function adminPageTitle(pathname: string): string {
  return TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? NOT_FOUND_TITLE;
}

/** The document title: "<page> · Busymate AI" (Home is the app name alone). */
export function adminDocumentTitle(pathname: string): string {
  const page = adminPageTitle(pathname);
  return page === APP_NAME ? APP_NAME : `${page} · ${APP_NAME}`;
}
