"use server";

import { err, fromThrown, type Result } from "@/lib/result";
import { ErpNotPermitted, requireErpForm } from "@/lib/erp/access";
import { lookupRequirementPo, type LinkPreview } from "@/lib/erp/screens/requirement-po";

/* What a PO number typed on a requirement fetches from the Quotation manager.
   A READ — it writes nothing, so a preview may ask it — but it still checks
   the screen, because a server action is a URL. Linking goes through
   `erpRunAction("requisitions", "linkPo", …)`. */
export async function erpRequirementPoLookup(id: string, poNo: string): Promise<Result<LinkPreview>> {
  try {
    const ctx = await requireErpForm("requisitions");
    return await lookupRequirementPo(ctx, id, poNo);
  } catch (e) {
    if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
    return fromThrown(e);
  }
}
