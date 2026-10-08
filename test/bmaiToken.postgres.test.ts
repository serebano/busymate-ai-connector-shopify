import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SHOPIFY_TOKEN_TEST_DATABASE_URL;
// Dedicated ephemeral Postgres in CI/local integration run; no production URL fallback.
describe.skipIf(!databaseUrl)("management OAuth across actual worker processes and Postgres", () => {
  const schema = `oauth_test_${randomUUID().replaceAll("-", "")}`;
  let admin: PrismaClient;
  let db: PrismaClient;
  let issuer: Server;
  const children: ChildProcess[] = [];
  let grants = 0;
  let rejected = 0;
  let nextRefresh = "refresh-0";
  let address: string;
  let scopedUrl: string;
  let sequence = 0;
  let dropResponse = false;

  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("schema", schema);
    scopedUrl = url.href;
    db = new PrismaClient({ datasourceUrl: scopedUrl });
    await db.$executeRawUnsafe('CREATE TABLE "BmaiCredential" (id text PRIMARY KEY, "clientId" text NOT NULL, "refreshToken" text NOT NULL, "refreshPendingAt" timestamptz, "updatedAt" timestamp NOT NULL DEFAULT now())');
    await db.bmaiCredential.create({ data: { id: "mgmt", clientId: "test-client", refreshToken: `test:${nextRefresh}` } });
    issuer = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      res.setHeader("content-type", "application/json");
      if (input.get("refresh_token") !== nextRefresh) {
        rejected++;
        res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const number = ++grants;
      nextRefresh = `refresh-${number}`;
      if (dropResponse) { res.destroy(); return; }
      // Keep the transaction open across a real network round-trip while the other worker waits.
      await new Promise(resolve => setTimeout(resolve, 30));
      res.end(JSON.stringify({ access_token: `access-${number}`, refresh_token: nextRefresh, expires_in: 3600 }));
    });
    issuer.listen(0, "127.0.0.1");
    await once(issuer, "listening");
    address = `http://127.0.0.1:${(issuer.address() as { port: number }).port}/mcp`;
  });

  afterAll(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }));
    if (issuer) await new Promise<void>(resolve => issuer.close(() => resolve()));
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  async function worker() {
    const child = fork(fileURLToPath(new URL("./fixtures/bmai-token-worker.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, SHOPIFY_TOKEN_TEST_DATABASE_URL: scopedUrl, SHOPIFY_TOKEN_TEST_ISSUER: address },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    await once(child, "message");
    return child;
  }

  function get(child: ChildProcess, invalidate = false) {
    const id = ++sequence;
    return new Promise<string>((resolve, reject) => {
      const handler = (message: { id: number; token?: string; error?: string }) => {
        if (message.id !== id) return;
        child.off("message", handler);
        if (message.error) reject(new Error(message.error));
        else resolve(message.token!);
      };
      child.on("message", handler);
      child.send({ id, invalidate });
    });
  }

  it("serializes cold workers and reloads later rotations without replaying old refresh tokens", async () => {
    const [web, backstop] = await Promise.all([worker(), worker()]);
    const tokens = await Promise.all([get(web), get(backstop)]);
    expect(new Set(tokens).size).toBe(2);
    expect(grants).toBe(2);
    expect(await get(web, true)).toBe("access-3");
    expect(await get(backstop, true)).toBe("access-4");
    expect(rejected).toBe(0);
    expect((await db.bmaiCredential.findUniqueOrThrow({ where: { id: "mgmt" } })).refreshToken).toBe("test:refresh-4");
    // A newly started worker also uses the last durable value, never the env seed.
    const restarted = await worker();
    expect(await get(restarted)).toBe("access-5");
    expect(rejected).toBe(0);
  }, 20_000);

  it("refuses a fresh process after the remote grant succeeds but the response is lost", async () => {
    const before = grants;
    dropResponse = true;
    try {
      await expect(get(await worker())).rejects.toThrow();
    } finally { dropResponse = false; }
    expect(grants).toBe(before + 1);
    expect((await db.bmaiCredential.findUniqueOrThrow({ where: { id: "mgmt" } })).refreshPendingAt).not.toBeNull();
    await expect(get(await worker())).rejects.toThrow("renewal was interrupted");
    expect(grants).toBe(before + 1);
    expect(rejected).toBe(0);
  }, 20_000);

  it("keeps the committed attempt marker when saving the rotated credential fails", async () => {
    // Synthetic recovery between failure cases; only this disposable test credential.
    await db.bmaiCredential.update({ where: { id: "mgmt" }, data: { refreshToken: `test:${nextRefresh}`, refreshPendingAt: null } });
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_rotation_save() RETURNS trigger AS $$ BEGIN IF NEW."refreshPendingAt" IS NULL THEN RAISE EXCEPTION 'synthetic save failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe('CREATE TRIGGER reject_rotation_save BEFORE UPDATE ON "BmaiCredential" FOR EACH ROW EXECUTE FUNCTION reject_rotation_save()');
    const before = grants;
    await expect(get(await worker())).rejects.toThrow("could not be saved");
    expect(grants).toBe(before + 1);
    await expect(get(await worker())).rejects.toThrow("renewal was interrupted");
    expect(grants).toBe(before + 1);
    expect(rejected).toBe(0);
  }, 20_000);
});
