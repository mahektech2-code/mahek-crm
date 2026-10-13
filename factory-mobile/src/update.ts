/**
 * WHETHER THERE IS A NEWER FACTORY APP, AND WHETHER TO ASK ABOUT IT NOW.
 *
 * The factory app's screens live in the APK — there is no over-the-air
 * channel — so every change to what the floor sees is a new APK, and a
 * sideloaded app never updates itself. The release workflow publishes
 * `/downloads/factory.json` beside the APK; the phone reads it, and where it
 * names a newer build the app asks: Update now, or Update later.
 *
 * COMPARED BY versionCode, never the version string: the code is what Android
 * itself compares, and "1.10.0" sorts below "1.9.0" as text. A manifest that is
 * missing, malformed, not https, or names a build that is not newer answers
 * `current` — a prompt raised by an HTML error page is one people learn to
 * dismiss without reading. A lower code is never offered as a downgrade.
 *
 * UPDATE LATER IS A SNOOZE OF THREE HOURS, not a dismissal: the same prompt
 * comes back once it lapses. A refresh pressed by hand asks at once, whatever
 * the snooze, because somebody who pressed it is asking.
 *
 * PURE, so it is tested without a phone (`update.test.ts`); `updater.ts` is the
 * fetch and the install.
 */

export type Manifest = { version: string; versionCode: number; url: string };

export type UpdateVerdict = { kind: "current" } | { kind: "available"; version: string; versionCode: number; url: string };

/** How long Update later keeps the prompt away. */
export const SNOOZE_MS = 3 * 60 * 60 * 1000;

export function updateVerdict(manifest: unknown, installedCode: number | null): UpdateVerdict {
  if (installedCode == null || !Number.isFinite(installedCode)) return { kind: "current" };
  if (!manifest || typeof manifest !== "object") return { kind: "current" };
  const m = manifest as Partial<Manifest>;
  if (typeof m.versionCode !== "number" || !Number.isFinite(m.versionCode)) return { kind: "current" };
  if (typeof m.url !== "string" || !m.url.startsWith("https://")) return { kind: "current" };
  if (m.versionCode <= installedCode) return { kind: "current" };
  const version = typeof m.version === "string" && m.version.trim() ? m.version.trim() : String(m.versionCode);
  return { kind: "available", version, versionCode: m.versionCode, url: m.url };
}

/** Whether the prompt may be shown now: never while snoozed, unless somebody pressed refresh. */
export function promptDue(nowMs: number, snoozedUntilMs: number | null, pressed = false): boolean {
  if (pressed) return true;
  return snoozedUntilMs == null || !Number.isFinite(snoozedUntilMs) || nowMs >= snoozedUntilMs;
}

/** When Update later lets the prompt come back. */
export function snoozeUntil(nowMs: number): number {
  return nowMs + SNOOZE_MS;
}
