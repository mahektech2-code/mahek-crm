import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { refOptions } from "@/lib/erp/refs";
import { transporterChoices } from "@/lib/erp/transporter-rename";
import type { PlaceOption, PlacePick } from "@/lib/erp/transporter-godowns";
import { resolveCustomerPick } from "@/lib/customer-place";
import { placeIdsFor, placeOptions } from "@/lib/services/place-write";
import { today } from "@/lib/recompute";

/* ---------------------------------------------------------------------------
 * What the customer add and edit forms offer, and the one write the place
 * pickers make. Read when a form opens, so every list is as of that moment —
 * a price list published a minute ago is in the dropdown.
 * ------------------------------------------------------------------------- */

export type CustomerFormOptions = {
  /** The reviewed place tree — state, district, city, area. */
  placeTree: PlaceOption[];
  /** Every price list in force or yet to start, by its full name. */
  priceLists: string[];
  /** ERP → Settings → Reference lists → Counter type, plus every value already on a customer. */
  counterTypes: string[];
  /** The ERP's Transporters list. */
  transporters: string[];
};

/**
 * Price lists a customer can be put on: published, and not ended. Names only,
 * one each — two versions of one list share a name, and the customer is tagged
 * with the list, not the version.
 */
export async function priceListNames(): Promise<string[]> {
  const day = await today();
  const rows = (await db.execute(sql`
    select distinct trim(name) as name from price_lists
     where status = 'published' and (effective_to is null or effective_to >= ${day}::date) and trim(name) <> ''
     order by 1
  `)) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

export async function customerFormOptions(): Promise<CustomerFormOptions> {
  const [placeTree, priceLists, counterTypes, transporters] = await Promise.all([
    placeOptions(),
    priceListNames(),
    refOptions("counterType"),
    transporterChoices(),
  ]);
  return { placeTree, priceLists, counterTypes, transporters };
}

/**
 * Files a customer under the place a person picked, adding any district, city
 * or area they typed because it was not listed. The four ids, the typed
 * `city`/`region`/`area` mirrors (every screen that shows a town reads them as
 * a fallback) and the mark that a PERSON decided it — so the nightly place
 * job, which re-reads typed places, never moves it.
 */
export async function writeCustomerPlace(
  customerId: string,
  pick: PlacePick,
  actorId: string,
): Promise<{ ok: true; names: { state: string; district: string; city: string; area: string | null } } | { ok: false; message: string }> {
  const tree = await placeOptions();
  const resolved = resolveCustomerPick(pick, tree);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const name = (k: string) => resolved.rungs.find((r) => r.kind === k)?.name ?? null;
  await db.transaction(async (tx) => {
    const ids = await placeIdsFor(tx, resolved.rungs);
    const id = (k: string) => ids.find((r) => r.kind === k)?.id ?? null;
    await tx.execute(sql`
      update customers set
        resolved_state_id = ${id("state")},
        resolved_district_id = ${id("district")},
        resolved_city_id = ${id("city")},
        resolved_area_id = ${id("area")},
        region = ${name("state")},
        city = ${name("city")},
        area = ${name("area")},
        place_source = 'manual',
        place_resolved_at = now(),
        place_decided_at = now(),
        place_decided_by_id = ${actorId},
        updated_at = now()
       where id = ${customerId}
    `);
  });
  return { ok: true, names: { state: name("state")!, district: name("district")!, city: name("city")!, area: name("area") } };
}
