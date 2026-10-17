import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSecret } from "@/lib/secrets";
import { getConfig } from "@/lib/config/store";
import {
  guessTaskLink,
  linkFits,
  MAX_TASK_FIELDS,
  TASK_FIELD_TYPE_LABELS,
  TASK_FIELD_TYPES,
  TASK_LINK_TARGET_KEYS,
  TASK_LINK_TARGETS,
  taskAnswerText,
  taskFormProblems,
  tidyTaskForm,
  visibleTaskFields,
  type TaskField,
  type TaskFieldLink,
  type TaskFieldType,
  type TaskLinkTarget,
} from "@/lib/task-form";
import type { CampaignDetail } from "@/lib/services/task-campaign-service";

/* ---------------------------------------------------------------------------
 * THE TASK BRAIN — OpenAI, and only OpenAI.
 *
 * Three readings, each a SUGGESTION a manager accepts or ignores:
 *
 *   - draftTask: a sentence ("get the owner's birthday at every shop in
 *     Thane that doesn't have one") becomes a title, instructions, a form
 *     with each question linked to the customer field it is really asking
 *     for, and a targeting hint ("only shops missing it");
 *   - suggestLinks: for a form somebody built by hand, which questions are
 *     really the customer record's own fields;
 *   - summariseCampaign: everything the field sent back, read as findings.
 *
 * What comes back is CHECKED, not trusted: question types outside the list are
 * dropped, a link whose type does not fit the field is removed, and the form
 * goes through `taskFormProblems` like a hand-built one. Nothing here writes a
 * record or assigns a task; the builder's buttons do that, after a person has
 * looked.
 * ------------------------------------------------------------------------- */

export async function taskAiAvailable(): Promise<boolean> {
  const config = await getConfig();
  if (config["taskIntel.enabled"] === false) return false;
  return Boolean(await readSecret("openai.apiKey"));
}

