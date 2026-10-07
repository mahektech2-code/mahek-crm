import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  hireAiOutputs,
  hireAnswers,
  hireApplications,
  hireAudit,
  hireBlueprints,
  hireBriefingResponses,
  hireCandidates,
  hireDecisions,
  hireDocuments,
  hireMessages,
  hireOffers,
  hireOnboardingItems,
  hireProfiles,
  hireRejectionProposals,
  hireSessions,
  hireStageExecutions,
  hireUserRoles,
  users,
  type HireEvidenceSpan,
} from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { calendarDate } from "@/lib/business-date";
import type { BlueprintDefinition, Question, Stage } from "../blueprint-types";
import { isScored } from "../blueprint-types";
import { scoreFixed } from "../engines/scoring";
import { SALES_EXECUTIVE, SEED_BLUEPRINTS } from "./blueprints";

/* ---------------------------------------------------------------------------
 * Seeding Hire.
 *
 * `seedHireBlueprints` is safe anywhere, production included: it inserts the
 * seeded blueprint versions that do not exist yet and touches nothing else.
 *
 * `seedHireDemo` is DEVELOPMENT data — Hire's staff accounts and a pipeline
 * of realistic candidates taken from the design (Suresh Patil, Ramesh
 * Kulkarni, Anil Deshmukh …) — and refuses to run unless told to reset.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID()}`;

/** Sales Executive v2 — the AppSheet app as it was, defects and all, so the diff has something real to show. */
function salesExecutiveV2(): BlueprintDefinition {
  const v2 = structuredClone(SALES_EXECUTIVE);
  for (const st of v2.stages) {
    if (st.key === "l1") {
      const q4 = st.questions.find((q) => q.key === "q4")!;
      if (q4.calc?.kind === "bands") {
        q4.calc.bands = q4.calc.bands.filter((b) => b.min != null);
        q4.calc.uncovered = null;
      }
      q4.note = "Salary below ₹15,000 has no score (D7).";
    }
    if (st.key === "l2") {
      const q7 = st.questions.find((q) => q.key === "q7")!;
      q7.options = q7.options!.map((o) => (o.key === "c" ? { ...o, points: null } : o));
      q7.note = "“Ask the team for help” scores nothing (D7).";
      for (const q of st.questions.filter((x) => x.mode === "ai_rubric")) q.mode = "fixed_choice";
    }
    if (st.key === "l3") {
      const q6 = st.questions.find((q) => q.key === "q6")!;
      if (q6.calc?.kind === "bands") q6.calc.bands = [{ min: null, max: 90, points: 0 }, { min: 90, max: null, points: 10 }];
      q6.note = "60–90% scores zero while above 90% scores 10 (D7).";
      const q8 = st.questions.find((q) => q.key === "q8")!;
      if (q8.calc?.kind === "formula") q8.calc.cap = null;
      for (const q of st.questions.filter((x) => x.mode === "ai_rubric")) q.mode = "fixed_choice";
    }
    if (st.key === "brf") st.briefing = st.briefing!.map((p) => ({ ...p, blocking: false }));
  }
  v2.stages = v2.stages.filter((s) => s.key !== "scr" && s.key !== "gate");
  v2.offer.growth = [
    { fromGrade: "S1", toGrade: "S2", criterion: "Cumulative sales of ₹10,00,000", incrementType: "fixed_amount", value: 200000 },
    { fromGrade: "S2", toGrade: "S3", criterion: "Cumulative sales of ₹25,00,000", incrementType: "fixed_amount", value: 250000 },
  ];
  v2.openQuestions = ["Level 2 passes at 70 for status but the result message fires from 63 (D4)."];
  return v2;
}

export async function seedHireBlueprints(actorId: string | null = null): Promise<{ created: string[] }> {
  const created: string[] = [];
  const rows = [
    ...SEED_BLUEPRINTS.map((b) => ({ ...b })),
    { ...SEED_BLUEPRINTS[0], version: 2, status: "retired" as const, definition: salesExecutiveV2(), source: "The AppSheet app as imported, before the D4/D7/D8/D11/D12 fixes." },
  ];
  for (const b of rows) {
    const [have] = await db.select({ id: hireBlueprints.id }).from(hireBlueprints).where(and(eq(hireBlueprints.key, b.key), eq(hireBlueprints.version, b.version))).limit(1);
    if (have) continue;
    const at = b.status === "draft" ? null : new Date(Date.now() - (b.version === 2 ? 120 : b.key === "sales-executive" ? 50 : 20) * 86_400_000);
    await db.insert(hireBlueprints).values({
      id: `hbp_${b.key}_v${b.version}`,
      key: b.key,
      version: b.version,
      status: b.status,
      title: b.title,
      family: b.family,
      department: b.department,
      level: b.level,
      employmentType: b.employmentType,
      locations: b.locations,
      headcount: b.headcount,
      descriptionSource: b.source,
      aiGenerated: b.ai,
      generationPromptVersion: b.ai ? "blueprint/v1" : null,
      parentId: b.version > 1 ? `hbp_${b.key}_v${b.version - 1}` : null,
      definition: b.definition,
      publishedAt: at,
      publishedById: b.status === "draft" ? null : actorId,
      retiredAt: b.status === "retired" ? new Date(Date.now() - 50 * 86_400_000) : null,
      createdById: actorId,
    });
    created.push(`${b.title} v${b.version}`);
  }
  return { created };
}

