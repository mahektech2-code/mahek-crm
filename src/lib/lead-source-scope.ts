/* ---------------------------------------------------------------------------
 * LEAD SOURCES THAT ONLY THE SALES MANAGER INTAKE OFFERS.
 *
 * `leads.sources` is the one configured list every flow reads — Telecaller
 * intake, the handset's new-lead picker, the Calling Desk, the funnel report
 * and both voice assistants — so a code added there reaches all of them. A
 * channel Mahek wants on the Sales Manager's form alone therefore cannot live
 * in it. It lives here instead, and is joined to the configured list only at
 * the two places that are the Sales Manager's: the intake page that draws the
 * dropdown and the capture action that validates it.
 *
 * Stored exactly like every other source — a CODE in `customers.lead_source`,
 * a free-text column, so no migration. Nothing here edits `app_settings`.
 *
 * PURE and client-safe, like `lead-workspace.ts`.
 * ------------------------------------------------------------------------- */

export type LeadSourceOption = { code: string; label: string };

export const SALES_MANAGER_ONLY_SOURCES: readonly LeadSourceOption[] = [
  { code: "google_maps", label: "Google Maps" },
];

/**
 * The sources one person may pick: the configured list unchanged, plus the
 * Sales-Manager-only ones for a Sales Manager. Existing options keep their
 * order; the extras go before `other`, which stays last as it always was.
 */
export function sourcesFor(
  configured: readonly LeadSourceOption[],
  isSalesManager: boolean,
): LeadSourceOption[] {
  if (!isSalesManager) return [...configured];
  const extras = SALES_MANAGER_ONLY_SOURCES.filter(
    (e) => !configured.some((c) => c.code === e.code),
  );
  const at = configured.findIndex((c) => c.code === "other");
  if (at < 0) return [...configured, ...extras];
  return [...configured.slice(0, at), ...extras, ...configured.slice(at)];
}
