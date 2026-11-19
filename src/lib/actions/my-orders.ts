"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";
import { cancelIntake, editIntake, intakeById } from "@/lib/erp/order-hub";
import { shopRates } from "@/lib/services/price-list-service";
import { db } from "@/db";
import { orders, products } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * A TELECALLER CHANGES HER OWN TO, and nothing else. Only while it is a TO
 * waiting for Accounts, or sent back by them - and only the person who took it
 * (the TO's taker, or the `orders` row's author). A change sends it to
 * Accounts again, which is `editIntake`'s rule; once Accounts approve it (that
 * makes its order number) nothing here applies.
 * A line kept keeps the rate it was taken at; a product added is priced from
 * the shop's own list, as on the call, and a line with no list rate is left
 * for the back office to price before its check.
 * ------------------------------------------------------------------------- */

const editSchema = z.object({
  intakeId: z.string().min(1),
  lines: z
    .array(z.object({ skuId: z.string().min(1), qtyCans: z.number().int().positive().max(100000) }))
    .min(1, "A TO needs at least one product."),
  remark: z.string().max(2000).optional(),
});

async function mine(userId: string, intakeId: string) {
  const got = await intakeById(intakeId);
  if (!got) return { error: err("That TO no longer exists.", "not_found") } as const;
  let author: string | null = null;
  if (got.intake.originOrderId) {
    const [o] = await db.select({ userId: orders.userId }).from(orders).where(eq(orders.id, got.intake.originOrderId));
    author = o?.userId ?? null;
  }
  if (got.intake.takenById !== userId && author !== userId) return { error: err("Only the person who took this order can change it here. Ask Accounts.", "not_permitted") } as const;
  return { got } as const;
}

function refresh() {
  try {
    revalidatePath("/crm/my-orders");
    revalidatePath("/crm/customers/[id]", "page");
  } catch {
    /* no request context */
  }
}

export async function editMyToAction(input: z.input<typeof editSchema>): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    if (!(await canOpenModule(user.id, "crm.my-orders"))) return err("My orders is not part of your access.", "not_permitted");
    const parsed = editSchema.safeParse(input);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Check the order.", "validation");
    const m = await mine(user.id, parsed.data.intakeId);
    if ("error" in m) return m.error!;
    const { intake, lines: before } = m.got;
    const kept = new Map(before.map((l) => [l.skuId, l]));
    const added = parsed.data.lines.filter((l) => !kept.has(l.skuId)).map((l) => l.skuId);
    const priced = added.length
      ? await shopRates(intake.billingCustomerId, added, intake.orderDate, Object.fromEntries(parsed.data.lines.map((l) => [l.skuId, l.qtyCans])))
      : { rates: {} as Record<string, { rateExGstPaise: number } | undefined> };
    const seen = new Set<string>();
    const lines = [];
    for (const l of parsed.data.lines) {
      if (seen.has(l.skuId)) return err("A product is on the order twice. Put its cans on one line.", "validation");
      seen.add(l.skuId);
      const was = kept.get(l.skuId);
      const rate = was ? was.ratePaise : (priced.rates[l.skuId]?.rateExGstPaise ?? null);
      lines.push({
        skuId: l.skuId,
        qtyCans: l.qtyCans,
        ratePaise: rate == null ? null : Number(rate),
        discountBp: was?.discountBp ?? null,
        listRatePaise: was ? was.listRatePaise : rate == null ? null : Number(rate),
        rateSetById: was?.rateSetById ?? null,
        rateSetAt: was?.rateSetAt ?? null,
        discountAuthorisedById: was?.discountAuthorisedById ?? null,
        remark: was?.remark ?? null,
      });
    }
    const res = await editIntake(user.id, intake.id, parsed.data.remark !== undefined ? { remark: parsed.data.remark.trim() || null } : {}, lines);
    if (!res.ok) return res;
    refresh();
    const unpriced = lines.filter((l) => l.ratePaise == null).length;
    const sent = intake.status === "correction" ? "corrected and sent to Accounts" : "changed · Accounts check it again";
    return okVoid(`TO-${intake.toNo} ${sent}${unpriced ? ` · ${unpriced} without a rate: Accounts price it` : ""}`);
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * The reason first, then the impact modal: the CRM order beside the TO, the
 * customer's place on the Call Log. The confirmation is checked after the
 * door and the TO's own refusals, so those keep their words.
 */
export async function cancelMyToAction(input: { intakeId: string; reason: string; confirmation?: ImpactConfirmation | null }): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    if (!(await canOpenModule(user.id, "crm.my-orders"))) return err("My orders is not part of your access.", "not_permitted");
    const m = await mine(user.id, input.intakeId);
    if ("error" in m) return m.error!;
    const s = m.got.intake.status;
    if (s !== "open" && s !== "correction") return err(`TO-${m.got.intake.toNo} can no longer be cancelled from here.`, "rule_violation");
    if (!input.reason?.trim()) return err("Say why it is cancelled.", "validation");
    const refusal = await confirmImpact("crm-to-cancel", input.intakeId, input.confirmation);
    if (refusal) return refusal;
    const res = await cancelIntake(user.id, input.intakeId, input.reason ?? "");
    if (res.ok) refresh();
    return res;
  } catch (e) {
    return fromThrown(e);
  }
}

/** The TO's lines as the edit dialog opens them. */
export async function loadMyToAction(intakeId: string): Promise<Result<{ toNo: number; remark: string | null; lines: { skuId: string; name: string; qtyCans: number; ratePaise: number | null }[] }>> {
  try {
    const user = await requireUser();
    if (!(await canOpenModule(user.id, "crm.my-orders"))) return err("My orders is not part of your access.", "not_permitted");
    const m = await mine(user.id, intakeId);
    if ("error" in m) return m.error!;
    const ids = m.got.lines.map((l) => l.skuId);
    const names = ids.length ? await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, ids)) : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return ok({
      toNo: m.got.intake.toNo,
      remark: m.got.intake.remark,
      lines: m.got.lines.map((l) => ({ skuId: l.skuId, name: nameOf.get(l.skuId) ?? l.skuId, qtyCans: l.qtyCans, ratePaise: l.ratePaise == null ? null : Number(l.ratePaise) })),
    });
  } catch (e) {
    return fromThrown(e);
  }
}
