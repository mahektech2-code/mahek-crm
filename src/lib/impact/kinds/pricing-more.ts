import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  priceListDiscountTerms,
  priceListDocuments,
  priceListRates,
  priceLists,
  priceRequests,
  products,
} from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { money } from "@/lib/format";
import { discountTermSentence } from "@/lib/price-list-labels";
import type { PriceDiscountKind } from "@/db/schema";
import { today } from "@/lib/recompute";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { pricingShiftWithout } from "@/lib/services/price-list-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * THE REST OF THE PRICE DESK — a rate, a discount, an imported document, a
 * special-price request.
 *
 * A rate is the one that sounds dangerous and is not: taking one off a list
 * that has priced anybody would rewrite what a shop was charged, so the act
 * refuses it outside a draft and this report carries that refusal. A discount
 * term has no such guard — it is words under the prices, not a price — so on a
 * published list it is gone from the printed sheet and from every ERP sales
 * order that names the list, from the moment it is removed.
 *
 * The price desk is asked of all but the request, which is the asker's own to
 * take back — the same checks the acts make.
 * ------------------------------------------------------------------------- */

const ACCOUNTS = "Accounts";

const authorize = async () => {
  await requirePriceDesk();
};

/** The record's own short name where somebody can type it; the verb otherwise. */
const typeable = (name: string, verb: string) => (name.trim() && name.length <= 40 ? name : verb);

/** What a published list's departure would be felt by — the shops priced from it today. */
async function pricedFrom(listId: string) {
  const shift = await pricingShiftWithout({ listId }, await today());
  return shift.moves;
}

/* ------------------------------------------------------------------ a rate */

/** `price-rate` — `removeRate`. */
export const priceRateImpact: ImpactSource = {
  authorize,
  async report(id) {
    const [row] = await db
      .select({
        rateExGstPaise: priceListRates.rateExGstPaise,
        minCans: priceListRates.minCans,
        maxCans: priceListRates.maxCans,
        product: products.name,
        listId: priceLists.id,
        listName: priceLists.name,
        status: priceLists.status,
      })
      .from(priceListRates)
      .innerJoin(priceLists, eq(priceLists.id, priceListRates.priceListId))
      .innerJoin(products, eq(products.id, priceListRates.productId))
      .where(eq(priceListRates.id, id));
    if (!row) return null;

    const slab = row.minCans ? ` from ${row.minCans}${row.maxCans ? ` to ${row.maxCans}` : ""} cans` : "";
    const items: ImpactItem[] = [
      {
        app: ACCOUNTS,
        label: row.minCans ? "slab rate on the list" : "rate on the list",
        effect: "deleted",
        count: 1,
        examples: [`${row.product} — ${money(row.rateExGstPaise)} ex GST${slab}`],
        note: `On ${row.listName}.`,
      },
    ];
    if (row.status === "draft") {
      items.push({
        app: "CRM",
        label: "shops' prices, orders and bills",
        effect: "kept",
        count: 0,
        note: "The list is a draft and prices nobody yet. Published without this rate, the product is not on it.",
      });
    }
    return {
      title: `${row.product} on ${row.listName}`,
      verb: "Remove",
      confirmWord: typeable(row.product, "REMOVE"),
      items,
      blockers:
        row.status === "draft"
          ? []
          : [
              `This list is ${row.status}. Taking a rate off it would change what a customer was charged; publish a new version instead.`,
            ],
    };
  },
};

/* --------------------------------------------------------- a discount term */

/** `price-discount-term` — `removeDiscountTerm`. */
export const priceDiscountTermImpact: ImpactSource = {
  authorize,
  async report(id) {
    const [row] = await db
      .select({
        kind: priceListDiscountTerms.kind,
        percentBp: priceListDiscountTerms.percentBp,
        thresholdLitres: priceListDiscountTerms.thresholdLitres,
        thresholdPaise: priceListDiscountTerms.thresholdPaise,
        listId: priceLists.id,
        listName: priceLists.name,
        status: priceLists.status,
      })
      .from(priceListDiscountTerms)
      .innerJoin(priceLists, eq(priceLists.id, priceListDiscountTerms.priceListId))
      .where(eq(priceListDiscountTerms.id, id));
    if (!row) return null;
    const sentence = discountTermSentence({ ...row, kind: row.kind as PriceDiscountKind });
    const items: ImpactItem[] = [
      {
        app: ACCOUNTS,
        label: "discount printed under the prices",
        effect: "deleted",
        count: 1,
        examples: [sentence],
        note: `On ${row.listName}. A printed copy or PDF made from now on no longer carries it; copies already sent out still do.`,
      },
    ];
    if (row.status === "published") {
      const moves = await pricedFrom(row.listId);
      items.push({
        app: "ERP",
        label: moves.length === 1 ? "billing party whose sales order stops offering it" : "billing parties whose sales orders stop offering it",
        effect: "changed",
        count: moves.length,
        examples: moves.slice(0, 5).map((m) => m.name),
        note: "A sales order shows its list's discounts in words beside the rate. Orders already taken keep what they said.",
      });
    } else {
      items.push({
        app: "CRM",
        label: "shops' prices, orders and bills",
        effect: "kept",
        count: 0,
        note:
          row.status === "draft"
            ? "The list is a draft and prices nobody yet."
            : "The list is no longer in force, so nobody is offered it today.",
      });
    }
    return {
      title: `${sentence} on ${row.listName}`,
      verb: "Remove",
      confirmWord: typeable(sentence, "REMOVE"),
      items,
      blockers: [],
    };
  },
};

