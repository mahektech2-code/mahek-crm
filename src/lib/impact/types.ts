/* ---------------------------------------------------------------------------
 * WHAT A DELETE OR A CHANGE WILL TOUCH, said before it happens — PURE and
 * client-safe, because the modal that shows it is a client component and the
 * server checks the same answer before it writes.
 *
 * A delete in MahekOne rarely stays where it was pressed. Taking a lead to
 * trash takes it off a salesman's handset; removing a holiday removes it from
 * HRMS, the field calendar and every phone that pulled it; deleting a draft
 * price list takes its rates and scopes with it. The person pressing the
 * button saw one row and none of that. An impact report is the list of what
 * else moves, grouped by the app it lives in, read off the database at the
 * moment the modal opens.
 *
 * THE REPORT IS ALSO THE CHECK. The modal hands back the report's fingerprint
 * with the confirmation, and the action recomputes the report before it
 * writes. If anything moved in between — somebody else added an order to the
 * customer, a phone pulled the holiday — the fingerprints differ and the
 * action refuses with `conflict`, so nobody confirms one picture and gets
 * another. The modal then shows the new picture and asks again.
 * ------------------------------------------------------------------------- */

/** What happens to one group of records. */
export type ImpactEffect =
  /** Gone with the record. */
  | "deleted"
  /** Kept, but no longer attached to it (a foreign key set to null, a link row removed). */
  | "unlinked"
  /** Kept and attached, with something on it rewritten. */
  | "changed"
  /** Taken off the salesmen's handsets on their next sync. */
  | "phones"
  /** Kept exactly as it is — named so nobody assumes it goes too. */
  | "kept";

/** The words each effect is said in, on the modal. */
export const EFFECT_WORDS: Record<ImpactEffect, string> = {
  deleted: "Will be deleted",
  unlinked: "Will be unlinked",
  changed: "Will change",
  phones: "Will leave the handsets",
  kept: "Stays as it is",
};

/** One group of affected records. */
export type ImpactItem = {
  /** The app they live in, as the launcher names it: "CRM", "ERP", "Sales Dashboard"… */
  app: string;
  /** What they are, plural, in plain words: "orders", "rates on this list". */
  label: string;
  effect: ImpactEffect;
  count: number;
  /** A few of them by name, so a number has faces. At most five. */
  examples?: string[];
  /** One sentence where the effect needs saying more exactly. */
  note?: string;
};

/** Everything a delete or change will touch, for one record. */
export type ImpactReport = {
  kind: string;
  id: string;
  /** The record as a person names it: "Customer A", "Diwali, 1 Nov 2026". */
  title: string;
  /** The act, as the button says it: "Delete", "Remove", "Withdraw", "Move to trash". */
  verb: string;
  /** What has to be typed to confirm — the record's own name, or the verb in capitals. */
  confirmWord: string;
  /** Groups of records that move with it, biggest effect first. */
  items: ImpactItem[];
  /**
   * Reasons it cannot be done at all, said in full. A report with blockers is
   * still shown — the person learns WHY — but the button never enables.
   */
  blockers: string[];
  fingerprint: string;
};

/** What the modal sends back with the act. */
export type ImpactConfirmation = { typed: string; fingerprint: string };

/** The field name a confirmation travels under in a form-shaped payload (ERP actions). */
export const IMPACT_FIELD = "__impact";

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Does what was typed match? Case and spacing do not matter; the words do. */
export function typedMatches(typed: string, confirmWord: string): boolean {
  return fold(confirmWord) !== "" && fold(typed) === fold(confirmWord);
}

/**
 * The fingerprint of a report: every group's app, label, effect and count, and
 * any blockers. Examples and notes are left out — they are prose, and a prose
 * edit in a later release must not refuse a confirmation made a second earlier.
 */
export function impactFingerprint(report: Pick<ImpactReport, "kind" | "id" | "items" | "blockers">): string {
  const parts = [
    report.kind,
    report.id,
    ...report.items.map((i) => `${i.app}|${i.label}|${i.effect}|${i.count}`).sort(),
    ...report.blockers.map((b) => `!${b}`).sort(),
  ];
  /* djb2 over the joined text: short, stable, and the same in both runtimes. */
  let h = 5381;
  const text = parts.join("\n");
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${parts.length}:${(h >>> 0).toString(36)}`;
}

/** Read a confirmation out of an ERP-style string payload. */
export function readConfirmation(values: Record<string, string> | undefined): ImpactConfirmation | null {
  const raw = values?.[IMPACT_FIELD];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ImpactConfirmation>;
    return typeof v.typed === "string" && typeof v.fingerprint === "string"
      ? { typed: v.typed, fingerprint: v.fingerprint }
      : null;
  } catch {
    return null;
  }
}
