import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSecret } from "@/lib/secrets";
import { toPaise, type ReadRow } from "@/lib/engines/bank-statements";
import { absolutePage, prepareStatement, StatementLocked } from "@/lib/bank-statement-pdf";

export { StatementLocked };

/* ---------------------------------------------------------------------------
 * A BANK'S STATEMENT PDF IN, ITS LINES OUT.
 *
 * LOCKED MEANS IT WILL NOT OPEN, NOT THAT IT IS ENCRYPTED. Most banks encrypt
 * every statement with an OWNER password only — it opens in any viewer and
 * merely refuses editing. So the PDF is always opened WITHOUT a password
 * first, and a password is asked for only when pdf.js says one is needed. A
 * password typed for a PDF that needs none is simply not used.
 *
 * A STATEMENT IS READ A FEW PAGES AT A TIME. Fifty pages in one call is a
 * reading longer than a model will write in one answer and longer than any
 * sane timeout, so it is cut into pieces of `PAGES_PER_CALL` pages, read
 * `PARALLEL` at a time, and joined in page order. A PDF that is not encrypted
 * goes as the file it is (each piece re-saved by pdf-lib), because the model
 * then sees the columns as the bank laid them out. An encrypted one cannot be
 * re-saved or read by the model, so its pages go as TEXT, laid out from each
 * word's position so the columns still line up.
 *
 * The model reads and nothing else. Whether the figures add up, which lines
 * are already in, and what each line could be are decided by the pure rules
 * in `lib/engines/bank-statements.ts`, so a reading that is wrong shows up as
 * a balance that breaks rather than as a confident figure.
 * ------------------------------------------------------------------------- */

/** Pieces read at once. */
const PARALLEL = 4;

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
  openingBalance: z.number().nullable().describe("The statement's opening balance in rupees, negative if overdrawn — only if it is printed on the pages you were given, else null. Never a page's brought-forward figure."),
  closingBalance: z.number().nullable().describe("The statement's closing balance in rupees, negative if overdrawn — only if it is printed on the pages you were given, else null. Never a page's carried-forward figure."),
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

You may be given the whole statement or a few of its pages. Read every transaction line on the pages you are given, in the order printed — the first and last lines on a page included. Copy figures exactly: amounts in rupees with their paise, Indian digit grouping removed (1,24,500.00 is 124500.00). A line is either a debit (money out, withdrawal, Dr) or a credit (money in, deposit, Cr) — never both.

Skip the opening balance row, the closing balance row, brought forward / carried forward rows, page totals and summary tables: they are not transactions. A narration that wraps over several printed lines is ONE transaction — join it with spaces.

Dates are written as YYYY-MM-DD. Statements are in India, so 05/10/2026 is 5 October 2026.

Use the confidence field honestly: below 80 where a digit is smudged, a column is ambiguous, or you had to guess which column a figure belongs to.`;

async function mapLimit<T, R>(list: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    }),
  );
  return out;
}

export async function readStatementPdf(args: {
  bytes: Uint8Array;
  fileName: string;
  password: string | null;
  model: string;
  /** Told after each piece: how many of how many are read, and the page count. */
  onProgress?: (done: number, total: number, pages: number) => Promise<void> | void;
}): Promise<StatementReading> {
  const key = await readSecret("openai.apiKey");
  if (!key) throw new Error("Reading statements needs the OpenAI key. Add it on Admin Console → Integrations.");
  const { pages, ranges, pieceFor } = await prepareStatement(args.bytes, args.fileName, args.password);
  await args.onProgress?.(0, ranges.length, pages);

  const client = createOpenAI({ apiKey: key });
  let done = 0;
  const results = await mapLimit(ranges, PARALLEL, async (r) => {
    const piece = await pieceFor(r);
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await generateText({
          model: client(args.model),
          system: SYSTEM,
          messages: [{ role: "user", content: piece.content }],
          output: Output.object({ schema: readingSchema }),
          providerOptions: { openai: { reasoningEffort: "low" } },
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(240_000),
        });
        done++;
        await args.onProgress?.(done, ranges.length, pages);
        return { r, out: result.output, usage: result.usage };
      } catch (e) {
        last = e;
      }
    }
    const why = last instanceof Error ? last.message : "";
    throw new Error(`Pages ${r.from}–${r.to} could not be read${why ? `: ${why.slice(0, 200)}` : "."}`);
  });

  const rows: ReadRow[] = [];
  let lineNo = 0;
  for (const { r, out } of results) {
    for (const x of out.rows) {
      const debit = toPaise(x.debit) ?? 0;
      const credit = toPaise(x.credit) ?? 0;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) continue;
      if ((debit > 0) === (credit > 0)) continue;
      rows.push({
        lineNo: ++lineNo,
        page: absolutePage(x.page, r.from, r.to),
        date: x.date,
        narration: x.narration.replace(/\s+/g, " ").trim() || "—",
        reference: x.reference?.trim() || null,
        debitPaise: Math.abs(debit),
        creditPaise: Math.abs(credit),
        balancePaise: toPaise(x.balance),
        confidence: Math.max(0, Math.min(100, Math.round(x.confidence))),
      });
    }
  }
  const outs = results.map((x) => x.out);
  const first = <K extends keyof (typeof outs)[number]>(k: K) => outs.find((o) => o[k] != null)?.[k] ?? null;
  const lastOf = <K extends keyof (typeof outs)[number]>(k: K) => [...outs].reverse().find((o) => o[k] != null)?.[k] ?? null;
  const sum = (k: "inputTokens" | "outputTokens") => results.reduce<number | null>((n, x) => (x.usage?.[k] == null ? n : (n ?? 0) + (x.usage[k] as number)), null);
  const last4 = first("accountLast4") as string | null;
  return {
    bankName: first("bankName") as string | null,
    accountLast4: last4?.replace(/\D/g, "").slice(-4) || null,
    periodFrom: first("periodFrom") as string | null,
    periodTo: first("periodTo") as string | null,
    openingPaise: toPaise(first("openingBalance") as number | null),
    closingPaise: toPaise(lastOf("closingBalance") as number | null),
    rows,
    pages,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
  };
}
