/**
 * WHETHER THERE IS A NEWER BUILD THAN THIS ONE.
 *
 * Sideloading has no auto-update. A release is built, signed, published to a
 * URL — and then sits there until somebody walks up to each handset. The cost
 * of that is not theoretical: on the day this was written the field was
 * running 1.0.0 and 1.1.0 while 1.4.0 had been published for hours, so every
 * fix in between existed and reached nobody. Three separate bugs were
 * diagnosed against builds that did not contain their own fixes.
 *
 * The office cannot push an APK — Android will not install one unattended
 * without device-owner enrolment nobody here has. What it CAN do is tell the
 * handset a newer build exists and hand it the link, which turns a fortnight
 * of nobody noticing into one tap plus the installer.
 *
 * COMPARED BY versionCode, NEVER the version string. `versionCode` is the
 * integer Android itself compares when deciding whether an install is an
 * upgrade; the name beside it is for humans and sorts wrong the moment there
 * is a 1.10.0 to hold against a 1.9.0. This app's own release procedure moves
 * both, and this reads the one that cannot be ambiguous.
 *
 * PURE, and an engine, for the reason the three files beside it give: the
 * fetch and `Application.nativeBuildVersion` both need a device, and a rule
 * that cannot be exercised without one is a rule nobody can be sure of.
 */

/** What the release workflow publishes beside the APK. */
export type ReleaseManifest = {
  /** The human name — shown, never compared. */
  version: string;
  /** What Android compares. The only field that decides anything. */
  versionCode: number;
  /** Where the APK is. Absolute, because a handset has no site to be relative to. */
  url: string;
};

export type UpdateVerdict =
  /** Nothing to do, or nothing trustworthy to act on. */
  | { kind: 'current' }
  /** A newer build exists, and this is what to say about it. */
  | { kind: 'available'; version: string; url: string };

/**
 * Read a manifest the way a handset should: suspiciously.
 *
 * Anything missing, malformed, or naming a build that is not newer answers
 * `current`. An update card that appears because a proxy returned an HTML
 * error page, or because a field arrived as a string, is one people learn to
 * dismiss without reading — and this card has exactly one job, which is to be
 * read the first time.
 *
 * A LOWER versionCode is not a downgrade offer. It is almost always a handset
 * running a build newer than what is published — somebody testing, or a
 * publish that has not finished — and offering to take him backwards would be
 * wrong even if he accepted.
 */
export function updateVerdict(
  manifest: unknown,
  installedVersionCode: number | null,
): UpdateVerdict {
  if (installedVersionCode === null || !Number.isFinite(installedVersionCode)) {
    /* This build cannot say what it is, so it cannot know it is behind. */
    return { kind: 'current' };
  }
  if (!manifest || typeof manifest !== 'object') return { kind: 'current' };

  const m = manifest as Partial<ReleaseManifest>;
  if (typeof m.versionCode !== 'number' || !Number.isFinite(m.versionCode)) {
    return { kind: 'current' };
  }
  if (typeof m.url !== 'string' || !m.url.startsWith('https://')) {
    /* Http would be an APK downloaded over a link anybody on the same wifi
       can rewrite, which is a worse outcome than not updating. */
    return { kind: 'current' };
  }
  if (m.versionCode <= installedVersionCode) return { kind: 'current' };

  return {
    kind: 'available',
    /* The NAME is what a person recognises; where it is missing the code
       stands in rather than the card saying "undefined is available". */
    version: typeof m.version === 'string' && m.version.trim() ? m.version.trim() : String(m.versionCode),
    url: m.url,
  };
}