/* --------------------------------------------------- an imported document */

/** `price-document` — `deleteDocument`. */
export const priceDocumentImpact: ImpactSource = {
  authorize,
  async report(id) {
    const [doc] = await db
      .select({
        filename: priceListDocuments.filename,
        parseStatus: priceListDocuments.parseStatus,
        rejectReason: priceListDocuments.rejectReason,
      })
      .from(priceListDocuments)
      .where(eq(priceListDocuments.id, id));
    if (!doc) return null;
    const [[cells], lists] = await Promise.all([
      db.execute<{ n: number; answered: number }>(sql`
        select count(*)::int as n,
               count(*) filter (where r.matched_product_id is not null)::int as answered
          from price_list_parse_rows r
         where r.document_id = ${id}
      `),
      db.select({ name: priceLists.name }).from(priceLists).where(eq(priceLists.documentId, id)),
    ]);

    const items: ImpactItem[] = [
      {
        app: ACCOUNTS,
        label: Number(cells?.n) === 1 ? "price read off it" : "prices read off it",
        effect: "deleted",
        count: Number(cells?.n ?? 0),
        note: Number(cells?.answered)
          ? `${Number(cells!.answered).toLocaleString("en-IN")} of them already matched to a product, by the reader or by a person — that work goes too.`
          : undefined,
      },
    ];
    if (doc.parseStatus === "rejected") {
      items.push({
        app: ACCOUNTS,
        label: "record that it was rejected, and why",
        effect: "deleted",
        count: 1,
        examples: doc.rejectReason ? [doc.rejectReason] : undefined,
      });
    }
    items.push({
      app: ACCOUNTS,
      label: "the uploaded file",
      effect: "kept",
      count: 0,
      note: "The bytes stay in storage. Uploading the same file again reads it afresh, as a new document.",
    });

    const blockers: string[] = [];
    if (doc.parseStatus === "published") {
      blockers.push("This one became a price list, and the list points back at it. Withdraw the list instead.");
    } else if (lists.length) {
      blockers.push(`${lists.map((l) => l.name).join(", ")} still ${lists.length === 1 ? "points" : "point"} back at it. Delete or withdraw that list first.`);
    }
    return { title: doc.filename, verb: "Delete", confirmWord: typeable(doc.filename, "DELETE"), items, blockers };
  },
};

/* ------------------------------------------------ a special-price request */

/** `price-request-withdraw` — `withdrawPriceRequest`. Only the person who asked, as the act says. */
export const priceRequestWithdrawImpact: ImpactSource = {
  async authorize(id) {
    const ctx = await requireCapability("pricelist.read");
    const [row] = await db.select({ by: priceRequests.requestedById }).from(priceRequests).where(eq(priceRequests.id, id));
    if (row && row.by !== ctx.user.id) throw new Error("Only the person who asked can withdraw it.");
  },
  async report(id) {
    const [row] = await db
      .select({
        status: priceRequests.status,
        requested: priceRequests.requestedRateExGstPaise,
        current: priceRequests.currentRateExGstPaise,
        currentListId: priceRequests.currentListId,
        customer: customers.name,
        product: products.name,
      })
      .from(priceRequests)
      .innerJoin(customers, eq(customers.id, priceRequests.customerId))
      .innerJoin(products, eq(products.id, priceRequests.productId))
      .where(eq(priceRequests.id, id));
    if (!row) return null;
    const [list] = row.currentListId
      ? await db.select({ name: priceLists.name }).from(priceLists).where(eq(priceLists.id, row.currentListId))
      : [];
    return {
      title: `the request for ${row.customer}`,
      verb: "Withdraw",
      confirmWord: typeable(row.customer, "WITHDRAW"),
      items: [
        {
          app: ACCOUNTS,
          label: "special-price request waiting for a decision",
          effect: "deleted",
          count: 1,
          examples: [`${row.product} at ${money(row.requested)} ex GST`],
          note: "It leaves the list of requests to decide, and nobody will decide it. You can ask again.",
        },
        {
          app: "CRM",
          label: `${row.customer}'s price`,
          effect: "kept",
          count: 0,
          note:
            row.current != null
              ? `Stays at ${money(row.current)} ex GST${list ? ` from ${list.name}` : ""}.`
              : "Nothing about what they are charged changes.",
        },
      ],
      blockers: row.status === "pending" ? [] : [`That request was already ${row.status}.`],
    };
  },
};