/* ------------------------------------------------------------------- demo */

const STAFF: { email: string; phone: string; name: string; role: string; level: "associate" | "manager" | "admin" }[] = [
  { email: "kavita@mahek.in", phone: "9820012001", name: "Kavita Shah", role: "hr_head", level: "manager" },
  { email: "priya.sharma@mahek.in", phone: "9820012002", name: "Priya Sharma", role: "recruiter", level: "associate" },
  { email: "neha.k@mahek.in", phone: "9820012003", name: "Neha Kulkarni", role: "recruiter", level: "associate" },
  { email: "rakesh.iyer@mahek.in", phone: "9820012004", name: "Rakesh Iyer", role: "interviewer", level: "associate" },
  { email: "meena@mahek.in", phone: "9820012005", name: "Meena Kulkarni", role: "interviewer", level: "associate" },
  { email: "nitin@mahek.in", phone: "9820012006", name: "Nitin Joshi", role: "interviewer", level: "associate" },
  { email: "sanjay@mahek.in", phone: "9820012007", name: "Sanjay Patil", role: "hiring_manager", level: "manager" },
  { email: "farida@mahek.in", phone: "9820012008", name: "Farida Khan", role: "onboarding", level: "associate" },
  { email: "farhan@mahek.in", phone: "9820012009", name: "Farhan Shaikh", role: "admin", level: "admin" },
];

const QUOTES: Record<string, string[]> = {
  c1: [
    "I used to divide my area into four parts and cover one part each day, keeping Saturday for the dealers who needed a second visit.",
    "Before Monday I write down which twenty counters I will touch that week, so nobody waits more than ten days for me.",
    "I start with the farthest town early morning and come back towards the city, so the traffic is behind me.",
  ],
  c2: [
    "Sharma ji stopped ordering for two months. I went to his shop without a sample bag, just to ask what went wrong.",
    "If the dealer’s son is handling the counter now, I talk to the son, but I still greet the father first.",
    "I keep their festival dates. On Diwali the dealer remembers who came, not who called.",
  ],
  c3: ["My target was six lakh a month. I did six point eight in March because I pushed the twenty-litre packs before the price change.", "I check my number every Thursday. If I am behind, Friday and Saturday go only to the big counters."],
  c4: ["In June I missed by forty percent. Two dealers shut for the monsoon. I took the train to Wardha and opened three new counters.", "The first week nobody gave me an order. I kept going back with the same price list until one painter tried it."],
  c5: ["I told him I cannot give a rate below the list. I can ask my manager for a scheme, but I will not promise it.", "Once I wrote a visit I did not make. My manager caught it. I never did it again."],
  c6: ["I don’t tell the painter it is better. I give him half a litre and stand there while he uses it.", "With dealers I speak Marathi, with the distributor I keep it formal in Hindi."],
  c7: ["I have my own two-wheeler and a licence. Four days outside is fine; my family knows the job.", "I can do three days outstation now. After my sister’s wedding in December, five is fine."],
  t1: ["I always say the customer’s shop name in the first line, so they know I am not a random call.", "If he starts talking about cricket I let him finish one sentence, then I bring it back to the order."],
  t2: ["He said “the same as last time”, so I read last month’s order back to him and he changed two items."],
  t3: ["I promised Patel bhai I would call at four. I set an alarm. I called at four."],
  t4: ["NC thinner is for the spray gun, PU for the polyurethane finish. If he uses the wrong one the finish goes cloudy."],
  t5: ["I repeat the quantity in cans and litres before I put the phone down."],
  a1: ["The bank showed one lakh twelve thousand more than Tally. It was three cheques entered twice in the old year."],
  a2: ["I tick every voucher against the bill before I post it, even when the senior says skip it."],
  a3: ["I can pass a GST purchase voucher, a debit note and pull the GSTR-2B match in Tally Prime."],
  a4: ["A dealer asked me to back-date a receipt. I said no and told my manager the same day."],
};

const FM = ["Aakash", "Ajay", "Amol", "Anand", "Arjun", "Bhushan", "Chetan", "Datta", "Dinesh", "Gaurav", "Harish", "Hemant", "Jitendra", "Kiran", "Lalit", "Mahesh", "Mangesh", "Nikhil", "Nilesh", "Omkar", "Pankaj", "Prashant", "Rahul", "Rajesh", "Rupesh", "Sachin", "Sagar", "Sandeep", "Santosh", "Shubham", "Swapnil", "Tushar", "Umesh", "Vikas", "Vishal", "Yogesh"];
const FF = ["Aditi", "Ashwini", "Bhagyashree", "Divya", "Gayatri", "Jyoti", "Komal", "Madhuri", "Pooja", "Priyanka", "Rupali", "Sakshi", "Shweta", "Snehal", "Sonali", "Supriya", "Tejaswini", "Vaishali"];
const LN = ["Bhagat", "Chavan", "Dhole", "Gawande", "Hatwar", "Ingle", "Jadhav", "Kale", "Khandare", "Lokhande", "Mane", "Meshram", "Nimje", "Pande", "Raut", "Sahu", "Sawant", "Shende", "Sonkusare", "Thakre", "Upadhyay", "Wankhede", "Yadav", "Bisen", "Choudhary", "Dubey", "Patel", "Rajput", "Tiwari", "Verma", "Sharma", "Mishra", "Soni", "Agrawal"];

