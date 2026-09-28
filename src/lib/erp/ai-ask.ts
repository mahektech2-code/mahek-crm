import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import type { ErpContext } from "./access";
import { featureState, logSuggestion } from "./ai";
import { erpLink, erpListLabel, erpScreen } from "./registry";
import { screenModule } from "./screens";
import { today } from "./screens/common";
import { traceBill } from "./trace";
import type { CellValue, ListRow } from "./ui";

/* ---------------------------------------------------------------------------
 * AI-5, Ask the ERP. The model does not query the database: it chooses from a
 * fixed set of question tools, and every tool answers by calling the SCREEN'S
 * OWN LOADER as the person asking — so an answer holds exactly the rows and
 * columns that person's screen would show them, with money and cost already
 * removed where they lack the power. Answering and navigating only.
 * ------------------------------------------------------------------------- */

export type AskRecord = { label: string; href: string };
export type AskAnswer = { answer: string; records: AskRecord[]; readAt: string; servedBy: string };

const MAX_ROWS = 12;

/** Rows of one screen, as the person would see them, narrowed by a predicate. */
async function fromScreen(ctx: ErpContext, key: string, keep: (r: ListRow) => boolean, label: string, records: AskRecord[]) {
  if (!ctx.screens.has(key)) return { refused: `The ${erpListLabel(key)} screen is not on this person's account.` };
  const mod = screenModule(key);
  if (!mod) return { refused: "That screen is not built." };
  const { spec, rows } = await mod.load(ctx);
  const kept = rows.filter(keep);
  const href = kept.length && kept.length <= 200 ? erpLink(key, { f: kept.map((r) => r.id).join(","), fl: label }) : erpLink(key);
  records.push({ label: `${erpListLabel(key)} · ${label} (${kept.length})`, href });
  const cols = spec.cols.filter((c) => c.t !== "f").map((c) => c.k);
  return {
    count: kept.length,
    columnsYouMaySee: spec.cols.filter((c) => c.t !== "f").map((c) => c.l),
    hiddenFromThisPerson: spec.hidden.map((h) => h.l),
    rows: kept.slice(0, MAX_ROWS).map((r) => Object.fromEntries(cols.map((k) => [k, r.v[k] as CellValue]))),
    truncated: kept.length > MAX_ROWS,
  };
}

const has = (v: CellValue | undefined, q?: string | null) => !q || String(v ?? "").toLowerCase().includes(q.toLowerCase());
const anyHas = (r: ListRow, q?: string | null) => !q || Object.values(r.v).some((v) => has(v, q)) || has(r.title, q);

