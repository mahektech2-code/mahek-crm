/* ---------------------------------------------------------------------------
 * MBOS REMOTE CONTROL — what the office can change on a salesman's phone
 * without an APK and without an over-the-air bundle.
 *
 * Three kinds, and only three, because each one has a fixed place on the
 * handset that knows how to draw it:
 *
 *   flag    `feature.<name>` / `menu.<route>.hidden` — on or off. A feature
 *           the office can switch off for everybody in seconds when it breaks
 *           in the field, and a More-menu entry it can hide.
 *   text    `text.<where>` — a sentence the handset shows in place of the one
 *           compiled into it. The compiled one is always the fallback.
 *   banner  `banner.<id>` — a card on a named screen: a title, a line, an
 *           optional picture and an optional tap that opens a screen or a link.
 *
 * THE LOCATION FENCE, and it is the reason this is its own channel rather than
 * more keys in `app_settings`. The trail — the fix every few seconds, its
 * cadence, its watchdog, its upload — reads `mbos.location.*` through the
 * ordinary configuration pull and nothing here can reach it:
 *
 *   - a key must start with `feature.`, `menu.`, `text.` or `banner.`, so it
 *     can never shadow a configuration key, `mbos.location.*` or any other;
 *     the database refuses anything else too (`0346_mbos_remote`);
 *   - it travels as its own `remote` field on the wire, applied by its own
 *     channel on the handset into its own `kv` row, so a bad item costs that
 *     channel and never the configuration the tracker reads;
 *   - the screens the day depends on — punching in, travel, phone and
 *     tracking setup, attendance, the sync screen — can never be hidden
 *     (`PROTECTED_ROUTES`), and no flag switches tracking.
 *
 * Pure: no I/O, no clock. The service reads the rows and the device.
 * ------------------------------------------------------------------------- */

export const REMOTE_KINDS = ["flag", "text", "banner"] as const;
export type RemoteKind = (typeof REMOTE_KINDS)[number];

/** Same expression as the database CHECK in `0346_mbos_remote`. */
export const REMOTE_KEY_PATTERN = /^(feature|menu|text|banner)\.[a-z0-9][a-z0-9._-]{0,79}$/;

/**
 * Screens that keep the day — and the trail — running. A `menu.<route>.hidden`
 * flag naming one is refused here and ignored on the handset as well.
 */
export const PROTECTED_ROUTES = [
  "home",
  "attendance",
  "travel",
  "tracking-setup",
  "phone-setup",
  "setup",
  "sync",
  "maps",
  "visit",
  "profile",
] as const;

/** Words that mark a key as being about location. Refused whatever the prefix. */
const LOCATION_WORDS = /(location|tracking|trail|gps|fix|position|geofence|punch)/;

export const BANNER_SCREENS = ["home", "more"] as const;
export type BannerScreen = (typeof BANNER_SCREENS)[number];

export const BANNER_TONES = ["info", "success", "warn"] as const;
export type BannerTone = (typeof BANNER_TONES)[number];

export type BannerValue = {
  screen: BannerScreen;
  title: string;
  body?: string;
  imageUrl?: string;
  tone?: BannerTone;
  /** A handset route (`catalogue`, `leads` …) or an https link. Never both. */
  route?: string;
  url?: string;
  /** Lower first. */
  order?: number;
  /** Inclusive window, ISO instants. Outside it the banner is not sent. */
  startsAt?: string;
  endsAt?: string;
};

export type Audience = {
  /** MBOS app levels: associate, manager, admin. Empty or absent = everybody. */
  roles?: string[];
  /** Named people. Absent = everybody. */
  userIds?: string[];
  /** Inclusive, on the handset's reported build ("1.26.0"). */
  minVersion?: string;
  maxVersion?: string;
  /** 1–100: a stable slice of people, the same people every time. */
  percent?: number;
};

export type RemoteItem = {
  key: string;
  kind: RemoteKind;
  value: unknown;
  audience: Audience;
  enabled: boolean;
  version: number;
};

export type Who = {
  userId: string;
  role: string;
  /** The label the handset reports, "1.26.0 (36) · f7f48848". Null if never reported. */
  appVersion: string | null;
};

export type RemotePayload = {
  /** Changes whenever anything this person receives changes. */
  version: string;
  flags: Record<string, boolean>;
  texts: Record<string, string>;
  banners: (BannerValue & { id: string })[];
};

/* ------------------------------------------------------------ validation */

export function validateRemoteItem(input: {
  key: string;
  kind: string;
  value: unknown;
  audience: Audience;
}): string[] {
  const errors: string[] = [];
  const { key, kind, value, audience } = input;

  if (!REMOTE_KEY_PATTERN.test(key)) {
    errors.push(
      "The key must start with feature., menu., text. or banner. and use only lower-case letters, digits, dots, dashes and underscores.",
    );
  }
  if (LOCATION_WORDS.test(key)) {
    errors.push("Nothing about location or tracking can be changed from here. Those settings stay where they are.");
  }
  if (!(REMOTE_KINDS as readonly string[]).includes(kind)) {
    errors.push("Unknown kind.");
    return errors;
  }

  const prefix = key.split(".")[0];
  if (kind === "flag" && prefix !== "feature" && prefix !== "menu") errors.push("A switch's key starts with feature. or menu.");
  if (kind === "text" && prefix !== "text") errors.push("A text's key starts with text.");
  if (kind === "banner" && prefix !== "banner") errors.push("A banner's key starts with banner.");

  if (prefix === "menu") {
    const m = /^menu\.([a-z0-9-]+)\.hidden$/.exec(key);
    if (!m) errors.push("A menu switch is menu.<screen>.hidden.");
    else if ((PROTECTED_ROUTES as readonly string[]).includes(m[1])) {
      errors.push(`${m[1]} keeps the working day running and cannot be hidden.`);
    }
  }

  if (kind === "flag" && typeof value !== "boolean") errors.push("A switch is on or off.");
  if (kind === "text") {
    if (typeof value !== "string" || !value.trim()) errors.push("The text is empty.");
    else if (value.length > 500) errors.push("Keep the text under 500 characters.");
  }
  if (kind === "banner") errors.push(...validateBanner(value));

  errors.push(...validateAudience(audience));
  return errors;
}

