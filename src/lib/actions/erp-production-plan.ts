"use server";

import { revalidatePath } from "next/cache";
import { err, fromThrown, type Result } from "@/lib/result";
import { ErpNotPermitted, requireErpWrite } from "@/lib/erp/access";
import { deletePlanLine, openPlanFor, recordPlanPrint, savePlanLine } from "@/lib/erp/production-plan";
import type { LineInput } from "@/lib/erp/engines/production-plan";

/* ---------------------------------------------------------------------------
 * Under Process's writes. Each re-checks the screen, because a server action
 * is a URL and a hidden button is not a permission.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

const touched = () => revalidatePath("/erp/under-process");

export async function erpPlanOpen(date: string): Promise<Result<{ id: string; created: boolean }>> {
  try {
    const ctx = await requireErpWrite("underProcess");
    const res = await openPlanFor(ctx, date);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpPlanSaveLine(planId: string, input: LineInput, lineId?: string): Promise<Result<{ id: string }>> {
  try {
    const ctx = await requireErpWrite("underProcess");
    const res = await savePlanLine(ctx, planId, input, lineId);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpPlanDeleteLine(lineId: string): Promise<Result<undefined>> {
  try {
    const ctx = await requireErpWrite("underProcess");
    const res = await deletePlanLine(ctx, lineId);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}

export async function erpPlanPrint(planId: string): Promise<Result<{ printNo: number }>> {
  try {
    const ctx = await requireErpWrite("underProcess");
    const res = await recordPlanPrint(ctx, planId);
    touched();
    return res;
  } catch (e) {
    return refused(e);
  }
}
