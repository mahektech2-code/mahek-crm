import "server-only";
import diagnostics from "node:diagnostics_channel";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { providerForHost } from "@/lib/integration-providers";

/* ---------------------------------------------------------------------------
 * COUNTING REQUESTS TO OUTSIDE SERVICES, without touching any call site.
 *
 * Node's fetch is undici, and undici publishes every request on a diagnostics
 * channel whichever library made it — the AI SDK, our own `fetch` calls, a
 * provider's client. Subscribing once at server start (`instrumentation.ts`)
 * counts all of them; a call site added next month is counted by existing.
 *
 * Counts are held in memory and written once a minute, so a busy minute is
 * one upsert per provider rather than one per request. Losing an unflushed
 * minute to a restart under-counts by that minute and is the accepted cost.
 * Nothing here may throw into the request it observes.
 * ------------------------------------------------------------------------- */

type Tally = { calls: number; failures: number };
const pending = new Map<string, Tally>();
let started = false;

function count(origin: unknown, ok: boolean) {
  try {
    const host = typeof origin === "string" ? new URL(origin).host : (origin as URL | undefined)?.host;
    if (!host) return;
    const provider = providerForHost(host);
    if (!provider) return;
    const t = pending.get(provider) ?? { calls: 0, failures: 0 };
    t.calls += 1;
    if (!ok) t.failures += 1;
    pending.set(provider, t);
  } catch {
    /* never in the way of the request */
  }
}

export async function flushUsage(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  for (const [provider, t] of batch) {
    try {
      await db.execute(sql`
        insert into integration_usage (provider, day, calls, failures, updated_at)
        values (${provider}, (now() at time zone ${APP_TIMEZONE})::date, ${t.calls}, ${t.failures}, now())
        on conflict (provider, day) do update
          set calls = integration_usage.calls + excluded.calls,
              failures = integration_usage.failures + excluded.failures,
              updated_at = now()`);
    } catch {
      /* a database hiccup costs a minute of counts, never a request */
    }
  }
}

/** Called once per server from `instrumentation.ts`. */
export function startUsageTracking(): void {
  if (started) return;
  started = true;
  const seen = new WeakSet<object>();
  diagnostics.subscribe("undici:request:headers", (message) => {
    const m = message as { request?: { origin?: unknown }; response?: { statusCode?: number } };
    if (!m.request || seen.has(m.request as object)) return;
    seen.add(m.request as object);
    const status = m.response?.statusCode ?? 0;
    count(m.request.origin, status > 0 && status < 400);
  });
  diagnostics.subscribe("undici:request:error", (message) => {
    const m = message as { request?: { origin?: unknown } };
    if (!m.request || seen.has(m.request as object)) return;
    seen.add(m.request as object);
    count(m.request.origin, false);
  });
  const timer = setInterval(() => void flushUsage(), 60_000);
  timer.unref?.();
}
