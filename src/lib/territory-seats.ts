/**
 * The four seats a customer's territory can be read through, for the
 * Territory screen's filter.
 *
 * PURE and client-safe: the filter is a client component and the service that
 * narrows by it is `server-only`, and a second copy of the list typed into the
 * screen is how the two come to disagree about what "field sales" means.
 *
 * - **Sales manager** — `sales_manager_id`, who the salesperson answers to.
 * - **Field sales** — the field salesman whose handset book it is: whoever
 *   holds the Salesman App, read through `coalesce(sales_am_id, owner_id)`,
 *   the same fall-through the screen has always grouped by.
 * - **Sales account manager** — `sales_am_id` itself, telecallers included.
 * - **Back-office account manager** — `back_office_am_id`.
 */
export const TERRITORY_SEATS = [
  { key: "field", label: "Field sales" },
  { key: "sales_am", label: "Sales account manager" },
  { key: "back_office", label: "Back-office account manager" },
  { key: "sales_manager", label: "Sales manager" },
] as const;

export type TerritorySeat = (typeof TERRITORY_SEATS)[number]["key"];

/** "none" asks for the shops nobody holds in that seat. */
export const NOBODY = "none";

export function parseSeat(value: string | undefined): TerritorySeat {
  return TERRITORY_SEATS.some((s) => s.key === value) ? (value as TerritorySeat) : "field";
}

export function seatLabel(seat: TerritorySeat): string {
  return TERRITORY_SEATS.find((s) => s.key === seat)!.label;
}
