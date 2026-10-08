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
export async function erpDispatchVerify(orderNo: number, date: string): Promise<Result<unknown>> {
  try {
    const ctx = await requireErpWrite("orderDetails");
    const ids = ((await db.execute(sql`
      select o.id from erp_orders o join erp_order_details d on d.order_id = o.id
       where o.order_no = ${orderNo} and coalesce(d.verification, 'Pending') = 'Pending'
    `)) as unknown as { id: string }[]).map((r) => r.id);
    if (!ids.length) return err("Nothing on this order is billed and waiting for dispatch verification. Bill it first, on Orders → Under process & ready.", "rule_violation");
    const verify = screenModule("orderDetails")?.bulk?.verify;
    if (!verify) return err("Dispatch verification is not available.", "not_found");
    const res = await verify(ctx, ids, { date });
    touched(orderNo);
    revalidatePath("/erp/orders");
    return res;
  } catch (e) {
    return refused(e);
  }
}

/** Anybody who prints labels works one of these screens. */
async function requireLabelScreen(): Promise<ErpContext> {
  const ctx = await erpContext();
  for (const s of ["units", "dispatch", "packBatches", "stock", "orders"]) {
    try {
      return await requireErpWrite(s);
    } catch (e) {
      if (!(e instanceof ErpNotPermitted)) throw e;
      if (ctx.viewingAs) throw e;
    }
  }
  throw new ErpNotPermitted("Labels are printed by whoever works the boxes, packing or dispatch.");
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
