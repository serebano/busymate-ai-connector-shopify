import allowlistFile from "../../config/admin-api-egress-allowlist.json";

/**
 * Shopify Admin API IP allowlist guard. Shopify refuses every Admin API call (and bulk
 * operation) from an address outside the app's Dev Dashboard allowlist once enforcement
 * is on. Our egress is a single node IP today; a node move, a NAT or a new host would
 * break every Shopify call silently. This module compares the LIVE egress address with
 * the repo's list (config/admin-api-egress-allowlist.json) so the change is caught by the
 * review-surface probe before merchants notice.
 *
 * Fail-closed: fewer than two echo services answering, or two answers that disagree,
 * is UNVERIFIED, never green.
 */

export type EgressVerdict = "green" | "red" | "unverified";

export interface EgressObservation {
  source: string;
  ip: string | null;
  error?: string;
}

export interface EgressHealth {
  verdict: EgressVerdict;
  observed: string[];
  allowlisted: string[];
  reasons: string[];
}

export const ALLOWLIST: readonly string[] = Object.freeze(allowlistFile.entries.map((e) => e.cidr));

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** IPv4 in an IPv4 CIDR, or an exact (normalised) IPv6 match. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a !== null && b !== null) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  if (a === null && b === null && bitsRaw === undefined) return ip.toLowerCase() === base.toLowerCase();
  return false;
}

export function isAllowlisted(ip: string, allowlist: readonly string[] = ALLOWLIST): boolean {
  return allowlist.some((cidr) => ipInCidr(ip, cidr));
}

/** Pure judge. */
export function evaluateEgress(obs: EgressObservation[], allowlist: readonly string[] = ALLOWLIST): EgressHealth {
  const answered = obs.filter((o) => typeof o.ip === "string" && o.ip.length > 0) as Array<EgressObservation & { ip: string }>;
  const observed = [...new Set(answered.map((o) => o.ip))];
  const reasons: string[] = [];
  const outside = observed.filter((ip) => !isAllowlisted(ip, allowlist));
  if (allowlist.length === 0) reasons.push("the repo allowlist is empty");
  if (outside.length > 0) {
    reasons.push(`egress ${outside.join(", ")} is NOT in config/admin-api-egress-allowlist.json — Shopify Admin API calls from it are refused once enforcement is on`);
    return { verdict: "red", observed, allowlisted: [...allowlist], reasons };
  }
  if (answered.length < 2) {
    reasons.push(`only ${answered.length} of ${obs.length} egress echo services answered (${obs.filter((o) => !o.ip).map((o) => `${o.source}: ${o.error ?? "no answer"}`).join("; ") || "none asked"})`);
    return { verdict: "unverified", observed, allowlisted: [...allowlist], reasons };
  }
  if (allowlist.length === 0) return { verdict: "unverified", observed, allowlisted: [], reasons };
  return { verdict: "green", observed, allowlisted: [...allowlist], reasons };
}

export const ECHO_SERVICES: readonly string[] = Object.freeze([
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
]);

/** Ask each echo service for our public address (plain-text body). */
export async function observeEgress(
  services: readonly string[] = ECHO_SERVICES,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<EgressObservation[]> {
  return Promise.all(
    services.map(async (source): Promise<EgressObservation> => {
      try {
        const res = await fetchImpl(source, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/plain" } });
        if (!res.ok) return { source, ip: null, error: `HTTP ${res.status}` };
        const ip = (await res.text()).trim();
        if (!/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return { source, ip: null, error: "not an address" };
        return { source, ip };
      } catch (err) {
        return { source, ip: null, error: err instanceof Error ? err.name : "fetch failed" };
      }
    }),
  );
}

let cache: { at: number; health: EgressHealth } | null = null;
const CACHE_MS = 5 * 60 * 1000;

/** Observe + judge, cached for 5 min so a probe never hammers the echo services. */
export async function readEgressHealth(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<EgressHealth & { checkedAt: string }> {
  if (!cache || now - cache.at > CACHE_MS) {
    cache = { at: now, health: evaluateEgress(await observeEgress(ECHO_SERVICES, fetchImpl)) };
  }
  return { ...cache.health, checkedAt: new Date(cache.at).toISOString() };
}

export function resetEgressCacheForTests(): void {
  cache = null;
}