function validateBanner(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["A banner needs a title."];
  const b = value as Partial<BannerValue>;
  if (!b.screen || !(BANNER_SCREENS as readonly string[]).includes(b.screen)) errors.push("Choose where the banner shows.");
  if (typeof b.title !== "string" || !b.title.trim()) errors.push("A banner needs a title.");
  else if (b.title.length > 80) errors.push("Keep the title under 80 characters.");
  if (b.body != null && (typeof b.body !== "string" || b.body.length > 300)) errors.push("Keep the line under 300 characters.");
  if (b.tone != null && !(BANNER_TONES as readonly string[]).includes(b.tone)) errors.push("Unknown colour.");
  if (b.imageUrl && !/^https:\/\/\S+$/.test(b.imageUrl)) errors.push("The picture must be an https:// link.");
  if (b.url && !/^https:\/\/\S+$/.test(b.url)) errors.push("The link must be an https:// link.");
  if (b.route && !/^[a-z0-9-]+(\?[a-zA-Z0-9=&_.-]*)?$/.test(b.route)) errors.push("The screen is a handset route like catalogue or leads.");
  if (b.route && b.url) errors.push("A banner opens a screen or a link, not both.");
  for (const k of ["startsAt", "endsAt"] as const) {
    if (b[k] != null && Number.isNaN(Date.parse(String(b[k])))) errors.push("A date in the window is not a date.");
  }
  if (b.startsAt && b.endsAt && Date.parse(b.startsAt) > Date.parse(b.endsAt)) errors.push("The window ends before it starts.");
  return errors;
}

function validateAudience(a: Audience): string[] {
  const errors: string[] = [];
  if (a.percent != null && (!Number.isInteger(a.percent) || a.percent < 1 || a.percent > 100)) {
    errors.push("The share of people is a whole number from 1 to 100.");
  }
  for (const v of [a.minVersion, a.maxVersion]) {
    if (v != null && v !== "" && !parseVersion(v)) errors.push(`${v} is not a build number like 1.26.0.`);
  }
  if (a.minVersion && a.maxVersion && compareVersions(a.minVersion, a.maxVersion) > 0) {
    errors.push("The oldest build is newer than the newest one.");
  }
  return errors;
}

/* -------------------------------------------------------------- audience */

/** "1.26.0 (36) · f7f48848" → [1, 26, 0]. Null if the label has no build number. */
export function parseVersion(label: string | null | undefined): [number, number, number] | null {
  if (!label) return null;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(label);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** A stable 0–99 bucket per person and key: the same people stay in a 10% rollout. */
export function bucketOf(userId: string, key: string): number {
  return fnv(`${key}:${userId}`) % 100;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function inAudience(a: Audience, key: string, who: Who): boolean {
  if (a.roles?.length && !a.roles.includes(who.role)) return false;
  if (a.userIds?.length && !a.userIds.includes(who.userId)) return false;
  if (a.minVersion || a.maxVersion) {
    /* A handset that never said which build it is cannot be shown something
       meant for a build range — the range exists because older builds cannot
       draw it. */
    if (!parseVersion(who.appVersion)) return false;
    if (a.minVersion && compareVersions(who.appVersion!, a.minVersion) < 0) return false;
    if (a.maxVersion && compareVersions(who.appVersion!, a.maxVersion) > 0) return false;
  }
  if (a.percent != null && a.percent < 100 && bucketOf(who.userId, key) >= a.percent) return false;
  return true;
}

/* --------------------------------------------------------------- resolve */

/**
 * What one person's phone receives. An item switched off, outside its audience,
 * outside its window or failing validation is simply absent, and the handset
 * then uses what is compiled into it — absence is always the safe answer.
 */
export function resolveRemote(items: RemoteItem[], who: Who, nowMs: number): RemotePayload {
  const flags: Record<string, boolean> = {};
  const texts: Record<string, string> = {};
  const banners: (BannerValue & { id: string })[] = [];
  const parts: string[] = [];

  for (const item of [...items].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!item.enabled) continue;
    if (validateRemoteItem(item).length) continue;
    if (!inAudience(item.audience ?? {}, item.key, who)) continue;

    if (item.kind === "flag") flags[item.key] = item.value as boolean;
    else if (item.kind === "text") texts[item.key] = item.value as string;
    else {
      const b = item.value as BannerValue;
      if (b.startsAt && Date.parse(b.startsAt) > nowMs) continue;
      if (b.endsAt && Date.parse(b.endsAt) < nowMs) continue;
      banners.push({ ...b, id: item.key });
    }
    parts.push(`${item.key}@${item.version}`);
  }

  banners.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  return { version: `${fnv(parts.join("|")).toString(16)}-${parts.length}`, flags, texts, banners };
}
