import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { aiReadTrials, attachments, mbosExpenses } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { fileStorage } from "@/lib/storage";
import { sarvamExtract } from "@/lib/sarvam-extract";
import type { LeadScanResult } from "@/lib/engines/lead-scan";
import {
  compareLeadScans,
  readDate,
  readRupeesToPaise,
  scoreBill,
  toSarvamSchema,
  type ReadBill,
  type ReadProvider,
} from "@/lib/engines/read-trial";
import { err, ok, type Result } from "@/lib/result";
import {
  readCardWithOpenai,
  readCardWithSarvam,
  type DetailedScan,
  type LeadScanImage,
} from "@/lib/services/lead-scan-service";

/* ---------------------------------------------------------------------------
 * THE READING TRIAL: Sarvam beside OpenAI, on our own photographs.
 *
 * Sarvam is built for India; whether that makes it the better reader of a
 * Marathi shop board or a Gujarati fuel bill is a question for evidence, so
 * neither feature changes who reads first on a hunch. Both providers read the
 * same photographs here, and `ai_read_trials` keeps how they compared — per
 * field VERDICTS and timings, never a value read (`engines/read-trial.ts`).
 * The results are on Admin Console → Integrations.
 *
 *   EXPENSE BILLS — run on demand ("Read bills with both"): the latest
 *   `readTrial.expenseBills` bill photos not already in the trial, each read
 *   by both and SCORED against what the salesman typed beside it. The photos
 *   are already stored; this reads them, writes nothing back to the expense.
 *
 *   LEAD SCANS — with `leadScan.trial` on, every scan, AFTER the handset has
 *   its answer (`after()` in the route): the provider that did not answer
 *   reads the same photographs and the two are COMPARED. Off by default,
 *   because it sends every card to a second company.
 *
 * Neither path can disturb the feature it measures: a trial read that fails
 * is a row saying so, and nothing here is on the salesman's clock.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------- lead scan */

const NOTHING: LeadScanResult = {
  businessName: null,
  contactPerson: null,
  mobile: null,
  otherNumbers: [],
  city: null,
  state: null,
  address: null,
  gstin: null,
  gstinCheck: null,
  note: null,
};

/** "Found nothing" is an answer to compare; a refusal or a timeout is a failure. */
function asReading(r: Result<LeadScanResult>): { ok: true; data: LeadScanResult } | { ok: false; error: string } {
  if (r.ok) return { ok: true, data: r.data };
  if (r.code === "not_found") return { ok: true, data: NOTHING };
  return { ok: false, error: r.error };
}

export async function recordLeadScanTrial(images: LeadScanImage[], primary: DetailedScan): Promise<void> {
  try {
    const config = await getConfig();
    if (!config["leadScan.trial"] || !primary.servedBy) return;
    const [openaiKey, sarvamKey] = await Promise.all([readSecret("openai.apiKey"), readSecret("sarvam.apiKey")]);
    if (!openaiKey || !sarvamKey) return;

    const other: ReadProvider = primary.servedBy === "openai" ? "sarvam" : "openai";
    const started = Date.now();
    const second = asReading(
      other === "sarvam"
        ? await readCardWithSarvam(images, { sarvamKey, openaiKey, model: config["leadScan.model"] }, 90_000)
        : await readCardWithOpenai(images, openaiKey, config["leadScan.model"]),
    );
    const otherMs = Date.now() - started;
    const first = asReading(primary.result);

    const byProvider = {
      [primary.servedBy]: { reading: first, ms: primary.ms },
      [other]: { reading: second, ms: otherMs },
    } as Record<ReadProvider, { reading: ReturnType<typeof asReading>; ms: number }>;
    const { openai, sarvam } = byProvider;
    /* The comparison is one fact about the pair; it is kept on Sarvam's row,
       the one under trial, so the summary counts it once. */
    const compared = openai.reading.ok && sarvam.reading.ok ? compareLeadScans(openai.reading.data, sarvam.reading.data) : {};
    const subjectId = randomUUID();
    await db.insert(aiReadTrials).values(
      (["openai", "sarvam"] as const).map((provider) => {
        const side = byProvider[provider];
        return {
          id: randomUUID(),
          feature: "lead_scan",
          provider,
          subjectId,
          ok: side.reading.ok,
          ms: side.ms,
          error: side.reading.ok ? null : side.reading.error.slice(0, 300),
          fields: provider === "sarvam" ? compared : {},
        };
      }),
    );
  } catch (e) {
    console.error("Reading trial: lead scan comparison failed:", e instanceof Error ? e.message : e);
  }
}

/* ------------------------------------------------------------- expense bills */

const billSchema = z.object({
  total: z
    .number()
    .nullable()
    .describe("The bill's grand total — the final amount payable, after tax and round off — in rupees, as a number. Null if no total is printed."),
  billNumber: z.string().nullable().describe("The bill, invoice or receipt number exactly as printed. Null if none."),
  billDate: z.string().nullable().describe("The date printed on the bill, exactly as printed (Indian bills put the day first). Null if none."),
});
type BillReading = z.infer<typeof billSchema>;

