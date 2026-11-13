import "server-only";
import { lockerAccess } from "@/lib/locker/access";
import { canEditRegister, toLite } from "@/lib/locker/register-service";
import { lockerEntitiesList, lockerSitesList, registerFor, today } from "@/lib/locker/service";

/** Everything the register screen needs, scoped to the person. */
export async function loadRegister(userId: string) {
  const day = today();
  const [access, rows, entities, sites] = await Promise.all([lockerAccess(userId), registerFor(userId, day), lockerEntitiesList(), lockerSitesList()]);
  return {
    access,
    rows: rows.filter((a) => a.live).map(toLite),
    entities: entities.map((e) => ({ id: e.id, name: e.name, gstin: e.gstin })),
    sites: sites.map((s) => ({ id: s.id, name: s.name, hazardous: s.hazardous })),
    canAdd: canEditRegister(access) && access.categories.length > 0,
  };
}

export const VIEWS = ["all", "d30", "d90", "over", "unowned", "unver", "crit", "prog", "mine"] as const;
export const viewOf = (v: string | undefined) => ((VIEWS as readonly string[]).includes(v ?? "") ? (v as (typeof VIEWS)[number]) : "all");
