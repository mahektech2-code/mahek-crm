import type { AppId } from "./apps";
import { ERP_POWER_SINCE, MODULE_SINCE } from "./module-since-data";
import { isAlwaysOpen, modulesForApp, type AppModule } from "./modules";

/* ---------------------------------------------------------------------------
 * WHAT SHIPPED AFTER SOMEBODY'S ACCESS WAS LAST DECIDED.
 *
 * Pure and client-safe: the Access screen draws the flag on the list and the
 * badge inside the dialog from the same answer. The dates are in
 * `module-since-data.ts`, which says why they exist.
 *
 * `setOn` is a business date (YYYY-MM-DD, Asia/Kolkata), and a key is new
 * only where it shipped on a LATER day. A screen merged on the afternoon of
 * the same day somebody was narrowed is therefore not reported — the date
 * has no time in it, and calling a deliberate choice an oversight is the
 * worse of the two mistakes, because it teaches people to ignore the flag.
 * ------------------------------------------------------------------------- */

/**
 * The screens of `app` that shipped after `setOn` and are not among `held`.
 *
 * Only what a whole-app grant would carry. An off-by-default desk and an
 * explicit-only seat are handed out deliberately by design, so their absence
 * from a narrowed grant is never an oversight; a write level is not a screen;
 * and an always-open screen is held by everybody who holds the app.
 */
export function screensNewSince(app: AppId, setOn: string | null, held: Iterable<string>): AppModule[] {
  if (!setOn) return [];
  const have = new Set(held);
  return modulesForApp(app).filter(
    (m) =>
      !m.offByDefault &&
      !m.explicitOnly &&
      !m.writeOf &&
      !isAlwaysOpen(m.key) &&
      !have.has(m.key) &&
      (MODULE_SINCE[m.key] ?? "") > setOn,
  );
}

/** The ERP powers that shipped after `setOn` and are not among `held`. */
export function erpPowersNewSince(setOn: string | null, held: Iterable<string>): string[] {
  if (!setOn) return [];
  const have = new Set(held);
  return Object.entries(ERP_POWER_SINCE)
    .filter(([power, since]) => !have.has(power) && since > setOn)
    .map(([power]) => power);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-05" → "5 Oct". A business date is already a day; no zone is involved. */
export function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1] ?? ""}`.trim();
}

/** "Opportunities" /"Opportunities and Under Process" / "A, B and 2 more". */
export function namedList(labels: string[], max = 3): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length <= max) return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `${labels.slice(0, max - 1).join(", ")} and ${labels.length - (max - 1)} more`;
}
