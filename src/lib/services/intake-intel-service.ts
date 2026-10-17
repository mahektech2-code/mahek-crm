import "server-only";
import { getConfig } from "@/lib/config/store";
import { decideIntakeFill, type IntakeAnalysis } from "@/lib/engines/intake-intel-decide";
import {
  INTAKE_SHAPE_HINT,
  intakeReadingSchema,
  intakeSystemPrompt,
  intakeUserPrompt,
  type IntakeReading,
} from "@/lib/intake-intel-schema";
import { err, ok, type Result } from "@/lib/result";
import { readStructured } from "@/lib/structured-read";
import { distributorOptions } from "./distributor-service";

/* ---------------------------------------------------------------------------
 * THE LEAD INTAKE FORM'S VOICE ASSISTANT, wired to data.
 *
 * A telecaller presses "Speak about this call" on the Intake form and talks —
 * in any language — about the customer on the phone. This reads it into the
 * form's own boxes and nothing else, and returns a proposal.
 *
 * IT IS READ-ONLY, AND THAT IS THE WHOLE DESIGN. It writes no customer, no
 * lead, no draft, no audit row, no notification: there is no `db` write and no
 * `captureLead` anywhere in this file, and `intake-intel.test.ts` reads the
 * source to keep it that way. The Calling Desk's assistant keeps its proposals
 * in `call_ai_drafts`; that table's `customer_id` is NOT NULL and a lead being
 * raised has no customer yet, so v1 keeps nothing rather than invent a second
 * place to hold half a lead.
 *
 * The form's sales type is never an argument. `offerUnder` says only whether
 * the form is drawing its "Under" box, and it reaches the engine, never the
 * model.
 * ------------------------------------------------------------------------- */

export type AnalyseIntakeInput = {
  /** What was said, in the language it was said in. Empty for a typed note. */
  spoken: string;
  /** The English the dictation produced. */
  english: string;
  /** Whatever is already typed into the note, read along with what was spoken. */
  typedNote: string;
  language: string | null;
  heardBy: string;
  /** Whether the form is drawing "Under" — decided by the form, used by the engine only. */
  offerUnder: boolean;
};

export type AnalyseIntakeResult = { analysis: IntakeAnalysis };

function intakeText(input: Pick<AnalyseIntakeInput, "spoken" | "english" | "typedNote">): string {
  return [input.typedNote, input.english, input.spoken]
    .map((s) => s.trim())
    .filter((s, i, all) => s && all.indexOf(s) === i)
    .join("\n");
}

export async function analyseIntake(input: AnalyseIntakeInput): Promise<Result<AnalyseIntakeResult>> {
  const config = await getConfig();
  if (!config["intakeIntel.enabled"]) {
    return err("The lead intake voice assistant is switched off.", "rule_violation");
  }

  const text = intakeText(input);
  if (text.length < 2) {
    return err("There is nothing to read yet — speak or type about the call first.", "validation");
  }
  if (text.length > 8000) {
    return err("That is longer than the assistant reads. Keep it to this one call.", "validation");
  }

  const sources = config["leads.sources"];
  const read = await readStructured({
    label: "Lead intake assistant",
    system: intakeSystemPrompt(),
    prompt: intakeUserPrompt({ text: input, sources }),
    schema: intakeReadingSchema,
    shapeHint: INTAKE_SHAPE_HINT,
    model: config["intakeIntel.model"],
  });
  const reading = read.output as IntakeReading | null;

  if (!reading) {
    return err(
      "The assistant could not read this call — no language model answered. Fill the form in as usual; nothing you said is lost.",
      "rule_violation",
    );
  }

  const analysis = decideIntakeFill({
    reading,
    text,
    sources,
    distributors: input.offerUnder ? await distributorOptions() : [],
    offerUnder: input.offerUnder,
    config: { confirmBelow: config["callIntel.confirmBelowPercent"] },
  });

  return ok({ analysis });
}
