import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import "../app/lib/requestLogRedaction.server";

const require = createRequire(import.meta.url);
const morgan = require("morgan") as ((format: string, options: { stream: { write(line: string): void } }) => (req: unknown, res: unknown, next: () => void) => void) & {
  compile(format: string): (tokens: unknown, req: unknown, res: unknown) => string;
};

describe("runtime request access logging", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server?.listening) return;
    server.close();
    await once(server, "close");
    server = undefined;
  });

  it("redacts credential query values and keeps control characters from creating extra log records", async () => {
    let output = "";
    const logger = morgan("tiny", { stream: { write: (line) => { output += line; } } });
    server = createServer((req, res) => {
      logger(req, res, () => {
        res.statusCode = 204;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a local TCP listener");
    const response = await fetch(`http://127.0.0.1:${address.port}/app?id_token=FAKE_JWT_ONLY&hmac=FAKE_HMAC_ONLY&shop=test.myshopify.com&note=%0D%0Asecond-line`);
    expect(response.status).toBe(204);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output).toContain("/app?id_token=REDACTED&hmac=REDACTED&shop=test.myshopify.com&note=%0D%0Asecond-line");
    expect(output).not.toContain("FAKE_JWT_ONLY");
    expect(output).not.toContain("FAKE_HMAC_ONLY");
    expect(output).toBe(`${output.trimEnd()}\n`);
    expect(output.trimEnd().split("\n")).toHaveLength(1);
  });

  it("escapes raw line separators in URL token values", () => {
    const line = morgan.compile(":url")(morgan, { originalUrl: "/app?value=first\r\nsecond\u0085third\u2028fourth\u2029last" }, {});
    expect(line).toBe("/app?value=first\\r\\nsecond\\u0085third\\u2028fourth\\u2029last");
    expect(line).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
  });
});
