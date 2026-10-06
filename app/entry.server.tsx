// #3718 P1 — redact credentials (id_token / hmac / session / code …) from the
// host's access log before the first request is served.
import "./lib/requestLogRedaction.server";
import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import type { EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { reportRouteFailure } from "./lib/routeDiagnostics";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  // Embedded-app frame headers (Content-Security-Policy frame-ancestors) so the
  // admin renders inside Shopify. Required for Built-for-Shopify.
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          reportRouteFailure("route_failed", request, error);
        },
      },
    );
    setTimeout(abort, streamTimeout + 1000);
  });
}

/** Router loader/action failures; preserve default response handling. */
export function handleError(error: unknown, { request }: { request: Request }) {
  reportRouteFailure("route_failed", request, error);
}
