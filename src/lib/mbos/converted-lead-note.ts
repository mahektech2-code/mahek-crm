/**
 * A NOTE OR A NEXT ACTION QUEUED ON A LEAD THAT HAS SINCE BECOME A CUSTOMER —
 * the pure half of the rule `handleLeadUpdate` applies. No I/O, so it is tested
 * without a database (`converted-lead-note.test.ts`).
 *
 * The outbox drains hours after it was written. A salesman who added a note to
 * a lead in a market with no signal, while accounts billed the shop's first
 * order at a desk, sent a lead update about a row that is now `kind =
 * 'customer'` — and the handler refused it: "is a customer now, not a lead".
 * That was right for a rung, a qualification or a hold, which mean nothing on
 * a customer. It was wrong for a sentence somebody typed about the shop, which
 * is exactly as true after the conversion as before it, and refusing it put
 * the note in `/rejections` for ever with nowhere else to go.
 *
 * So an update that carries NOTHING but a note, a next action and the activity
 * stamps is accepted, and what it says lands on the customer's timeline. Any
 * other field in the payload keeps the refusal: half-applying a lead change to
 * a customer would be worse than the honest no.
 */

/** Every key `addNote`, `setNextAction` and `touchLead` put on the wire. */
const AFTER_CONVERSION_KEYS = new Set([
  "id",
  "notes",
  "lastActivityDate",
  "nextAction",
  "nextActionDate",
  "nextActionOwnerId",
  "nextActionOutcome",
  "nextFollowUpDate",
]);

/** Whether this lead update may still be taken once the lead is a customer. */
export function survivesConversion(payload: Record<string, unknown> | null | undefined): boolean {
  const keys = Object.keys(payload ?? {});
  return keys.length > 0 && keys.every((k) => AFTER_CONVERSION_KEYS.has(k));
}

/**
 * The sentence that is NEW in this note list.
 *
 * The handset sends its whole note list flattened into one string, every time,
 * because it appends locally (`wireNotes`). What the office already stored is
 * a prefix of it when nothing came between; the remainder is what he just
 * wrote. Where they do not line up — the office's copy was edited, or the row
 * never had his notes — the last line is the newest note, which is how the
 * handset orders them. Null when nothing new was said.
 */
export function newNoteText(stored: string | null | undefined, wire: string | null | undefined): string | null {
  const sent = (wire ?? "").trim();
  if (!sent) return null;
  const had = (stored ?? "").trim();
  if (had && sent === had) return null;
  if (had && sent.startsWith(had)) {
    const rest = sent.slice(had.length).trim();
    return rest || null;
  }
  const lines = sent.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}
