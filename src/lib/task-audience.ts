/* ---------------------------------------------------------------------------
 * WHO A TASK GOES TO — PURE and client-safe.
 *
 * Two independent questions, because every real assignment is some mix of
 * them: WHICH SHOPS is it about (none at all, a hand-picked list, or every
 * shop a place-and-filter pick reaches), and WHO DOES IT (each shop's own
 * salesman, or a set of salesmen named here). "Ask Rahul and Seema to send a
 * photo of the godown" is no shops and two people; "every lead in Thane,
 * photographed by whoever carries it" is a filter and its carriers; "these
 * eight shops, checked by both the salesman and his manager" is a list and
 * two people for each.
 *
 * One task per (salesman, shop) pair — never a shared task several people
 * tick — so every salesman's answer is his own row and the results screen can
 * lay them side by side. `expandTaskAudience` is the one statement of that
 * rule, and the preview and the save both run it, so the count somebody
 * reviewed is the count that gets written.
 * ------------------------------------------------------------------------- */

import type { PlaceFilterValues } from "@/lib/place-filters";

export type TaskShopTarget =
  | { kind: "none" }
  | { kind: "list"; customerIds: string[] }
  | {
      kind: "filter";
      places: PlaceFilterValues;
      /** Only shops carried by these salesmen. Empty is anybody's. */
      carriedBy: string[];
      /** Which kinds of account. Empty is both. */
      accountKinds: ("customer" | "lead")[];
      missingGpsOnly?: boolean;
      search?: string;
    };

export type TaskAssignees = { kind: "carrier" } | { kind: "chosen"; salesmanIds: string[] };

export type TaskAudience = { shops: TaskShopTarget; assignees: TaskAssignees };

/** The most tasks one assignment may write. Past this it is a data load. */
export const MAX_TASKS_PER_ASSIGNMENT = 3000;

export type AudienceShop = { id: string; carrierId: string | null };

export type AudiencePair = { salesmanId: string; customerId: string | null };

/**
 * The tasks an audience means. `shops` is what the shop half resolved to
 * (null for "no shop"); `allowed` is the set of salesmen the assigner may put
 * work on, so a carrier outside the manager's team is skipped and counted
 * rather than handed a task by somebody who cannot see him.
 */
export function expandTaskAudience(
  shops: AudienceShop[] | null,
  assignees: TaskAssignees,
  allowed: (salesmanId: string) => boolean,
): { pairs: AudiencePair[]; noCarrier: number; outsideTeam: number } {
  const pairs: AudiencePair[] = [];
  const seen = new Set<string>();
  let noCarrier = 0;
  let outsideTeam = 0;
  const add = (salesmanId: string, customerId: string | null) => {
    const key = `${salesmanId}|${customerId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ salesmanId, customerId });
  };

  if (shops === null) {
    if (assignees.kind === "chosen") {
      for (const id of assignees.salesmanIds) {
        if (allowed(id)) add(id, null);
        else outsideTeam += 1;
      }
    }
    return { pairs, noCarrier, outsideTeam };
  }

  for (const shop of shops) {
    if (assignees.kind === "carrier") {
      if (!shop.carrierId) noCarrier += 1;
      else if (!allowed(shop.carrierId)) outsideTeam += 1;
      else add(shop.carrierId, shop.id);
    } else {
      for (const id of assignees.salesmanIds) {
        if (allowed(id)) add(id, shop.id);
        else outsideTeam += 1;
      }
    }
  }
  return { pairs, noCarrier, outsideTeam };
}

/** What is wrong with an audience before anything is looked up. */
export function taskAudienceProblem(a: TaskAudience): string | null {
  if (a.assignees.kind === "chosen" && a.assignees.salesmanIds.length === 0) {
    return "Pick at least one salesman.";
  }
  if (a.shops.kind === "none" && a.assignees.kind === "carrier") {
    return "A task about no shop has no shop's salesman — pick the salesmen it goes to.";
  }
  if (a.shops.kind === "list" && a.shops.customerIds.length === 0) {
    return "Pick at least one shop.";
  }
  return null;
}

/** The audience said back in words, kept on the assignment for its header. */
export function taskAudienceSentence(
  a: TaskAudience,
  names: { salesman: (id: string) => string; place: (id: string) => string },
): string {
  const who =
    a.assignees.kind === "carrier"
      ? "each shop's own salesman"
      : a.assignees.salesmanIds.length <= 3
        ? a.assignees.salesmanIds.map(names.salesman).join(", ")
        : `${a.assignees.salesmanIds.length} salesmen`;
  if (a.shops.kind === "none") return `For ${who}, not about any shop`;
  if (a.shops.kind === "list") {
    const n = a.shops.customerIds.length;
    return `${n} chosen shop${n === 1 ? "" : "s"}, done by ${who}`;
  }
  const parts: string[] = [];
  for (const rung of ["area", "city", "district", "state"] as const) {
    const picked = (a.shops.places[rung] ?? "").split(",").filter(Boolean);
    if (picked.length) {
      parts.push(picked.map(names.place).join(", "));
      break;
    }
  }
  if (a.shops.accountKinds.length === 1) parts.push(a.shops.accountKinds[0] === "lead" ? "leads only" : "customers only");
  if (a.shops.carriedBy.length) parts.push(`carried by ${a.shops.carriedBy.map(names.salesman).join(", ")}`);
  if (a.shops.missingGpsOnly) parts.push("no location saved");
  if (a.shops.search?.trim()) parts.push(`matching "${a.shops.search.trim()}"`);
  return `Every shop${parts.length ? ` — ${parts.join(" · ")}` : " in the book"}, done by ${who}`;
}
