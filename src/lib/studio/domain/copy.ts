import { z } from "zod";
import { audiencesSchema } from "./audience";
import { languageSchema, LANGUAGE_SCRIPT, type Language } from "./language";
import { firstWord } from "./text";

// Approved greeting wording (copy.json) and the guardrails every wording must pass, whether it was
// written by hand or (in a later phase) adapted by AI. Pure.

export const ALLOWED_PLACEHOLDERS = ["company", "contact", "product"] as const;
export type Placeholder = (typeof ALLOWED_PLACEHOLDERS)[number];

export const copyOptionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case id"),
  label: z.string().min(1),
  text: z.string().min(1),
  /** Who this wording is cleared for. It can only narrow the design's audiences; absent means the design's. */
  audiences: audiencesSchema.optional(),
});
export type CopyOption = z.infer<typeof copyOptionSchema>;

export const copySchema = z.partialRecord(languageSchema, z.array(copyOptionSchema).min(1));
export type Copy = z.infer<typeof copySchema>;

const INDIC = /[\u{900}-\u{97F}\u{A80}-\u{AFF}]/u;
const DEVANAGARI = /[\u{900}-\u{97F}]/u;
const GUJARATI = /[\u{A80}-\u{AFF}]/u;

// No prices, offers or claims. A conservative word list: it can only make wording stricter.
export const CLAIM_WORDS = /\b(discount|discounts|offer|offers|sale|price|prices|priced|cheap|cheapest|free|guarantee|guaranteed|warranty|certified|certification|best in|no\.?\s*1|number one|limited time|cashback|save)\b/i;

export type CopyIssue = { code: "digits" | "currency" | "percent" | "url" | "phone" | "claim" | "placeholder" | "script" | "length" | "empty"; message: string };

/**
 * Checks one wording against the guardrails. `maxChars` is the greeting field's limit. Returns the
 * list of problems; an empty list means the wording is allowed.
 */
export function checkCopyText(text: string, language: Language, maxChars?: number): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const add = (code: CopyIssue["code"], message: string) => issues.push({ code, message });
  const trimmed = text.trim();
  if (!trimmed) add("empty", "wording is empty");

  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(m[1])) add("placeholder", `placeholder {${m[1]}} is not allowed (use ${ALLOWED_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`);
  }
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ""))) add("placeholder", "stray brace in wording");

  const bare = text.replace(/\{(company|contact|product)\}/g, "");
  if (/[0-9\u{966}-\u{96F}\u{AE6}-\u{AEF}]/u.test(bare)) add("digits", "wording must not contain digits");
  if (/[₹$€£]|\b(rs|inr|usd)\b\.?/i.test(bare)) add("currency", "wording must not mention currency");
  if (/%|percent|per cent/i.test(bare)) add("percent", "wording must not contain percentages");
  if (/https?:|www\.|\.(com|in|org|net)\b|@/i.test(bare)) add("url", "wording must not contain links or addresses");
  if (/\+\s*\d|\b\d{6,}\b/.test(bare)) add("phone", "wording must not contain phone numbers");
  if (CLAIM_WORDS.test(bare)) add("claim", "wording must not contain prices, offers or claims");

  const script = LANGUAGE_SCRIPT[language];
  if (script === "latin" && INDIC.test(bare)) add("script", "English wording must not contain Indic script");
  if (script === "devanagari" && !DEVANAGARI.test(bare)) add("script", "Devanagari wording must contain Devanagari text");
  if (script === "gujarati" && !GUJARATI.test(bare)) add("script", "Gujarati wording must contain Gujarati text");
  if (script === "devanagari" && GUJARATI.test(bare)) add("script", "Devanagari wording must not contain Gujarati script");
  if (script === "gujarati" && DEVANAGARI.test(bare)) add("script", "Gujarati wording must not contain Devanagari script");

  if (maxChars !== undefined && Array.from(trimmed).length > maxChars) add("length", `wording is ${Array.from(trimmed).length} characters; the limit is ${maxChars}`);
  return issues;
}

// Wording written for a NEW LEAD (an enquiry or a welcome). It must never reach a customer. A
// maintained list, so a design that offers a customer such a line is caught when it is validated. It
// is a safety net, not a substitute for the native-reader approval of every line.
const LEAD_STYLE_PHRASES = /\b(your\s+(interest|enquiry|inquiry)|reach(ed|ing)\s+out|welcome\s+to|thank(s|\s+you)\s+for\s+(contacting|enquiring|inquiring)|get(ting)?\s+in\s+touch|new\s+(lead|customer))\b|रुचि|पूछताछ|स्वागत|પૂછપરછ|સ્વાગત|રસ\s+બદલ/iu;

/** Problems that make a wording unfit for a customer: lead-style (enquiry or welcome) language. */
export function checkCustomerWording(text: string): CopyIssue[] {
  return LEAD_STYLE_PHRASES.test(text) ? [{ code: "claim", message: "wording sounds like a new-lead welcome or enquiry reply, which must not reach a customer" }] : [];
}

/** Fills {company}, {contact} and {product}. Placeholders are replaced with plain text, never interpreted. */
export function fillPlaceholders(text: string, values: { company: string; contact: string | null; product: string | null }): string {
  const map: Record<Placeholder, string> = {
    company: values.company,
    contact: values.contact ? firstWord(values.contact) : values.company,
    product: values.product ?? "our range",
  };
  return text.replace(/\{(company|contact|product)\}/g, (_, key: Placeholder) => map[key]);
}

/** The option with this id, or the first option when the id is unknown or missing (the default wording). */
export function pickOption(options: readonly CopyOption[], id: string | undefined): CopyOption | null {
  return options.find((o) => o.id === id) ?? options[0] ?? null;
}
