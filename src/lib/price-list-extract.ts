import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { readSecret } from "@/lib/secrets";
import type { ParsedPriceList } from "./price-list-parse";

/* ---------------------------------------------------------------------------
 * GETTING THE WORDS OFF THE PAGE — and only where a reader cannot.
 *
 * Mahek's own lists are text PDFs, so `unpdf` reads every character exactly
 * and the pure parser does the rest with no model, no key and no bill. That is
 * the path this feature is built on: thirty-odd lists a month cannot be worth
 * an API call each when a regular expression is right every time.
 *
 * A MODEL IS THE FALLBACK, not the reader. A scan, a photograph of a printed
 * sheet, a list somebody rebuilt in Word and exported oddly — those carry no
 * text layer, and refusing them would send the office back to typing prices in
 * by hand. So a PDF with no text and an image go to a vision model with a
 * strict schema, and its answer is put through the SAME validation, the same
 * matching and the same human review as a parsed one. Nothing it says is
 * published without somebody opening the document.
 *
 * NO KEY IS AN ANSWER. `readSecret` is the one place a credential is read and
 * it may simply be absent; the caller then records that the file could not be
 * read and says so on the screen, rather than failing in a way that reads as
 * a broken upload.
 *
 * The bytes go to the model and nowhere else. Nothing here stores a file, and
 * the document's own attachment is the only copy MahekOne keeps.
 * ------------------------------------------------------------------------- */

export type ExtractedPages = {
  kind: "pdf_text" | "pdf_scan" | "image";
  /** Empty for a scan or an image: there was nothing to read without a model. */
  pages: string[];
  pageCount: number;
};

/** Below this, a page is a picture of words rather than words. */
const TEXT_PER_PAGE_FLOOR = 40;

export async function extractPages(bytes: Uint8Array, contentType: string): Promise<ExtractedPages> {
  if (contentType.startsWith("image/")) return { kind: "image", pages: [], pageCount: 1 };

  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p ?? "");
  const readable = pages.filter((p) => p.replace(/\s/g, "").length >= TEXT_PER_PAGE_FLOOR);
  if (!readable.length) return { kind: "pdf_scan", pages: [], pageCount: totalPages };
  return { kind: "pdf_text", pages, pageCount: totalPages };
}

/* ---------------------------------------------------------------- vision */

const VISION_MODEL = "gpt-4o";

/**
 * The shape the model must answer in.
 *
 * Deliberately the parser's own shape rather than free prose: a model asked
 * for JSON that matches what the deterministic reader produces can be fed
 * through exactly the same matching, validation and review, and the two paths
 * cannot drift into two ideas of what a price list is. Prices come back as the
 * document PRINTS them — a string like "Rs.1,168" — because asking a model to
 * do arithmetic on money is asking for a wrong rupee nobody can trace.
 */
const VisionSchema = z.object({
  refNo: z.string().nullable(),
  effectiveFrom: z.string().nullable().describe("ISO date, YYYY-MM-DD"),
  taxBasis: z.enum(["inclusive", "exclusive"]).nullable(),
  gstPercent: z.number().nullable(),
  deliveryBasis: z.enum(["for_mumbai", "for_godown", "door_delivery", "ex_factory"]).nullable(),
  freightTerm: z.enum(["to_pay", "paid", "not_stated"]).nullable(),
  validityDays: z.number().nullable(),
  signatory: z.string().nullable(),
  columns: z
    .array(
      z.object({
        sizeLabel: z.string().describe('As printed, e.g. "20 Litre" or "20L Tin Can"'),
        packLabel: z.string().describe('As printed, e.g. "02/bx" or "01 Can"'),
      }),
    )
    .describe("The pack-size columns, left to right"),
  rows: z
    .array(
      z.object({
        product: z.string().describe("The product name exactly as printed down the side"),
        prices: z.array(z.string()).describe('One per column, as printed — "Rs.1,168" or "—" where there is no price'),
      }),
    )
    .describe("The product rows, top to bottom"),
  discountTerms: z.array(
    z.object({
      kind: z.enum(["advance_payment", "quantity", "prompt_payment", "other"]),
      percent: z.number(),
      thresholdLitres: z.number().nullable(),
      rawText: z.string(),
    }),
  ),
  termsText: z.string().nullable().describe("The terms and conditions block, as printed"),
});

export type VisionOutcome =
  | { parsed: ParsedPriceList; model: string }
  | { error: string };

/**
 * Read a scan or a photograph.
 *
 * The answer is assembled into the parser's own structure here rather than in
 * the caller, so `parseDocument` has one shape to store whichever reader
 * produced it. Confidence is capped well below a text read: a model that has
 * misread one digit looks exactly like one that has not.
 */
export async function readWithVision(bytes: Uint8Array, contentType: string): Promise<VisionOutcome> {
  const key = await readSecret("openai.apiKey");
  if (!key) {
    return {
      error:
        "This file has no text in it, so it has to be read by a model, and no OpenAI key is set. Add one in Admin Console → Platform, or upload a PDF that was exported rather than scanned.",
    };
  }

  const client = createOpenAI({ apiKey: key });
  try {
    const result = await generateObject({
      model: client(VISION_MODEL),
      schema: VisionSchema,
      abortSignal: AbortSignal.timeout(120_000),
      system:
        "You read price lists. Transcribe EXACTLY what the document shows: never compute, convert, round or infer a price, and never invent a row or a column. Where a cell is blank or shows a dash, answer with a dash. Keep product names and pack labels spelled as printed.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this price list. Every product row, every pack-size column, and the header and terms." },
            { type: "file", data: bytes, mediaType: contentType },
          ],
        },
      ],
    });

    const { parsePackColumn, parseRupees } = await import("./price-list-parse");
    const o = result.object;
    const columns = o.columns.map((c, colIndex) => ({ colIndex, ...parsePackColumn(c.sizeLabel, c.packLabel) }));
    const rows = o.rows.map((r, rowIndex) => ({
      rowIndex,
      rawProduct: r.product,
      cells: r.prices.slice(0, columns.length).map((raw, colIndex) => ({
        colIndex,
        raw,
        inclPaise: parseRupees(raw),
        offered: parseRupees(raw) != null,
      })),
    }));
    const discountTerms = o.discountTerms.map((d) => ({
      kind: d.kind,
      percentBp: Math.round(d.percent * 100),
      thresholdLitres: d.thresholdLitres,
      thresholdPaise: null,
      rawText: d.rawText,
    }));

    const warnings = ["Read by a model rather than from the file's own text. Check every figure before publishing."];
    if (rows.some((r) => r.cells.length !== columns.length)) warnings.push("A row came back with a different number of prices than there are columns.");

    const header = {
      refNo: o.refNo,
      effectiveFrom: o.effectiveFrom,
      taxBasis: o.taxBasis,
      gstBp: o.gstPercent == null ? null : Math.round(o.gstPercent * 100),
      deliveryBasis: o.deliveryBasis,
      freightTerm: o.freightTerm,
      validityDays: o.validityDays,
      signatory: o.signatory,
      discountTerms,
      termsText: o.termsText,
    };

    return {
      parsed: {
        layout: columns.length > 1 ? "grid" : "long",
        header,
        columns,
        rows,
        discountTerms,
        termsText: o.termsText,
        warnings,
        // A model read is never better than "worth checking", whatever it says.
        confidence: Math.min(70, rows.length ? 70 : 20),
      },
      model: VISION_MODEL,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "The model could not read this file." };
  }
}
