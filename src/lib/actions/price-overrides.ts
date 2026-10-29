"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { priceOverrides } from "@/db/schema";
import { canFor, requireCapability } from "@/lib/access-control";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { exFromIncl } from "@/lib/engines/price-math";
import { overrideProblem, overrideState } from "@/lib/engines/price-overrides";
import { ratesForCustomer, assertPricingCustomerInScope } from "@/lib/services/price-list-service";
import { audit, Refused } from "@/lib/services/price-write";
import {
  adviseOnRequest,
  askShopPrices,
  requestContext,
  shopProductFacts,
  syncShopOverrides,
} from "@/lib/services/price-override-service";
import { err, fieldErr, fromThrown, ok, okVoid, type Result } from "@/lib/result";
import type { RequestAdvice, RequestContext, ShopProductFacts } from "@/components/pricing/overrides/types";

/* ---------------------------------------------------------------------------
 * EVERY WRITE AN OVERRIDE TAKES — create, end, extend, cancel — and the reads
 * the decide and ask screens fetch.
 *
 * An override is the Price Desk's (`requirePriceDesk`, checked here because a
 * server action is a URL). Its own row is written and audited in one
 * transaction; the shop's agreed list is brought into line AFTER that commits
 * (`syncShopOverrides`), so a failure there never loses the decision — the
 * hourly job catches up and the screen says so.
 *
 * NOTHING IS DELETED. Ending moves the last day; cancelling stamps who and
 * why. Both leave the row as the record of what the shop was promised.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function refresh(customerId?: string) {
  try {
    for (const base of ["/crm/price-lists", "/accounts/price-lists", "/founder/price-lists"]) revalidatePath(base, "layout");
    if (customerId) revalidatePath(`/crm/customers/${customerId}`);
  } catch {
    /* No request context — a job or a test. */
  }
}

/** Bring the shop's agreed list into line, and say so if it could not be. */
async function applied(customerId: string, ctx: Awaited<ReturnType<typeof requirePriceDesk>>): Promise<string[]> {
  try {
    const s = await syncShopOverrides(customerId, await today(), ctx);
    return s.skipped ? [s.skipped] : [];
  } catch (e) {
    return [`Saved, but the shop's prices could not be updated yet (${e instanceof Error ? e.message : String(e)}). The hourly check will try again.`];
  }
}

