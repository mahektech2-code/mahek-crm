import { PLACE_KINDS, type PlaceKind } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * A transporter's godowns and the people at each — the rule, PURE and
 * client-safe, so the form checks what the save checks.
 *
 * A godown is ONE place on the reviewed place tree, picked State → District →
 * City → Area on the godown's own row (the narrowest pick is the place), its
 * street address as typed, and the people there with up to three numbers
 * each. A single searchable list of every town in the country was too long to
 * find one in; four short lists, each narrowed by the one above, are not.
 * ------------------------------------------------------------------------- */

export const MAX_PHONES = 3;

export type PlaceOption = { id: string; kind: PlaceKind; name: string; parentId: string | null };
export type PlaceLookup = Map<string, PlaceOption>;

export type ContactInput = { id?: string | null; name?: string | null; role?: string | null; phones?: (string | null)[] };
export type GodownInput = { id?: string | null; label?: string | null; placeId?: string | null; address?: string | null; contacts?: ContactInput[] };

export type Contact = { id: string | null; name: string | null; role: string | null; phones: string[] };
export type Godown = { id: string | null; label: string | null; placeId: string | null; address: string | null; contacts: Contact[] };

export function lookup(nodes: PlaceOption[]): PlaceLookup {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** "Bhiwandi, Thane, Maharashtra" — the place and the path above it. */
export function placePath(id: string | null, byId: PlaceLookup): string {
  const out: string[] = [];
  let at = id ? byId.get(id) : undefined;
  while (at && !out.includes(at.name) && out.length < 6) {
    out.push(at.name);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return out.join(", ");
}

/** The picked rung of each kind on the way down to `id`: what the four pickers show. */
export function placeChain(id: string | null, byId: PlaceLookup): Partial<Record<PlaceKind, string>> {
  const out: Partial<Record<PlaceKind, string>> = {};
  let at = id ? byId.get(id) : undefined;
  for (let i = 0; at && i < 6; i++) {
    if (!out[at.kind]) out[at.kind] = at.id;
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return out;
}

/**
 * What one picker offers: the places of its kind under the rung picked above
 * it, by name. A rung with nothing picked above offers nothing — except the
 * state, which is the top.
 */
export function placeChoices(nodes: PlaceOption[], kind: PlaceKind, chain: Partial<Record<PlaceKind, string>>): PlaceOption[] {
  const above = PLACE_KINDS[PLACE_KINDS.indexOf(kind) - 1];
  const parent = above ? chain[above] : null;
  if (above && !parent) return [];
  return nodes.filter((n) => n.kind === kind && (above ? n.parentId === parent : true)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The place a godown is in once a rung is picked (or cleared): the narrowest pick left, with every rung below it cleared. */
export function pickRung(chain: Partial<Record<PlaceKind, string>>, kind: PlaceKind, id: string | null): string | null {
  const at = PLACE_KINDS.indexOf(kind);
  if (id) return id;
  for (let i = at - 1; i >= 0; i--) {
    const v = chain[PLACE_KINDS[i]];
    if (v) return v;
  }
  return null;
}

const tidy = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ") || null;
const digits = (s: string) => s.replace(/\D/g, "").length;

/**
 * The godowns as they will be stored, or the first thing wrong with them,
 * named by its place on the form (`g2.c1.phones`). Wholly empty rows are
 * dropped rather than refused — an untouched "Add contact" is not a mistake.
 */
export function cleanGodowns(input: GodownInput[], knownPlace: (id: string) => boolean): { ok: true; godowns: Godown[] } | { ok: false; field: string; message: string } {
  const out: Godown[] = [];
  for (const [gi, g] of input.entries()) {
    const at = `g${gi + 1}`;
    const contacts: Contact[] = [];
    for (const [ci, c] of (g.contacts ?? []).entries()) {
      const phones = [...new Set((c.phones ?? []).map(tidy).filter((p): p is string => !!p))];
      const name = tidy(c.name);
      const role = tidy(c.role);
      if (!name && !role && !phones.length) continue;
      const field = `${at}.c${ci + 1}`;
      if (phones.length > MAX_PHONES) return { ok: false, field: `${field}.phones`, message: `A person takes up to ${MAX_PHONES} numbers` };
      const bad = phones.find((p) => digits(p) < 6 || digits(p) > 15 || /[^\d\s+()-]/.test(p));
      if (bad) return { ok: false, field: `${field}.phones`, message: `${bad} does not look like a phone number` };
      if (!name && !phones.length) return { ok: false, field: `${field}.name`, message: "Give the person a name or a number" };
      contacts.push({ id: c.id ?? null, name, role, phones });
    }
    const placeId = g.placeId || null;
    const label = tidy(g.label);
    const address = tidy(g.address);
    if (!placeId && !label && !address && !contacts.length) continue;
    if (placeId && !knownPlace(placeId)) return { ok: false, field: `${at}.placeId`, message: "That place is no longer on the list. Pick it again." };
    if (!placeId && !address) return { ok: false, field: `${at}.placeId`, message: `Pick the place for godown ${gi + 1}` };
    out.push({ id: g.id ?? null, label, placeId, address, contacts });
  }
  return { ok: true, godowns: out };
}

/**
 * What the transporter row mirrors for the call buttons: the first person with
 * a number, else the first with a name.
 */
export function mirrorsFrom(godowns: Godown[]): { contactPerson: string | null; phone: string | null; altPhone: string | null } {
  const people = godowns.flatMap((g) => g.contacts);
  const c = people.find((p) => p.phones.length) ?? people.find((p) => p.name);
  return c ? { contactPerson: c.name, phone: c.phones[0] ?? null, altPhone: c.phones[1] ?? null } : { contactPerson: null, phone: null, altPhone: null };
}
