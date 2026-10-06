import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The Shopify CLI (`shopify app dev`) fronts this with a tunnel; HMR runs over
// the tunnel host. See https://shopify.dev/docs/api/shopify-app-react-router
const host = new URL(process.env.SHOPIFY_APP_URL || "https://localhost").hostname;
const buildRevision = process.env.BMAI_APP_BUILD_REVISION || null;
if (buildRevision !== null && !/^[0-9a-f]{40}$/.test(buildRevision)) {
  throw new Error("BMAI_APP_BUILD_REVISION must be a full commit SHA");
}
const hmrConfig =
  host === "localhost"
    ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 }
    : { protocol: "wss", host, port: Number(process.env.FRONTEND_PORT) || 8002, clientPort: 443 };

export default defineConfig({
  define: {
    "process.env.BMAI_APP_BUILD_REVISION": JSON.stringify(buildRevision),
  },
  // Shopify's boundary.error checks React Router ErrorResponse constructor names.
  // Preserve them through client minification or token-recovery HTML turns into
  // a root error during hydration (SSR itself succeeds).
  esbuild: { keepNames: true },
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT) || 3000,
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
});
