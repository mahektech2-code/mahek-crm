import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { priceListScopes, priceLists, type PriceScopeKind } from "@/db/schema";
import { longDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { SCOPE_KIND_LABEL } from "@/lib/price-list-labels";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { pricingShiftWithout, type PricingShift } from "@/lib/services/price-list-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * WHAT TAKING A PRICE LIST AWAY REACHES.
 *
 * A list is read in three apps: the price desk keeps it (Accounts, and the
 * Founder's door onto the same lists), the CRM prices a shop's order form and
 * its record from it, and the ERP fills a sales order's rate from it. So the
 * two acts that change who is priced — withdrawing a list and removing one of
 * its rules — are answered by the resolver itself, shop by shop
 * (`pricingShiftWithout`), and say by name where each shop lands.
 *
 * Deleting a DRAFT changes nobody's price — a draft never priced anything —
 * and what it does reach is its own contents, the document it was read in
 * from, and the lists derived or versioned from it.
 *
 * Every source asks for the price desk, the same check every one of these
 * acts makes, so the modal is no wider a window than the act.
 * ------------------------------------------------------------------------- */

const authorize = async () => {
  await requirePriceDesk();
};

const ids = (list: readonly string[]) => sql.join(list.map((id) => sql`${id}`), sql`, `);

function describeScope(s: { scopeKind: string; scopeLabel: string | null; scopeValue: string }): string {
  if (s.scopeKind === "everybody") return "Everybody";
  const kind = SCOPE_KIND_LABEL[s.scopeKind as PriceScopeKind] ?? s.scopeKind;
  return `${kind}: ${s.scopeLabel || s.scopeValue}`;
}

/** The day a list's departure is felt: today, or the day a list not yet in force would have started. */
async function dayFelt(effectiveFrom: string): Promise<{ asOf: string; when: string }> {
  const day = await today();
  return effectiveFrom > day
    ? { asOf: effectiveFrom, when: `From ${longDate(effectiveFrom)}, when it would have come into force` }
    : { asOf: day, when: "From today" };
}

/** Where the shops go — the CRM's two answers, and the ERP's sales order beside them. */
function shopMoves(shift: PricingShift, when: string): ImpactItem[] {
  const moved = shift.moves.filter((m) => m.toListId);
  const stranded = shift.moves.filter((m) => !m.toListId);
  return [
    {
      app: "CRM",
      label: moved.length === 1 ? "shop priced from another list instead" : "shops priced from another list instead",
      effect: "changed",
      count: moved.length,
      examples: moved.slice(0, 5).map((m) => `${m.name} → ${m.toListName}`),
      note: `${when}, their order form and their record's prices read from the list beside their name — the next narrowest that names them.`,
    },
    {
      app: "CRM",
      label: stranded.length === 1 ? "shop left with no price list" : "shops left with no price list",
      effect: "unlinked",
      count: stranded.length,
      examples: stranded.slice(0, 5).map((m) => m.name),
      note: `Nothing else names them. ${when}, their order form shows quantities and no money until a list is put on them.`,
    },
    {
      app: "ERP",
      label: shift.moves.length === 1 ? "billing party whose sales-order rate changes" : "billing parties whose sales-order rates change",
      effect: "changed",
      count: shift.moves.length,
      examples: shift.moves.slice(0, 5).map((m) => m.name),
      note: "A new sales order fills its rate from the list they fall to, or leaves it to be typed where none is left. Orders already taken keep their rates.",
    },
  ];
}

/* ------------------------------------------------------------- a draft */

/** What deleting these drafts takes with it. The ids are drafts only — the callers filter. */
async function draftItems(draftIds: readonly string[]): Promise<ImpactItem[]> {
  if (!draftIds.length) return [];
  const [[counts], scopes, children, successors, documents] = await Promise.all([
    db.execute<{ rates: number; slabs: number; scopes: number; terms: number }>(sql`
      select
        (select count(*)::int from price_list_rates r where r.price_list_id in (${ids(draftIds)}) and r.min_cans is null) as rates,
        (select count(*)::int from price_list_rates r where r.price_list_id in (${ids(draftIds)}) and r.min_cans is not null) as slabs,
        (select count(*)::int from price_list_scopes s where s.price_list_id in (${ids(draftIds)})) as scopes,
        (select count(*)::int from price_list_discount_terms t where t.price_list_id in (${ids(draftIds)})) as terms
    `),
    db
      .select({ scopeKind: priceListScopes.scopeKind, scopeLabel: priceListScopes.scopeLabel, scopeValue: priceListScopes.scopeValue })
      .from(priceListScopes)
      .where(inArray(priceListScopes.priceListId, [...draftIds]))
      .limit(5),
    /* A list being deleted in the same breath is not "left behind". */
    db.execute<{ name: string }>(sql`
      select c.name from price_lists c
       where c.parent_list_id in (${ids(draftIds)}) and c.id not in (${ids(draftIds)})
       order by c.name
    `),
    db.execute<{ name: string }>(sql`
      select v.name, v.version from price_lists v
       where v.supersedes_id in (${ids(draftIds)}) and v.id not in (${ids(draftIds)})
       order by v.name, v.version
    `),
    db.execute<{ filename: string }>(sql`
      select d.filename from price_list_documents d
       where d.price_list_id in (${ids(draftIds)}) and d.parse_status = 'published'
       order by d.filename
    `),
  ]);

  return [
    { app: "Accounts", label: "rates on it", effect: "deleted", count: Number(counts?.rates ?? 0) },
    { app: "Accounts", label: "slab rates (quantity breaks)", effect: "deleted", count: Number(counts?.slabs ?? 0) },
    {
      app: "Accounts",
      label: "rules saying who it is for",
      effect: "deleted",
      count: Number(counts?.scopes ?? 0),
      examples: scopes.map(describeScope),
    },
    { app: "Accounts", label: "discount terms printed under it", effect: "deleted", count: Number(counts?.terms ?? 0) },
    {
      app: "Accounts",
      label: documents.length === 1 ? "imported document it was read from" : "imported documents it was read from",
      effect: "changed",
      count: documents.length,
      examples: documents.slice(0, 5).map((d) => d.filename),
      note: "Back to the documents waiting for a person. The file and everything read from it are kept, so it can be read in again.",
    },
    {
      app: "Accounts",
      label: children.length === 1 ? "list derived from it" : "lists derived from it",
      effect: "unlinked",
      count: children.length,
      examples: children.slice(0, 5).map((c) => c.name),
      note: "They keep every rate they were made with, and stop being checked against this list's rates when they are published.",
    },
    {
      app: "Accounts",
      label: successors.length === 1 ? "newer version drafted from it" : "newer versions drafted from it",
      effect: "unlinked",
      count: successors.length,
      examples: successors.slice(0, 5).map((v) => v.name),
      note: "They stay drafts of their own, and no longer name this one as the list they replace.",
    },
    {
      app: "CRM",
      label: "shops' prices, orders and bills",
      effect: "kept",
      count: 0,
      note: "A draft has never priced anything, so no shop, order or bill changes.",
    },
  ];
}

const DRAFT_ONLY =
  "Only a draft can be deleted. A list that has been published is what somebody was charged; withdraw it instead.";

/** `price-list-draft` — `deleteDraftPriceList`. */
export const priceListDraftImpact: ImpactSource = {
  authorize,
  async report(id) {
    const [row] = await db
      .select({ id: priceLists.id, name: priceLists.name, status: priceLists.status })
      .from(priceLists)
      .where(eq(priceLists.id, id));
    if (!row) return null;
    const draft = row.status === "draft";
    return {
      title: row.name,
      verb: "Delete",
      confirmWord: row.name,
      items: draft ? await draftItems([row.id]) : [],
      blockers: draft ? [] : [DRAFT_ONLY],
    };
  },
};

/**
 * `price-list-drafts` — `deleteDraftPriceLists`. The id is the selection's ids
 * joined by commas, exactly as the action joins them.
 */
export const priceListDraftsImpact: ImpactSource = {
  authorize,
  async report(id) {
    const wanted = id.split(",").filter(Boolean);
    if (!wanted.length) return null;
    const rows = await db
      .select({ id: priceLists.id, name: priceLists.name, status: priceLists.status })
      .from(priceLists)
      .where(inArray(priceLists.id, wanted));
    if (!rows.length) return null;
    const drafts = rows.filter((r) => r.status === "draft").sort((a, b) => a.name.localeCompare(b.name));
    const others = rows.filter((r) => r.status !== "draft").sort((a, b) => a.name.localeCompare(b.name));
    const one = drafts.length === 1 ? drafts[0] : null;

    const items: ImpactItem[] = [
      {
        app: "Accounts",
        label: drafts.length === 1 ? "draft price list" : "draft price lists",
        effect: "deleted",
        count: drafts.length,
        examples: drafts.slice(0, 5).map((d) => d.name),
      },
      ...(await draftItems(drafts.map((d) => d.id))),
    ];
    if (others.length) {
      items.push({
        app: "Accounts",
        label: others.length === 1 ? "published list ticked with them" : "published lists ticked with them",
        effect: "kept",
        count: others.length,
        examples: others.slice(0, 5).map((o) => o.name),
        note: "Left alone. A published list is withdrawn, never deleted.",
      });
    }
    return {
      title: one ? one.name : `${drafts.length} draft price lists`,
      verb: "Delete",
      confirmWord: one ? one.name : `Delete ${drafts.length} drafts`,
      items,
      blockers: drafts.length ? [] : ["None of these is a draft. " + DRAFT_ONLY],
    };
  },
};

/* ------------------------------------------------------------ withdrawing */

/** `price-list-withdrawal` — `withdrawPriceList`. */
export const priceListWithdrawalImpact: ImpactSource = {
  authorize,
  async report(id) {
    const [row] = await db
      .select({ id: priceLists.id, name: priceLists.name, status: priceLists.status, effectiveFrom: priceLists.effectiveFrom })
      .from(priceLists)
      .where(eq(priceLists.id, id));
    if (!row) return null;

    const live = row.status === "published";
    const { asOf, when } = await dayFelt(row.effectiveFrom);
    const [shift, scopes, children, successors, requests, [orders]] = await Promise.all([
      live ? pricingShiftWithout({ listId: id }, asOf) : Promise.resolve<PricingShift>({ named: 0, moves: [] }),
      db
        .select({ scopeKind: priceListScopes.scopeKind, scopeLabel: priceListScopes.scopeLabel, scopeValue: priceListScopes.scopeValue })
        .from(priceListScopes)
        .where(eq(priceListScopes.priceListId, id)),
      db.execute<{ name: string }>(sql`
        select c.name from price_lists c
         where c.parent_list_id = ${id} and c.status in ('draft', 'published')
         order by c.name
      `),
      db.execute<{ name: string }>(sql`
        select v.name from price_lists v
         where v.supersedes_id = ${id} and v.status = 'draft'
         order by v.name
      `),
      db.execute<{ name: string }>(sql`
        select cu.name from price_requests r
          join customers cu on cu.id = r.customer_id
         where r.current_list_id = ${id} and r.status = 'pending'
         order by r.created_at
      `),
      db.execute<{ n: number }>(sql`select count(*)::int as n from orders o where o.price_list_id = ${id}`),
    ]);

    const items: ImpactItem[] = shopMoves(shift, when);
    const unmoved = shift.named - shift.moves.length;
    if (live && unmoved > 0) {
      items.push({
        app: "CRM",
        label: unmoved === 1 ? "shop it names but does not price" : "shops it names but does not price",
        effect: "kept",
        count: unmoved,
        note: "A narrower list already prices them, so nothing about their price changes.",
      });
    }
    if (scopes.length) {
      items.push({
        app: "Accounts",
        label: "rules saying who it is for",
        effect: "kept",
        count: scopes.length,
        examples: scopes.slice(0, 5).map(describeScope),
        note: "They stay on the list as the record of who it was for. A withdrawn list prices nobody.",
      });
    }
    if (children.length) {
      items.push({
        app: "Accounts",
        label: children.length === 1 ? "list derived from it" : "lists derived from it",
        effect: "kept",
        count: children.length,
        examples: children.slice(0, 5).map((c) => c.name),
        note: "They carry rates of their own and stay as they are — including a special price agreed for one shop on top of this list.",
      });
    }
    if (successors.length) {
      items.push({
        app: "Accounts",
        label: successors.length === 1 ? "draft new version of it" : "draft new versions of it",
        effect: "kept",
        count: successors.length,
        examples: successors.slice(0, 5).map((v) => v.name),
        note: "They stay drafts. Publish one as a list of its own: this one will already be out of force, so there is nothing left for it to replace.",
      });
    }
    if (requests.length) {
      items.push({
        app: "Accounts",
        label: requests.length === 1 ? "special-price request waiting on it" : "special-price requests waiting on it",
        effect: "kept",
        count: requests.length,
        examples: requests.slice(0, 5).map((r) => r.name),
        note: "Still waiting for a decision. Each was asked against a rate on this list, so check it before deciding.",
      });
    }
    if (Number(orders?.n ?? 0)) {
      items.push({
        app: "CRM",
        label: "orders priced from it",
        effect: "kept",
        count: Number(orders!.n),
        note: "Every order keeps the price it was taken at, and so does its bill — a list leaving force never rewrites one.",
      });
    }

    return {
      title: row.name,
      verb: "Withdraw",
      confirmWord: row.name,
      items,
      blockers: row.status === "withdrawn" ? ["That list has already been withdrawn."] : [],
    };
  },
};

/* --------------------------------------------------------------- a scope */

/** `price-list-scope` — `removeScope`. */
export const priceListScopeImpact: ImpactSource = {
  authorize,
  async report(id) {
    const [row] = await db
      .select({
        scopeKind: priceListScopes.scopeKind,
        scopeLabel: priceListScopes.scopeLabel,
        scopeValue: priceListScopes.scopeValue,
        listName: priceLists.name,
        status: priceLists.status,
        effectiveFrom: priceLists.effectiveFrom,
      })
      .from(priceListScopes)
      .innerJoin(priceLists, eq(priceLists.id, priceListScopes.priceListId))
      .where(eq(priceListScopes.id, id));
    if (!row) return null;

    const { asOf, when } = await dayFelt(row.effectiveFrom);
    const shift = await pricingShiftWithout({ scopeId: id }, asOf);
    const items: ImpactItem[] = [
      {
        app: "Accounts",
        label: "rule saying who the list is for",
        effect: "deleted",
        count: 1,
        examples: [describeScope(row)],
        note: `On ${row.listName}.`,
      },
    ];
    const unmoved = shift.named - shift.moves.length;
    if (row.status === "published") {
      items.push(...shopMoves(shift, when));
      if (unmoved > 0) {
        items.push({
          app: "CRM",
          label: unmoved === 1 ? "shop it names whose price does not change" : "shops it names whose price does not change",
          effect: "kept",
          count: unmoved,
          note: "Another rule on this list, or a narrower list, prices them already.",
        });
      }
    } else if (shift.named > 0) {
      items.push({
        app: "CRM",
        label: shift.named === 1 ? "shop this rule names" : "shops this rule names",
        effect: "kept",
        count: shift.named,
        note:
          row.status === "draft"
            ? "The list is a draft and prices nobody yet. Without this rule they will not be on it when it is published."
            : "The list is no longer in force, so nobody's price moves; the rule is only the record of who it was for.",
      });
    }

    const own = row.scopeKind === "everybody" ? "Everybody" : row.scopeLabel || row.scopeValue;
    return {
      title: `${describeScope(row)} on ${row.listName}`,
      verb: "Remove",
      confirmWord: own,
      items,
      blockers: [],
    };
  },
};
