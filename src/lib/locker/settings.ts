/* ---------------------------------------------------------------------------
 * The Locker's Security settings — Admin › Security. PURE: the defaults and
 * the shape. The row lives in `locker_settings`; `lockerSettingsRow()` in
 * service.ts merges it over these, so a setting nobody has touched reads its
 * default and adding one needs no migration.
 *
 * The per-tier defaults are the functional spec's §2 table. Two of its rules
 * are NOT settings, because no admin may turn them off (§10.3 A2, A3): a
 * restricted reveal always needs a second person, and break-glass can never
 * be invoked and approved by the same one.
 * ------------------------------------------------------------------------- */

import type { Tier } from "./engine";

export type TierRules = {
  /** Re-enter your own MahekOne password before the reveal. */
  stepUp: boolean;
  /** A written reason, at least `reasonMin` characters. */
  reason: boolean;
  /** Seconds the value stays on screen. */
  showSeconds: number;
  /** Seconds before a copied value is wiped; 0 means copying is not offered. */
  clipboardSeconds: number;
  /** The viewer's name, code and the time drawn across the value. */
  watermark: boolean;
  /** Days between password changes. */
  rotateDays: number;
};

export type LockerSettings = {
  tiers: Record<Tier, TierRules>;
  reasonMin: number;
  /** Minutes a restricted-reveal request waits for its approver. */
  approvalMinutes: number;
  /** Reveals one person may make in an hour before they are soft-blocked and an admin is told. */
  revealsPerHour: number;
  /** Working hours; a reveal outside them is logged as notable. */
  workStartHour: number;
  workEndHour: number;
  /** The emergency access window. */
  breakglassMinutes: number;
  /** Hours after emergency access in which its review must be recorded. */
  breakglassReviewHours: number;
  /** A card expiring inside this many days raises an alert on every subscription it pays for. */
  cardWarnDays: number;
};

export const DEFAULT_SETTINGS: LockerSettings = {
  tiers: {
    standard: { stepUp: false, reason: false, showSeconds: 60, clipboardSeconds: 45, watermark: false, rotateDays: 365 },
    sensitive: { stepUp: true, reason: true, showSeconds: 30, clipboardSeconds: 30, watermark: true, rotateDays: 180 },
    restricted: { stepUp: true, reason: true, showSeconds: 20, clipboardSeconds: 0, watermark: true, rotateDays: 90 },
  },
  reasonMin: 15,
  approvalMinutes: 15,
  revealsPerHour: 12,
  workStartHour: 8,
  workEndHour: 21,
  breakglassMinutes: 60,
  breakglassReviewHours: 48,
  cardWarnDays: 60,
};

export function mergeSettings(stored: Record<string, unknown> | null | undefined): LockerSettings {
  const s = (stored ?? {}) as Partial<LockerSettings>;
  const t = (s.tiers ?? {}) as Partial<Record<Tier, Partial<TierRules>>>;
  const out: LockerSettings = { ...DEFAULT_SETTINGS, ...s, tiers: { ...DEFAULT_SETTINGS.tiers } };
  for (const k of ["standard", "sensitive", "restricted"] as Tier[]) out.tiers[k] = { ...DEFAULT_SETTINGS.tiers[k], ...(t[k] ?? {}) };
  /* The restricted tier never offers copying, whatever was stored — the spec's "read and type". */
  out.tiers.restricted.clipboardSeconds = 0;
  out.tiers.restricted.reason = true;
  out.tiers.restricted.stepUp = true;
  return out;
}
