import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { attachments, priceAiRuns } from "@/db/schema";
import { fileStorage } from "@/lib/storage";
import { readSecret } from "@/lib/secrets";
import { getConfig } from "@/lib/config/store";
import { parseRupees } from "@/lib/price-list-parse";
import type { ModelCell } from "@/lib/engines/price-cross-read";
import type { Provider } from "@/lib/price-ai/providers";

/* ---------------------------------------------------------------------------
 * TWO MODELS READ THE PDF ITSELF — the second and third readers.
 *
 * The text reader is exact where a PDF carries text and blind where it does
 * not; a model reads what is on the page but can misread one digit and look
 * perfectly sure. So both models are handed the FILE — the same bytes the desk
 * uploaded — and asked to transcribe every cell exactly as printed, never
 * computing, converting or rounding. They never see each other's answer or
 * the text reader's. Each answer is kept in `price_ai_runs` (feature
 * `document_cross_read`), and the comparison is worked out on read by
 * `engines/price-cross-read.ts`.
 *
 * AI IS ADVICE. Nothing here touches `price_list_parse_rows`: a model's figure
 * enters a cell only where a person presses "use this value".
 * ------------------------------------------------------------------------- */

export const CROSS_READ_FEATURE = "document_cross_read";

const CellsSchema = z.object({
  cells: z.array(
    z.object({
      product: z.string().describe("The product's name exactly as printed on its row"),
      pack: z.string().describe("The pack-size column heading the price sits under, as printed (\"20 Ltr 2/bx\"); empty where the list has one price a line"),
      price: z.string().describe("The price exactly as printed, digits and separators as shown; \"-\" for a dash or a blank cell"),
    }),
  ),
});

const SYSTEM =
  "You transcribe price lists. Read EVERY product row and EVERY pack-size column of the document and list one entry per cell. " +
  "Copy each price exactly as printed: never compute, convert, round, add GST or infer a figure, and never invent a row or a column. " +
  "A blank cell or a dash is \"-\". Keep product names and pack labels spelled as printed.";

const PROMPT = "List every cell of this price list: the product, the pack column, and the price as printed.";

type Bytes = { bytes: Uint8Array; contentType: string };

/** The document's stored file, back out of storage. */
export async function documentFile(attachmentId: string | null): Promise<Bytes | null> {
  if (!attachmentId) return null;
  const [row] = await db
    .select({ storedRef: attachments.storedRef, contentType: attachments.contentType, status: attachments.status })
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  if (!row || row.status !== "available") return null;
  const bytes = await fileStorage.read(row.storedRef);
  return { bytes: new Uint8Array(bytes), contentType: row.contentType };
}

export type CrossReadAnswer =
  | { ok: true; provider: Provider; model: string; cells: ModelCell[]; runId: string | null }
  | { ok: false; provider: Provider; reason: string; runId: string | null };

function toCells(output: z.infer<typeof CellsSchema>): ModelCell[] {
  return output.cells.map((c) => ({ product: c.product.trim(), pack: c.pack.trim(), pricePaise: parseRupees(c.price) }));
}

async function record(input: {
  documentId: string;
  provider: Provider;
  model: string | null;
  ok: boolean;
  output?: unknown;
  error?: string;
  ms: number;
  userId: string | null;
}): Promise<string | null> {
  try {
    const id = `pai_${randomUUID().slice(0, 12)}`;
    await db.insert(priceAiRuns).values({
      id,
      subjectKind: "price_list_document",
      subjectId: input.documentId,
      feature: CROSS_READ_FEATURE,
      provider: input.provider,
      model: input.model,
      ok: input.ok,
      output: (input.output ?? null) as never,
      error: input.error ?? null,
      ms: input.ms,
      createdById: input.userId,
    });
    return id;
  } catch (e) {
    console.error("price-ai: could not record a cross-read:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function readWithOpenAI(documentId: string, file: Bytes, userId: string | null): Promise<CrossReadAnswer> {
  const config = await getConfig();
  const model = config["pricing.ai.openaiModel"];
  if (!config["pricing.ai.enabled"]) return { ok: false, provider: "openai", reason: "AI is switched off for prices.", runId: null };
  const key = await readSecret("openai.apiKey");
  if (!key) return { ok: false, provider: "openai", reason: "No OpenAI key is set (Admin Console → Integrations).", runId: null };
  const started = Date.now();
  try {
    const client = createOpenAI({ apiKey: key });
    const result = await generateText({
      model: client(model),
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "file", data: file.bytes, mediaType: file.contentType },
          ],
        },
      ],
      output: Output.object({ schema: CellsSchema }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(180_000),
    });
    const parsed = CellsSchema.safeParse(result.output);
    if (!parsed.success) throw new Error("The answer did not fit the expected shape.");
    const cells = toCells(parsed.data);
    const runId = await record({ documentId, provider: "openai", model, ok: true, output: { cells }, ms: Date.now() - started, userId });
    return { ok: true, provider: "openai", model, cells, runId };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const runId = await record({ documentId, provider: "openai", model, ok: false, error: reason, ms: Date.now() - started, userId });
    return { ok: false, provider: "openai", reason: `OpenAI could not read it: ${reason}`, runId };
  }
}

async function readWithAnthropic(documentId: string, file: Bytes, userId: string | null): Promise<CrossReadAnswer> {
  const config = await getConfig();
  const model = config["pricing.ai.anthropicModel"];
  if (!config["pricing.ai.enabled"]) return { ok: false, provider: "anthropic", reason: "AI is switched off for prices.", runId: null };
  const key = await readSecret("anthropic.apiKey");
  if (!key) return { ok: false, provider: "anthropic", reason: "No Anthropic key is set (Admin Console → Integrations).", runId: null };
  const started = Date.now();
  try {
    const data = Buffer.from(file.bytes).toString("base64");
    const media =
      file.contentType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: file.contentType, data } };
    const inputSchema = z.toJSONSchema(CellsSchema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: "user", content: [media, { type: "text", text: PROMPT }] }],
        tools: [{ name: "answer", description: "Give every cell in this exact shape.", input_schema: inputSchema }],
        tool_choice: { type: "tool", name: "answer" },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const body = (await response.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> };
    const use = body.content?.find((c) => c.type === "tool_use" && c.name === "answer");
    if (!use) throw new Error("No answer came back.");
    const parsed = CellsSchema.safeParse(use.input);
    if (!parsed.success) throw new Error("The answer did not fit the expected shape.");
    const cells = toCells(parsed.data);
    const runId = await record({ documentId, provider: "anthropic", model, ok: true, output: { cells }, ms: Date.now() - started, userId });
    return { ok: true, provider: "anthropic", model, cells, runId };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const runId = await record({ documentId, provider: "anthropic", model, ok: false, error: reason, ms: Date.now() - started, userId });
    return { ok: false, provider: "anthropic", reason: `Claude could not read it: ${reason}`, runId };
  }
}

/** Both models, in parallel, independently, on the same bytes. */
export async function crossReadFile(
  documentId: string,
  file: Bytes,
  userId: string | null,
): Promise<{ openai: CrossReadAnswer; anthropic: CrossReadAnswer }> {
  const [openai, anthropic] = await Promise.all([readWithOpenAI(documentId, file, userId), readWithAnthropic(documentId, file, userId)]);
  return { openai, anthropic };
}