let seed = 7;
const rnd = () => {
  seed++;
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length) % a.length];
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const daysAgo = (d: number, h = 11) => new Date(Date.now() - d * 86_400_000 - (h - 11) * 3_600_000);

type Ctx = { staff: Record<string, string>; bp: Record<string, { id: string; def: BlueprintDefinition }> };

/** One completed (or pending-review) stage with its answers. */
async function addScoredStage(c: Ctx, appId: string, stage: Stage, target: number, at: Date, by: string, opts: { review?: boolean; fail?: boolean } = {}) {
  const exId = id("hex");
  const answers: (typeof hireAnswers.$inferInsert)[] = [];
  let earned = 0;
  for (const q of stage.questions) {
    let pts = Math.round(Math.max(0, Math.min(q.maxPoints, (q.maxPoints * (target + ri(-12, 12))) / 100)) * 10) / 10;
    let selected: string[] | null = null;
    let response: string | null = null;
    let evidence: HireEvidenceSpan[] = [];
    if (q.mode === "fixed_choice") {
      const opts = (q.options ?? []).filter((o) => o.points != null);
      const best = opts.reduce((a, o) => (Math.abs((o.points ?? 0) - pts) < Math.abs((a.points ?? 0) - pts) ? o : a), opts[0]);
      selected = [best.key];
      pts = scoreFixed(q, selected).points ?? 0;
      response = `Selected: ${best.label}`;
    } else if (q.mode === "ai_rubric") {
      const comp = q.competencyKeys[0];
      response = pick(QUOTES[comp] ?? QUOTES.c1);
      const crit = q.rubric[q.rubric.length - (pts >= q.maxPoints * 0.75 ? 1 : 2)] ?? q.rubric[0];
      evidence = [{ verbatim: response, start: 0, end: response.length, criterionKey: crit?.key ?? null, criterion: crit?.descriptor ?? "", tier: pts >= q.maxPoints * 0.75 ? "full" : "partial", points: crit?.points ?? null, source: `${stage.name} · ${q.key.toUpperCase()}` }];
    } else {
      response = "Calculated from the inputs captured in the interview.";
    }
    earned += pts;
    const ai = q.mode === "ai_rubric";
    answers.push({
      id: id("han"),
      executionId: exId,
      questionKey: q.key,
      responseText: response,
      selected,
      score: opts.review && ai ? null : pts,
      maxPoints: q.maxPoints,
      scoredBy: ai ? "ai" : q.mode === "calculated" ? "calculated" : "fixed_choice",
      aiScore: ai ? pts : null,
      aiReasoning: ai ? (pts >= q.maxPoints * 0.75 ? "Gives a specific example with the result, in terms of the rubric’s full tier." : "Gives one example; the rubric’s higher tier needs what they changed afterwards.") : null,
      aiConfidence: ai ? (rnd() < 0.15 ? 0.6 : 0.88) : null,
      evidence,
      humanAction: opts.review && ai ? null : ai ? (rnd() < 0.8 ? "accepted" : "adjusted") : q.mode === "calculated" ? "calculated" : "selected",
      confirmedById: opts.review && ai ? null : by,
      confirmedAt: opts.review && ai ? null : at,
      createdAt: at,
      createdById: by,
    });
  }
  const normalised = Math.round((earned / stage.maxPoints) * 1000) / 10;
  await db.insert(hireStageExecutions).values({
    id: exId,
    applicationId: appId,
    stageKey: stage.key,
    status: opts.review ? "in_progress" : "completed",
    modality: stage.type === "ai_screen" ? "ai_voice" : "in_person",
    startedAt: new Date(at.getTime() - 50 * 60_000),
    completedAt: opts.review ? null : at,
    conductedById: by,
    earned: opts.review ? null : earned,
    maxPoints: stage.maxPoints,
    normalised: opts.review ? null : normalised,
    finalScore: opts.review ? null : normalised,
    outcome: opts.review ? "pending" : normalised >= stage.passThreshold ? "pass" : "fail",
    createdAt: at,
  });
  await db.insert(hireAnswers).values(answers);
  return { exId, normalised };
}

async function completeSimple(appId: string, stage: Stage, at: Date, by: string, outcome: "pass" | "pending" = "pass") {
  const exId = id("hex");
  await db.insert(hireStageExecutions).values({ id: exId, applicationId: appId, stageKey: stage.key, status: outcome === "pass" ? "completed" : "in_progress", completedAt: outcome === "pass" ? at : null, conductedById: by, outcome, createdAt: at });
  return exId;
}

