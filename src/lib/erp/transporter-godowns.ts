import { checkGstin, gstState } from "@/lib/engines/lead-scan";
import { INDIA_STATES, canonicalState, isKnownState, stateKey } from "@/lib/india-states";
import { PLACE_KINDS, placeKey, type PlaceKind } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * A transporter's godowns and the people at each — the rule, PURE and
 * client-safe, so the godown dialog checks what the save checks.
 *
 * A godown is ONE AREA on the reviewed place tree, picked State → District →
 * City → Area, every rung required, each list narrowed by the rung above it.
 * The tree is built from where Mahek's CUSTOMERS are, so it is missing places
 * a transporter's godown can be in: 211 of its 581 cities carry no area at
 * all. A rung that is not listed is therefore TYPED, under the rung picked
 * above it, and becomes a node on save — matched first on `placeKey` under
 * the same parent, so "Narpoli" typed twice is one place, and a typed name
 * that is already listed is the listed one. A state is never typed: it is
 * picked from the country's own list (`INDIA_STATES`).
 *
 * A godown also carries its OWN GST number. GST is registered per state, so a
 * transporter's godowns in two states have two numbers, and the first two
 * digits of each name the state it was registered in — which has to be the
 * state the godown is picked in.
 * ------------------------------------------------------------------------- */

export const MAX_PHONES = 3;

/** The rungs a godown is picked on: all four, coarsest first, every one required. */
export const GODOWN_PLACE_KINDS = PLACE_KINDS;

export type PlaceOption = { id: string; kind: PlaceKind; name: string; parentId: string | null };
export type PlaceLookup = Map<string, PlaceOption>;

/** One rung as the dialog holds it: a listed place (`id`), or one typed because it is not listed (`name`). */
export type PlaceRung = { id?: string | null; name?: string | null };
export type PlacePick = Partial<Record<PlaceKind, PlaceRung>>;

/** A rung as it will be stored: the listed id, or null with the name to create under the rung above. */
export type ResolvedRung = { kind: PlaceKind; id: string | null; name: string };

export type ContactInput = { id?: string | null; name?: string | null; role?: string | null; phones?: (string | null)[] };
export type GodownInput = {
  id?: string | null;
  label?: string | null;
  /** The four rungs. Where absent, `placeId` is read as the pick it names. */
  place?: PlacePick | null;
  placeId?: string | null;
  gstin?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  contacts?: ContactInput[];
};

export type Contact = { id: string | null; name: string | null; role: string | null; phones: string[] };
export type Godown = {
  id: string | null;
  label: string | null;
  /** State first, area last; a rung with a null id is created on save. */
  place: ResolvedRung[];
  gstin: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  contacts: Contact[];
};

