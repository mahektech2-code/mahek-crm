/**
 * WHERE A LEAD MAY BE RAISED, as the choices the lead form offers.
 *
 * Mahek's rule is that a salesman raises leads inside his own area, and the
 * office enforces it in `handleLead` — but refused there, the lead goes to
 * `/rejections` with the shop, the photograph and the pin behind it, so the
 * form asks the question first and offers only places that will be accepted.
 * The areas are the office's own list (`TerritoryState.areas`), and picking one
 * also says which STATE the shop is in, which is what puts the lead in a
 * territory at all: a lead filed under a town and no state matched none, and
 * reached nobody's Customers tab, its author's included.
 *
 * Pure, like every engine here, so the rule about what the form will and will
 * not let through can be tested without a phone.
 */

export type AreaRow = { kind: string; value: string; parent: string | null };

export type AreaChoice = {
  key: string;
  label: string;
  /** The town the lead is filed under, or null where he has to type it. */
  city: string | null;
  /** The locality, for a beat. */
  area: string | null;
  state: string | null;
};

/** What the form should do, given what the office last said about him. */
export type AreaRule =
  /* An older server that sends no areas, or a manager or admin whom nothing
     narrows: the form is as it always was. */
  | { kind: 'free' }
  /* Nowhere allocated: no lead can be raised, and the form says why. */
  | { kind: 'none' }
  | { kind: 'pick'; choices: AreaChoice[] };

export function areaRule(
  territory: { exempt: boolean; areas?: AreaRow[] } | null,
): AreaRule {
  if (!territory || !Array.isArray(territory.areas)) return { kind: 'free' };
  if (!territory.areas.length) return territory.exempt ? { kind: 'free' } : { kind: 'none' };

  const seen = new Set<string>();
  const choices: AreaChoice[] = [];
  for (const t of territory.areas) {
    const parent = t.parent?.trim() || null;
    const choice: AreaChoice =
      t.kind === 'city'
        ? { key: '', label: parent ? `${t.value} · ${parent}` : t.value, city: t.value, area: null, state: parent }
        : t.kind === 'beat'
          ? { key: '', label: parent ? `${t.value} · ${parent}` : t.value, city: parent, area: t.value, state: null }
          : { key: '', label: t.value, city: null, area: null, state: t.value };
    choice.key = `${t.kind}|${t.value}|${parent ?? ''}`.toLowerCase();
    /* A state allocated twice — once as his working area and once as a
       manager's region row — is one choice, not two identical chips. */
    const dedupe = choice.city === null && choice.area === null ? `state|${t.value}`.toLowerCase() : choice.key;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    choices.push(choice);
  }
  /* Towns first, because a town picks itself and a state still asks one. */
  choices.sort((a, b) => Number(a.city === null) - Number(b.city === null) || a.label.localeCompare(b.label));
  return { kind: 'pick', choices };
}
