/* ---------------------------------------------------------------------------
 * WHAT AN LGD "LOCAL BODY TYPE CODE" IS CALLED — PURE and client-safe.
 *
 * `geo_local_bodies.type_code` keeps the source's code as text. This is the only
 * place a code becomes words, and it holds ONLY the codes an official report has
 * actually named. The Maharashtra "Urban Local bodies" report (lgdirectory.gov.in,
 * downloaded 25 Nov 2026) carries a "Localbody Type Name" beside each code:
 *
 *   4  Municipal Corporation   (29 of 422)
 *   5  Municipality            (244)
 *   7  Nagar Panchayat         (149)
 *
 * Other states use other codes (a Municipal Council, a Cantonment Board...) that
 * no report we hold has named. They are NOT guessed: `ulbTypeName` answers null
 * and the screen shows no type for them, until a report that names them is
 * imported and this list is extended from it.
 * ------------------------------------------------------------------------- */

const NAMED_BY_AN_OFFICIAL_REPORT: Readonly<Record<string, string>> = {
  "4": "Municipal Corporation",
  "5": "Municipality",
  "7": "Nagar Panchayat",
};

export function ulbTypeName(code: string | null | undefined): string | null {
  return NAMED_BY_AN_OFFICIAL_REPORT[(code ?? "").trim()] ?? null;
}

/** The codes above, for a check that an import's own names still agree with them. */
export const KNOWN_ULB_TYPES = NAMED_BY_AN_OFFICIAL_REPORT;
