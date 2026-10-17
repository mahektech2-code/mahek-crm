import { buildIsBehind } from "./handset-health";

/* ---------------------------------------------------------------------------
 * WHICH BUILD EACH HANDSET IS RUNNING — the words and the arithmetic for the
 * Admin Console's Handsets table. Pure and client-safe, like `handset-health`
 * beside it, because the table re-reads every few seconds in the browser and
 * a second copy of "is this behind" typed into the screen would drift from the
 * one the Live map already uses. `buildIsBehind` is that one.
 * ------------------------------------------------------------------------- */

/** One row of the table, as the API sends it. Instants are ISO strings. */
export type HandsetRow = {
  userId: string;
  name: string;
  phone: string | null;
  email: string | null;
  deviceId: string | null;
  model: string | null;
  platform: string | null;
  appVersion: string | null;
  /** The last request that carried the version. Null: this build only says at sign-in. */
  appVersionReportedAt: string | null;
  /** When the version last moved to a new value. */
  appVersionChangedAt: string | null;
  /** The newest of every request, a location upload and a sign-in. */
  lastHeardAt: string | null;
  boundAt: string | null;
};

export type HandsetsPayload = {
  rows: HandsetRow[];
  /** The build every phone should be on, and where that answer came from. */
  reference: string | null;
  referenceSource: "setting" | "newest" | null;
  /** When the server read it — the table's own "as of". */
  at: string;
};

/**
 * `"1.15.0 (21) · a1b2c3d4"` → its three parts. The label is what the handset
 * builds in `buildLabel`: the store version, the build number, and which
 * over-the-air bundle is running — `embedded` for the one inside the APK and
 * `updates off` for a build that cannot take one.
 */
export type BuildLabel = { version: string | null; build: string | null; bundle: string | null };

export function parseBuildLabel(raw: string | null): BuildLabel | null {
  const label = raw?.trim();
  if (!label) return null;
  const [head, ...rest] = label.split("·").map((s) => s.trim());
  const m = /^v?(\d+(?:\.\d+)*)\s*(?:\((\w+)\))?/.exec(head);
  return {
    version: m ? m[1] : head || null,
    build: m?.[2] ?? null,
    bundle: rest.join(" · ") || null,
  };
}

export type VersionStatus = "latest" | "behind" | "unknown" | "none";

/** No handset at all, no version to read, behind the reference, or on it. */
export function versionStatus(row: Pick<HandsetRow, "deviceId" | "appVersion">, reference: string | null): VersionStatus {
  if (!row.deviceId) return "none";
  const behind = buildIsBehind(row.appVersion, reference);
  if (behind === null) return "unknown";
  return behind ? "behind" : "latest";
}

/** The newest store version any phone reports — the reference when nobody has set one. */
export function newestVersion(labels: Array<string | null>): string | null {
  let best: string | null = null;
  for (const raw of labels) {
    const v = parseBuildLabel(raw)?.version ?? null;
    if (!v || !/^\d/.test(v)) continue;
    if (best === null || buildIsBehind(best, v)) best = v;
  }
  return best;
}

export type Presence = "online" | "recent" | "quiet" | "never";

/** Heard in the last 2 minutes is a phone syncing right now; 30 minutes, recently. */
export const ONLINE_MS = 2 * 60_000;
export const RECENT_MS = 30 * 60_000;

export function presence(at: string | null, nowMs: number): Presence {
  if (!at) return "never";
  const age = nowMs - Date.parse(at);
  if (age < ONLINE_MS) return "online";
  if (age < RECENT_MS) return "recent";
  return "quiet";
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". A future instant reads as now. */
export function ago(at: string | null, nowMs: number): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round((nowMs - Date.parse(at)) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
