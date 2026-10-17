import "server-only";
import { z } from "zod";
import {
  MASKABLE,
  STAGE_TYPES,
  type BlueprintDefinition,
  type BriefingPoint,
  type DocumentRequirement,
  type Question,
  type Stage,
  type StageType,
} from "../blueprint-types";
import { runTask } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * BLUEPRINT GENERATION (spec §5.1), in six honest steps — each a real model
 * call whose answer the next one reads, so the studio's progress list shows
 * what has actually been drafted rather than a timer:
 *
 *   1 identity + competency model    4 expectation set + document set
 *   2 stage pipeline + thresholds    5 offer model + onboarding + provisioning
 *   3 question bank + rubrics        6 fairness configuration
 *
 * `assembleDefinition` then enforces what a prompt can only ask for: weights
 * normalised to 1.0, a decision gate before the offer, a briefing stage for
 * the expectation set, stage maxima that equal their questions. Everything it
 * produces is `ai: true, approved: false` — a person approves every element
 * before anything can be published. Questions the model left unmapped stay
 * unmapped, for the validator to name; guessing a competency would be the
 * system deciding something a person should.
 * ------------------------------------------------------------------------- */

export type Intake = {
  jd?: string;
  six?: { title: string; what: string; where: string; reportsTo: string; greatMonth: string; dealBreakers: string };
};

export type GenStep = "identity" | "stages" | "questions" | "expectation" | "offer" | "fairness";

const PROVISIONABLE = ["crm", "field", "sales", "accounts", "hrms", "erp", "reports", "enquiries", "website"] as const;

const Identity = z.object({
  identity: z.object({ title: z.string(), family: z.string(), department: z.string(), level: z.string(), employmentType: z.string(), locations: z.array(z.string()), headcount: z.number().int() }),
  competencies: z.array(z.object({ name: z.string(), definition: z.string(), weight: z.number(), anchors: z.object({ low: z.string(), mid: z.string(), high: z.string() }) })),
});
const Stages = z.object({
  stages: z.array(
    z.object({
      name: z.string(),
      type: z.enum(STAGE_TYPES),
      rationale: z.string(),
      passThreshold: z.number(),
      autoRejectFloor: z.number().nullable(),
      slaHours: z.number().int(),
    }),
  ),
});
const Questions = z.object({
  questions: z.array(
    z.object({
      stageName: z.string(),
      text: z.string(),
      type: z.enum(["behavioural", "situational", "technical", "factual"]),
      competencyNames: z.array(z.string()),
      maxPoints: z.number().int(),
      mode: z.enum(["ai_rubric", "fixed_choice"]),
      idealAnswer: z.string(),
      probes: z.array(z.string()),
      rubric: z.array(z.object({ descriptor: z.string(), points: z.number(), tier: z.enum(["zero", "partial", "full"]), indicators: z.array(z.string()) })),
      options: z.array(z.object({ label: z.string(), points: z.number() })),
    }),
  ),
});
const Expectation = z.object({
  expectationPoints: z.array(z.object({ title: z.string(), body: z.string(), responseType: z.enum(["told_only", "agree_disagree", "agree_disagree_willtry"]), blocking: z.boolean() })),
  documents: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(["aadhaar", "pan", "bank", "photo", "certificate", "payslip", "address", "other"]),
      mandatory: z.boolean(),
      verify: z.boolean(),
      pii: z.enum(["none", "personal", "sensitive", "restricted"]),
    }),
  ),
});
const Offer = z.object({
  grades: z.array(z.object({ label: z.string(), basicMinRupees: z.number(), basicMaxRupees: z.number() })),
  incentive: z.string(),
  growth: z.array(z.object({ fromGrade: z.number().int().describe("Index into grades"), toGrade: z.number().int(), criterion: z.string(), incrementType: z.enum(["percentage", "fixed_amount"]), value: z.number().describe("Percent, or rupees for fixed_amount") })),
  assets: z.array(z.string()),
  modules: z.array(z.object({ name: z.string(), topics: z.array(z.string()) })),
  setup: z.array(z.object({ system: z.string(), steps: z.array(z.string()) })),
  provisioning: z.object({ apps: z.array(z.enum(PROVISIONABLE)), roleLabel: z.string(), device: z.boolean() }),
});
const Fairness = z.object({
  masked: z.array(z.enum(MASKABLE)),
  justifications: z.array(z.object({ attribute: z.enum(MASKABLE), why: z.string() })),
  notes: z.array(z.string()),
});

export type GenParts = {
  identity?: z.infer<typeof Identity>;
  stages?: z.infer<typeof Stages>;
  questions?: z.infer<typeof Questions>;
  expectation?: z.infer<typeof Expectation>;
  offer?: z.infer<typeof Offer>;
  fairness?: z.infer<typeof Fairness>;
};

