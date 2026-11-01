/* ---------------------------------------------------------------------------
 * FACTORY HANDSETS — what the Admin Console says about each factory phone.
 * Pure and client-safe: the page is a client component and polls, and the
 * words it draws are decided here once, beside their tests.
 *
 * Which build is "latest" is read off the phones themselves, as the MBOS
 * page does when nobody has named one: the newest APK version any phone
 * runs, and on that version the newest over-the-air update any phone has.
 * A phone short of the version needs the APK; one on the version but an
 * older update has an OTA it has not applied yet — which happens on its own
 * the next time the app is closed and opened.
 * ------------------------------------------------------------------------- */

export type FactoryHandsetRow = {
  /** The phone's id, or null for a factory worker no phone has reported for. */
  deviceId: string | null;
  userId: string | null;
  name: string;
  phone: string | null;
  area: string | null;
  roleLabel: string | null;
  godown: string | null;
  lastSeenAt: string | null;
  firstSeenAt: string | null;
  appVersion: string | null;
  updateId: string | null;
  updateCreatedAt: string | null;
  embedded: boolean | null;
  channel: string | null;
  os: string | null;
  osVersion: string | null;
  apiLevel: number | null;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  network: string | null;
  internet: boolean | null;
  queuePending: number | null;
  queueHeld: number | null;
  queueOldestAt: string | null;
  camera: string | null;
  screen: string | null;
  fontScalePct: number | null;
  clockSkewMs: number | null;
  lang: string | null;
  /** From the loading scan log, today in Asia/Kolkata. */
  scansToday: number;
  lastScanAt: string | null;
  medianWaitMs: number | null;
  disagreeToday: number;
};

export type FactoryHandsetsPayload = { rows: FactoryHandsetRow[]; newest: Newest };
export type Newest = { version: string | null; updateCreatedAt: string | null; updateId: string | null };

export type OtaStatus = "latest" | "ota" | "apk" | "unknown" | "none";

/** "2.10.0" above "2.4.0": numeric by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest APK any phone runs, and on it the newest update any phone has applied. */
export function newestOf(rows: Pick<FactoryHandsetRow, "appVersion" | "updateId" | "updateCreatedAt">[]): Newest {
  const versions = rows.map((r) => r.appVersion).filter((v): v is string => !!v && /^\d+(\.\d+)*$/.test(v));
  if (!versions.length) return { version: null, updateCreatedAt: null, updateId: null };
  const version = versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
  const on = rows.filter((r) => r.appVersion === version && r.updateCreatedAt && r.updateId);
  const top = on.reduce<(typeof on)[number] | null>((a, b) => (!a || Date.parse(b.updateCreatedAt!) > Date.parse(a.updateCreatedAt!) ? b : a), null);
  return { version, updateCreatedAt: top?.updateCreatedAt ?? null, updateId: top?.updateId ?? null };
}

export function otaStatus(r: Pick<FactoryHandsetRow, "deviceId" | "appVersion" | "updateCreatedAt">, newest: Newest): OtaStatus {
  if (!r.deviceId) return "none";
  if (!r.appVersion || !newest.version) return "unknown";
  if (compareVersions(r.appVersion, newest.version) < 0) return "apk";
  if (newest.updateCreatedAt && (!r.updateCreatedAt || Date.parse(r.updateCreatedAt) < Date.parse(newest.updateCreatedAt))) return "ota";
  return "latest";
}

export const OTA_LABEL: Record<OtaStatus, string> = {
  latest: "On the latest",
  ota: "Update waiting",
  apk: "Needs the new APK",
  unknown: "Version unknown",
  none: "No phone yet",
};

/** Work waiting this long on a phone that is still checking in is stuck, not slow. */
export const STUCK_QUEUE_MS = 30 * 60_000;
/** A clock this far off misdates every scan and job the phone sends. */
export const SKEW_WARN_MS = 2 * 60_000;
/** Android's font size above this breaks the factory screens' layout. */
export const BIG_FONT_PCT = 130;

export type Issue = { tone: "danger" | "warn"; text: string };

/** What is wrong with a phone, worst first — the things somebody can walk over and fix. */
export function handsetIssues(r: FactoryHandsetRow, nowMs: number): Issue[] {
  if (!r.deviceId) return [];
  const out: Issue[] = [];
  if (r.camera && r.camera !== "granted") out.push({ tone: "danger", text: r.camera === "denied" ? "Camera not allowed — it cannot scan" : "Camera never allowed yet" });
  if ((r.queuePending ?? 0) > 0 && r.queueOldestAt && nowMs - Date.parse(r.queueOldestAt) > STUCK_QUEUE_MS)
    out.push({ tone: "danger", text: `${r.queuePending} ${r.queuePending === 1 ? "job" : "jobs"} not sent for ${waitWords(nowMs - Date.parse(r.queueOldestAt))}` });
  if ((r.queueHeld ?? 0) > 0) out.push({ tone: "warn", text: `${r.queueHeld} held back by the server` });
  if (r.internet === false) out.push({ tone: "warn", text: "No internet at last report" });
  if (r.clockSkewMs != null && Math.abs(r.clockSkewMs) > SKEW_WARN_MS)
    out.push({ tone: "warn", text: `Clock ${waitWords(Math.abs(r.clockSkewMs))} ${r.clockSkewMs > 0 ? "fast" : "slow"}` });
  if (r.fontScalePct != null && r.fontScalePct > BIG_FONT_PCT) out.push({ tone: "warn", text: `Font size ${r.fontScalePct}% — screens may cut off` });
  if (r.disagreeToday > 0) out.push({ tone: "warn", text: `${r.disagreeToday} scan ${r.disagreeToday === 1 ? "judgement" : "judgements"} differed from the server today` });
  return out;
}

function waitWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** "Samsung Galaxy A14" from what Android reports, without saying the brand twice. */
export function handsetName(r: Pick<FactoryHandsetRow, "manufacturer" | "brand" | "model">): string | null {
  const maker = r.manufacturer || r.brand;
  if (!r.model) return maker ? cap(maker) : null;
  if (!maker || r.model.toLowerCase().startsWith(maker.toLowerCase())) return r.model;
  return `${cap(maker)} ${r.model}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
