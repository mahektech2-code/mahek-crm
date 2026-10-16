"use server";

import { revalidatePath } from "next/cache";
import { err, fromThrown, type Result } from "@/lib/result";
import { ErpNotPermitted, requireErpWrite } from "@/lib/erp/access";
import { applyQuoteOps, type QuoteOp } from "@/lib/erp/quotes";

/* The Quotation manager's one write. Like every ERP write it re-checks the
   screen, because a server action is a URL. */
export async function erpQuoteApply(ops: QuoteOp[]): Promise<Result<{ applied: number }>> {
  try {
    const ctx = await requireErpWrite("quoteManager");
    const res = await applyQuoteOps(ctx, ops);
    if (res.ok) revalidatePath("/erp/quotation-manager");
    return res;
  } catch (e) {
    if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
    return fromThrown(e);
  }
}