async function makeCandidate(
  c: Ctx,
  o: {
    code?: string;
    name: string;
    phone: string;
    gender: string;
    ageBand: string;
    location: string;
    bpKey: string;
    stageIdx: number;
    status?: string;
    applied: number;
    source?: string;
    recruiter?: string;
    interviewer?: string;
    scores?: Record<string, number | undefined>;
    review?: string;
    hold?: string;
    fail?: boolean;
  },
) {
  const bp = c.bp[o.bpKey];
  const def = bp.def;
  const candId = id("hca");
  const [{ n }] = (await db.execute(sql`select nextval('hire_candidate_code_seq')::int as n`)) as unknown as { n: number }[];
  await db.insert(hireCandidates).values({
    id: candId,
    code: o.code ?? `C-${n}`,
    primaryPhone: o.phone,
    fullName: o.name,
    gender: o.gender,
    ageBand: o.ageBand,
    location: o.location,
    source: o.source ?? pick(["Walk-in", "Referral", "Naukri", "Candidate portal", "Candidate portal", "WhatsApp enquiry"]),
    consentAt: daysAgo(o.applied),
    aiDisclosedAt: daysAgo(o.applied),
    createdAt: daysAgo(o.applied),
  });
  const appId = id("hap");
  const hired = o.status === "hired";
  const idx = Math.min(o.stageIdx, def.stages.length - 1);
  const stage = def.stages[idx];
  const recruiter = c.staff[o.recruiter ?? pick(["Priya Sharma", "Priya Sharma", "Neha Kulkarni"])];
  const interviewer = c.staff[o.interviewer ?? pick(["Rakesh Iyer", "Meena Kulkarni", "Nitin Joshi"])];
  const step = Math.max(1, Math.floor(o.applied / Math.max(1, idx + 1)));
  await db.insert(hireApplications).values({
    id: appId,
    candidateId: candId,
    blueprintId: bp.id,
    appliedAt: daysAgo(o.applied),
    location: o.location,
    stageKey: stage.key,
    stageEnteredAt: daysAgo(Math.max(0, o.applied - idx * step), 9 + ri(0, 8)),
    status: o.status ?? "in_progress",
    holdReason: o.hold ?? null,
    recruiterId: recruiter,
    interviewerId: interviewer,
    hiringManagerId: c.staff["Sanjay Patil"],
    hiredAt: hired ? daysAgo(ri(1, 20)) : null,
    closedAt: o.status && o.status !== "in_progress" && o.status !== "on_hold" ? daysAgo(ri(1, 10)) : null,
    rejectionReasonCode: o.status === "rejected" ? "below_pass" : null,
    rejectionStageKey: o.status === "rejected" ? stage.key : null,
    createdAt: daysAgo(o.applied),
  });
  const upto = hired ? def.stages.length : idx;
  for (let i = 0; i < upto; i++) {
    const s = def.stages[i];
    const at = daysAgo(Math.max(0, o.applied - (i + 1) * step), 11 + (i % 5));
    const by = s.type === "decision_gate" ? c.staff["Sanjay Patil"] : interviewer;
    if (isScored(s)) await addScoredStage(c, appId, s, o.scores?.[s.key] ?? ri(72, 92), at, by);
    else {
      await completeSimple(appId, s, at, by);
      if (s.type === "decision_gate") await db.insert(hireDecisions).values({ id: id("hde"), applicationId: appId, decisionPoint: "decision_gate", decidedById: c.staff["Sanjay Patil"], decidedByRole: "Hiring Manager", decidedAt: at, decision: "advance", reasoning: "Above the pass mark at every stage with evidence on every competency; compensation inside the band.", agreedWithAi: true, aiRecommendation: { action: "Advance", confidence: "High", why: "At or above the pass mark at every stage." } });
      if (s.type === "briefing") {
        const ex = await db.select({ id: hireStageExecutions.id }).from(hireStageExecutions).where(and(eq(hireStageExecutions.applicationId, appId), eq(hireStageExecutions.stageKey, s.key))).limit(1);
        await db.insert(hireBriefingResponses).values((s.briefing ?? []).map((p) => ({ id: id("hbr"), executionId: ex[0].id, pointKey: p.key, response: p.responseType === "told_only" ? "told" : "agree", recordedById: recruiter, recordedAt: at })));
      }
      if (s.type === "document_collection") {
        for (const d of def.documents) await db.insert(hireDocuments).values({ id: id("hdo"), applicationId: appId, requirementKey: d.key, verificationStatus: "verified", verifiedById: c.staff["Farida Khan"], verifiedAt: at, createdAt: at });
        const g = def.offer.grades[0];
        await db.insert(hireOffers).values({ id: id("hof"), applicationId: appId, status: "accepted", grade: g.key, gradeLabel: g.label, basicPaise: g.basicMinPaise + 200000, incentive: def.offer.incentive, growth: def.offer.growth, issuedAt: at, issuedById: c.staff["Sanjay Patil"], respondedAt: at, response: "accepted", growthConfirmation: "agree", letterConfirmation: "agree", courierStatus: "received", backgroundCheck: "clear" });
      }
      if (s.type === "checklist" || s.type === "system_setup") {
        const items =
          s.type === "checklist"
            ? [...def.onboarding.assets.map((a) => ["asset", "assets", a.key]), ...def.onboarding.modules.flatMap((m) => m.topics.map((t) => ["topic", m.key, t.key]))]
            : def.onboarding.setup.flatMap((g) => g.steps.map((st) => ["setup", g.key, st.key]));
        await db.insert(hireOnboardingItems).values(items.map(([kind, groupKey, itemKey]) => ({ id: id("hon"), applicationId: appId, kind, groupKey, itemKey, done: true, doneById: c.staff["Farida Khan"], doneAt: at }))).onConflictDoNothing();
      }
    }
  }
  if (!hired && o.status !== "offer_declined") {
    if (isScored(stage)) {
      if (o.fail || o.status === "rejected") await addScoredStage(c, appId, stage, ri(44, 62), daysAgo(1), interviewer);
      else if (o.scores?.[stage.key] != null) await addScoredStage(c, appId, stage, o.scores[stage.key]!, daysAgo(0, 9), interviewer, { review: o.review === stage.key });
      else await db.insert(hireStageExecutions).values({ id: id("hex"), applicationId: appId, stageKey: stage.key, status: rnd() < 0.5 ? "scheduled" : "not_started", scheduledAt: rnd() < 0.5 ? new Date(Date.now() + ri(1, 120) * 3_600_000) : null, scheduledMinutes: 45, conductedById: interviewer, maxPoints: stage.maxPoints, outcome: "pending" });
    } else await completeSimple(appId, stage, daysAgo(0), interviewer, "pending");
  }
  await db.insert(hireAudit).values({ id: id("hau"), applicationId: appId, candidateId: candId, entityType: "application", entityId: appId, eventType: "created", summary: `Application created · consent recorded · duplicate check: no match`, actorName: "System", at: daysAgo(o.applied) });
  return { appId, candId };
}

