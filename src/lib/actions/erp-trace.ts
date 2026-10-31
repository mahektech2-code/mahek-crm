"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { ErpNotPermitted, erpContext, requireErpWrite, type ErpContext } from "@/lib/erp/access";
import { decideOverride, requestOverride, scanOntoOrder, unscanUnit, type ScanAnswer } from "@/lib/erp/dispatch";
import { screenModule } from "@/lib/erp/screens";
import { erpAudit } from "@/lib/erp/server";
import { unitEvent } from "@/lib/erp/units";

/* ---------------------------------------------------------------------------
 * The dispatch desk's and the label sheet's writes. Like every ERP write each
 * re-checks the screen it belongs to, because a server action is a URL.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

function touched(orderNo?: number) {
  revalidatePath("/erp/dispatch");
  if (orderNo != null) revalidatePath(`/erp/dispatch?order=${orderNo}`);
  revalidatePath("/erp/trace");
  revalidatePath("/erp/boxes");
}

export async function erpDispatchScan(orderNo: number, code: string): Promise<Result<ScanAnswer>> {
  try {
    const ctx = await requireErpWrite("dispatch");
    const res = await scanOntoOrder(ctx, orderNo, code);
    touched(orderNo);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpDispatchUnscan(unitId: string): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite("dispatch");
    const res = await unscanUnit(ctx, unitId);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpDispatchRequestOverride(orderNo: number, code: string, reason: string): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite("dispatch");
    const res = await requestOverride(ctx, orderNo, code, reason);
    touched(orderNo);
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpDispatchDecideOverride(id: string, approve: boolean, note: string): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite("dispatch", "dispatchOverride");
    const res = await decideOverride(ctx, id, approve, note.trim() || null);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}

/**
 * Do Verified, from the desk, for every billed line of the order that is not
 * yet verified. It runs the Billing & dispatch tab's own handler, so it asks
 * for that screen too and every rule there — the scan gate included — holds.
 */
export async function erpDispatchVerify(orderNo: number, input: { date: string; vehicle?: string; driver?: string; remark?: string }): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite("orderDetails");
    /* "Still to dispatch" is the handler's own rule — blank or Pending — so the desk cannot offer a line the handler then refuses. Anything else gets the reason it is, not "bill it first". */
    const lines = (await db.execute(sql`
      select o.id, d.verification from erp_orders o join erp_order_details d on d.order_id = o.id
       where o.order_no = ${orderNo} and o.status <> 'Cancel'
    `)) as unknown as { id: string; verification: string | null }[];
    const ids = lines.filter((l) => !l.verification || l.verification === "Pending").map((l) => l.id);
    if (!ids.length) {
      if (!lines.length) return err("Nothing on this order is billed yet. Bill it first, on Orders → Ready to bill.", "rule_violation");
      if (lines.some((l) => l.verification === "Not Verify"))
        return err(`An administrator marked order ${orderNo} not verified on Orders → Billing & dispatch, and a line marked so cannot be dispatched again. Ask an ERP administrator.`, "rule_violation");
      return err(`Order ${orderNo} has already been dispatched.`, "rule_violation");
    }
    const verify = screenModule("orderDetails")?.bulk?.verify;
    if (!verify) return err("Dispatch verification is not available.", "not_found");
    const res = await verify(ctx, ids, { date: input?.date ?? "", vehicle: input?.vehicle ?? "", driver: input?.driver ?? "", remark: input?.remark ?? "" });
    touched(orderNo);
    revalidatePath("/erp/orders");
    return res;
  } catch (e) {
    return refused(e);
  }
}

/** Somebody who works any one of these screens, or the refusal. */
async function requireOneOf(screens: string[], refusal: string): Promise<ErpContext> {
  const ctx = await erpContext();
  for (const s of screens) {
    try {
      return await requireErpWrite(s);
    } catch (e) {
      if (!(e instanceof ErpNotPermitted)) throw e;
      if (ctx.viewingAs) throw e;
    }
  }
  throw new ErpNotPermitted(refusal);
}

/** Anybody who prints labels works one of these screens. */
async function requireLabelScreen(): Promise<ErpContext> {
  return requireOneOf(["units", "dispatch", "packBatches", "stock", "orders"], "Labels are printed by whoever works the boxes, packing or dispatch.");
}

/**
 * Ids for stock that has none, asked from the label sheet: the boxes of a
 * batch packed before box ids, or cans of an FG lot to sell loose. The
 * screens' own actions do the work, so the label sheet and the stock rows
 * cannot give ids by two different rules.
 */
export async function erpGiveIds(p: { batch: string; godownId: string } | { lot: string; finishedGoodId: string; godownId: string; count: number }): Promise<Result<unknown>> {
  try {
    const res =
      "batch" in p
        ? await screenModule("packStock")!.actions!.labelBoxes(await requireOneOf(["packStock", "packBatches"], "Box ids are given by whoever works packing or the stock."), `${p.batch}|${p.godownId}`, {})
        : await screenModule("fgStock")!.actions!.labelLoose(await requireOneOf(["fgStock", "fgFill"], "Unit ids are given by whoever works filling or the stock."), `${p.finishedGoodId}|${p.lot}|${p.godownId}`, { count: String(p.count) });
    if (res.ok)
      try {
        revalidatePath("/erp/boxes");
      } catch {
        /* outside a request; the ids are written either way */
      }
    return res;
  } catch (e) {
    return refused(e);
  }
}

/** The label sheet was sent to the printer: each box says when, and how many times. */
export async function erpMarkLabelsPrinted(ids: string[]): Promise<Result<{ printed: number }>> {
  try {
    const ctx = await requireLabelScreen();
    if (!ids.length) return ok({ printed: 0 });
    const rows = (await db.execute(sql`
      update erp_units set label_printed_at = now(), label_prints = label_prints + 1, updated_at = now() where id in ${ids} returning id, label_prints as n, status, godown_id as godown
    `)) as unknown as { id: string; n: number; status: string; godown: string }[];
    for (const r of rows) await unitEvent(db, { unitId: r.id, event: "labelled", from: null, to: null, godownId: r.godown, note: Number(r.n) > 1 ? `Label reprinted (${r.n})` : "Label printed", byId: ctx.user.id });
    await erpAudit(ctx, "erp.unit.labelPrint", "erp_unit", ids.slice(0, 50).join(","), null, { count: rows.length });
    revalidatePath("/erp/boxes");
    return ok({ printed: rows.length });
  } catch (e) {
    return refused(e);
  }
}