const BILL_SYSTEM = `You read one photograph or PDF of a bill or receipt a salesman in India is claiming as an expense: fuel, a meal, lodging, a bus or auto fare, parking. Read only what is printed or written; never compute, guess or invent. Digits printed in an Indian script are written as 0-9.`;
const SARVAM_BILL_SCHEMA = toSarvamSchema(z.toJSONSchema(billSchema) as Record<string, unknown>);

const asBill = (r: Partial<BillReading> | Record<string, unknown>): ReadBill => ({
  amountPaise: readRupeesToPaise(r.total),
  billNumber: typeof r.billNumber === "string" && r.billNumber.trim() ? r.billNumber.trim() : null,
  billDate: readDate(r.billDate),
});

type BillFile = { bytes: Uint8Array; mediaType: string };
type Read = { ok: true; bill: ReadBill; ms: number } | { ok: false; error: string; ms: number };

async function readBillWithOpenai(file: BillFile, key: string, model: string): Promise<Read> {
  const started = Date.now();
  try {
    const r = await generateText({
      model: createOpenAI({ apiKey: key })(model),
      system: BILL_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this bill." },
            { type: "file", mediaType: file.mediaType, data: file.bytes, providerOptions: { openai: { imageDetail: "high" } } },
          ],
        },
      ],
      output: Output.object({ schema: billSchema }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(90_000),
    });
    return { ok: true, bill: asBill(r.output), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), ms: Date.now() - started };
  }
}

async function readBillWithSarvam(file: BillFile, key: string): Promise<Read> {
  const ext = file.mediaType === "application/pdf" ? "pdf" : file.mediaType === "image/png" ? "png" : "jpg";
  const r = await sarvamExtract({
    key,
    files: [{ ...file, filename: `bill.${ext}` }],
    schema: SARVAM_BILL_SCHEMA,
    timeoutMs: 120_000,
  });
  return r.ok ? { ok: true, bill: asBill(r.result), ms: r.ms } : { ok: false, error: r.error, ms: r.ms };
}

const READABLE = ["image/jpeg", "image/png", "application/pdf"];

/* ONE RUN AT A TIME. "Already in the trial" is decided before a run has
   written anything, so a second press while the first is reading would pick
   the same bills and pay for them twice. The app is one Node process on the
   droplet, so a flag in it is the whole of the lock. */
let billTrialRunning = false;

/**
 * Picks the bills and hands back the work to do — the caller runs it in
 * `after()`, because twenty bills read twice is minutes, not a request.
 */
export async function prepareExpenseBillTrial(): Promise<Result<{ bills: number; run: () => Promise<void> }>> {
  if (billTrialRunning) return err("A reading trial is already running. Reload in a few minutes to see it.", "rule_violation");
  const config = await getConfig();
  const [openaiKey, sarvamKey] = await Promise.all([readSecret("openai.apiKey"), readSecret("sarvam.apiKey")]);
  if (!openaiKey || !sarvamKey) {
    return err(`The trial needs both keys; ${!openaiKey ? "OpenAI" : "Sarvam"}'s is not set.`, "rule_violation");
  }

  const bills = await db
    .select({
      id: mbosExpenses.id,
      amountPaise: mbosExpenses.amountPaise,
      billNumber: mbosExpenses.billNumber,
      billDate: mbosExpenses.billDate,
      storedRef: attachments.storedRef,
      contentType: attachments.contentType,
    })
    .from(mbosExpenses)
    .innerJoin(attachments, eq(attachments.id, mbosExpenses.billPhotoId))
    .where(
      and(
        eq(attachments.status, "available"),
        inArray(attachments.contentType, READABLE),
        sql`${mbosExpenses.amountPaise} > 0`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(aiReadTrials)
            .where(and(eq(aiReadTrials.feature, "expense_bill"), eq(aiReadTrials.subjectId, mbosExpenses.id))),
        ),
      ),
    )
    .orderBy(desc(mbosExpenses.serverCreatedAt))
    .limit(config["readTrial.expenseBills"]);

  if (bills.length === 0) return err("Every expense bill photo is already in the trial.", "not_found");

  const model = config["leadScan.model"];
  billTrialRunning = true;
  const run = async () => {
    try {
      await readBills();
    } finally {
      billTrialRunning = false;
    }
  };
  const readBills = async () => {
    for (const b of bills) {
      try {
        const file: BillFile = { bytes: new Uint8Array(await fileStorage.read(b.storedRef)), mediaType: b.contentType };
        const typed = { amountPaise: Number(b.amountPaise), billNumber: b.billNumber, billDate: b.billDate };
        const [openai, sarvam] = await Promise.all([readBillWithOpenai(file, openaiKey, model), readBillWithSarvam(file, sarvamKey)]);
        await db.insert(aiReadTrials).values(
          ([["openai", openai], ["sarvam", sarvam]] as const).map(([provider, r]) => ({
            id: randomUUID(),
            feature: "expense_bill",
            provider,
            subjectId: b.id,
            ok: r.ok,
            ms: r.ms,
            error: r.ok ? null : r.error,
            fields: r.ok ? scoreBill(typed, r.bill) : {},
          })),
        );
      } catch (e) {
        console.error("Reading trial: bill", b.id, "could not be read:", e instanceof Error ? e.message : e);
      }
    }
  };
  return ok({ bills: bills.length, run });
}
