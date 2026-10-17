import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { hireAiTasks } from "@/db/schema";
import { readSecret } from "@/lib/secrets";
import type { DocumentRequirement } from "../blueprint-types";
import { findProhibited } from "./guards";
import { aiState, estimateCostPaise, modelFor } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * DOCUMENT EXTRACTION (spec §5.6) — vision, one document at a time.
 *
 * WHY THIS DOES NOT GO THROUGH `runTask`. The orchestrator writes the full
 * structured output to `hire_ai_tasks`, which is right for every other task
 * and wrong for exactly this one: the output of reading an Aadhaar card IS the
 * Aadhaar number, and the spec says an extracted identity number goes straight
 * to the vault and never into a log. So this task keeps every other guarantee
 * of the orchestrator — the switch and the key, the tier's model, one retry,
 * the prohibited-inference scan, a ledger row with tokens, latency and cost —
 * and writes the ledger itself with the number REMOVED from the logged output.
 * The orchestrator growing a `scrubOutput` hook would let this file go back
 * through it; until then this is the one exception, and it says so.
 *
 * It never decides fraud. Tampering signals are listed for a person; low
 * confidence routes to manual review instead of a guess.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "extract-document/v1";

const Schema = z.object({
  documentTypeMatches: z.boolean().describe("Whether this looks like the expected document type at all."),
  fields: z
    .array(z.object({ label: z.string(), value: z.string(), confidence: z.number().min(0).max(1) }))
    .describe("Name, date of birth, address, issue date, bank name, IFSC, and the like. NEVER the identity or account number itself — that goes in idNumber."),
  idNumber: z.string().nullable().describe("The Aadhaar number, PAN, or bank account number exactly as printed, or null if the document has none or it is unreadable."),
  idNumberConfidence: z.number().min(0).max(1),
  signals: z.array(z.string()).describe("Observable authenticity or quality concerns, e.g. 'edges look edited', 'photo of a screen', 'text partly cut off'. Never a conclusion about fraud."),
  quality: z.enum(["good", "poor", "unreadable"]),
  overallConfidence: z.number().min(0).max(1),
});

export type Extraction = {
  fields: { label: string; value: string; confidence: number }[];
  signals: string[];
  quality: string;
  aiTaskId?: string;
  matches: boolean;
  confidence: number;
  /** In memory only — the caller vaults it and drops it. */
  idNumber: string | null;
  idConfidence: number;
};

export type ExtractResult = { ok: true; extraction: Extraction } | { ok: false; reason: string };

export async function extractDocument(args: {
  requirement: DocumentRequirement;
  bytes: Uint8Array;
  contentType: string;
  actorId: string;
  applicationId: string;
  documentId: string;
}): Promise<ExtractResult> {
  const state = await aiState();
  const model = await modelFor("vision");
  const inputHash = createHash("sha256").update(args.bytes).digest("hex");
  const base = {
    taskType: "document_extract",
    promptVersion: PROMPT_VERSION,
    tier: "vision",
    provider: "openai",
    inputHash,
    triggeredById: args.actorId,
    entityType: "document",
    entityId: args.documentId,
    applicationId: args.applicationId,
    /* The image itself cannot be redacted before it is read; what is
       guaranteed is that the number read from it is never sent onward. */
    redactionApplied: true,
    redactedFields: ["idNumber"],
  };
  const ledger = async (row: Partial<typeof hireAiTasks.$inferInsert>) => {
    const id = `hai_${randomUUID()}`;
    try {
      await db.insert(hireAiTasks).values({ id, status: "error", ...base, ...row } as typeof hireAiTasks.$inferInsert);
    } catch (e) {
      console.error("hire ai ledger:", e instanceof Error ? e.message : e);
    }
    return id;
  };

  if (!state.on) {
    await ledger({ modelId: null, status: "disabled", error: state.reason, fallbackUsed: "manual" });
    return { ok: false, reason: `${state.reason} Enter the fields by hand with the document beside you.` };
  }

  const key = (await readSecret("openai.apiKey")) as string;
  const client = createOpenAI({ apiKey: key });
  const started = Date.now();
  let inTok = 0;
  let outTok = 0;
  let lastErr = "";
  let lastStatus = "error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model: client(model),
        system:
          "You read one identity, bank, address or certificate document for an employer's onboarding desk. Report what is printed, with a confidence per field. Put any Aadhaar number, PAN or bank account number ONLY in idNumber, never in fields. List observable tampering or quality signals, but never conclude that a document is forged — that is a person's judgement. Never comment on the person's appearance, age, religion, caste or family.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `Expected document: ${args.requirement.label} (${args.requirement.kind}).` },
              { type: "file", data: args.bytes, mediaType: args.contentType },
            ],
          },
        ],
        output: Output.object({ schema: Schema }),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(90_000),
      });
      inTok += result.usage?.inputTokens ?? 0;
      outTok += result.usage?.outputTokens ?? 0;
      const out = result.output as z.infer<typeof Schema>;
      /* The number must not slip into a field either. */
      const leaked = out.fields.filter((f) => /\d{4}\s?\d{4}\s?\d{4}|[A-Z]{5}\d{4}[A-Z]|\d{9,18}/.test(f.value));
      const fields = out.fields.filter((f) => !leaked.includes(f));
      const banned = findProhibited({ fields, signals: out.signals });
      if (banned) {
        lastStatus = "prohibited";
        lastErr = `The output made a prohibited inference (${banned}).`;
        continue;
      }
      const taskId = await ledger({
        modelId: model,
        status: "success",
        output: { ...out, fields, idNumber: out.idNumber ? "[sent to the vault]" : null },
        inputTokens: inTok,
        outputTokens: outTok,
        latencyMs: Date.now() - started,
        costPaise: estimateCostPaise(model, inTok, outTok),
        retryCount: attempt,
      });
      return {
        ok: true,
        extraction: {
          fields,
          signals: out.documentTypeMatches ? out.signals : [`This does not look like a ${args.requirement.label}.`, ...out.signals],
          quality: out.quality,
          aiTaskId: taskId,
          matches: out.documentTypeMatches,
          confidence: out.overallConfidence,
          idNumber: out.idNumber,
          idConfidence: out.idNumberConfidence,
        },
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      lastStatus = /timeout|aborted/i.test(lastErr) ? "timeout" : /schema|parse|NoObjectGenerated|No output/i.test(lastErr) ? "schema_violation" : "error";
      if (lastStatus !== "schema_violation") break;
    }
  }
  /* The error text is the provider's, which never contains the document's contents. */
  await ledger({ modelId: model, status: lastStatus, error: lastErr.slice(0, 1000), inputTokens: inTok || null, outputTokens: outTok || null, latencyMs: Date.now() - started, costPaise: estimateCostPaise(model, inTok, outTok), retryCount: 1, fallbackUsed: "manual" });
  console.error(`hire document extraction: ${lastStatus}`);
  return { ok: false, reason: "The document could not be read automatically. Enter the fields by hand with the document beside you." };
}
