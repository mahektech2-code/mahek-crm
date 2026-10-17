"use server";

import { z } from "zod";
import { requireCapability } from "@/lib/access-control";
import { canOpenModule } from "@/lib/access";
import { err, fromThrown, type Result } from "@/lib/result";
import { analyseIntake, type AnalyseIntakeResult } from "@/lib/services/intake-intel-service";

/* ---------------------------------------------------------------------------
 * The Lead Intake form's voice assistant, from the browser — one door, and it
 * only READS.
 *
 * It writes nothing: no lead, no customer, no draft. What it proposes reaches
 * `customers` only through the form's own "Raise the lead" and `captureLead`,
 * pressed by a person, which re-validates everything. Checked as that action
 * is: `lead.work`, and the Intake module of the workspace the form is mounted
 * in (a server action is a URL, and a route guard is a courtesy).
 * ------------------------------------------------------------------------- */

const analyseSchema = z.object({
  workspace: z.enum(["crm", "sales"]),
  spoken: z.string().max(8000).default(""),
  english: z.string().max(8000).default(""),
  typedNote: z.string().max(8000).default(""),
  language: z.string().max(20).nullable().default(null),
  heardBy: z.enum(["sarvam", "openai", "dictation", "typed"]).default("typed"),
  offerUnder: z.boolean().default(false),
});

export async function analyseIntakeAction(
  raw: z.input<typeof analyseSchema>,
): Promise<Result<AnalyseIntakeResult>> {
  try {
    const parsed = analyseSchema.safeParse(raw);
    if (!parsed.success) return err("That could not be read.", "validation");
    const { workspace, ...input } = parsed.data;

    const ctx = await requireCapability("lead.work");
    if (!(await canOpenModule(ctx.user.id, `${workspace}.lead-intake`))) {
      return err("You have not been given Lead intake. Ask whoever manages access to grant it.", "not_permitted");
    }

    return await analyseIntake(input);
  } catch (e) {
    return fromThrown(e);
  }
}