export async function createOverride(input: {
  customerId: string;
  productId: string;
  rateInclGstPaise: number;
  validFrom: string;
  validTo: string | null;
  minCansPerMonth: number | null;
  note: string;
}): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requirePriceDesk();
    const day = await today();
    if (!Number.isInteger(input.rateInclGstPaise) || input.rateInclGstPaise <= 0) {
      return fieldErr("rateInclGstPaise", "A special price has to be above zero.");
    }
    const [customer] = await db.execute<{ name: string }>(sql`select name from customers where id = ${input.customerId}`);
    if (!customer) return err("That customer does not exist.", "not_found");
    const [product] = await db.execute<{ name: string }>(sql`select name from products where id = ${input.productId}`);
    if (!product) return err("That product does not exist.", "not_found");

    const config = await getConfig();
    const book = (await ratesForCustomer(input.customerId, [input.productId], day))[input.productId];
    const gstBp = book?.gstBp ?? config["pricing.gstBp"] ?? 1800;
    const ex = exFromIncl(input.rateInclGstPaise, gstBp);
    const problem = overrideProblem({
      rateExGstPaise: ex,
      validFrom: input.validFrom,
      validTo: input.validTo || null,
      minCansPerMonth: input.minCansPerMonth,
      today: day,
    });
    if (problem) return err(problem, "validation");

    const id = gen("pov");
    await db.transaction(async (tx) => {
      await tx.insert(priceOverrides).values({
        id,
        customerId: input.customerId,
        productId: input.productId,
        rateExGstPaise: ex,
        rateInclGstPaise: input.rateInclGstPaise,
        gstBp,
        validFrom: input.validFrom,
        validTo: input.validTo || null,
        minCansPerMonth: input.minCansPerMonth,
        note: input.note.trim() || null,
        createdById: ctx.user.id,
      });
      await audit(tx, ctx, {
        action: "pricelist.override.create",
        entityType: "price_override",
        entityId: id,
        after: { customer: customer.name, product: product.name, ex, from: input.validFrom, to: input.validTo || null, min: input.minCansPerMonth },
      });
    });
    const warnings = await applied(input.customerId, ctx);
    refresh(input.customerId);
    return ok(
      { id },
      input.validFrom > day ? `Saved. ${customer.name} pays it from ${input.validFrom}.` : `Saved. ${customer.name} pays it from today.`,
      warnings,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

async function lockedOverride(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string) {
  const [row] = await tx.select().from(priceOverrides).where(eq(priceOverrides.id, id)).for("update");
  if (!row) throw new Refused(err("That special price does not exist.", "not_found"));
  return row;
}

/** End it on a day — today or later. The shop goes back to its book the day after. */
export async function endOverride(id: string, endDate: string, reason: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const day = await today();
    if (!ISO_DATE.test(endDate)) return fieldErr("endDate", "Choose the last day it applies.");
    if (!reason.trim()) return fieldErr("reason", "Say why it is ending. The person who asked for it reads this.");
    const row = await db.transaction(async (tx) => {
      const o = await lockedOverride(tx, id);
      const state = overrideState(o, day);
      if (state === "cancelled" || state === "ended") throw new Refused(err(`That special price has already ${state === "ended" ? "ended" : "been cancelled"}.`, "rule_violation"));
      // The last day it applies. "End today" means it still prices today.
      const last = endDate < o.validFrom ? null : endDate;
      if (!last) throw new Refused(fieldErr("endDate", "It cannot end before it starts. Cancel it instead."));
      if (last < addDays(day, -1)) throw new Refused(fieldErr("endDate", "That day has already passed."));
      await tx.update(priceOverrides).set({ validTo: last, updatedAt: new Date(), remindedAt: null }).where(eq(priceOverrides.id, id));
      await audit(tx, ctx, {
        action: "pricelist.override.end",
        entityType: "price_override",
        entityId: id,
        before: { validTo: o.validTo },
        after: { validTo: last, reason: reason.trim() },
      });
      return o;
    });
    const warnings = await applied(row.customerId, ctx);
    refresh(row.customerId);
    return { ...okVoid(`Ends after ${endDate}. The shop is back on its book price the day after.`), warnings };
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** Cancel it outright — for a special price that should never have applied. */
export async function cancelOverride(id: string, reason: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (!reason.trim()) return fieldErr("reason", "Say why. The person who asked for it reads this.");
    const row = await db.transaction(async (tx) => {
      const o = await lockedOverride(tx, id);
      if (o.cancelledAt) throw new Refused(err("That special price was already cancelled.", "rule_violation"));
      await tx
        .update(priceOverrides)
        .set({ cancelledAt: new Date(), cancelledById: ctx.user.id, cancelReason: reason.trim(), updatedAt: new Date() })
        .where(eq(priceOverrides.id, id));
      await audit(tx, ctx, {
        action: "pricelist.override.cancel",
        entityType: "price_override",
        entityId: id,
        after: { reason: reason.trim() },
      });
      return o;
    });
    const warnings = await applied(row.customerId, ctx);
    refresh(row.customerId);
    return { ...okVoid("Cancelled. The shop is back on its book price."), warnings };
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** Move the last day later, or take the end off (null). */
export async function extendOverride(id: string, newValidTo: string | null): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const day = await today();
    if (newValidTo && !ISO_DATE.test(newValidTo)) return fieldErr("validTo", "That is not a date.");
    const row = await db.transaction(async (tx) => {
      const o = await lockedOverride(tx, id);
      if (o.cancelledAt) throw new Refused(err("A cancelled special price cannot be extended. Make a new one.", "rule_violation"));
      if (newValidTo && o.validTo && newValidTo <= o.validTo) throw new Refused(fieldErr("validTo", "Choose a day after the one it ends on now."));
      const problem = overrideProblem({ rateExGstPaise: o.rateExGstPaise, validFrom: o.validFrom, validTo: newValidTo, minCansPerMonth: o.minCansPerMonth, today: day });
      if (problem) throw new Refused(fieldErr("validTo", problem));
      await tx.update(priceOverrides).set({ validTo: newValidTo, remindedAt: null, updatedAt: new Date() }).where(eq(priceOverrides.id, id));
      await audit(tx, ctx, {
        action: "pricelist.override.extend",
        entityType: "price_override",
        entityId: id,
        before: { validTo: o.validTo },
        after: { validTo: newValidTo },
      });
      return o;
    });
    const warnings = await applied(row.customerId, ctx);
    refresh(row.customerId);
    return { ...okVoid(newValidTo ? `Extended to ${newValidTo}.` : "It now has no end date."), warnings };
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- reads */

async function viewer() {
  const ctx = await requireCapability("pricelist.read");
  return { id: ctx.user.id, deskHolder: await canFor(ctx.user, "pricelist.manage") };
}

/** The decide drawer's facts and stored advice. The requester or the Price Desk only. */
export async function requestContextAction(requestId: string): Promise<Result<RequestContext>> {
  try {
    const v = await viewer();
    const context = await requestContext(requestId, v);
    if (!context) return err("That request does not exist.", "not_found");
    return ok(context);
  } catch (e) {
    return fromThrown(e);
  }
}

/** Both models, asked afresh. Advice only. */
export async function requestAdviceAction(requestId: string): Promise<Result<RequestAdvice[]>> {
  try {
    const v = await viewer();
    if (!v.deskHolder) return err("Only the Price Desk asks for advice on a decision.", "not_permitted");
    const advice = await adviseOnRequest(requestId, v);
    if (!advice) return err("That request does not exist.", "not_found");
    return ok(advice);
  } catch (e) {
    return fromThrown(e);
  }
}

/** The facts behind a request not yet sent — shown on the ask form, stored nowhere. */
export async function askFactsAction(customerId: string, productId: string): Promise<Result<ShopProductFacts>> {
  try {
    await requireCapability("pricelist.read");
    if (!(await assertPricingCustomerInScope(customerId))) return err("That customer does not exist.", "not_found");
    const facts = await shopProductFacts(customerId, productId, await today());
    if (!facts) return err("That product does not exist.", "not_found");
    return ok(facts);
  } catch (e) {
    return fromThrown(e);
  }
}

/** One question about a shop's prices, from the facts on its screen. */
export async function askShopPricesAction(customerId: string, question: string): Promise<Result<{ answer: string; by: string }>> {
  try {
    const ctx = await requireCapability("pricelist.read");
    if (!question.trim()) return fieldErr("question", "Type a question.");
    if (question.length > 500) return fieldErr("question", "Keep the question under 500 characters.");
    if (!(await assertPricingCustomerInScope(customerId))) return err("That customer does not exist.", "not_found");
    const a = await askShopPrices(customerId, question.trim(), ctx.user.id);
    if (!a.ok) return err(a.reason, "rule_violation");
    return ok({ answer: a.answer, by: a.by });
  } catch (e) {
    return fromThrown(e);
  }
}