const SYSTEM = [
  "You draft one part of a hiring blueprint for Mahek Marketing India, a paint and thinner manufacturer and distributor in Maharashtra and central India (field sales, telecalling, accounts, warehouse, production).",
  "Everything you draft is reviewed and approved by a person before use.",
  "Rules: competencies are observable behaviours with behavioural anchors, never traits. Rubric criteria describe what a candidate SAYS or DOES — never confidence, personality, appearance, accent or 'culture fit'.",
  "No question may ask about or imply a protected attribute: age, gender, marital status, children, religion, caste, health, disability.",
  "Every reachable answer must have a defined score. Write plainly, in British English, the way a careful HR manager would.",
].join(" ");

function intakeText(i: Intake): string {
  if (i.jd?.trim()) return `Job description:\n"""\n${i.jd.trim()}\n"""`;
  const s = i.six!;
  return [
    `Title: ${s.title}`,
    `What the job is: ${s.what}`,
    `Where: ${s.where}`,
    `Reports to: ${s.reportsTo}`,
    `What a great month looks like: ${s.greatMonth}`,
    `Deal-breakers: ${s.dealBreakers}`,
  ].join("\n");
}

export async function generateStep(
  step: GenStep,
  intake: Intake,
  parts: GenParts,
  ctx: { actorId: string; similar: string[] },
): Promise<{ ok: true; parts: GenParts } | { ok: false; reason: string }> {
  const base = `${intakeText(intake)}\n\nSimilar blueprints already in use here (stay consistent with them where it fits): ${ctx.similar.join("; ") || "none"}.`;
  const comps = parts.identity?.competencies.map((c) => c.name).join(", ") ?? "";
  const stages = parts.stages?.stages.map((s) => `${s.name} (${s.type})`).join(", ") ?? "";
  const common = { promptVersion: "blueprint/v1", tier: "reasoning" as const, system: SYSTEM, entity: { type: "blueprint_draft" }, actorId: ctx.actorId, timeoutSeconds: 120 };

  if (step === "identity") {
    const r = await runTask({ ...common, taskType: "blueprint_identity", prompt: `${base}\n\nDraft the role identity and 5–9 weighted competencies. Weights sum to 1.0.`, schema: Identity });
    return r.ok ? { ok: true, parts: { ...parts, identity: r.output } } : { ok: false, reason: r.reason };
  }
  if (step === "stages") {
    const r = await runTask({
      ...common,
      taskType: "blueprint_stages",
      prompt: `${base}\n\nCompetencies: ${comps}\n\nDraft the stage pipeline, cheapest screening first and the most expensive interview last. Start with an application stage. Include at least one decision_gate BEFORE document_collection, a briefing stage if candidates must accept terms (pay, travel, targets, shifts), then document_collection, checklist and system_setup. Pass thresholds are on a 0–100 normalised scale (70 is typical); give each stage a rationale and an SLA in hours.`,
      schema: Stages,
    });
    return r.ok ? { ok: true, parts: { ...parts, stages: r.output } } : { ok: false, reason: r.reason };
  }
  if (step === "questions") {
    const scored = parts.stages?.stages.filter((s) => ["ai_screen", "scored_interview", "async_assessment", "work_sample", "reference_check"].includes(s.type)).map((s) => s.name) ?? [];
    const r = await runTask({
      ...common,
      taskType: "blueprint_questions",
      prompt: `${base}\n\nCompetencies: ${comps}\nScored stages: ${scored.join(", ")}\n\nDraft 4–8 questions for EACH scored stage (use the stage name exactly). Behavioural and situational questions use mode ai_rubric with 3–4 rubric criteria from zero to full whose points rise with the tier; factual questions use fixed_choice with options that cover every possible answer. Map every question to at least one competency by its exact name. maxPoints is usually 10.`,
      schema: Questions,
    });
    return r.ok ? { ok: true, parts: { ...parts, questions: r.output } } : { ok: false, reason: r.reason };
  }
  if (step === "expectation") {
    const r = await runTask({
      ...common,
      taskType: "blueprint_expectation",
      prompt: `${base}\n\nStages: ${stages}\n\nDraft the expectation set — what a candidate must explicitly hear and accept before an offer (pay, travel, targets, shifts, rules); mark as blocking only the points a disagreement must stop progression on. Then the documents to collect; identity and bank documents are restricted or sensitive.`,
      schema: Expectation,
    });
    return r.ok ? { ok: true, parts: { ...parts, expectation: r.output } } : { ok: false, reason: r.reason };
  }
  if (step === "offer") {
    const r = await runTask({
      ...common,
      taskType: "blueprint_offer",
      prompt: `${base}\n\nDraft the offer model (1–3 grades with monthly basic salary bands in rupees, the incentive structure, a growth ladder — ONE kind of increment), the onboarding plan (work kit, training modules each with topics, system setup steps) and which MahekOne apps the hire receives: crm = Telecaller CRM, field = MBOS handset for field sales, sales = field sales dashboard, accounts, hrms (everyone), erp = factory and godowns, reports, enquiries, website.`,
      schema: Offer,
    });
    return r.ok ? { ok: true, parts: { ...parts, offer: r.output } } : { ok: false, reason: r.reason };
  }
  const r = await runTask({
    ...common,
    taskType: "blueprint_fairness",
    tier: "fast",
    prompt: `${base}\n\nWhich of name, gender_markers, age, photo, location, institution should be masked during evaluation for this role? Mask by default; leave one unmasked only where it is a genuine job requirement, and justify it. Add any fairness notes.`,
    schema: Fairness,
  });
  return r.ok ? { ok: true, parts: { ...parts, fairness: r.output } } : { ok: false, reason: r.reason };
}

