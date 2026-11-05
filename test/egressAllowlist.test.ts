import { afterEach, describe, expect, it } from "vitest";
import allowlistFile from "../config/admin-api-egress-allowlist.json";
import {
  ALLOWLIST,
  evaluateEgress,
  ipInCidr,
  observeEgress,
  readEgressHealth,
  resetEgressCacheForTests,
} from "../app/lib/egressAllowlist";
import { loader } from "../app/routes/api.egress.health";

const EFIRS = "141.95.126.194";
const ok = (ip: string) => ({ source: "s", ip });

afterEach(() => resetEgressCacheForTests());

describe("admin-api egress allowlist file", () => {
  it("is non-empty, every entry is a CIDR with its callers named", () => {
    expect(allowlistFile.entries.length).toBeGreaterThan(0);
    for (const e of allowlistFile.entries) {
      expect(e.cidr).toMatch(/^[0-9a-fA-F:.]+\/\d{1,3}$/);
      expect(e.host.length).toBeGreaterThan(0);
      expect(e.callers.length).toBeGreaterThan(0);
    }
  });

  it("covers the efirs node every Admin API caller is pinned to", () => {
    expect(ALLOWLIST.some((c) => ipInCidr(EFIRS, c))).toBe(true);
  });
});

describe("ipInCidr", () => {
  it("matches /32, /24, /0 and refuses neighbours", () => {
    expect(ipInCidr("10.0.0.5", "10.0.0.5/32")).toBe(true);
    expect(ipInCidr("10.0.0.6", "10.0.0.5/32")).toBe(false);
    expect(ipInCidr("10.0.0.200", "10.0.0.0/24")).toBe(true);
    expect(ipInCidr("10.0.1.1", "10.0.0.0/24")).toBe(false);
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });
  it("refuses malformed input and IPv6 against an IPv4 range", () => {
    expect(ipInCidr("999.1.1.1", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr("2001:db8::1", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
  });
});

describe("evaluateEgress", () => {
  it("green when ≥2 echo services agree on an allowlisted address", () => {
    const h = evaluateEgress([ok(EFIRS), ok(EFIRS), { source: "c", ip: null, error: "TimeoutError" }]);
    expect(h.verdict).toBe("green");
    expect(h.observed).toEqual([EFIRS]);
  });

  it("RED when the egress moved outside the list (node move / NAT)", () => {
    const h = evaluateEgress([ok("198.244.165.193"), ok("198.244.165.193")]);
    expect(h.verdict).toBe("red");
    expect(h.reasons.join(" ")).toContain("198.244.165.193");
  });

  it("RED when any one of several egress addresses is outside the list", () => {
    expect(evaluateEgress([ok(EFIRS), ok("51.161.216.17")]).verdict).toBe("red");
  });

  it("RED even with a single answer, if that answer is outside the list", () => {
    expect(evaluateEgress([ok("1.2.3.4"), { source: "b", ip: null }]).verdict).toBe("red");
  });

  it("UNVERIFIED (never green) when fewer than two services answer", () => {
    expect(evaluateEgress([ok(EFIRS), { source: "b", ip: null }, { source: "c", ip: null }]).verdict).toBe("unverified");
    expect(evaluateEgress([]).verdict).toBe("unverified");
  });

  it("an empty allowlist is never green", () => {
    expect(evaluateEgress([ok(EFIRS), ok(EFIRS)], []).verdict).toBe("red");
    expect(evaluateEgress([], []).verdict).toBe("unverified");
  });
});

function fakeFetch(answers: Record<string, string | Error | number>): typeof fetch {
  return (async (url: string) => {
    const a = answers[url];
    if (a instanceof Error) throw a;
    if (typeof a === "number") return new Response("", { status: a });
    return new Response(`${a ?? ""}\n`, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("observeEgress", () => {
  it("parses plain-text answers and records failures without throwing", async () => {
    const obs = await observeEgress(["a", "b", "c", "d"], fakeFetch({ a: EFIRS, b: 502, c: new Error("x"), d: "<html>" }));
    expect(obs.map((o) => o.ip)).toEqual([EFIRS, null, null, null]);
    expect(obs[1].error).toBe("HTTP 502");
  });
});

describe("readEgressHealth + /api/egress/health", () => {
  it("caches for 5 min", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(EFIRS); }) as unknown as typeof fetch;
    await readEgressHealth(1_000, f);
    await readEgressHealth(2_000, f);
    expect(calls).toBe(3);
    await readEgressHealth(1_000 + 5 * 60 * 1000 + 1, f);
    expect(calls).toBe(6);
  });

  it("route answers 503 when the egress is not verified (no network in tests is never a 200)", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    try {
      const res = await loader();
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; verdict: string };
      expect(body.ok).toBe(false);
      expect(body.verdict).toBe("unverified");
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("route answers 200 green on the allowlisted egress", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(EFIRS)) as unknown as typeof fetch;
    try {
      const res = await loader();
      expect(res.status).toBe(200);
      expect(((await res.json()) as { verdict: string }).verdict).toBe("green");
    } finally {
      globalThis.fetch = real;
    }
  });
});
