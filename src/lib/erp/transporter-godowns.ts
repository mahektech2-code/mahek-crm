import type { PlaceKind } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * A transporter's godowns and the people at each — the rule, PURE and
 * client-safe, so the form checks what the save checks.
 *
 * A godown is ONE town on the reviewed place tree (a city, or an area inside
 * one), its street address as typed, and the people there with up to three
 * numbers each. It replaced four cascading state/district/city/area pickers,
 * which made a company with godowns in two states a puzzle of which district
 * belonged to which city; a godown per row says the same thing plainly.
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

/** The towns a godown can be in — every city and area, named with the path above it. */
export function townOptions(nodes: PlaceOption[], byId: PlaceLookup): { id: string; label: string }[] {
  const seen = new Map<string, number>();
  return nodes
    .filter((n) => n.kind === "city" || n.kind === "area")
    .map((n) => ({ id: n.id, label: placePath(n.id, byId) }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((o) => {
      const n = (seen.get(o.label) ?? 0) + 1;
      seen.set(o.label, n);
      return n === 1 ? o : { ...o, label: `${o.label} (${n})` };
    });
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
    if (placeId && !knownPlace(placeId)) return { ok: false, field: `${at}.placeId`, message: "That town is no longer on the list. Pick it again." };
    if (!placeId && !address) return { ok: false, field: `${at}.placeId`, message: `Pick the town for godown ${gi + 1}` };
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