const keyed = (prefix: string, i: number) => `${prefix}${i + 1}`;
const SCORED: StageType[] = ["ai_screen", "scored_interview", "async_assessment", "work_sample", "reference_check"];

/** The model's parts → a BlueprintDefinition, with every structural rule enforced. */
export function assembleDefinition(parts: GenParts): { def: BlueprintDefinition & { competenciesApproved: boolean }; identity: NonNullable<GenParts["identity"]>["identity"] | null } {
  const rawComps = parts.identity?.competencies ?? [];
  const total = rawComps.reduce((n, c) => n + Math.max(0, c.weight), 0) || 1;
  const competencies = rawComps.map((c, i) => ({ key: keyed("c", i), name: c.name, definition: c.definition, weight: Math.round((Math.max(0, c.weight) / total) * 1000) / 1000, anchors: c.anchors }));
  const drift = 1 - competencies.reduce((n, c) => n + c.weight, 0);
  if (competencies.length) competencies[0].weight = Math.round((competencies[0].weight + drift) * 1000) / 1000;
  const compByName = new Map(competencies.map((c) => [c.name.trim().toLowerCase(), c.key]));

  let stages: Stage[] = (parts.stages?.stages ?? []).map((s, i) => ({
    key: keyed("s", i),
    name: s.name,
    type: s.type,
    maxPoints: 0,
    passThreshold: Math.min(100, Math.max(1, Math.round(s.passThreshold))),
    autoRejectFloor: s.autoRejectFloor != null && s.autoRejectFloor < s.passThreshold ? Math.round(s.autoRejectFloor) : null,
    strongSignal: null,
    graceRange: 5,
    slaHours: Math.max(1, s.slaHours),
    gateRole: s.type === "decision_gate" ? "Hiring Manager" : undefined,
    questions: [],
    rationale: s.rationale,
    approved: false,
    ai: true,
  }));
  const mk = (key: string, name: string, type: StageType, sla: number): Stage => ({ key, name, type, maxPoints: 0, passThreshold: 70, autoRejectFloor: null, strongSignal: null, graceRange: 5, slaHours: sla, questions: [], approved: false, ai: true, gateRole: type === "decision_gate" ? "Hiring Manager" : undefined });
  if (!stages.length || stages[0].type !== "application") stages.unshift(mk("app", "Application", "application", 24));
  if (!stages.some((s) => s.type === "document_collection")) stages.push(mk("doc", "Documents & offer", "document_collection", 120));
  const docAt = () => stages.findIndex((s) => s.type === "document_collection");
  const gateAt = stages.findIndex((s) => s.type === "decision_gate");
  if (gateAt < 0 || gateAt > docAt()) {
    if (gateAt >= 0) stages.splice(gateAt, 1);
    stages.splice(docAt(), 0, mk("gate", "Decision gate", "decision_gate", 24));
  }
  if (!stages.some((s) => s.type === "checklist")) stages.push(mk("kit", "Induction", "checklist", 72));
  if (!stages.some((s) => s.type === "system_setup")) stages.push(mk("setup", "System setup", "system_setup", 24));

  /* Questions onto their stages */
  const byStage = new Map(stages.map((s) => [s.name.trim().toLowerCase(), s]));
  const scoredStages = stages.filter((s) => SCORED.includes(s.type));
  for (const q of parts.questions?.questions ?? []) {
    const st = byStage.get(q.stageName.trim().toLowerCase()) ?? scoredStages[0];
    if (!st || !SCORED.includes(st.type)) continue;
    const max = Math.max(1, q.maxPoints || 10);
    const question: Question = {
      key: `q${st.questions.length + 1}`,
      text: q.text,
      type: q.type,
      competencyKeys: q.competencyNames.map((n) => compByName.get(n.trim().toLowerCase())).filter((k): k is string => Boolean(k)),
      maxPoints: max,
      weight: 1,
      mode: q.mode,
      idealAnswer: q.idealAnswer,
      probes: q.probes,
      rubric: q.mode === "ai_rubric" ? q.rubric.map((r, i) => ({ key: `r${i}`, descriptor: r.descriptor, points: Math.min(max, Math.max(0, r.points)), tier: r.tier, indicators: r.indicators })) : [],
      options: q.mode === "fixed_choice" ? q.options.map((o, i) => ({ key: String.fromCharCode(97 + i), label: o.label, points: Math.min(max, o.points) })) : undefined,
      mandatory: true,
      knockout: false,
      approved: false,
      ai: true,
    };
    st.questions.push(question);
  }
  for (const s of stages) s.maxPoints = s.questions.reduce((n, q) => n + q.maxPoints, 0);
  /* A scored stage the model gave no questions is kept, empty, for the validator to name. */

  /* The expectation set becomes a briefing stage before the gate */
  const points: BriefingPoint[] = (parts.expectation?.expectationPoints ?? []).map((p, i) => ({
    key: keyed("p", i),
    title: p.title,
    body: p.body,
    responseType: p.blocking && p.responseType === "told_only" ? "agree_disagree" : p.responseType,
    blocking: p.blocking,
    commentOnDisagree: p.responseType !== "told_only",
    approved: false,
    ai: true,
  }));
  if (points.length) {
    let brf = stages.find((s) => s.type === "briefing");
    if (!brf) {
      brf = mk("brf", "Briefing", "briefing", 48);
      stages.splice(stages.findIndex((s) => s.type === "decision_gate"), 0, brf);
    }
    brf.briefing = points;
  }
  stages = stages.map((s, i) => ({ ...s, key: s.key.startsWith("s") ? s.key : s.key || keyed("s", i) }));

  const documents: DocumentRequirement[] = (parts.expectation?.documents ?? []).map((d, i) => ({
    key: keyed("d", i),
    label: d.label,
    kind: d.kind,
    mandatory: d.mandatory,
    verify: d.verify,
    retentionMonths: 84,
    pii: (d.kind === "aadhaar" || d.kind === "pan") && d.pii !== "restricted" ? "restricted" : d.kind === "bank" && d.pii === "none" ? "sensitive" : d.pii,
    approved: false,
    ai: true,
  }));

  const o = parts.offer;
  const grades = (o?.grades ?? []).map((g, i) => ({ key: `G${i + 1}`, label: g.label, basicMinPaise: Math.round(Math.min(g.basicMinRupees, g.basicMaxRupees) * 100), basicMaxPaise: Math.round(Math.max(g.basicMinRupees, g.basicMaxRupees) * 100) }));
  const oneKind = o?.growth[0]?.incrementType ?? "percentage";
  const growth = (o?.growth ?? [])
    .filter((g) => grades[g.fromGrade] && grades[g.toGrade])
    .map((g) => ({ fromGrade: grades[g.fromGrade].key, toGrade: grades[g.toGrade].key, criterion: g.criterion, incrementType: oneKind, value: oneKind === "percentage" ? g.value : Math.round(g.value * 100) }));

  const f = parts.fairness;
  const masked = f?.masked ?? [...MASKABLE];
  const def: BlueprintDefinition & { competenciesApproved: boolean } = {
    competencies,
    competenciesApproved: false,
    stages,
    documents,
    offer: { currency: "INR", grades, incentive: o?.incentive ?? "", growth, approved: false, ai: true },
    onboarding: {
      assets: (o?.assets ?? []).map((label, i) => ({ key: keyed("a", i), label, serial: false })),
      modules: (o?.modules ?? []).map((m, i) => ({ key: keyed("m", i), name: m.name, topics: m.topics.map((t, j) => ({ key: keyed("t", j), title: t })) })),
      setup: (o?.setup ?? []).map((g, i) => ({ key: keyed("g", i), system: g.system, steps: g.steps.map((s, j) => ({ key: keyed("st", j), label: s })) })),
      approved: false,
      ai: true,
    },
    provisioning: { apps: [...new Set(["hrms", ...(o?.provisioning.apps ?? [])])], level: "associate", roleLabel: o?.provisioning.roleLabel ?? "", device: Boolean(o?.provisioning.device), approved: false, ai: true },
    fairness: {
      masked,
      unmaskedJustification: Object.fromEntries((f?.justifications ?? []).filter((j) => !masked.includes(j.attribute)).map((j) => [j.attribute, j.why])),
      monitor: { gender: true, age: true, location: true },
      adverseImpactThreshold: 0.8,
      redactBeforeTransmission: true,
      approved: false,
      ai: true,
    },
    coolingOff: [{ reasonCode: "below_pass", days: 90 }],
    openQuestions: f?.notes ?? [],
  };
  return { def, identity: parts.identity?.identity ?? null };
}
