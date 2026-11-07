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

/** `row` is set on an `asRow` offer: the one record the selection is, whose own action it runs. */
export type BulkOffer = { b: BulkSpec; label: string; row?: ListRow };

/* THE SHAPE OF A SELECTION. `same` names row values every ticked row must
   share — one PR, one party — so a selection of one PR's lines is offered that
   PR's own work and a selection across PRs is offered only what each line can
   take alone. It can be judged only where every ticked row is in hand. */
function shared(rows: ListRow[], keys: string[] | undefined): boolean {
  return !keys?.length || keys.every((k) => new Set(rows.map((r) => String(r.v[k] ?? ""))).size === 1);
}

function judge(held: ListRow[], chosen: string[]) {
  const byId = new Map<string, ListRow>();
  for (const r of held) for (const x of [r, ...(r.sub ?? [])]) byId.set(x.id, x);
  const judged = chosen.map((id) => byId.get(id)).filter((r): r is ListRow => !!r && !!r.actions);
  /* Every ticked row is in hand, so a count can be said against all of them. */
  return { judged, whole: judged.length > 0 && judged.length === chosen.length };
}

const canTake = (r: ListRow, key: string) => r.actions!.some((a) => a.id === key && !a.why);

export function bulkOffers(bulk: BulkSpec[], held: ListRow[], chosen: string[]): BulkOffer[] {
  const { judged, whole } = judge(held, chosen);
  const out: BulkOffer[] = [];
  for (const b of bulk) {
    const key = b.fits || b.id;
    if (b.asRow) {
      /* One record's own action: only when that record is certainly all that is ticked. */
      const r = whole && shared(judged, b.same) ? judged.find((x) => canTake(x, key)) : undefined;
      if (r) out.push({ b, label: b.l, row: r });
      continue;
    }
    if (whole && !shared(judged, b.same)) continue;
    if (b.fits === false || !judged.length) {
      out.push({ b, label: b.l });
      continue;
    }
    const n = judged.filter((r) => canTake(r, key)).length;
    if (!n) continue;
    out.push({ b, label: whole && n < judged.length ? `${b.l} · ${n} of ${judged.length}` : b.l });
  }
  return out;
}

/**
 * What a narrower selection would add: the actions held back only because the
 * ticks span more than one of something — "with one PR ticked: Transport &
 * costs". Said in the Combined view so the shape rule is seen, not guessed at.
 */
export function narrowerOffers(bulk: BulkSpec[], held: ListRow[], chosen: string[]): { same: string[]; l: string }[] {
  const { judged, whole } = judge(held, chosen);
  if (!whole) return [];
  return bulk
    .filter((b) => b.same?.length && !shared(judged, b.same) && (b.fits === false || judged.some((r) => canTake(r, b.fits || b.id))))
    .map((b) => ({ same: b.same!, l: b.l }));
}
