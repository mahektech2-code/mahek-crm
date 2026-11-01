/* ---------------------------------------------------------------------------
 * WHICH BULK ACTIONS THE TICKED ROWS CAN TAKE. PURE and client-safe.
 *
 * The selection bar used to draw every bulk action a tab has, whatever was
 * ticked — one Verified line offered Verify order, Bill together and Print
 * invoices beside the two that could actually happen. A row already says what
 * can be done to it: its record carries an action only where it applies, and
 * fills `why` where it applies but cannot run yet. So the bar asks the rows
 * rather than keeping a second copy of every rule.
 *
 * An action is offered when at least one ticked row can take it — a mixed
 * selection still gets "Ready" for the lines that can be made ready, and the
 * act itself says which it refused. Where only some can, the count is said
 * on the button, so nobody presses it believing it covers the lot.
 *
 * A row the page does not hold (a "Select all" past this page) or a row with
 * no actions at all cannot be judged here, and never hides anything.
 * ------------------------------------------------------------------------- */
import type { BulkSpec, ListRow } from "./ui";

export type BulkOffer = { b: BulkSpec; label: string };

export function bulkOffers(bulk: BulkSpec[], held: ListRow[], chosen: string[]): BulkOffer[] {
  const byId = new Map<string, ListRow>();
  for (const r of held) for (const x of [r, ...(r.sub ?? [])]) byId.set(x.id, x);
  const judged = chosen.map((id) => byId.get(id)).filter((r): r is ListRow => !!r && !!r.actions);
  /* Every ticked row is in hand, so a count can be said against all of them. */
  const whole = judged.length === chosen.length;
  const out: BulkOffer[] = [];
  for (const b of bulk) {
    if (b.fits === false || !judged.length) {
      out.push({ b, label: b.l });
      continue;
    }
    const key = b.fits ?? b.id;
    const n = judged.filter((r) => r.actions!.some((a) => a.id === key && !a.why)).length;
    if (!n) continue;
    out.push({ b, label: whole && n < judged.length ? `${b.l} · ${n} of ${judged.length}` : b.l });
  }
  return out;
}
