"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { PRICE_SCOPE_KINDS } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { today } from "@/lib/recompute";
import { getConfig } from "@/lib/config/store";
import { booksOnShop } from "@/lib/engines/price-one-list";
import { placeKey } from "@/lib/engines/price-resolution";
import { GEO_SELECT, resolveOptionsFrom, toGeo, type GeoRow } from "@/lib/services/price-list-service";
import {
  doubleListedShops,
  leaveShopOutOfBook,
  loadWorld,
  previewClashes,
  type ClashView,
  type DoubleListedView,
} from "@/lib/services/price-one-list-service";
import { audit } from "@/lib/services/price-write";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * ONE PRICE LIST PER SHOP — the reads a screen asks before it writes, and the
 * one write that settles shops already on two lists.
 *
 * The rule is `engines/price-one-list.ts`; the refusals are in the writes
 * themselves (`addScope`, `publishDraftIn`, `assignCustomerList`). These
 * answer the question the Applies-to step asks while somebody is still
 * typing: what would these rules reach, and who is already somewhere else.
 * ------------------------------------------------------------------------- */

const GEOGRAPHY = new Set(["state", "district", "city", "area", "beat"]);

const rowSchema = z.object({
  scopeKind: z.enum(PRICE_SCOPE_KINDS),
  scopeValue: z.string().default(""),
  scopeLabel: z.string().nullish(),
  parentKey: z.string().default(""),
  freightTermMatch: z.enum(["any", "to_pay", "paid"]).default("any"),
  priority: z.number().int().optional(),
  validFrom: z.string().nullish(),
  validTo: z.string().nullish(),
  excluded: z.boolean().optional(),
});

const previewSchema = z.object({
  listId: z.string().nullish(),
  supersedesId: z.string().nullish(),
  freightTerm: z.enum(["to_pay", "paid", "not_stated"]).nullish(),
  rows: z.array(rowSchema),
  moves: z.array(z.object({ customerId: z.string().min(1), fromBookId: z.string().min(1) })).nullish(),
  /** Read the list's own saved rows too (less `replaceScopeId`), and add `rows` to them — for one row added or corrected. */
  withSavedRows: z.boolean().optional(),
  replaceScopeId: z.string().nullish(),
});

export type RulesPreview = {
  /** Shops the rules name, before anything is left out. */
  reached: number;
  /** Of those, the shops a leave-out row takes off. */
  leftOut: number;
  /** What the list would price: reached less left out. */
  priced: number;
  /** Shops these rules would put on a second list, and the lists they are already on. */
  clashes: ClashView[];
  /** False where the rule is switched off: clashes are listed but nothing is refused. */
  enforced: boolean;
};

/** What a set of rules would reach, leave out and clash with — read on every change to the Applies-to step. */
export async function previewListRules(input: z.input<typeof previewSchema>): Promise<Result<RulesPreview>> {
  try {
    await requireCapability("pricelist.manage");
    const parsed = previewSchema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "That is not a set of rules.");
    const [day, config] = await Promise.all([today(), getConfig()]);
    const rows = parsed.data.rows
      .map((r) => ({
        ...r,
        scopeValue: GEOGRAPHY.has(r.scopeKind) ? placeKey(r.scopeValue) : r.scopeValue.trim(),
        parentKey: GEOGRAPHY.has(r.scopeKind) ? placeKey(r.parentKey) : r.parentKey,
      }))
      .filter((r) => r.scopeKind === "everybody" || r.scopeValue);
    if (parsed.data.withSavedRows && parsed.data.listId) {
      const saved = await db.execute<{
        scope_kind: (typeof PRICE_SCOPE_KINDS)[number];
        scope_value: string;
        scope_label: string | null;
        parent_key: string;
        freight_term_match: "any" | "to_pay" | "paid";
        priority: number;
        valid_from: string | null;
        valid_to: string | null;
        excluded: boolean;
      }>(sql`
        select scope_kind, scope_value, scope_label, parent_key, freight_term_match, priority,
               valid_from::text as valid_from, valid_to::text as valid_to, excluded
          from price_list_scopes
         where price_list_id = ${parsed.data.listId}
           and (${parsed.data.replaceScopeId ?? null}::text is null or id <> ${parsed.data.replaceScopeId ?? null})
      `);
      rows.unshift(
        ...[...saved].map((r) => ({
          scopeKind: r.scope_kind,
          scopeValue: r.scope_value,
          scopeLabel: r.scope_label,
          parentKey: r.parent_key,
          freightTermMatch: r.freight_term_match,
          priority: r.priority,
          validFrom: r.valid_from,
          validTo: r.valid_to,
          excluded: r.excluded,
        })),
      );
    }
    const answer = await previewClashes({
      listId: parsed.data.listId ?? null,
      supersedesId: parsed.data.supersedesId ?? null,
      freightTerm: parsed.data.freightTerm ?? undefined,
      rows,
      moves: parsed.data.moves ?? [],
      day,
    });
    return ok({ ...answer, enforced: config["pricing.oneListPerShop"] });
  } catch (e) {
    return fromThrown(e);
  }
}

