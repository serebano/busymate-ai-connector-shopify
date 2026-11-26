import { resolveCaller, type ConnectorCaller } from "./auth";
import { consumeJti, type ConsumeJti } from "./jtiStore";
import { adminForShop } from "./shopifyAdmin";
import { TOOLS, toolByName, publicToolNames } from "./tools/registry";
import { errorResult, type ToolContext } from "./tools/types";

const APP_URL = process.env.SHOPIFY_APP_URL || "https://store.busymate.ai";
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}
function rpcError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Public MCP tool descriptors (schema only — no handlers). */
function toolDescriptors() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      tier: t.tier,
      confirm: t.confirm,
      adminOnly: t.adminOnly,
      readOnlyHint: t.tier === "public" || t.tier === "identified",
    },
  }));
}

/** Injectable seams (tests run the real gates with no DB, no Shopify, no env). */
export interface McpRouteDeps {
  resolveCaller: (request: Request) => Promise<ConnectorCaller | null>;
  consumeJti: ConsumeJti;
  adminForShop: typeof adminForShop;
}

const DEFAULT_DEPS: McpRouteDeps = {
  resolveCaller: (request) => resolveCaller(request),
  consumeJti,
  adminForShop,
};

/**
 * Handle the connector transport: OAuth 2.1 discovery (GET) + JSON-RPC (POST).
 * DISCOVERY (initialize/tools/list/ping) is pre-auth; tools/call is gated.
 */
export async function handleMcpRequest(request: Request, deps: McpRouteDeps = DEFAULT_DEPS): Promise<Response> {
  const url = new URL(request.url);

  // ── OAuth 2.1 discovery (DCR + PKCE + resource indicator + iss) ────────────
  if (request.method === "GET") {
    if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: `${APP_URL}/mcp`,
        authorization_servers: [APP_URL],
      });
    }
    if (url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
      // TODO(P2/P3): full AS metadata (DCR /register, PKCE S256 /authorize,
      // /token, iss). Mirrors the bmai MCP-delegation surface.
      return Response.json({
        issuer: APP_URL,
        authorization_endpoint: `${APP_URL}/oauth/authorize`,
        token_endpoint: `${APP_URL}/oauth/token`,
        registration_endpoint: `${APP_URL}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    return new Response("bmai Shopify Admin connector", { status: 200 });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }

  // Pre-auth discovery.
  switch (body.method) {
    case "initialize":
      return rpcResult(body.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bmai-shopify-admin", version: "0.1.0" },
      });
    case "ping":
      return rpcResult(body.id, {});
    case "tools/list":
      return rpcResult(body.id, {
        tools: toolDescriptors(),
        _meta: { publicTools: publicToolNames() },
      });
    case "tools/call":
      break; // gated below
    default:
      return rpcError(body.id, -32601, `method not found: ${body.method}`);
  }

  // ── tools/call — gated ─────────────────────────────────────────────────────
  const caller = await deps.resolveCaller(request);
  if (!caller) return rpcError(body.id, -32001, "unauthorized (fail-closed: no verified shop binding)");

  const name = String(body.params?.name ?? "");
  const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
  // ECO-03 — a v3 credential authorizes ONE tool (its signed `tool` claim). A credential the
  // customer confirmed for tool A never runs tool B. Refused before any lookup or side effect.
  if (caller.signedTool !== undefined && caller.signedTool !== name) {
    return rpcError(body.id, -32001, "unauthorized (fail-closed: credential was signed for a different tool)");
  }
  const tool = toolByName(name);
  if (!tool) return rpcError(body.id, -32602, `unknown tool: ${name}`);

  // Tier + confirm gates (defense-in-depth; Busymate AI's connector gate is the primary).
  if (tool.tier !== "public" && !caller.customerId) {
    return rpcResult(body.id, errorResult("Please sign in to the store so I can help with your own orders."));
  }
  if (tool.confirm && !caller.confirmed) {
    return rpcResult(body.id, {
      content: [{ type: "text", text: `Confirmation required before running ${name}.` }],
      structuredContent: { requiresConfirm: true, tool: name, arguments: args },
    });
  }

  // ECO-03 — burn the credential's single-use id(s) BEFORE any side effect, in the app's own
  // Postgres (holds across replicas). v3 ids always (one token = one call); a v2 id only for a
  // confirmed write (see `ConnectorCaller.singleUse`). Replay or store failure ⇒ refused.
  for (const use of caller.singleUse ?? []) {
    if (use.version === 2 && !tool.confirm) continue;
    if (!(await deps.consumeJti(use.key, use.exp).catch(() => false))) {
      return rpcError(body.id, -32001, "unauthorized (fail-closed: credential already used)");
    }
  }

  let admin;
  try {
    admin = await deps.adminForShop(caller.shop);
  } catch (err) {
    return rpcResult(body.id, errorResult(err instanceof Error ? err.message : "admin client error"));
  }

  const ctx: ToolContext = {
    shop: caller.shop,
    customerId: caller.customerId,
    confirmed: caller.confirmed,
    admin,
  };
  try {
    const result = await tool.handler(args, ctx);
    return rpcResult(body.id, result);
  } catch (err) {
    return rpcResult(body.id, errorResult(err instanceof Error ? err.message : "tool error"));
  }
}
