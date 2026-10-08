/* ---------------------------------------------------------------------------
 * WHO DOES WHAT TO ONE MATERIAL.
 *
 * Four duties, each set per raw material by an ERP administrator from the
 * material's record:
 *
 *   request   raise a purchase requirement for it
 *   raisePo   put its requirement on a purchase order
 *   approve   approve (or send back) a PO that carries it
 *   test      record a quality test of its lots — chemicals only
 *
 * A duty names PEOPLE, DEPARTMENTS (ERP designations: everybody holding
 * "Production", "Purchase / store", "Quality tester"…), or both.
 *
 * UNCONFIGURED IS THE OLD RULE, which is what let this ship without moving
 * anybody: a duty nobody has been named for is open to whoever holds the
 * screen — and approval to whoever holds "Approve purchase orders". Once a
 * duty names anybody, it is theirs alone for this material, plus an ERP
 * administrator's; for approval that means a named person approves without
 * the power and an unnamed power holder no longer does. A PO carries several
 * materials, so raising or approving one needs the duty for every line.
 *
 * This decides who may DO it. Seeing the screen is still the screen's grant,
 * and the other rules (nobody approves a PO they raised; a department raises
 * for its own categories) still apply on top.
 *
 * PURE and client-safe: the record drawer says who holds each duty, and the
 * form that sets them is drawn from the same list the server enforces.
 * ------------------------------------------------------------------------- */

export const MATERIAL_DUTIES = ["request", "raisePo", "approve", "test"] as const;
export type MaterialDuty = (typeof MATERIAL_DUTIES)[number];

export const DUTY_LABEL: Record<MaterialDuty, { label: string; verb: string; open: string; chemicalOnly?: true }> = {
  request: { label: "Who can request it", verb: "raise a requirement for", open: "Anyone who can raise requirements" },
  raisePo: { label: "Who can raise the PO", verb: "raise a PO for", open: "Anyone who can raise purchase orders" },
  approve: { label: "Who approves the PO", verb: "approve a PO for", open: "Anyone with “Approve purchase orders”" },
  test: { label: "Who tests it", verb: "test", open: "Anyone who can record tests", chemicalOnly: true },
};

export function isMaterialDuty(v: unknown): v is MaterialDuty {
  return typeof v === "string" && (MATERIAL_DUTIES as readonly string[]).includes(v);
}

/** Whether a duty applies to a category: testing is a chemical's alone. */
export function dutyApplies(duty: MaterialDuty, materialType: string): boolean {
  return !DUTY_LABEL[duty].chemicalOnly || materialType === "Chemical";
}

/** Who one duty of one material is set to. Both empty: not configured. */
export type DutyHolders = { userIds: string[]; designationIds: string[] };

/** Every configured duty, by material id. A material or duty absent from it is unconfigured. */
export type DutyBook = Map<string, Partial<Record<MaterialDuty, DutyHolders>>>;

/** The person asking: who they are, the designation they hold, and whether they administer the ERP. */
export type DutyActor = { userId: string; designationIds: readonly string[]; administrator: boolean };

export function isConfigured(h: DutyHolders | undefined): h is DutyHolders {
  return !!h && (h.userIds.length > 0 || h.designationIds.length > 0);
}

/**
 * May `actor` do `duty` for this material? `fallback` is the answer where the
 * duty is not configured — the rule that held before: `true` for the screens,
 * the approver power for approval.
 */
export function dutyAllows(book: DutyBook, materialId: string, duty: MaterialDuty, actor: DutyActor, fallback: boolean): boolean {
  if (actor.administrator) return true;
  const h = book.get(materialId)?.[duty];
  if (!isConfigured(h)) return fallback;
  return h.userIds.includes(actor.userId) || h.designationIds.some((d) => actor.designationIds.includes(d));
}

/** The same question over several materials at once — a PO's lines. All of them must allow it. */
export function dutyAllowsAll(book: DutyBook, materialIds: readonly string[], duty: MaterialDuty, actor: DutyActor, fallback: boolean): boolean {
  return materialIds.every((id) => dutyAllows(book, id, duty, actor, fallback));
}

/**
 * The sentence a disabled button carries, naming who the duty belongs to —
 * "Raising a PO for Mix Xylene is set to Priya Shah, Purchase / store". Null
 * where the duty is not configured for this material (the caller's own rule
 * explains a refusal then).
 */
export function dutyRefusal(
  book: DutyBook,
  material: { id: string; name: string },
  duty: MaterialDuty,
  names: { users: ReadonlyMap<string, string>; designations: ReadonlyMap<string, string> },
): string | null {
  const h = book.get(material.id)?.[duty];
  if (!isConfigured(h)) return null;
  const who = holderNames(h, names);
  const what = { request: "Requesting", raisePo: "Raising a PO for", approve: "Approving a PO for", test: "Testing" }[duty];
  return `${what} ${material.name} is set to ${who.length ? who.join(", ") : "somebody no longer here"}`;
}

/** Holders in words: people by name, departments by designation name. Unknown ids are left out. */
export function holderNames(h: DutyHolders, names: { users: ReadonlyMap<string, string>; designations: ReadonlyMap<string, string> }): string[] {
  return [
    ...h.userIds.map((id) => names.users.get(id)).filter((x): x is string => !!x),
    ...h.designationIds.map((id) => names.designations.get(id)).filter((x): x is string => !!x),
  ];
}

/** Rows as stored → the book. */
export function dutyBookFrom(rows: readonly { rawMaterialId: string; duty: string; userId: string | null; designationId: string | null }[]): DutyBook {
  const book: DutyBook = new Map();
  for (const r of rows) {
    if (!isMaterialDuty(r.duty)) continue;
    const m = book.get(r.rawMaterialId) ?? book.set(r.rawMaterialId, {}).get(r.rawMaterialId)!;
    const h = (m[r.duty] ??= { userIds: [], designationIds: [] });
    if (r.userId) h.userIds.push(r.userId);
    if (r.designationId) h.designationIds.push(r.designationId);
  }
  return book;
}
