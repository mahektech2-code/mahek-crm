import "server-only";
import { cache } from "react";
import { canOpen, listUserModules } from "@/lib/access";
import { NAV_CATEGORIES, categoryModuleSlug } from "./catalogue";

/* ---------------------------------------------------------------------------
 * WHAT THIS PERSON MAY OPEN IN THE LOCKER. The design's "tabs a person holds"
 * are MahekOne modules (lib/modules.ts, `locker.*`), ticked on the Access
 * screen; this reads them once per request and answers the questions every
 * screen asks — which categories, whether the vault, whether to approve.
 *
 * A REGISTER CATEGORY IS A SCOPE as well as a screen. Somebody holding only
 * Vehicles sees vehicle assets on the dashboard, in search and on the
 * calendar, and nothing else; holding All assets with no category ticked
 * means every category (the design's own rule: `has('assets') && !anyCat`).
 * ------------------------------------------------------------------------- */

export type LockerAccess = {
  keys: Set<string>;
  has: (key: string) => boolean;
  /** May open assets of this category (its module, or All assets with none narrowed). */
  catOk: (category: string) => boolean;
  /** The categories visible at all. */
  categories: string[];
  vault: boolean;
  canApprove: boolean;
  isAdmin: boolean;
};

export const lockerAccess = cache(async function lockerAccess(userId: string): Promise<LockerAccess> {
  const keys = new Set<string>();
  if (await canOpen(userId, "locker")) {
    for (const m of await listUserModules(userId, "locker")) keys.add(m.key);
  }
  const has = (k: string) => keys.has(k);
  const anyCat = NAV_CATEGORIES.some((c) => has(`locker.cat.${c}`));
  const catOk = (category: string) => {
    const slug = categoryModuleSlug(category);
    return has(`locker.cat.${slug}`) || (has("locker.assets") && !anyCat);
  };
  const all = ["statutory", "hazardous", "insurance", "vehicles", "property", "contracts", "ip", "cert", "banking", "digital", "software", "corporate"];
  return {
    keys,
    has,
    catOk,
    categories: all.filter(catOk),
    vault: has("locker.credentials"),
    canApprove: has("locker.approvals"),
    isAdmin: has("locker.access") || has("locker.types"),
  };
});

/** For server actions: refuse unless the module is held. Returns the refusal sentence, or null. */
export async function lockerRefusal(userId: string, key: string): Promise<string | null> {
  const a = await lockerAccess(userId);
  return a.has(key) ? null : "You do not have this part of the Locker. A Locker admin can give it to you under Admin › Access.";
}
