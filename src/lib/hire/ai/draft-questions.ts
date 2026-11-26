import "server-only";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { trainingModuleVersions, trainingModules } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { questionProblems } from "@/lib/training/engine";
import { productFacts, saveModuleDraft } from "@/lib/training/service";
import type { McqQuestion } from "@/lib/training/types";
import type { HireContext } from "../access";
import { runTask } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * MCQ DRAFTING. A model reads the module's OWN content (text blocks, and the
 * live product facts it shows) and drafts questions about it. Every one lands
 * `ai: true, approved: false`: the module cannot be published with an active
 * unapproved question, so nothing reaches a learner until a person has read
 * it. A question the model could only answer from outside the content is
 * exactly the kind that tests the wrong thing — so it is told not to.
 * ------------------------------------------------------------------------- */

const PROMPT_VERSION = "draft-questions/v1";

const Schema = z.object({
  questions: z.array(
    z.object({
      text: z.string(),
      options: z.array(z.string()).min(3).max(5),
      correctIndex: z.number().int().min(0),
      explanation: z.string(),
      difficulty: z.enum(["easy", "medium", "hard"]),
      tags: z.array(z.string()).max(4),
    }),
  ),
});

export async function draftQuestions(ctx: HireContext, moduleId: string, count: number): Promise<Result<{ added: number }>> {
  const [m] = await db.select().from(trainingModules).where(eq(trainingModules.id, moduleId)).limit(1);
  if (!m) return err("That module does not exist.", "not_found");
  const [v] = await db.select().from(trainingModuleVersions).where(eq(trainingModuleVersions.moduleId, moduleId)).orderBy(desc(trainingModuleVersions.version)).limit(1);
  if (!v) return err("That module has no version.", "not_found");
  const def = v.definition;
  const parts: string[] = [];
  for (const b of def.content) {
    if (b.kind === "text") parts.push(`## ${b.title}\n${b.body}`);
    if (b.kind === "product_facts") {
      const facts = await productFacts(b.match);
      if (facts.length) parts.push(`## ${b.title}\n${facts.map((f) => `${f.name}${f.packSize ? ` · ${f.packSize}` : ""}${f.cansPerBox > 1 ? ` · ${f.cansPerBox} per box` : ""}`).join("\n")}`);
    }
  }
  const material = parts.join("\n\n").trim();
  if (material.length < 200) return err("Write the module’s content first — questions are drafted from what it says.", "rule_violation");
  const n = Math.max(1, Math.min(10, Math.round(count) || 5));
  const res = await runTask({
    taskType: "training_questions",
    promptVersion: PROMPT_VERSION,
    tier: "fast",
    system: [
      "You write multiple-choice questions for Mahek Marketing India's sales training, for a trainer to review before anybody sees them.",
      "Ask ONLY about what the material says. Never ask about anything the material does not state, never invent a price, a percentage or a rule.",
      "One correct option; the others plausible but clearly wrong to someone who read the material. No 'all of the above'. Plain English a field salesperson reads easily.",
      "The explanation says why the answer is right, quoting the material where it can. Tags are one or two lower-case words: pricing, packing, safety, credit, gst, application.",
    ].join(" "),
    prompt: `Module: ${m.title}\nWrite ${n} questions.\n\nMaterial:\n${material.slice(0, 12000)}`,
    schema: Schema,
    entity: { type: "training_module", id: moduleId },
    actorId: ctx.user.id,
    validate: (o) => (o.questions.some((q) => q.correctIndex >= q.options.length) ? "A question marks an option that does not exist." : null),
  });
  if (!res.ok) return err(`${res.reason} Write the questions by hand on the Question bank.`, "rule_violation");
  const added: McqQuestion[] = res.output.questions
    .map((q) => {
      const opts = q.options.map((t, i) => ({ key: String.fromCharCode(97 + i), text: t.trim() }));
      return { key: `q_${randomUUID().slice(0, 8)}`, text: q.text.trim(), options: opts, correctKey: opts[q.correctIndex]?.key ?? "a", explanation: q.explanation.trim(), difficulty: q.difficulty, tags: q.tags.map((t) => t.trim().toLowerCase()).filter(Boolean), active: true, ai: true, approved: false };
    })
    .filter((q) => !questionProblems(q).length);
  if (!added.length) return err("The drafts did not hold up — write the questions by hand.", "rule_violation");
  const saved = await saveModuleDraft({ id: ctx.user.id, name: ctx.user.name }, moduleId, { definition: { ...def, questions: [...def.questions, ...added] } });
  if (!saved.ok) return saved;
  return ok({ added: added.length }, `${added.length} questions drafted into v${saved.data.version}. Each is marked ◈ and needs approving before the module can be published.`);
}
