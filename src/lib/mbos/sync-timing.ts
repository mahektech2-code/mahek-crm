/* ---------------------------------------------------------------------------
 * WHERE A HANDSET SYNC SPENDS ITS TIME, said in a Server-Timing header.
 *
 * Measured from the Caddy log (17 Nov): a sync that only asks for changes takes
 * ~650 ms and brings back ~30 KB, while each query in `buildPull` runs in ~5 ms
 * — so the time is somewhere the statistics cannot see. Caddy already logs
 * response headers, so this header puts the split (reading the request, filing
 * the outbox, building the pull, writing JSON) and the row count of every pull
 * channel into the log for every sync, from real phones on real networks.
 *
 * The handset ignores the header. Nothing here changes what is sent or stored,
 * and the location upload (`/api/mbos/positions`) is a different route.
 *
 * PURE: no clock, no I/O — the route measures and hands the numbers in.
 * ------------------------------------------------------------------------- */

export type SyncPhase = { name: string; ms: number };

/** "auth;dur=3.1, ingest;dur=402.6;desc=\"5\"" — one entry per phase, in order. */
function phaseEntries(phases: SyncPhase[], items: number): string[] {
  return phases.map((p) => `${token(p.name)};dur=${round1(p.ms)}${p.name === "ingest" ? `;desc="${items}"` : ""}`);
}

/**
 * The row count of every channel in a pull that sent anything, as
 * "customers:12 timeline:40". Arrays are counted; a channel that is an object
 * (config, territory, remote) is named with no count, because it is sent whole
 * on every pass and its presence is the fact worth seeing.
 */
export function pullRows(pull: Record<string, unknown> | null | undefined): string {
  if (!pull) return "";
  const out: string[] = [];
  for (const [k, v] of Object.entries(pull)) {
    if (Array.isArray(v)) {
      if (v.length) out.push(`${k}:${v.length}`);
    } else if (v && typeof v === "object") out.push(k);
  }
  return out.join(" ");
}

/** The whole header value. Kept under a kilobyte: a long header is a cost on every sync. */
export function syncTimingHeader(phases: SyncPhase[], o: { items: number; bytes: number; pull: Record<string, unknown> | null | undefined }): string {
  const parts = [...phaseEntries(phases, o.items), `bytes;desc="${o.bytes}"`];
  const rows = pullRows(o.pull);
  if (rows) parts.push(`rows;desc="${quoteSafe(rows).slice(0, 600)}"`);
  return parts.join(", ");
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;
const token = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const quoteSafe = (s: string) => s.replace(/["\\\r\n]/g, "_");
