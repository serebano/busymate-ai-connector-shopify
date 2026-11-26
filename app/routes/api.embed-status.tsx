import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseEmbedStatus } from "../lib/themeEmbed";

/**
 * `POST /api/embed-status` — Home reports App Bridge's answer for the app embed
 * when it differs from the stored one, so the next Home render starts in its
 * final shape (F5, admin CLS). Embedded-admin session token required (App
 * Bridge adds it to the fetch); the shop comes from the session, never the body.
 * Fails closed: anything but `{"status":"on"|"off"}` is a 400, no write.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const { session } = await authenticate.admin(request);
  const status = parseEmbedStatus(await request.json().catch(() => null));
  if (!status) return Response.json({ ok: false, error: "status must be on or off" }, { status: 400 });
  await prisma.shopTenant.updateMany({
    where: { shop: session.shop },
    data: { embedConfirmedAt: status === "on" ? new Date() : null },
  });
  return Response.json({ ok: true });
};