/** Every shop on more than one list today, with the one that prices it — the list Coverage settles. */
export async function shopsOnTwoLists(): Promise<Result<DoubleListedView[]>> {
  try {
    await requireCapability("pricelist.manage");
    const [day, config] = await Promise.all([today(), getConfig()]);
    return ok(await doubleListedShops(day, resolveOptionsFrom(config)));
  } catch (e) {
    return fromThrown(e);
  }
}

const settleSchema = z.array(z.object({ customerId: z.string().min(1), keepBookId: z.string().min(1) })).max(5000);

/**
 * SETTLES SHOPS THAT ARE ON TWO LISTS: each keeps the one book named, and
 * every other book it is on leaves it out. Nothing else about the books
 * changes. One transaction for the lot, so a half-settled page is impossible.
 */
export async function settleDoubleListed(answers: Array<{ customerId: string; keepBookId: string }>): Promise<Result<{ settled: number }>> {
  try {
    const ctx = await requirePriceDesk();
    const parsed = settleSchema.safeParse(answers);
    if (!parsed.success) return err("That is not a list of shops and the list each keeps.");
    if (!parsed.data.length) return ok({ settled: 0 }, "Nothing to settle.");
    const day = await today();
    const settled = await db.transaction(async (tx) => {
      const world = await loadWorld(tx);
      let count = 0;
      for (const a of parsed.data) {
        const [row] = await tx.execute<GeoRow & { name: string }>(sql`
          select g.*, named.name
            from (${GEO_SELECT} where c.id = ${a.customerId}) g
            join customers named on named.id = g."customerId"
        `);
        if (!row) continue;
        const books = booksOnShop(toGeo(row), world.scopes, world.lists, day);
        if (!books.some((b) => b.bookId === a.keepBookId)) continue;
        for (const b of books) {
          if (b.bookId === a.keepBookId) continue;
          await leaveShopOutOfBook(tx, { bookId: b.bookId, customerId: a.customerId, label: row.name, userId: ctx.user.id, day });
        }
        count++;
      }
      await audit(tx, ctx, {
        action: "pricelist.oneList.settle",
        entityType: "price_list",
        entityId: "one-list",
        after: { settled: count, answers: parsed.data.slice(0, 200) },
      });
      return count;
    });
    try {
      revalidatePath("/accounts/price-lists");
      revalidatePath("/founder/price-lists");
      revalidatePath("/crm/price-lists");
    } catch {
      /* no request — a test */
    }
    return ok({ settled }, `${settled} shop${settled === 1 ? " is" : "s are"} on one list now.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/** The one-click answer: every shop keeps the list that prices it today, so no price changes. */
export async function settleAllToTodaysList(): Promise<Result<{ settled: number }>> {
  const listed = await shopsOnTwoLists();
  if (!listed.ok) return listed;
  return settleDoubleListed(
    listed.data.filter((s) => s.pricedFromBookId).map((s) => ({ customerId: s.customerId, keepBookId: s.pricedFromBookId! })),
  );
}
