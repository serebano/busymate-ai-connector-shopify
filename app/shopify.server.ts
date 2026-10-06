import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { onAfterAuth, onAppUninstalled } from "./bmai.server";
import { observeAdminAuthentication } from "./lib/routeDiagnostics";
import { encryptedSessionStorage } from "./lib/encryptedSessionStorage";

// The pinned Admin API version (2026-07). Overridable by env for a dated dry-run;
// the runtime uses the string verbatim in the request URL.
const API_VERSION = (process.env.SHOPIFY_API_VERSION || ApiVersion.July26) as ApiVersion;

// Managed installation + token exchange (the v2 default). EXPIRING offline access
// tokens (#2110): each token lives ~1h and the library refreshes it — on the
// embedded path inside authenticate.admin, on every background path inside
// unauthenticated.admin(shop) (app/mcp/shopifyAdmin.ts) — using the refresh token
// persisted next to it. Both are encrypted at rest by the session-storage decorator.
// Shopify rejects non-expiring tokens for public apps created after 2026-04-01
// ("[API] Non-expiring access tokens are no longer accepted"); pre-upgrade
// sessions are cycled once with scripts/cycle-offline-tokens.ts (SETUP.md).
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // Session storage wrapped with app-level field encryption at rest (accessToken +
  // refreshToken + staff email). See app/lib/encryptedSessionStorage.ts + fieldCipher.ts.
  sessionStorage: encryptedSessionStorage(new PrismaSessionStorage(prisma)),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // afterAuth = the install/re-auth convergence point. Runs the bmai MCP
    // provision lifecycle only when the tenant is not already live (#3718: an
    // expiring offline token re-exchanges every ~1 h, and each re-run used to
    // publish a new revision). See bmai.server.ts::onAfterAuth.
    //
    // afterAuth MUST NOT throw: it runs AFTER the session is persisted, inside the
    // Shopify token-exchange strategy, which converts ANY afterAuth throw into a
    // bare `500 Internal Server Error` on the embedded app's first load — the App
    // Store review failure (Req 2.1.1 "no critical errors" / 2.1.3 "an interactive
    // UI, not a web 500"). onAppInstalled never throws: provisioning errors are
    // recorded + surfaced in the app UI.
    //
    // Webhook subscriptions are declared in shopify.app.toml (app-specific
    // subscriptions, managed by `shopify app deploy`) — there is deliberately no
    // per-install registerWebhooks call here (it was redundant and only logged a
    // 403 per install).
    afterAuth: async ({ session }) => {
      await onAfterAuth(session);
    },
  },
});

export default shopify;
export const apiVersion = API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = { ...shopify.authenticate, admin: observeAdminAuthentication(shopify.authenticate.admin) };
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;

// Re-export so webhook routes can reach the teardown seam without a cycle.
export { onAppUninstalled };
