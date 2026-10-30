import "server-only";
import { z } from "zod";
import { askBoth, askEither, PROVIDER_LABEL, type AiAnswer, type Provider } from "@/lib/price-ai/providers";
import type { CellDiff, ChangeFlag } from "@/lib/engines/price-change";
import { EMPTY_TARGET, type InstructionRule } from "@/lib/engines/price-instruction";
import type { ChangeAiReview } from "@/lib/price-book-views";

/* ---------------------------------------------------------------------------
 * AI ON A PRICE CHANGE — reading an instruction, reviewing the change twice,
 * and a second opinion for the approver. Every prompt is built here from
 * evidence code already computed; no answer is ever used as a number.
 * ------------------------------------------------------------------------- */

const rupees = (p: number | null | undefined) => (p == null ? "—" : `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const pack = (ml: number | null) => (ml == null ? "?" : ml >= 1000 ? `${ml / 1000} L` : `${ml} ml`);

/* ------------------------------------------------------------ instruction */

const targetSchema = z.object({
  families: z.array(z.string()).describe("Brand lines named, copied exactly from the list given. Empty means every family."),
  productIds: z.array(z.string()).describe("Product ids named, only from the list given. Usually empty."),
  minLitres: z.number().nullable(),
  maxLitres: z.number().nullable(),
});

const instructionSchema = z.object({
  understood: z.boolean().describe("False if the sentence is not an instruction to change prices."),
  op: z.enum(["percent", "per_litre", "per_can", "set"]),
  valueBp: z.number().int().nullable().describe("For percent: basis points, signed. +5% is 500, -3% is -300."),
  valuePaise: z.number().int().nullable().describe("For per_litre, per_can (signed) and set: paise. ₹2 is 200."),
  basis: z.enum(["incl", "ex"]).describe("incl unless the sentence says before GST / ex-GST."),
  target: targetSchema,
  rounding: z.enum(["none", "rupee", "five", "ten"]),
  exceptions: z.array(
    targetSchema.extend({
      action: z.enum(["hold", "percent", "set"]),
      valueBp: z.number().int().nullable(),
      valuePaise: z.number().int().nullable(),
    }),
  ),
  question: z.string().nullable().describe("A question to ask the person if anything is ambiguous, else null."),
});

export async function aiReadInstruction(input: {
  changeId: string;
  text: string;
  families: string[];
  products: Array<{ id: string; name: string }>;
  userId: string;
}): Promise<{ rule: InstructionRule | null; question: string | null; by: string | null; reason: string | null }> {
  const answer = await askEither({
    feature: "instruction",
    subject: { kind: "price_change", id: input.changeId },
    userId: input.userId,
    timeoutSeconds: 40,
    schema: instructionSchema,
    system: [
      "You turn one sentence from a paint company's pricing desk into a structured price rule.",
      "You never compute prices. You only describe the rule the sentence states.",
      "Use only family names and product ids from the lists given; never invent one.",
      "Percent values are basis points (5% = 500). Rupee values are paise (₹2 = 200). Down/cut/reduce is negative.",
      "Prices on Mahek's lists are printed including GST, so basis is incl unless the sentence says otherwise.",
      "If anything is ambiguous, still give your best reading and put the question in `question`.",
    ].join("\n"),
    prompt: [
      `Instruction: ${input.text}`,
      `Families on this book: ${input.families.join("; ")}`,
      `Products (id: name): ${input.products.slice(0, 300).map((p) => `${p.id}: ${p.name}`).join("; ")}`,
    ].join("\n"),
  });
  if (!answer.ok) return { rule: null, question: null, by: null, reason: answer.reason };
  const o = answer.output;
  if (!o.understood) return { rule: null, question: o.question ?? "That does not read as a change to prices.", by: PROVIDER_LABEL[answer.provider], reason: null };
  const known = new Set(input.families.map((f) => f.toLowerCase()));
  const ids = new Set(input.products.map((p) => p.id));
  const clean = <T extends { families: string[]; productIds: string[] }>(t: T): T => ({
    ...t,
    families: t.families.filter((f) => known.has(f.toLowerCase())),
    productIds: t.productIds.filter((id) => ids.has(id)),
  });
  const rule: InstructionRule = {
    op: o.op,
    valueBp: o.valueBp,
    valuePaise: o.valuePaise,
    basis: o.basis,
    target: { ...EMPTY_TARGET, ...clean(o.target) },
    rounding: o.rounding,
    exceptions: o.exceptions.map((e) => ({ ...EMPTY_TARGET, ...clean(e) })),
  };
  return { rule, question: o.question, by: PROVIDER_LABEL[answer.provider], reason: null };
}

/* ----------------------------------------------------------------- review */

const TOPICS = ["typo", "ladder", "drift_from_books", "below_billed", "unit_confusion", "exception_wording", "volume_risk", "other"] as const;

const reviewSchema = z.object({
  summary: z.string().describe("Two or three sentences: is this change consistent, and where is the risk."),
  findings: z.array(
    z.object({
      severity: z.enum(["high", "medium", "low"]),
      topic: z.enum(TOPICS),
      productId: z.string().nullable().describe("The product id the finding is about, from the evidence, or null."),
      message: z.string().describe("One plain sentence a pricing clerk can act on."),
    }),
  ),
});

export type ReviewEvidence = {
  bookName: string;
  freightTerm: string;
  gstBp: number;
  reason: string | null;
  changed: CellDiff[];
  /** Per product: the median of the same product in other live books. */
  neighbourMedian: Map<string, number>;
  /** Per product: what the book's shops were billed in the last six months. */
  billed: Map<string, { lines: number; minEx: number; medianEx: number }>;
  totals: { changed: number; up: number; down: number; effectPerMonthPaise: number };
};

function evidenceText(e: ReviewEvidence): string {
  const lines = e.changed.slice(0, 250).map((d) => {
    const n = e.neighbourMedian.get(d.productId);
    const b = e.billed.get(d.productId);
    return [
      `${d.productId} | ${d.productName} | ${pack(d.millilitresPerCan)}${d.minCans ? ` from ${d.minCans} cans` : ""}`,
      `before ex ${rupees(d.before?.rateExGstPaise)} incl ${rupees(d.before?.rateInclGstPaise)}`,
      `after ex ${rupees(d.after?.rateExGstPaise)} incl ${rupees(d.after?.rateInclGstPaise)}`,
      `move ${d.kind}${d.changeBp != null ? ` ${(d.changeBp / 100).toFixed(1)}%` : ""}`,
      n != null ? `other books median ex ${rupees(n)}` : "no other book",
      b ? `billed 6m: ${b.lines} lines, lowest ex ${rupees(b.minEx)}, median ex ${rupees(b.medianEx)}` : "not billed in 6m",
    ].join(" ; ");
  });
  return [
    `Book: ${e.bookName} · freight ${e.freightTerm} · GST ${(e.gstBp / 100).toFixed(0)}%`,
    `Reason given by the maker: ${e.reason?.trim() || "(none given)"}`,
    `Totals: ${e.totals.changed} cells changed, ${e.totals.up} up, ${e.totals.down} down, effect a month at recent volume ${rupees(e.totals.effectPerMonthPaise)}.`,
    "Changed cells (product id | name | pack ; before ; after ; move ; other books ; billed):",
    ...lines,
    e.changed.length > 250 ? `(${e.changed.length - 250} more not shown)` : "",
  ].join("\n");
}

const REVIEW_SYSTEM = [
  "You are an independent reviewer of a price-list change at an Indian paint-thinner manufacturer.",
  "Another reviewer checks the same change separately; you do not see each other's answer.",
  "You may only FLAG. You never propose new prices as figures to be used, and you never approve.",
  "Look for: likely typos (a slipped digit, a price far from other books), a bigger pack dearer per litre than a smaller one,",
  "this book drifting away from neighbouring books, customers already billed below the old price (the rise may not stick),",
  "litre vs can confusion, an exception that contradicts the stated reason, and moves too large for the reason given.",
  "Refer to products by the product id given. Be concrete and short. If the change looks sound, say so and return few or no findings.",
].join("\n");

export async function aiReviewChange(input: { changeId: string; userId: string; evidence: ReviewEvidence }): Promise<ChangeAiReview[]> {
  const prompt = evidenceText(input.evidence);
  const { openai, anthropic } = await askBoth({
    feature: "review",
    subject: { kind: "price_change", id: input.changeId },
    userId: input.userId,
    timeoutSeconds: 90,
    schema: reviewSchema,
    system: REVIEW_SYSTEM,
    prompt,
  });
  const ids = new Set(input.evidence.changed.map((d) => d.productId));
  return [toReview(openai, ids), toReview(anthropic, ids)];
}

function toReview(answer: AiAnswer<z.infer<typeof reviewSchema>>, ids: Set<string>): ChangeAiReview {
  const label = PROVIDER_LABEL[answer.provider];
  if (!answer.ok) return { provider: answer.provider, label, ok: false, reason: answer.reason, summary: null, findings: [], at: new Date().toISOString() };
  const seen = new Set<string>();
  const findings: ChangeFlag[] = [];
  for (const f of answer.output.findings.slice(0, 40)) {
    const productId = f.productId && ids.has(f.productId) ? f.productId : null;
    // Keyed on who, what and which product — not the wording, which changes
    // every run — so an acknowledgement survives a re-check.
    let key = `ai|${answer.provider}|${f.topic}|${productId ?? "-"}`;
    if (seen.has(key)) key = `${key}|${seen.size}`;
    seen.add(key);
    findings.push({
      key,
      kind: "readback",
      severity: f.severity,
      blocking: false,
      productId,
      cellKey: productId ? `${productId}|0` : null,
      message: f.message,
      by: label,
    });
  }
  return { provider: answer.provider, label, ok: true, reason: null, summary: answer.output.summary, findings, at: new Date().toISOString() };
}

/* ---------------------------------------------------------- second opinion */

const opinionSchema = z.object({
  paragraph: z.string().describe("One paragraph for the approver: does the change match its stated reason, and where is the risk."),
  recommendation: z.enum(["approve", "check_first", "send_back"]),
});

export async function aiSecondOpinion(input: {
  changeId: string;
  userId: string;
  evidence: ReviewEvidence;
  acknowledged: Array<{ message: string; note: string }>;
}): Promise<{ provider: Provider; text: string; recommendation: string } | { error: string }> {
  const answer = await askEither({
    feature: "second_opinion",
    subject: { kind: "price_change", id: input.changeId },
    userId: input.userId,
    timeoutSeconds: 60,
    schema: opinionSchema,
    system: [
      "You give an approver at a paint manufacturer a second opinion on a price change before they approve it.",
      "You advise only; the approver decides. Be brief, specific and plain.",
    ].join("\n"),
    prompt: [
      evidenceText(input.evidence),
      "",
      "Flags the maker acknowledged as intended, with their reasons:",
      ...(input.acknowledged.length ? input.acknowledged.map((a) => `- ${a.message} — maker says: ${a.note}`) : ["(none)"]),
    ].join("\n"),
  });
  if (!answer.ok) return { error: answer.reason };
  return { provider: answer.provider, text: answer.output.paragraph, recommendation: answer.output.recommendation };
}
