import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, priceOverrides, priceRequests, products, users } from "@/db/schema";
import { longDate, money } from "@/lib/format";
import { overrideState } from "@/lib/engines/price-overrides";
import { today } from "@/lib/recompute";
import { requirePriceDesk } from "@/lib/services/price-desk";
import type { ImpactBody, ImpactSource } from "../registry";
import { present, word } from "./crm-common";

/* ---------------------------------------------------------------------------
 * A SPECIAL PRICE CANCELLED — for one that should never have applied.
 *
 * Nothing is deleted (price-books.md: ending moves the last day, cancelling
 * stamps who and why), but a LIVE one cancelled changes what the shop pays
 * from today: its agreed list is brought back into line and the next order is
 * priced from the book. Orders already taken keep the rate they were taken at.
 * The person who asked for it reads the reason, so it is asked for first.
 * ------------------------------------------------------------------------- */

/** `pricing-override-cancel` — `cancelOverride`, the Price Desk's. */
export const overrideCancelImpact: ImpactSource = {
  authorize: async () => {
    await requirePriceDesk();
  },

  async report(id): Promise<ImpactBody | null> {
    const [row] = await db
      .select({ o: priceOverrides, customer: customers.name, product: products.name })
      .from(priceOverrides)
      .innerJoin(customers, eq(customers.id, priceOverrides.customerId))
      .innerJoin(products, eq(products.id, priceOverrides.productId))
      .where(eq(priceOverrides.id, id));
    if (!row) return null;
    const { o } = row;
    const day = await today();
    const state = overrideState(o, day);
    const [asker] = o.requestId
      ? await db
          .select({ name: users.name })
          .from(priceRequests)
          .innerJoin(users, eq(users.id, priceRequests.requestedById))
          .where(eq(priceRequests.id, o.requestId))
      : [];
    const span = `${longDate(String(o.validFrom))} → ${o.validTo ? longDate(String(o.validTo)) : "no end"}`;

    return {
      title: `${row.customer}'s special price on ${row.product}`,
      verb: "Cancel",
      confirmWord: word(row.customer, "CANCEL"),
      items: present([
        {
          app: "Accounts",
          label: "special price",
          effect: "changed",
          count: 1,
          examples: [`${row.product} at ${money(Number(o.rateInclGstPaise))} incl GST · ${span}`],
          note: "Marked cancelled with your reason. The row stays as the record of what the shop was promised.",
        },
        {
          app: "Accounts",
          label: "rate on the shop's agreed list",
          effect: "changed",
          count: state === "live" ? 1 : 0,
          note: "It comes off today: the shop's next order is priced from its book, in the CRM, on the handset and in the ERP. Orders already taken keep the rate they were taken at.",
        },
        {
          app: "Accounts",
          label: "special price due to start",
          effect: "changed",
          count: state === "scheduled" ? 1 : 0,
          note: "It never starts.",
        },
        {
          app: "CRM",
          label: `request by ${asker?.name ?? "the person who asked"}`,
          effect: "kept",
          count: asker ? 1 : 0,
          note: "They read your reason on the special price.",
        },
      ]),
      blockers: o.cancelledAt ? ["That special price was already cancelled."] : [],
    };
  },
};
