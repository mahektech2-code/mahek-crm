/**
 * WHICH CALL OF THE DAY A MARK ON THE MAP IS.
 *
 * The Live map drew every act as the same dot, so a day's work read as a
 * scatter with nothing in it a manager could act on: he already knows his
 * salesman made visits, and what he wants is WHICH shops and in what order.
 * The order is what turns the scatter into a morning somebody walked.
 *
 * Pure and structurally typed, like `live-feed.ts` beside it and for the same
 * two reasons: the map that draws these is a client component and could not
 * import anything declared next to `server-only`, and a rule that decides the
 * number on four hundred pins a day should be exercisable without a browser,
 * a map key or a database.
 */

/** Enough of an activity mark to number it — `ActivityPoint`'s own shape. */
export type VisitMark = {
  salesmanId: string;
  entityType: string;
  customerId: string | null;
  /** The check-in. A raw `db.execute` hands timestamps back as STRINGS. */
  visitStartAt: Date | string | null;
  capturedAt: Date | string | null;
};

/** A timestamp off the wire is a string whatever the type beside it says. */
export function markMs(at: Date | string | null | undefined): number {
  if (!at) return 0;
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The day's visits, in the order they were made, numbered per salesman.
 *
 * **The number restarts for each man**, because it is the order of HIS day:
 * two salesmen on one screen both have a Visit 1, and the card a pin opens
 * names the shop. A single sequence across the team would be a number nobody
 * could reconcile against anything.
 *
 * **Ordered by the CHECK-IN and not by the fix.** The two are normally seconds
 * apart — the position is taken as he walks in — but they answer different
 * questions, and the one the number is about is when he walked in. Where a
 * visit has no check-in time at all the fix is the only answer there is.
 *
 * **It numbers what can be DRAWN.** A mark with no customer behind it is not a
 * visit anybody can name, so it is left to the general activity layer rather
 * than given a number that opens nothing. A visit made where the handset could
 * get no fix has no row here at all — there is nowhere on a map to put it, and
 * inventing a spot is the one thing a map of where things happened must not
 * do — so these numbers count the pins. The check-in time travels on the card
 * for exactly that reason: it is what reconciles a pin against the Visits
 * screen, which lists every visit whether or not it has a position.
 */
export function numberVisits<M extends VisitMark>(marks: M[]): Array<M & { seq: number }> {
  const visits = marks.filter((a) => a.entityType === "visit" && a.customerId);
  visits.sort((a, b) => visitMs(a) - visitMs(b));
  const seen = new Map<string, number>();
  return visits.map((a) => {
    const seq = (seen.get(a.salesmanId) ?? 0) + 1;
    seen.set(a.salesmanId, seq);
    return { ...a, seq };
  });
}

/** Everything the numbered layer does not draw — every other kind of act. */
export function otherMarks<M extends VisitMark>(marks: M[]): M[] {
  return marks.filter((a) => !(a.entityType === "visit" && a.customerId));
}

function visitMs(a: VisitMark): number {
  return markMs(a.visitStartAt) || markMs(a.capturedAt);
}
