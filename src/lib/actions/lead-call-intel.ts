"use server";

import { z } from "zod";
import { requireCapability } from "@/lib/access-control";
import { err, fromThrown, type Result } from "@/lib/result";
import {
  analyseLeadCall,
  type AnalyseLeadCallResult,
} from "@/lib/services/lead-call-intel-service";

/* ---------------------------------------------------------------------------
 * The Lead Calling Desk's own voice assistant, from the browser — one door.
 *
 * It READS. It writes one row — the transcript and the proposal, in
 * `call_ai_drafts` — and nothing a telecaller would call a record: no call, no
 * lead field, no stage move. Everything it proposes reaches `customers` only
 * through the ordinary `logQualificationCall()`, pressed by a person on the
 * ordinary Save button.
 *
 * Checked exactly as every other desk write is: `lead.work` (the capability
 * the whole funnel is worked under), the Calling Desk module grant (a server
 * action is a URL, and a route guard is a courtesy) and the customer's scope,
 * the last of those inside `analyseLeadCall` itself — the same split
 * `logQualificationCall` keeps.
 * ------------------------------------------------------------------------- */

const analyseSchema = z.object({
  customerId: z.string().min(1),
  spoken: z.string().max(8000).default(""),
  english: z.string().max(8000).default(""),
  typedNote: z.string().max(8000).default(""),
  language: z.string().max(20).nullable().default(null),
  heardBy: z.enum(["sarvam", "openai", "dictation", "typed"]).default("typed"),
});

export async function analyseLeadCallAction(
  raw: z.input<typeof analyseSchema>,
): Promise<Result<AnalyseLeadCallResult>> {
  try {
    const parsed = analyseSchema.safeParse(raw);
    if (!parsed.success) return err("That could not be read.", "validation");

    /* The reading is of a call this person may log: `lead.work`, and
       `analyseLeadCall` asks the lead's scope itself. */
    await requireCapability("lead.work");

    return await analyseLeadCall(parsed.data);
  } catch (e) {
    return fromThrown(e);
  }
}
