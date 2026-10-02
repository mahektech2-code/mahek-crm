import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { callAiDrafts, customers, products } from "@/db/schema";
import { assertCustomerInScope, resolveScope } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { decideVerifyFill, type OnFile, type VerifyAnalysis } from "@/lib/engines/verify-intel-decide";
import {
  VERIFY_SHAPE_HINT,
  verifyReadingSchema,
  verifySystemPrompt,
  verifyUserPrompt,
  type VerifyReading,
} from "@/lib/verify-intel-schema";
import { err, ok, type Result } from "@/lib/result";
import { readStructured } from "@/lib/structured-read";

/* ---------------------------------------------------------------------------
 * THE MANAGER VERIFICATION DIALOG'S VOICE ASSISTANT, wired to data.
 *
 * The Sales Manager presses "Speak about this call" in the verification dialog
 * and talks — in any language — about what the shop said. This reads it into
 * the dialog's answers and the shop's own figures, and returns a proposal.
 *
 * WHAT IT WRITES: one `call_ai_drafts` row (`channel: "verify_call"`) holding
 * the transcript, the reading, the proposal and the salesman's values as they
 * stood when it was read — the same audit row the Calling Desk's assistant
 * keeps, and for the same reason. The lead exists, so the table's NOT NULL
 * customer fits. It writes NO lead field, NO validation call, NO correction,
 * NO stage move and NO notification: `recordLeadValidationCall` is the only
 * writer of a verification, and this file never imports it.
 *
 * THE SCOPE is the signed-in person's own: `assertCustomerInScope` resolves
 * the Sales Manager seat from the request, exactly as the save does, so a lead
 * that cannot be verified from here cannot be read from here either.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type AnalyseVerifyInput = {
  customerId: string;
  /** What was said, in the language it was said in. Empty for a typed note. */
  spoken: string;
  /** The English the dictation produced. */
  english: string;
  /** What the manager typed into the assistant's own box. */
  typedNote: string;
  language: string | null;
  heardBy: string;
};

export type AnalyseVerifyResult = { draftId: string; analysis: VerifyAnalysis };

function verifyText(input: Pick<AnalyseVerifyInput, "spoken" | "english" | "typedNote">): string {
  return [input.typedNote, input.english, input.spoken]
    .map((s) => s.trim())
    .filter((s, i, all) => s && all.indexOf(s) === i)
    .join("\n");
}

export async function analyseVerifyCall(input: AnalyseVerifyInput): Promise<Result<AnalyseVerifyResult>> {
  const started = Date.now();
  const config = await getConfig();
  if (!config["verifyIntel.enabled"]) {
    return err("The verification call assistant is switched off.", "rule_violation");
  }

  const [row] = await db
    .select({
      name: customers.name,
      companyName: customers.companyName,
      stage: customers.leadStage,
      kind: customers.kind,
      ownerId: customers.ownerId,
      salesAmId: customers.salesAmId,
      backOfficeAmId: customers.backOfficeAmId,
      leadManagerId: customers.leadManagerId,
      salesManagerId: customers.salesManagerId,
      litres: customers.leadMonthlyVolumeLitres,
      potentialPaise: customers.leadEstimatedPotentialPaise,
      competitor: customers.leadCompetitor,
      contact: customers.contactPerson,
      decisionMaker: customers.leadDecisionMaker,
      productName: products.name,
    })
    .from(customers)
    .leftJoin(products, eq(products.id, customers.leadRequiredProductId))
    .where(eq(customers.id, input.customerId));
  if (!row) return err("That lead is not on MahekOne.", "not_found");
  const ctx = await resolveScope();
  await assertCustomerInScope(row);

  if (row.stage === "lost") {
    return err("This lead is closed, so there is no verification call to record.", "rule_violation");
  }

  const text = verifyText(input);
  if (text.length < 2) {
    return err("There is nothing to read yet — speak or type what the shop said first.", "validation");
  }
  if (text.length > 8000) {
    return err("That is longer than the assistant reads. Keep it to this one call.", "validation");
  }

  /* THE SALESMAN'S VALUES, as the dialog's own rows show them — read here, from
     the lead, and never taken from the browser. They go to the engine and the
     audit row; they are NOT shown to the model. */
  const onFile: OnFile = {
    monthlyLitres: row.litres && row.litres > 0 ? row.litres : null,
    potentialRupees: row.potentialPaise && Number(row.potentialPaise) > 0 ? Math.round(Number(row.potentialPaise) / 100) : null,
    product: row.productName?.trim() || null,
    competitor: row.competitor?.trim() || null,
    contact: row.contact?.trim() || null,
    decisionMaker: row.decisionMaker?.trim() || null,
  };

  const read = await readStructured({
    label: "Manager verification assistant",
    system: verifySystemPrompt(),
    prompt: verifyUserPrompt({ text: input, shopName: row.companyName || row.name }),
    schema: verifyReadingSchema,
    shapeHint: VERIFY_SHAPE_HINT,
    model: config["verifyIntel.model"],
  });
  const reading = read.output as VerifyReading | null;

  const analysis = decideVerifyFill({
    reading,
    text,
    onFile,
    config: { confirmBelow: config["callIntel.confirmBelowPercent"] },
  });

  const draftId = id("vcd");
  await db.insert(callAiDrafts).values({
    id: draftId,
    channel: "verify_call",
    customerId: input.customerId,
    userId: ctx.user.id,
    spoken: input.spoken.slice(0, 8000),
    english: (input.english || input.typedNote).slice(0, 8000),
    language: input.language,
    heardBy: input.heardBy,
    reading: reading as never,
    analysis: { ...analysis, onFileAtReading: onFile } as never,
    model: read.model,
    latencyMs: Date.now() - started,
  });

  if (!reading) {
    return err(
      "The assistant could not read this call — no language model answered. Fill the verification in as usual; nothing you said is lost.",
      "rule_violation",
    );
  }

  return ok({ draftId, analysis });
}
