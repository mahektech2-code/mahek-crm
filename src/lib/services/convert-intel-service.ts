import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { callAiDrafts, customers, products } from "@/db/schema";
import { assertCustomerInScope, resolveScope } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { decideConvertFill, type ConvertAnalysis, type ConvertOnFile } from "@/lib/engines/convert-intel-decide";
import type { ProductMatch } from "@/lib/engines/call-intel-decide";
import { chooseProduct } from "@/lib/engines/call-intel-products";
import {
  CONVERT_SHAPE_HINT,
  convertReadingSchema,
  convertSystemPrompt,
  convertUserPrompt,
  type ConvertReading,
} from "@/lib/convert-intel-schema";
import { err, ok, type Result } from "@/lib/result";
import { readStructured } from "@/lib/structured-read";
import { searchProducts } from "./product-service";

/* ---------------------------------------------------------------------------
 * THE CONVERT-TO-PROSPECT DIALOG'S VOICE ASSISTANT, wired to data.
 *
 * The Sales Manager presses "Speak about this shop" in the Convert dialog and
 * talks — in any language. This reads it into the facts the dialog asks for and
 * returns a proposal, comparing each with what the salesman recorded.
 *
 * WHAT IT WRITES: one `call_ai_drafts` row (`channel: "convert_call"`) holding
 * the transcript, the reading, the proposal and the salesman's values as they
 * stood when it was read. That row is the only record of what the lead held
 * before a correction, because `convertProspect` — which stays the ONLY writer
 * of the converted values — keeps none. It writes NO lead field, NO stage move,
 * NO next action and NO audit entry of its own: it never imports
 * `convertProspect`, `saveProspectFields` or `advanceLeadStage`.
 *
 * THE PRODUCT is resolved by the catalogue's own search and the same
 * `chooseProduct` the Calling Desk uses. There is no second catalogue and no
 * second matcher; several candidates, or none, stay a question for the manager.
 *
 * THE SCOPE is the signed-in person's own: `assertCustomerInScope` resolves the
 * Sales Manager seat from the request, exactly as the save does.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type AnalyseConvertInput = {
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

export type AnalyseConvertResult = { draftId: string; analysis: ConvertAnalysis };

function convertText(input: Pick<AnalyseConvertInput, "spoken" | "english" | "typedNote">): string {
  return [input.typedNote, input.english, input.spoken]
    .map((s) => s.trim())
    .filter((s, i, all) => s && all.indexOf(s) === i)
    .join("\n");
}

export async function analyseConvertCall(input: AnalyseConvertInput): Promise<Result<AnalyseConvertResult>> {
  const started = Date.now();
  const config = await getConfig();
  if (!config["convertIntel.enabled"]) {
    return err("The Convert to Prospect assistant is switched off.", "rule_violation");
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
      customerType: customers.customerType,
      litres: customers.leadMonthlyVolumeLitres,
      potentialPaise: customers.leadEstimatedPotentialPaise,
      competitor: customers.leadCompetitor,
      contact: customers.contactPerson,
      decisionMaker: customers.leadDecisionMaker,
      productId: customers.leadRequiredProductId,
      productName: products.name,
    })
    .from(customers)
    .leftJoin(products, eq(products.id, customers.leadRequiredProductId))
    .where(eq(customers.id, input.customerId));
  if (!row) return err("That lead is not on MahekOne.", "not_found");
  const ctx = await resolveScope();
  await assertCustomerInScope(row);

  /* Convert is the move off the foot of the ladder. Past it there is nothing to convert. */
  if (row.stage !== "suspect" && row.stage !== "new") {
    return err("Only a Suspect is converted to a Prospect, so there is nothing for this assistant to fill.", "rule_violation");
  }

  const text = convertText(input);
  if (text.length < 2) {
    return err("There is nothing to read yet — speak or type what you know about the shop first.", "validation");
  }
  if (text.length > 8000) {
    return err("That is longer than the assistant reads. Keep it to this one shop.", "validation");
  }

  /* THE SALESMAN'S VALUES, as the dialog shows them — read here, from the lead,
     never taken from the browser. They go to the engine and the audit row; they
     are NOT shown to the model. */
  const onFile: ConvertOnFile = {
    customerType: row.customerType ?? null,
    productId: row.productId ?? null,
    productName: row.productName?.trim() || null,
    monthlyLitres: row.litres && row.litres > 0 ? row.litres : null,
    potentialRupees: row.potentialPaise && Number(row.potentialPaise) > 0 ? Math.round(Number(row.potentialPaise) / 100) : null,
    competitor: row.competitor?.trim() || null,
    contact: row.contact?.trim() || null,
    decisionMaker: row.decisionMaker?.trim() || null,
  };

  const read = await readStructured({
    label: "Convert to Prospect assistant",
    system: convertSystemPrompt(),
    prompt: convertUserPrompt({ text: input, shopName: row.companyName || row.name }),
    schema: convertReadingSchema,
    shapeHint: CONVERT_SHAPE_HINT,
    model: config["convertIntel.model"],
  });
  const reading = read.output as ConvertReading | null;

  /* The product, through the catalogue's own search. A failed search is "none", never a guess. */
  let product: ProductMatch | null = null;
  const said = reading?.product?.value?.trim();
  if (said) {
    try {
      const rows = await searchProducts(said, input.customerId);
      product = chooseProduct(
        said,
        rows.map((r) => ({ productId: r.productId, name: r.displayName, boughtBefore: r.boughtBefore })),
      );
    } catch {
      product = { state: "none" };
    }
  }

  const analysis = decideConvertFill({
    reading,
    text,
    onFile,
    product,
    config: { confirmBelow: config["callIntel.confirmBelowPercent"] },
  });

  const draftId = id("ccd");
  await db.insert(callAiDrafts).values({
    id: draftId,
    channel: "convert_call",
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
      "The assistant could not read this — no language model answered. Fill the dialog in as usual; nothing you said is lost.",
      "rule_violation",
    );
  }

  return ok({ draftId, analysis });
}
