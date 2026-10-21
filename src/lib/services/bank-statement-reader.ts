import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSecret } from "@/lib/secrets";
import { toPaise, type ReadRow } from "@/lib/engines/bank-statements";

/* ---------------------------------------------------------------------------
 * A BANK'S STATEMENT PDF IN, ITS LINES OUT.
 *
 * The PDF goes to OpenAI as the file it is — the model sees the pages as the
 * bank laid them out, which is what a statement's columns need. A PDF the bank
 * locked with a password is opened here with that password and its TEXT is
 * sent instead: an encrypted file is unreadable to the model, and the
 * password is used once and never stored.
 *
 * The model reads and nothing else. Whether the figures add up, which lines
 * are already in, and what each line could be are decided by the pure rules
 * in `lib/engines/bank-statements.ts`, so a reading that is wrong shows up as
 * a balance that breaks rather than as a confident figure.
 * ------------------------------------------------------------------------- */

const rowSchema = z.object({
  page: z.number().int().nullable().describe("The page the line is printed on, from 1."),
  date: z.string().describe("The transaction date (not the value date) as YYYY-MM-DD."),
  narration: z.string().describe("The narration / description / particulars exactly as printed, on one line."),
  reference: z
    .string()
    .nullable()
    .describe("The cheque number, UTR or reference number from its own column, or null. Do not invent one from the narration."),
  debit: z.number().nullable().describe("Money out (withdrawal / debit / Dr), in rupees with paise, or null."),
  credit: z.number().nullable().describe("Money in (deposit / credit / Cr), in rupees with paise, or null."),
  balance: z.number().nullable().describe("The running balance printed on the line, in rupees with paise. Negative for an overdrawn (Dr) balance. Null if none is printed."),
  confidence: z.number().int().describe("0–100: how sure you are of this line's date, amount and balance as read."),
});

const readingSchema = z.object({
  bankName: z.string().nullable().describe("The bank, e.g. Kotak Mahindra Bank."),
  accountLast4: z.string().nullable().describe("The last four digits of the account number."),
  periodFrom: z.string().nullable().describe("The start of the statement period as printed, e.g. '21 Oct 2026' or '21 Oct 2026 00:00'."),
  periodTo: z.string().nullable().describe("The end of the statement period as printed."),
  openingBalance: z.number().nullable().describe("The opening balance in rupees, negative if overdrawn, or null."),
  closingBalance: z.number().nullable().describe("The closing balance in rupees, negative if overdrawn, or null."),
  rows: z.array(rowSchema).describe("Every transaction line, in the order printed. Never the opening balance, closing balance, B/F, C/F or total rows."),
});

export type StatementReading = {
  bankName: string | null;
  accountLast4: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  openingPaise: number | null;
  closingPaise: number | null;
  rows: ReadRow[];
  pages: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

const SYSTEM = `You read Indian bank account statements (Kotak, ICICI, HDFC, SBI, Axis and others) into a table.

Read every transaction line on every page, in the order printed. Copy figures exactly: amounts in rupees with their paise, Indian digit grouping removed (1,24,500.00 is 124500.00). A line is either a debit (money out, withdrawal, Dr) or a credit (money in, deposit, Cr) — never both.

Skip the opening balance row, the closing balance row, brought forward / carried forward rows, page totals and summary tables: they are not transactions. A narration that wraps over several printed lines is ONE transaction — join it with spaces.

Dates are written as YYYY-MM-DD. Statements are in India, so 05/10/2026 is 5 October 2026.

Use the confidence field honestly: below 80 where a digit is smudged, a column is ambiguous, or you had to guess which column a figure belongs to.`;

export class StatementLocked extends Error {
  constructor(public wrongPassword: boolean) {
    super(wrongPassword ? "That password does not open this PDF." : "This PDF is locked with a password.");
  }
}

/** Opens the PDF: how many pages, whether it is locked, and its text where a password opened it. */
async function openPdf(bytes: Uint8Array, password: string | null): Promise<{ pages: number; locked: boolean; text: string | null }> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const locked = isEncrypted(bytes);
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), password ? { password } : undefined);
    if (!locked) return { pages: pdf.numPages, locked, text: null };
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((p, i) => `--- Page ${i + 1} ---\n${p ?? ""}`);
    return { pages: pdf.numPages, locked, text: pages.join("\n\n") };
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "PasswordException" || /password/i.test(e instanceof Error ? e.message : "")) throw new StatementLocked(!!password);
    throw e;
  }
}

function isEncrypted(bytes: Uint8Array): boolean {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 4096))).toString("latin1");
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("latin1");
  return /\/Encrypt\b/.test(tail) || /\/Encrypt\b/.test(head);
}

export async function readStatementPdf(args: { bytes: Uint8Array; fileName: string; password: string | null; model: string }): Promise<StatementReading> {
  const key = await readSecret("openai.apiKey");
  if (!key) throw new Error("Reading statements needs the OpenAI key. Add it on Admin Console → Integrations.");
  const opened = await openPdf(args.bytes, args.password);
  if (opened.locked && !args.password) throw new StatementLocked(false);
  if (opened.locked && !opened.text?.replace(/[-\sPage\d]/g, "")) throw new Error("This PDF has no text once opened, so it cannot be read. Download the statement again as a text PDF.");

  const client = createOpenAI({ apiKey: key });
  const content =
    opened.locked && opened.text
      ? [{ type: "text" as const, text: `Read this bank statement. Its text, page by page:\n\n${opened.text}` }]
      : [
          { type: "text" as const, text: "Read this bank statement." },
          { type: "file" as const, mediaType: "application/pdf", data: args.bytes, filename: args.fileName },
        ];
  const result = await generateText({
    model: client(args.model),
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output: Output.object({ schema: readingSchema }),
    providerOptions: { openai: { reasoningEffort: "low" } },
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(300_000),
  });
  const r = result.output;
  const rows: ReadRow[] = [];
  for (const [i, x] of r.rows.entries()) {
    const debit = toPaise(x.debit) ?? 0;
    const credit = toPaise(x.credit) ?? 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) continue;
    if ((debit > 0) === (credit > 0)) continue;
    rows.push({
      lineNo: i + 1,
      page: x.page,
      date: x.date,
      narration: x.narration.replace(/\s+/g, " ").trim() || "—",
      reference: x.reference?.trim() || null,
      debitPaise: Math.abs(debit),
      creditPaise: Math.abs(credit),
      balancePaise: toPaise(x.balance),
      confidence: Math.max(0, Math.min(100, Math.round(x.confidence))),
    });
  }
  return {
    bankName: r.bankName,
    accountLast4: r.accountLast4?.replace(/\D/g, "").slice(-4) || null,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    openingPaise: toPaise(r.openingBalance),
    closingPaise: toPaise(r.closingBalance),
    rows,
    pages: opened.pages,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
  };
}