export function lookup(nodes: PlaceOption[]): PlaceLookup {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** "Narpoli, Bhiwandi, Thane, Maharashtra" — the place and the path above it. */
export function placePath(id: string | null, byId: PlaceLookup): string {
  const out: string[] = [];
  let at = id ? byId.get(id) : undefined;
  while (at && !out.includes(at.name) && out.length < 6) {
    out.push(at.name);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return out.join(", ");
}

/** The rung of each kind on the way up from `id`. */
export function placeChain(id: string | null, byId: PlaceLookup): Partial<Record<PlaceKind, string>> {
  const out: Partial<Record<PlaceKind, string>> = {};
  let at = id ? byId.get(id) : undefined;
  for (let i = 0; at && i < 6; i++) {
    if (!out[at.kind]) out[at.kind] = at.id;
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return out;
}

/** A stored place as the dialog's four rungs. A godown filed at a district opens with its city and area still to pick. */
export function pickOf(id: string | null, byId: PlaceLookup): PlacePick {
  const chain = placeChain(id, byId);
  const out: PlacePick = {};
  for (const kind of PLACE_KINDS) if (chain[kind]) out[kind] = { id: chain[kind] };
  return out;
}

/** The name of one rung of a pick, listed or typed. */
export function rungName(r: PlaceRung | undefined, byId: PlaceLookup): string | null {
  if (!r) return null;
  if (r.id) return byId.get(r.id)?.name ?? null;
  return tidy(r.name);
}

/** "Narpoli, Bhiwandi, Thane, Maharashtra" off a pick — what the godown list prints. */
export function pickPath(p: PlacePick, byId: PlaceLookup): string {
  return [...PLACE_KINDS]
    .reverse()
    .map((k) => rungName(p[k], byId))
    .filter(Boolean)
    .join(", ");
}

/**
 * What one picker offers: the listed places of its kind under the rung picked
 * above it, by name. Nothing is listed under a rung that was TYPED — a place
 * nobody has filed anything under yet has no children — and nothing under a
 * rung not picked yet, except the state, which is the top.
 */
export function placeChoices(nodes: PlaceOption[], kind: PlaceKind, pick: PlacePick): PlaceOption[] {
  const above = PLACE_KINDS[PLACE_KINDS.indexOf(kind) - 1];
  const parent = above ? pick[above]?.id : null;
  if (above && !parent) return [];
  return nodes.filter((n) => n.kind === kind && (above ? n.parentId === parent : true)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The pick once one rung is set (or cleared): every rung below it is cleared, because it was picked under the old one. */
export function setRung(pick: PlacePick, kind: PlaceKind, rung: PlaceRung | null): PlacePick {
  const at = PLACE_KINDS.indexOf(kind);
  const out: PlacePick = {};
  for (let i = 0; i < at; i++) if (pick[PLACE_KINDS[i]]) out[PLACE_KINDS[i]] = pick[PLACE_KINDS[i]];
  /* An empty name is kept: it is somebody who pressed "Add … not listed" and has not typed yet. */
  if (rung && (rung.id || rung.name != null)) out[kind] = rung.id ? { id: rung.id } : { name: rung.name ?? "" };
  return out;
}

/** The states the state picker offers beyond the listed ones: the rest of the country, by name, to be added on save. */
export function unlistedStates(nodes: PlaceOption[]): string[] {
  const listed = new Set(nodes.filter((n) => n.kind === "state").map((n) => stateKey(canonicalState(n.name))));
  return INDIA_STATES.filter((s) => !listed.has(stateKey(s)));
}

const KIND_WORD: Record<PlaceKind, string> = { state: "state", district: "district", city: "city", area: "area" };

/**
 * The four rungs as they will be stored, or the first thing wrong. A typed
 * name that is already listed under the same parent becomes that listed place,
 * so nothing is created twice; a state must be a listed one or one of the
 * country's (`knownState`), and is never invented.
 */
export function resolvePick(pick: PlacePick, byId: PlaceLookup, nodes: PlaceOption[]): { ok: true; rungs: ResolvedRung[] } | { ok: false; kind: PlaceKind; message: string } {
  const rungs: ResolvedRung[] = [];
  let parentId: string | null = null;
  let parentTyped = false;
  for (const kind of PLACE_KINDS) {
    const r = pick[kind];
    const word = KIND_WORD[kind];
    if (r?.id) {
      const n = byId.get(r.id);
      if (!n || n.kind !== kind || n.parentId !== parentId || parentTyped) return { ok: false, kind, message: `That ${word} is no longer on the list under the one above it. Pick it again.` };
      rungs.push({ kind, id: n.id, name: n.name });
      parentId = n.id;
      continue;
    }
    let name = tidy(r?.name);
    if (!name) return { ok: false, kind, message: `Pick the ${word}${kind === "state" ? "" : ", or add it if it is not listed"}` };
    if (kind === "state") {
      if (!isKnownState(name)) return { ok: false, kind, message: `${name} is not a state or union territory` };
      name = canonicalState(name);
    }
    if (name.length > 80) return { ok: false, kind, message: `That ${word} name is too long` };
    const key = placeKey(name);
    if (!key) return { ok: false, kind, message: `Write the ${word}'s name` };
    const same = parentTyped ? undefined : nodes.find((n) => n.kind === kind && n.parentId === parentId && placeKey(n.name) === key);
    if (same) {
      rungs.push({ kind, id: same.id, name: same.name });
      parentId = same.id;
    } else {
      rungs.push({ kind, id: null, name });
      parentTyped = true;
      parentId = null;
    }
  }
  return { ok: true, rungs };
}

/**
 * A godown's GST number, checked: its checksum, and that its first two digits
 * name the state the godown is picked in. Null is fine here — whether it is
 * REQUIRED is the save's question, asked in `cleanGodowns`.
 */
export function godownGstProblem(raw: string | null | undefined, stateName: string | null): string | null {
  const g = checkGstin(raw);
  if (!g) return null;
  if (g.check === "invalid") return "That GST number does not check out — it is 15 characters, like 27ABCDE1234F1Z5";
  const registered = gstState(g.gstin);
  if (registered && stateName && stateKey(canonicalState(registered)) !== stateKey(canonicalState(stateName)))
    return `${g.gstin} is registered in ${registered}, but the godown is in ${stateName}. Each godown's GST number is the one for its own state.`;
  return null;
}

const tidy = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ") || null;
const digits = (s: string) => s.replace(/\D/g, "").length;

/** Whether a godown on the form has anything in it at all. A wholly empty one is dropped, never refused. */
function untouched(g: GodownInput, pick: PlacePick): boolean {
  return !Object.values(pick).some((r) => r?.id || tidy(r?.name)) && !tidy(g.label) && !tidy(g.gstin) && !tidy(g.address) && !(g.contacts ?? []).some((c) => tidy(c.name) || tidy(c.role) || (c.phones ?? []).some((p) => tidy(p)));
}

/**
 * The godowns as they will be stored, or the first thing wrong with them,
 * named by its place on the form (`g2.place.city`, `g2.gstin`, `g2.c1.phones`).
 */
export function cleanGodowns(input: GodownInput[], nodes: PlaceOption[]): { ok: true; godowns: Godown[] } | { ok: false; field: string; message: string } {
  const byId = lookup(nodes);
  const out: Godown[] = [];
  for (const [gi, g] of input.entries()) {
    const at = `g${gi + 1}`;
    const pick = g.place ?? pickOf(g.placeId ?? null, byId);
    if (untouched(g, pick)) continue;
    const name = tidy(g.label) ?? `godown ${gi + 1}`;

    const place = resolvePick(pick, byId, nodes);
    if (!place.ok) return { ok: false, field: `${at}.place.${place.kind}`, message: `${cap(name)}: ${place.message}` };

    const gst = checkGstin(g.gstin);
    if (!gst) return { ok: false, field: `${at}.gstin`, message: `${cap(name)}: give its GST number` };
    const gstBad = godownGstProblem(gst.gstin, place.rungs[0].name);
    if (gstBad) return { ok: false, field: `${at}.gstin`, message: `${cap(name)}: ${gstBad}` };

    const contacts: Contact[] = [];
    for (const [ci, c] of (g.contacts ?? []).entries()) {
      const phones = [...new Set((c.phones ?? []).map(tidy).filter((p): p is string => !!p))];
      const cname = tidy(c.name);
      const role = tidy(c.role);
      if (!cname && !role && !phones.length) continue;
      const field = `${at}.c${ci + 1}`;
      if (phones.length > MAX_PHONES) return { ok: false, field: `${field}.phones`, message: `A person takes up to ${MAX_PHONES} numbers` };
      const bad = phones.find((p) => digits(p) < 6 || digits(p) > 15 || /[^\d\s+()-]/.test(p));
      if (bad) return { ok: false, field: `${field}.phones`, message: `${bad} does not look like a phone number` };
      if (!cname && !phones.length) return { ok: false, field: `${field}.name`, message: "Give the person a name or a number" };
      contacts.push({ id: c.id ?? null, name: cname, role, phones });
    }
    const hasLat = g.lat != null && Number.isFinite(g.lat);
    const hasLng = g.lng != null && Number.isFinite(g.lng);
    if (hasLat !== hasLng) return { ok: false, field: `${at}.pin`, message: "A pin is a latitude and a longitude — give both, or neither" };
    if (hasLat && (Math.abs(g.lat as number) > 90 || Math.abs(g.lng as number) > 180)) return { ok: false, field: `${at}.pin`, message: "That pin is not on the map — latitude is −90 to 90, longitude −180 to 180" };
    out.push({ id: g.id ?? null, label: tidy(g.label), place: place.rungs, gstin: gst.gstin, address: tidy(g.address), lat: hasLat ? (g.lat as number) : null, lng: hasLng ? (g.lng as number) : null, contacts });
  }
  return { ok: true, godowns: out };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the transporter row mirrors for the call buttons: the first person with
 * a number, else the first with a name.
 */
export function mirrorsFrom(godowns: { contacts: Contact[] }[]): { contactPerson: string | null; phone: string | null; altPhone: string | null } {
  const people = godowns.flatMap((g) => g.contacts);
  const c = people.find((p) => p.phones.length) ?? people.find((p) => p.name);
  return c ? { contactPerson: c.name, phone: c.phones[0] ?? null, altPhone: c.phones[1] ?? null } : { contactPerson: null, phone: null, altPhone: null };
}
