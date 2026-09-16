import { z } from "zod";

/**
 * The shape a website (or, later, another source) must send to
 * /api/public/enquiries. Pure and dependency-free — no database, no
 * secrets — so it can be tested without either, the same reason the
 * website's own `enquiry-server-validation.ts` is kept separate from its
 * route handler.
 *
 * `formType`/`category` are the website's own vocabulary
 * (src/types/enquiry.ts in the mahek-website repo), duplicated here rather
 * than shared, because nothing can be imported across two repositories —
 * keep this list in step with that one if the website ever adds a ninth
 * form.
 */
export const ENQUIRY_SOURCE_FORM_TYPES = [
  "CONTACT",
  "QUICK_ENQUIRY",
  "PRODUCT_ENQUIRY",
  "DISTRIBUTOR",
  "TECHNICAL_ENQUIRY",
  "QUOTE",
  "SAMPLE",
  "CAREER",
] as const;

export const ENQUIRY_SOURCE_CATEGORIES = ["GENERAL", "SALES", "DISTRIBUTOR", "CAREER", "LOGISTICS"] as const;

/** Keys that must never appear as a submission field. The payload is stored as plain jsonb and never spread onto a live object, so nothing here is exploitable — a request trying to smuggle them in simply isn't a real form submission. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const EnquiryIngestSchema = z.object({
  formType: z.enum(ENQUIRY_SOURCE_FORM_TYPES),
  category: z.enum(ENQUIRY_SOURCE_CATEGORIES).optional(),
  /** The sending source's own id for this submission — the idempotency key. Never a phone number, never a timestamp. */
  externalRef: z.string().trim().min(1).max(100),
  /** The sending source's own backend clock, not a visitor's browser. */
  receivedAt: z.iso.datetime({ offset: true }),
  submission: z.record(z.string(), z.unknown()).refine(
    (obj) => Object.keys(obj).every((k) => !FORBIDDEN_KEYS.has(k)),
    { message: "Invalid submission." },
  ),
});

export type EnquiryIngestPayload = z.infer<typeof EnquiryIngestSchema>;

/** Bytes, not characters — comfortably above the largest real form (Distributor, ~15 fields) with room for free text, without leaving the door open to an arbitrarily large body. */
export const MAX_INGEST_BODY_BYTES = 32 * 1024;

export function parseIngestPayload(raw: unknown): { ok: true; data: EnquiryIngestPayload } | { ok: false; error: string } {
  const parsed = EnquiryIngestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid submission." };
  return { ok: true, data: parsed.data };
}
