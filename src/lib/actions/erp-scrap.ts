"use server";

import { revalidatePath } from "next/cache";
import { err, fromThrown, type Result } from "@/lib/result";
import { ErpNotPermitted, requireErpForm, requireErpWrite } from "@/lib/erp/access";
import { lookupDrumLot, recordEmptyDrum, type DrumLot, type RecordedDrum } from "@/lib/erp/scrap";

/* ---------------------------------------------------------------------------
 * The empty-drum scale's two calls. Like every ERP write each re-checks the
 * screen, because a server action is a URL and a hidden page is not a
 * permission. Looking a lot up writes nothing, so a preview may do it.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

export async function erpEmptyDrumLookup(code: string): Promise<Result<DrumLot>> {
  try {
    await requireErpForm("emptyDrums");
    return await lookupDrumLot(code);
  } catch (e) {
    return refused(e);
  }
}

export async function erpEmptyDrumRecord(input: { code: string; weightKg: number | null; exceptionNote?: string | null }): Promise<Result<RecordedDrum>> {
  try {
    const ctx = await requireErpWrite("emptyDrums");
    const res = await recordEmptyDrum(ctx, input);
    if (res.ok) {
      revalidatePath("/erp/empty-drums");
      revalidatePath("/erp/scrap");
      revalidatePath("/erp");
    }
    return res;
  } catch (e) {
    return refused(e);
  }
}
