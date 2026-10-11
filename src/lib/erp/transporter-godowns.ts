/* ---------------------------------------------------------------------------
 * A transporter's godowns and the people at each — the rule, PURE and
 * client-safe, so the form checks what the save checks.
 *
 * A godown is a TOWN AS TYPED, its street address, and the people there with
 * up to three numbers each. The town was picked from the reviewed place tree
 * for a while; every city and area in India is far too long a list to scroll
 * for the one town a transporter's godown is in, so it is typed again.
 * ------------------------------------------------------------------------- */

export const MAX_PHONES = 3;

export type ContactInput = { id?: string | null; name?: string | null; role?: string | null; phones?: (string | null)[] };
export type GodownInput = { id?: string | null; label?: string | null; town?: string | null; address?: string | null; contacts?: ContactInput[] };

export type Contact = { id: string | null; name: string | null; role: string | null; phones: string[] };
export type Godown = { id: string | null; label: string | null; town: string | null; address: string | null; contacts: Contact[] };

const tidy = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ") || null;
const digits = (s: string) => s.replace(/\D/g, "").length;

/**
 * The godowns as they will be stored, or the first thing wrong with them,
 * named by its place on the form (`g2.c1.phones`). Wholly empty rows are
 * dropped rather than refused — an untouched "Add contact" is not a mistake.
 */
export function cleanGodowns(input: GodownInput[]): { ok: true; godowns: Godown[] } | { ok: false; field: string; message: string } {
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
    const town = tidy(g.town);
    const label = tidy(g.label);
    const address = tidy(g.address);
    if (!town && !label && !address && !contacts.length) continue;
    if (!town && !address) return { ok: false, field: `${at}.town`, message: `Type the town for godown ${gi + 1}` };
    out.push({ id: g.id ?? null, label, town, address, contacts });
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