export async function seedHireDemo(opts: { reset: boolean }) {
  if (!opts.reset) throw new Error("seedHireDemo wipes Hire's data first — pass { reset: true } (npm run hire:seed -- --reset).");
  await db.execute(sql`truncate hire_audit, hire_ai_outputs, hire_ai_tasks, hire_messages, hire_onboarding_items, hire_offers, hire_profiles, hire_documents, hire_vault, hire_files, hire_sessions, hire_rejection_proposals, hire_decisions, hire_briefing_responses, hire_answers, hire_stage_executions, hire_outcomes, hire_applications, hire_candidates, hire_user_roles, hire_blueprints cascade`);
  await db.execute(sql`alter sequence hire_candidate_code_seq restart with 1100`);

  /* Staff */
  const pw = await hashPassword("mahek1234");
  const staff: Record<string, string> = {};
  for (const s of STAFF) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, s.email)).limit(1);
    const uid = u?.id ?? `usr_hire_${s.email.split("@")[0].replace(/\W/g, "")}`;
    if (!u) await db.insert(users).values({ id: uid, name: s.name, email: s.email, phone: s.phone, passwordHash: pw, role: s.level, initials: s.name.split(" ").map((w) => w[0]).join("") });
    staff[s.name] = uid;
    await db.delete(appAccess).where(and(eq(appAccess.userId, uid), eq(appAccess.app, "hire")));
    await db.insert(appAccess).values({ id: id("acc"), userId: uid, app: "hire", role: s.level });
    await db.insert(hireUserRoles).values({ userId: uid, role: s.role }).onConflictDoNothing();
  }
  const [vikram] = await db.select({ id: users.id }).from(users).where(eq(users.email, "vikram@mahek.in")).limit(1);
  if (vikram) {
    await db.delete(appAccess).where(and(eq(appAccess.userId, vikram.id), eq(appAccess.app, "hire")));
    await db.insert(appAccess).values({ id: id("acc"), userId: vikram.id, app: "hire", role: "admin" });
    await db.insert(hireUserRoles).values({ userId: vikram.id, role: "hr_head" }).onConflictDoNothing();
  }

  await seedHireBlueprints(staff["Kavita Shah"]);
  const bps = await db.select().from(hireBlueprints);
  const c: Ctx = { staff, bp: {} };
  for (const b of bps) if (b.status === "published") c.bp[b.key] = { id: b.id, def: b.definition };

  /* The design's featured candidates */
  const F = [
    { code: "C-1042", name: "Suresh Patil", phone: "+919822041736", gender: "M", ageBand: "26–35", location: "Pune", bpKey: "sales-executive", stageIdx: 6, applied: 24, source: "Referral", scores: { scr: 81, l1: 85, l2: 78, l3: 84 } },
    { code: "C-1043", name: "Ramesh Kulkarni", phone: "+919766320914", gender: "M", ageBand: "26–35", location: "Nagpur", bpKey: "sales-executive", stageIdx: 5, applied: 21, source: "Candidate portal", scores: { scr: 78, l1: 81, l2: 74 }, interviewer: "Sanjay Patil" },
    { code: "C-1044", name: "Anil Deshmukh", phone: "+919970155283", gender: "M", ageBand: "26–35", location: "Nagpur", bpKey: "sales-executive", stageIdx: 3, applied: 16, source: "Walk-in", scores: { scr: 72, l1: 76, l2: 71 }, review: "l2" },
    { code: "C-1045", name: "Neha Joshi", phone: "+919893077412", gender: "F", ageBand: "18–25", location: "Indore", bpKey: "sales-executive", stageIdx: 7, applied: 31, recruiter: "Neha Kulkarni", source: "Candidate portal", scores: { scr: 80, l1: 79, l2: 82, l3: 80 } },
    { code: "C-1046", name: "Imran Qureshi", phone: "+919425231867", gender: "M", ageBand: "26–35", location: "Raipur", bpKey: "sales-executive", stageIdx: 8, applied: 38, scores: { scr: 76, l1: 83, l2: 79, l3: 77 } },
    { code: "C-1047", name: "Pradeep Yadav", phone: "+919850063129", gender: "M", ageBand: "26–35", location: "Nagpur", bpKey: "sales-executive", stageIdx: 9, applied: 41, scores: { scr: 84, l1: 88, l2: 81, l3: 86 } },
    { code: "C-1048", name: "Sunil Bhosale", phone: "+919730018245", gender: "M", ageBand: "36–45", location: "Pune", bpKey: "sales-executive", stageIdx: 2, applied: 12, scores: { scr: 66 }, fail: true },
    { code: "C-1049", name: "Manoj Thakur", phone: "+919049055617", gender: "M", ageBand: "26–35", location: "Nashik", bpKey: "sales-executive", stageIdx: 3, applied: 15, scores: { scr: 70, l1: 74 }, fail: true },
    { code: "C-1050", name: "Deepak Rathod", phone: "+919827240381", gender: "M", ageBand: "26–35", location: "Indore", bpKey: "sales-executive", stageIdx: 0, applied: 0, source: "Candidate portal" },
    { code: "C-1051", name: "Vijay Pawar", phone: "+919926381450", gender: "M", ageBand: "26–35", location: "Raipur", bpKey: "sales-executive", stageIdx: 4, applied: 22, status: "on_hold", hold: "Disagreed with 4–5 days outstation travel — a blocking briefing point", scores: { scr: 75, l1: 77, l2: 76 } },
    { code: "C-1052", name: "Ganesh More", phone: "+919764022018", gender: "M", ageBand: "26–35", location: "Nagpur", bpKey: "sales-executive", stageIdx: 6, applied: 26, interviewer: "Meena Kulkarni", scores: { scr: 79, l1: 80, l2: 80, l3: 82 } },
    { code: "C-1053", name: "Aarti Shinde", phone: "+919890164472", gender: "F", ageBand: "26–35", location: "Pune", bpKey: "sales-executive", stageIdx: 6, applied: 27, interviewer: "Meena Kulkarni", source: "Naukri", scores: { scr: 83, l1: 78, l2: 86, l3: 81 } },
    { code: "C-1054", name: "Rohit Gaikwad", phone: "+919920948831", gender: "M", ageBand: "18–25", location: "Bhiwandi HQ", bpKey: "telecaller", stageIdx: 1, applied: 1, recruiter: "Neha Kulkarni", source: "WhatsApp enquiry" },
    { code: "C-1055", name: "Lakshmi Iyer", phone: "+919867610293", gender: "F", ageBand: "26–35", location: "Bhiwandi HQ", bpKey: "accounts-executive", stageIdx: 3, applied: 14, interviewer: "Nitin Joshi", source: "Naukri", scores: { scr: 82, xl: 88 } },
  ];
  const featured: Record<string, { appId: string; candId: string }> = {};
  for (const f of F) featured[f.code] = await makeCandidate(c, f);

  /* The pipeline around them */
  const used = new Set(F.map((f) => f.name));
  const gen = async (bpKey: string, count: number, locs: string[]) => {
    const n = c.bp[bpKey].def.stages.length;
    for (let i = 0; i < count; i++) {
      const fem = rnd() < 0.3;
      let nm = `${pick(fem ? FF : FM)} ${pick(LN)}`;
      for (let g = 0; used.has(nm) && g < 4; g++) nm = `${pick(fem ? FF : FM)} ${pick(LN)}`;
      used.add(nm);
      const roll = rnd();
      let status = "in_progress";
      let idx = Math.min(n - 1, Math.floor(Math.pow(rnd(), 1.5) * n));
      if (roll < 0.18) status = "rejected";
      else if (roll < 0.22) status = "withdrawn";
      else if (roll < 0.32) {
        status = "hired";
        idx = n - 1;
      }
      const stage = c.bp[bpKey].def.stages[idx];
      if (status === "rejected" && !isScored(stage)) idx = Math.max(1, Math.min(idx, 3));
      await makeCandidate(c, {
        name: nm,
        phone: `+919${String(ri(100000000, 999999999))}`,
        gender: fem ? "F" : "M",
        ageBand: pick(["18–25", "26–35", "26–35", "36–45"]),
        location: pick(locs),
        bpKey,
        stageIdx: idx,
        status,
        applied: ri(1, 75),
        fail: status === "rejected",
        review: rnd() < 0.15 ? stage.key : undefined,
        scores: rnd() < 0.3 && isScored(stage) ? { [stage.key]: ri(71, 92) } : undefined,
      });
    }
  };
  await gen("sales-executive", 90, ["Nagpur", "Pune", "Indore", "Raipur", "Nashik"]);
  await gen("telecaller", 30, ["Bhiwandi HQ"]);
  await gen("accounts-executive", 12, ["Bhiwandi HQ"]);

  /* Rejection proposals — Sunil (58 at Level 1) and Manoj (66 at Level 2, the old 63–69 band) */
  const now = Date.now();
  await db.insert(hireRejectionProposals).values([
    { id: id("hrp"), applicationId: featured["C-1048"].appId, stageKey: "l1", score: 58, reasonCode: "below_pass", proposedById: staff["Rakesh Iyer"], proposedAt: daysAgo(1), windowEndsAt: new Date(now + 2 * 86_400_000) },
    {
      id: id("hrp"),
      applicationId: featured["C-1049"].appId,
      stageKey: "l2",
      score: 66,
      reasonCode: "below_pass",
      proposedById: staff["Sanjay Patil"],
      proposedAt: daysAgo(1),
      windowEndsAt: new Date(now + 2 * 86_400_000),
      note: "66 falls in the old 63–69 band. Under the AppSheet app this candidate would have been shown Fail and told they were selected for the Zoom round. One threshold of 70 now governs status, message and progression.",
    },
  ]);

  /* Deepak Rathod — a possible duplicate of a rejected Deepak Rathore */
  const rath = await makeCandidate(c, { code: "C-0871", name: "Deepak Rathore", phone: "+919827240399", gender: "M", ageBand: "26–35", location: "Indore", bpKey: "sales-executive", stageIdx: 2, status: "rejected", applied: 127, fail: true });
  await db
    .update(hireApplications)
    .set({ duplicate: { candidateId: rath.candId, applicationId: rath.appId, confidence: "High", why: "Name differs by one letter, same Indore address, a phone number one digit apart.", outcome: "Rejected at Level 1 · 61 against 70", coolingEnds: new Date(now + 4 * 86_400_000).toISOString(), status: "open" } })
    .where(eq(hireApplications.id, featured["C-1050"].appId));

  /* Suresh Patil's record, as the design draws it */
  const s = featured["C-1042"];
  await db.insert(hireProfiles).values({
    applicationId: s.appId,
    data: {
      fields: {
        "Current employer": { value: "Berger Paints India", source: "ai", confidence: 0.97 },
        "Current title": { value: "Territory Sales Officer", source: "ai", confidence: 0.95 },
        "Total experience": { value: "7 years 0 months", source: "ai", confidence: 0.91 },
        "Relevant experience": { value: "7 years 0 months", source: "ai", confidence: 0.88 },
        Education: { value: "B.Com, Savitribai Phule Pune University, 2018", source: "ai", confidence: 0.96 },
        Languages: { value: "Marathi, Hindi, English", source: "ai", confidence: 0.93 },
        "Current compensation": { value: "₹17,500 a month", source: "ai", confidence: 0.82 },
        "Expected compensation": { value: "₹19,000 a month", source: "human", confidence: 1 },
        "Notice period": { value: "30 days", source: "ai", confidence: 0.79 },
        Gaps: { value: "None found", source: "ai", confidence: 0.9 },
      },
      employers: [
        { name: "Berger Paints India", title: "Territory Sales Officer", from: "Jul 2023", to: "present", months: 39 },
        { name: "Shree Ganesh Distributors", title: "Sales Representative", from: "Jun 2019", to: "Jun 2023", months: 48 },
        { name: "Om Sai Hardware", title: "Counter salesman", from: "Aug 2018", to: "May 2019", months: 10 },
      ],
      education: ["B.Com, Savitribai Phule Pune University, 2018"],
      skills: ["Dealer management", "Territory planning", "Collections"],
      languages: ["Marathi", "Hindi", "English"],
      gaps: [],
    },
    corrections: [{ field: "Expected compensation", from: "₹1,90,000", to: "₹19,000 a month", byId: staff["Priya Sharma"], byName: "Priya Sharma", at: daysAgo(22).toISOString() }],
    extractionConfidence: 0.89,
    extractedAt: daysAgo(22),
  });
  await db.insert(hireAiOutputs).values([
    {
      id: id("hao"),
      kind: "summary",
      applicationId: s.appId,
      content: {
        summary:
          "Seven years in paint and hardware field sales across Pune and Satara. The strongest evidence is in territory planning and dealer relationships, with specific examples that can be checked. His target history is consistent across three stages. One open question: tenure at his current employer is three years on the CV and “a little over two” at Level 3.",
        recommendation: { action: "Advance to documents & offer", confidence: "High", why: "At or above the pass mark at every stage, with evidence on all seven competencies. His compensation expectation of ₹19,000 is inside the S1 band. Check the tenure discrepancy with his reference before the offer is issued." },
        strengths: [
          { title: "Recovers lapsed dealers in person", quote: "Kale Hardware stopped buying from us after a wrong delivery. I went with the corrected invoice myself and stayed till he checked every drum.", source: "Level 2 · Q2" },
          { title: "Plans the week before it starts", quote: "I make the beat on Sunday night. Monday is Hadapsar and Kharadi, Tuesday is the highway towns.", source: "Level 3 · Q1" },
        ],
        concerns: [
          { title: "Missed last year’s target by four percent", quote: "Last year my target was seventy-two lakh. I did sixty-nine — ninety-six percent. I lost Kale for two months.", source: "Level 3 · Q6" },
          { title: "Product detail is general rather than specific", quote: "NC and PU are both thinners, PU is the costly one, the finish is better.", source: "Level 3 · Q5" },
        ],
      },
      createdAt: daysAgo(4),
    },
    {
      id: id("hao"),
      kind: "consistency",
      applicationId: s.appId,
      content: {
        consistencies: [{ claim: "Target of ₹72 lakh last year, achieved 96%", sources: ["AI voice screen · Q4", "Level 3 · Q6"], strength: "Strong" }],
        inconsistencies: [
          {
            nature: "Tenure",
            severity: "Moderate",
            a: { text: "Berger Paints India · Territory Sales Officer · Jul 2023 – present (3 years)", source: "CV" },
            b: { text: "I have been at Berger a little over two years now.", source: "Level 3 · 02 Oct, 11:44" },
            probe: "Ask his reference for the month he joined Berger.",
          },
        ],
        unverified: ["Opened four counters in Saswad"],
        score: 0.86,
      },
      createdAt: daysAgo(4),
    },
  ]);
  await db.insert(hireMessages).values([
    { id: id("hms"), candidateId: s.candId, applicationId: s.appId, direction: "out", channel: "whatsapp", language: "English", body: "Hi Suresh, thank you for applying for Sales Executive at Mahek Marketing. Your AI screening call is booked for 18 Sep at 10:00. The call is with an AI interviewer; you can ask for a person at any time.", aiDrafted: true, status: "read", sentById: staff["Priya Sharma"], at: daysAgo(22, 10) },
    { id: id("hms"), candidateId: s.candId, applicationId: s.appId, direction: "in", channel: "whatsapp", language: "English", body: "Ok sir, I will be available.", status: "logged", at: daysAgo(22, 11) },
    { id: id("hms"), candidateId: s.candId, applicationId: s.appId, direction: "out", channel: "sms", language: "Marathi", body: "सुरेश, तुमची Level 1 मुलाखत 20 सप्टेंबर, सकाळी 11 वाजता, बिबवेवाडी कार्यालयात आहे.", aiDrafted: true, status: "delivered", sentById: staff["Priya Sharma"], at: daysAgo(19, 16) },
    { id: id("hms"), candidateId: s.candId, applicationId: s.appId, direction: "out", channel: "email", language: "English", subject: "Your Level 3 interview", body: "Dear Suresh,\nYour Level 3 interview is on 2 October at 11:00 at our Pune office. It will take about an hour. Please bring your last three payslips.\nPriya Sharma, Mahek Marketing", aiDrafted: true, status: "read", sentById: staff["Priya Sharma"], at: daysAgo(11, 12) },
  ]);

  /* Ramesh Kulkarni — a Level 3 interview in progress, transcript so far */
  const r = featured["C-1043"];
  const [rx] = await db.select({ id: hireStageExecutions.id }).from(hireStageExecutions).where(and(eq(hireStageExecutions.applicationId, r.appId), eq(hireStageExecutions.stageKey, "l3"))).limit(1);
  if (rx) {
    await db.update(hireStageExecutions).set({ status: "in_progress", startedAt: daysAgo(0, 14) }).where(eq(hireStageExecutions.id, rx.id));
    await db.insert(hireSessions).values({
      id: id("hse"),
      executionId: rx.id,
      modality: "in_person",
      status: "live",
      recordingConsent: true,
      consentAt: daysAgo(0, 14),
      language: "English",
      languages: ["English", "Hindi"],
      interviewerIds: [staff["Sanjay Patil"]],
      segments: [
        { speaker: "interviewer", name: "Sanjay Patil", startMs: 0, endMs: 9000, text: "Let’s start with territory. You are given a new district with forty counters. How do you plan your first month?", questionKey: "q1" },
        { speaker: "candidate", startMs: 9000, endMs: 41000, text: "First week I just visit all forty, no selling, only listening. Then I make four groups by distance and order size, and each group gets one fixed day.", questionKey: "q1" },
        { speaker: "interviewer", name: "Sanjay Patil", startMs: 360000, endMs: 368000, text: "A dealer complains that our delivery came three days late. What do you do that day?", questionKey: "q2" },
        { speaker: "candidate", startMs: 368000, endMs: 402000, text: "I go to him the same day with the transporter’s LR copy, so he sees I am not making excuses. At Asian Paints, I was there about eighteen months, this happened every monsoon.", questionKey: "q2" },
      ],
    });
  }

  /* Hired outcomes for Quality */
  const hiredApps = (await db.execute(sql`select id from hire_applications where status = 'hired'`)) as unknown as { id: string }[];
  for (const h of hiredApps) await db.execute(sql`insert into hire_outcomes (application_id, performance_score, left_at) values (${h.id}, ${ri(55, 95)}, ${rnd() < 0.12 ? calendarDate(daysAgo(ri(1, 60))) : null}) on conflict do nothing`);

  const [{ apps }] = (await db.execute(sql`select count(*)::int as apps from hire_applications`)) as unknown as { apps: number }[];
  return { staff: Object.keys(staff).length, applications: apps };
}