async function ask<S extends z.ZodTypeAny>(label: string, system: string, prompt: string, schema: S): Promise<z.infer<S> | null> {
  const config = await getConfig();
  if (config["taskIntel.enabled"] === false) return null;
  const key = await readSecret("openai.apiKey");
  if (!key) return null;
  try {
    const client = createOpenAI({ apiKey: key });
    const result = await generateText({
      model: client(String(config["taskIntel.model"] || "gpt-5-mini")),
      system,
      prompt,
      output: Output.object({ schema }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(60_000),
    });
    return result.output as z.infer<S>;
  } catch (e) {
    console.error(`${label}: OpenAI read failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

const TYPE_LIST = TASK_FIELD_TYPES.map((t) => `- ${t}: ${TASK_FIELD_TYPE_LABELS[t].label} — ${TASK_FIELD_TYPE_LABELS[t].hint}`).join("\n");
const LINK_LIST = TASK_LINK_TARGET_KEYS.map(
  (k) => `- ${k}: ${TASK_LINK_TARGETS[k].label} (question type: ${TASK_LINK_TARGETS[k].types.join(" or ")}${TASK_LINK_TARGETS[k].contact ? "; per contact" : ""})`,
).join("\n");

const CONTEXT = `You help the sales office of Mahek, an Indian maker of paint thinners, assign tasks to field salesmen. A salesman sees each task on his phone, usually standing in a paint or hardware shop (a "shop" or "customer"), and answers the questions the office attached.

Question types:
${TYPE_LIST}

Customer-record fields a question can be LINKED to (the answer is then written to the customer record, the phone shows what the record already holds, and a task asking only for missing linked data completes itself once the record has it):
${LINK_LIST}

Link modes: "fill" = collect it only where the record is missing it (the usual choice for collecting data); "update" = check what we hold and correct it.
Contact scopes: "primary" = the shop's main contact; "each" = every person we hold at that shop (one question per person).

Rules:
- Link a question ONLY when it is genuinely asking for that exact record field. A photo, an opinion, a count of stock, a review screenshot is never linked.
- Proof of something done outside the shop (a Google review, a WhatsApp status, a display put up) is a photo question, usually after a yes/no.
- Keep forms short: what the office actually needs, in the order a conversation goes. Plain words a salesman understands.`;

/* ----------------------------------------------------------------- drafting */

const questionSchema = z.object({
  type: z.enum(TASK_FIELD_TYPES),
  label: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  options: z.array(z.string()).nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  unit: z.string().nullable(),
  showIfQuestionNumber: z.number().int().nullable().describe("1-based number of an EARLIER question this one depends on, or null"),
  showIfOp: z.enum(["is", "is_not", "includes", "answered"]).nullable(),
  showIfValue: z.string().nullable().describe('For yes/no use "yes" or "no"; for a pick, one of its options'),
  linkTarget: z.enum(TASK_LINK_TARGET_KEYS as [TaskLinkTarget, ...TaskLinkTarget[]]).nullable(),
  linkMode: z.enum(["fill", "update"]).nullable(),
  linkScope: z.enum(["primary", "each"]).nullable(),
});

const draftSchema = z.object({
  title: z.string(),
  instructions: z.string().nullable(),
  priority: z.enum(["low", "medium", "high"]),
  dueInDays: z.number().int().nullable(),
  questions: z.array(questionSchema),
  targeting: z.object({
    shops: z.enum(["none", "filter"]).describe('"none" when the task is not about shops (e.g. attend a meeting); otherwise "filter"'),
    accountKinds: z.array(z.enum(["customer", "lead"])),
    assignTo: z.enum(["carrier", "chosen"]).describe('"carrier" = each shop\'s own salesman'),
    onlyMissingData: z.boolean(),
  }),
  explanation: z.string().describe("Two or three sentences for the manager: what you built and why, and which answers will update the customer record."),
});

export type TaskDraft = {
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  dueInDays: number | null;
  fields: TaskField[];
  targeting: z.infer<typeof draftSchema>["targeting"];
  explanation: string;
};

function questionsToFields(questions: z.infer<typeof questionSchema>[]): TaskField[] {
  const fields: TaskField[] = [];
  questions.slice(0, MAX_TASK_FIELDS).forEach((q, i) => {
    let type: TaskFieldType = q.type;
    let options = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
    if ((type === "single_choice" || type === "multi_choice") && new Set(options).size < 2) {
      type = "short_text";
      options = [];
    }
    const f: TaskField = { id: `q${i + 1}`, type, label: q.label.trim().slice(0, 300) || `Question ${i + 1}`, required: type !== "info" && q.required };
    if (q.help?.trim()) f.help = q.help.trim().slice(0, 1000);
    if (options.length) f.options = [...new Set(options)].slice(0, 30);
    if (q.min != null) f.min = q.min;
    if (q.max != null) f.max = q.max;
    if (type === "photo") {
      f.max = Math.min(10, Math.max(1, f.max ?? 3));
      f.min = Math.max(0, Math.min(f.min ?? (f.required ? 1 : 0), f.max));
    }
    if (type === "rating") {
      f.min = f.min ?? 1;
      f.max = Math.min(10, f.max ?? 5);
    }
    if (f.min != null && f.max != null && f.min > f.max) delete f.min;
    if (type === "number" && q.unit?.trim()) f.unit = q.unit.trim().slice(0, 40);
    const parentAt = (q.showIfQuestionNumber ?? 0) - 1;
    if (parentAt >= 0 && parentAt < i && q.showIfOp) {
      f.showIf = { field: `q${parentAt + 1}`, op: q.showIfOp };
      if (q.showIfOp !== "answered") f.showIf.value = (q.showIfValue ?? "").trim();
    }
    if (q.linkTarget && linkFits(type, q.linkTarget)) {
      f.link = { target: q.linkTarget, mode: q.linkMode === "update" ? "update" : "fill" };
      if (TASK_LINK_TARGETS[q.linkTarget].contact) f.link.scope = q.linkScope === "each" ? "each" : "primary";
    }
    fields.push(f);
  });
  /* A condition the checker refuses is dropped rather than the whole draft —
     the question still makes sense asked of everybody. */
  let tidy = tidyTaskForm(fields);
  for (let pass = 0; pass < 3; pass++) {
    const problems = taskFormProblems(tidy);
    if (!problems.length) break;
    tidy = tidy.map((f, i) => (problems.some((p) => p.startsWith(`Question ${i + 1} `) || p.startsWith(`Question ${i + 1}:`)) ? { ...f, showIf: undefined } : f));
  }
  return tidy;
}

export async function draftTask(brief: string): Promise<TaskDraft | null> {
  const out = await ask(
    "task draft",
    CONTEXT,
    `The sales manager wrote:\n"""${brief.slice(0, 4000)}"""\n\nBuild the task: a short title (imperative, under 70 characters), instructions for the salesman, the questions, links to the customer record where a question is really asking for one, and the targeting.`,
    draftSchema,
  );
  if (!out) return null;
  return {
    title: out.title.trim().slice(0, 200),
    description: (out.instructions ?? "").trim().slice(0, 4000),
    priority: out.priority,
    dueInDays: out.dueInDays != null ? Math.max(0, Math.min(90, out.dueInDays)) : null,
    fields: questionsToFields(out.questions),
    targeting: out.targeting,
    explanation: out.explanation.trim().slice(0, 1000),
  };
}

/* ----------------------------------------------------------------- link check */

const linkSchema = z.object({
  suggestions: z.array(
    z.object({
      questionNumber: z.number().int(),
      linkTarget: z.enum(TASK_LINK_TARGET_KEYS as [TaskLinkTarget, ...TaskLinkTarget[]]).nullable(),
      linkMode: z.enum(["fill", "update"]),
      linkScope: z.enum(["primary", "each"]).nullable(),
      confidence: z.number().int().describe("0-100"),
      reason: z.string().describe("One short sentence a sales manager understands."),
    }),
  ),
});

export type LinkSuggestion = {
  fieldId: string;
  link: TaskFieldLink;
  confidence: number;
  reason: string;
  source: "ai" | "rule";
};

/**
 * Which unlinked questions are really asking for a customer-record field.
 * The keyword guess answers instantly and without a key; the model is asked
 * as well when it is available, and its answer wins where the two differ.
 */
export async function suggestLinks(fields: TaskField[], title: string): Promise<{ suggestions: LinkSuggestion[]; usedAi: boolean }> {
  const unlinked = fields.filter((f) => !f.link && f.type !== "info");
  const byRule = new Map<string, LinkSuggestion>();
  for (const f of unlinked) {
    const g = guessTaskLink(f);
    if (g) byRule.set(f.id, { fieldId: f.id, link: g, confidence: 70, reason: "It asks for something the customer record already keeps.", source: "rule" });
  }
  if (!unlinked.length) return { suggestions: [], usedAi: false };

  const listing = fields
    .map((f, i) => `${i + 1}. [${f.type}] ${f.label}${f.help ? ` (${f.help})` : ""}${f.link ? ` — already linked to ${f.link.target}` : ""}`)
    .join("\n");
  const out = await ask(
    "task links",
    CONTEXT,
    `Task: "${title}"\nQuestions:\n${listing}\n\nFor each question that is NOT already linked, say which customer-record field (if any) its answer should update. Return only questions that should be linked.`,
    linkSchema,
  );
  const result = new Map(byRule);
  if (out) {
    for (const s of out.suggestions) {
      const f = fields[s.questionNumber - 1];
      if (!f || f.link || !s.linkTarget || !linkFits(f.type, s.linkTarget) || s.confidence < 55) continue;
      const link: TaskFieldLink = { target: s.linkTarget, mode: s.linkMode };
      if (TASK_LINK_TARGETS[s.linkTarget].contact) link.scope = s.linkScope === "each" ? "each" : "primary";
      result.set(f.id, { fieldId: f.id, link, confidence: Math.min(100, Math.max(0, s.confidence)), reason: s.reason.trim().slice(0, 300), source: "ai" });
    }
  }
  return { suggestions: [...result.values()], usedAi: Boolean(out) };
}

/* ----------------------------------------------------------------- summary */

const summarySchema = z.object({
  headline: z.string().describe("One sentence: the single most important thing the answers say."),
  findings: z.array(z.string()).describe("3 to 6 findings, each with numbers where the answers give them."),
  followUps: z.array(z.string()).describe("Up to 4 concrete next actions for the sales manager, naming shops or salesmen where relevant."),
  dataQuality: z.string().nullable().describe("Anything odd in the answers worth checking (duplicates, answers that look made up), or null."),
});

export type TaskSummary = z.infer<typeof summarySchema>;

export async function summariseCampaign(c: CampaignDetail): Promise<TaskSummary | null> {
  const asking = c.form.filter((f) => f.type !== "info");
  const done = c.tasks.filter((t) => t.status === "done");
  const lines = done.slice(0, 400).map((t) => {
    const answers = t.responses ?? {};
    const shown = new Set(visibleTaskFields(c.form, answers).map((f) => f.id));
    const parts = asking
      .filter((f) => shown.has(f.id) || Object.keys(answers).some((k) => k.startsWith(`${f.id}@`)))
      .map((f) => {
        const direct = answers[f.id];
        const each = Object.entries(answers).filter(([k]) => k.startsWith(`${f.id}@`)).map(([, v]) => taskAnswerText(f, v));
        const text = direct !== undefined ? taskAnswerText(f, direct) : each.join(" / ");
        return text ? `${f.label}=${text}` : "";
      })
      .filter(Boolean);
    const extra = t.completedVia === "record" ? " (from the record)" : "";
    return `- ${t.salesmanName} | ${t.customerName ?? "no shop"}${t.place ? ` (${t.place})` : ""}${extra}: ${parts.join("; ")}`;
  });
  const waiting = c.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const bySalesman = new Map<string, number>();
  for (const t of waiting) bySalesman.set(t.salesmanName, (bySalesman.get(t.salesmanName) ?? 0) + 1);

  return ask(
    "task summary",
    `${CONTEXT}\n\nNow you are reading back what the field answered. Be specific and numeric. Do not invent anything the answers do not say.`,
    `Task: "${c.title}"\n${c.description ? `Instructions: ${c.description}\n` : ""}Questions: ${asking.map((f) => f.label).join(" | ")}\n` +
      `Answered: ${done.length} of ${c.tasks.length}. Still waiting by salesman: ${[...bySalesman].map(([n, k]) => `${n} ${k}`).join(", ") || "none"}.\n\nAnswers:\n${lines.join("\n")}`,
    summarySchema,
  );
}