export function askTools(ctx: ErpContext, records: AskRecord[]) {
  return {
    stock: tool({
      description: "Current stock by lot and godown at one stage: raw material (rm), semi-finished (sfg), loose finished goods in cans (fg), or boxed stock (pack).",
      inputSchema: z.object({ stage: z.enum(["rm", "sfg", "fg", "pack"]), item: z.string().nullable().describe("product or item words to match"), godown: z.string().nullable() }),
      execute: async ({ stage, item, godown }) =>
        fromScreen(ctx, { rm: "rmStock", sfg: "sfgStock", fg: "fgStock", pack: "packStock" }[stage], (r) => anyHas(r, item) && has(r.v.godown, godown), [item, godown].filter(Boolean).join(" at ") || "all", records),
    }),
    orders: tool({
      description: "Taken order lines, by status (Under Process, Ready, Today, Delay, Cancel, Tomorrow, Hold From Office) and words to match (customer, SKU, order number). Includes allocation state and whether billed.",
      inputSchema: z.object({ status: z.string().nullable(), match: z.string().nullable() }),
      execute: async ({ status, match }) => fromScreen(ctx, "orders", (r) => has(r.v.status, status) && anyHas(r, match), [status, match].filter(Boolean).join(" · ") || "all", records),
    }),
    orderDetails: tool({
      description: "Order details: billed and dispatched lines, by customer or words to match, and month (e.g. 'Sep2026').",
      inputSchema: z.object({ match: z.string().nullable(), month: z.string().nullable() }),
      execute: async ({ match, month }) => fromScreen(ctx, "orderDetails", (r) => anyHas(r, match) && has(r.v.monthId, month), [match, month].filter(Boolean).join(" · ") || "all", records),
    }),
    purchases: tool({
      description: "The purchase register: purchases by item and supplier words. Rates only where the person may see purchase money.",
      inputSchema: z.object({ match: z.string().nullable() }),
      execute: async ({ match }) => fromScreen(ctx, "register", (r) => anyHas(r, match), match || "all", records),
    }),
    trace: tool({
      description: "Trace what a customer received on a bill back to its lots, production and suppliers.",
      inputSchema: z.object({ customerName: z.string(), billNo: z.string(), sku: z.string().nullable() }),
      execute: async ({ customerName, billNo, sku }) => {
        if (!ctx.screens.has("requests") && !ctx.screens.has("orderDetails")) return { refused: "Tracing needs Customer requests or Order details on this person's account." };
        const { loadCustomers } = await import("./screens/masters");
        const { customers } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        const [c] = await loadCustomers(eq(customers.name, customerName));
        if (!c) return { refused: `No customer is named "${customerName}".` };
        const t = await traceBill(c.id, billNo, sku);
        t.steps.forEach((s) => {
          if (erpScreen(s.screen) && ctx.screens.has(s.screen)) records.push({ label: `${s.stage}: ${s.label}`, href: erpLink(s.screen, { f: s.ids.join(","), fl: s.stage }) });
        });
        return { steps: t.steps.map((s) => ({ stage: s.stage, label: s.label, detail: s.detail })), missing: t.missing };
      },
    }),
    reorder: tool({
      description: "Items to re-order: followed raw materials below their level (rm) or finished goods below their minimum (fg).",
      inputSchema: z.object({ kind: z.enum(["rm", "fg"]) }),
      execute: async ({ kind }) => fromScreen(ctx, kind === "rm" ? "reorderRm" : "reorderFg", () => true, "all", records),
    }),
    transport: tool({
      description: "Dispatched bills in transport follow-up, by material stage or words to match (LR, transporter, customer).",
      inputSchema: z.object({ match: z.string().nullable() }),
      execute: async ({ match }) => fromScreen(ctx, "transport", (r) => anyHas(r, match), match || "all", records),
    }),
    requests: tool({
      description: "Customer requests and credit notes, by status (Requested, Accepted, Rejected) and words to match.",
      inputSchema: z.object({ status: z.string().nullable(), match: z.string().nullable() }),
      execute: async ({ status, match }) => fromScreen(ctx, "requests", (r) => has(r.v.status, status) && anyHas(r, match), [status, match].filter(Boolean).join(" · ") || "all", records),
    }),
    pettyCash: tool({
      description: "Petty-cash expenses and the cash each person still holds, by person or godown.",
      inputSchema: z.object({ match: z.string().nullable() }),
      execute: async ({ match }) => fromScreen(ctx, "expenses", (r) => anyHas(r, match), match || "all", records),
    }),
  };
}

export async function askErp(ctx: ErpContext, question: string): Promise<{ ok: true; answer: AskAnswer } | { ok: false; error: string }> {
  const state = await featureState("ask", true);
  if (!state.on) return { ok: false, error: state.reason };
  const q = question.trim();
  if (q.length < 3) return { ok: false, error: "Ask a question in a few words." };
  const key = await readSecret("openai.apiKey");
  if (!key) return { ok: false, error: "Ask the ERP needs an OpenAI key." };
  const model = (await getConfig())["erp.ai.textModel"];
  const records: AskRecord[] = [];
  const readAt = new Date();
  try {
    const result = await generateText({
      model: createOpenAI({ apiKey: key })(model),
      system: [
        "You answer questions about Mahek Marketing India's ERP for one member of staff.",
        "Use ONLY what the tools return. Never invent, estimate or compute a figure the tools did not give; you may count and add up rows they returned.",
        "If a tool says a screen is not on this person's account, say so plainly. If no tool fits the question, say which part of the ERP to look in.",
        "If a result lists columns hidden from this person, never guess them.",
        "Answer in one to three short sentences, in the language of the question, with the figure first.",
        `Today is ${today()}.`,
      ].join(" "),
      prompt: q,
      tools: askTools(ctx, records),
      stopWhen: isStepCount(5),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(60_000),
    });
    const answer = result.text.trim() || "I could not find an answer in the ERP for that.";
    await logSuggestion({ feature: "ask", recordType: "question", inputRef: q.slice(0, 500), proposed: { answer, records }, servedBy: `openai:${model}`, userId: ctx.user.id });
    const seen = new Set<string>();
    return {
      ok: true,
      answer: { answer, records: records.filter((r) => (seen.has(r.href) ? false : (seen.add(r.href), true))), readAt: readAt.toISOString(), servedBy: `openai:${model}` },
    };
  } catch (e) {
    console.error("ERP ask failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "The question could not be answered just now. Try the screens, or ask again in a minute." };
  }
}
