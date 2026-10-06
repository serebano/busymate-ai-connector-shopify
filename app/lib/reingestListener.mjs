import { Client } from "pg";
import { clearTimeout, setTimeout } from "node:timers";

/**
 * Dedicated authenticated PostgreSQL session. Notifications are wake hints only;
 * the callback must reread the durable queue, including after every LISTEN/rejoin.
 * @param {{connection: import('pg').ClientConfig, wake: () => void, signal: AbortSignal, status?: (connected: boolean) => Promise<void>, retryMs?: number}} options
 */
export async function listenReingest({ connection, wake, signal, status = async () => {}, retryMs = 1000 }) {
  let delay = retryMs;
  while (!signal.aborted) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 5000, query_timeout: 5000, keepAlive: true });
    let disconnected;
    const ended = new Promise(resolve => { disconnected = resolve; });
    const end = () => disconnected();
    client.on("error", end); // Provider details may contain connection secrets: never print them.
    client.on("end", end);
    client.on("notification", message => { if (message.channel === "kb_reingest_wake" && !signal.aborted) wake(); });
    const abort = () => { end(); void client.end().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      if (signal.aborted) break;
      await client.query("LISTEN kb_reingest_wake");
      await status(true);
      delay = retryMs;
      wake(); // Covers committed events missed before subscription or during disconnect.
      await ended;
    } catch { /* Retry plus durable fallback; never acknowledge work here. */ }
    finally { signal.removeEventListener("abort", abort); await client.end().catch(() => {}); await status(false).catch(() => {}); }
    if (!signal.aborted) {
      await new Promise(resolve => {
        const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
        const timer = setTimeout(stop, delay);
        signal.addEventListener("abort", stop, { once: true });
      });
      delay = Math.min(30000, delay * 2);
    }
  }
}
