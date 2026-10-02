"use server";

import { z } from "zod";
import { requireCapability } from "@/lib/access-control";
import { canOpenModule } from "@/lib/access";
import { err, fromThrown, type Result } from "@/lib/result";
import { analyseVerifyCall, type AnalyseVerifyResult } from "@/lib/services/verify-intel-service";
import { inCrmSalesManagerWorkspace } from "@/lib/services/crm-sales-manager-scope";

/* ---------------------------------------------------------------------------
 * The Manager verification dialog's voice assistant, from the browser — one
 * door, and it only READS.
 *
 * It writes one audit row (the transcript and the proposal, in
 * `call_ai_drafts`) and nothing a Sales Manager would call a record: no
 * verification, no correction, no lead field, no stage move. What it proposes
 * reaches the lead only through the dialog's own "Save verification" and
 * `verifyProspect`, pressed by a person, which re-validates everything.
 *
 * THREE CHECKS, in the order a refusal should say them:
 *   - `lead.verify` — the capability the save itself asks for, so the assistant
 *     is never offered to somebody who could not save what it fills;
 *   - the CRM Sales Manager WORKSPACE (the request header `src/proxy.ts`
 *     writes) and its module. The dialog is shared with the Sales Dashboard's
 *     pipeline, and the assistant belongs to the CRM workspace only;
 *   - the customer's scope, inside `analyseVerifyCall`.
 * ------------------------------------------------------------------------- */

const analyseSchema = z.object({
  customerId: z.string().min(1),
  spoken: z.string().max(8000).default(""),
  english: z.string().max(8000).default(""),
  typedNote: z.string().max(8000).default(""),
  language: z.string().max(20).nullable().default(null),
  heardBy: z.enum(["sarvam", "openai", "dictation", "typed"]).default("typed"),
});

export async function analyseVerifyCallAction(
  raw: z.input<typeof analyseSchema>,
): Promise<Result<AnalyseVerifyResult>> {
  try {
    const parsed = analyseSchema.safeParse(raw);
    if (!parsed.success) return err("That could not be read.", "validation");

    const ctx = await requireCapability("lead.verify");
    if (!(await inCrmSalesManagerWorkspace())) {
      return err("The verification assistant is part of the CRM Sales Manager workspace.", "not_permitted");
    }
    if (!(await canOpenModule(ctx.user.id, "crm.sales-manager"))) {
      return err("You have not been given the Sales Manager workspace. Ask whoever manages access to grant it.", "not_permitted");
    }

    return await analyseVerifyCall(parsed.data);
  } catch (e) {
    return fromThrown(e);
  }
}
