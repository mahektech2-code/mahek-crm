import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  hireApplications,
  hireAssetIssues,
  hireBackgroundChecks,
  hireBlueprints,
  hireCandidates,
  hireCourierEvents,
  hireCourierShipments,
  hireDecisions,
  hireDocTemplates,
  hireDocuments,
  hireEmploymentDocs,
  hireIncentivePlans,
  hireOffers,
  hireOnboardingItems,
  trainingAttempts,
  trainingEnrollments,
  trainingEvents,
  trainingModuleVersions,
  trainingModules,
  trainingTrackVersions,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { drawAttempt, score, seedFrom } from "@/lib/training/engine";
import { renderLetter, slabLines } from "@/app/hire/_onboard/letter";
import { fillTemplate } from "../engines/onboarding";
import type { BlueprintDefinition } from "../blueprint-types";
import { GATE_POINT } from "../roles";
import { publishOnboardingVersions, seedOnboardingContent } from "../install";

/* ---------------------------------------------------------------------------
 * DEMO ONLY — the onboarding flow with somebody at every step, so each screen
 * has something real on it: an offer waiting for approval, one waiting for an
 * answer, documents half in, employment documents with a courier out, a new
 * employee acknowledging assets, and one in training with a failed module
 * waiting for the trainer. Two of them have accounts and can sign in to /learn.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID()}`;
const DAY = 86_400_000;
const daysAgo = (d: number, h = 11) => new Date(Date.now() - d * DAY + (h - 11) * 3_600_000);
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
const L = 100;

export const LEARNERS = [
  { email: "kiran.shinde@mahek.in", phone: "9822041410", name: "Kiran Shinde" },
  { email: "tejas.kale@mahek.in", phone: "9822041422", name: "Tejas Kale" },
];

export async function seedOnboardingDemo(staff: Record<string, string>): Promise<number> {
  const head = staff["Kavita Shah"];
  await seedOnboardingContent(head, true);
  await publishOnboardingVersions(head);
  const [bp] = await db.select().from(hireBlueprints).where(and(eq(hireBlueprints.key, "sales-executive"), eq(hireBlueprints.version, 4))).limit(1);
  if (!bp) return 0;
  const def = bp.definition as BlueprintDefinition;
  const [plan] = await db.select().from(hireIncentivePlans).where(eq(hireIncentivePlans.key, "sales-executive-monthly")).limit(1);
  const priya = staff["Priya Sharma"];
  const farida = staff["Farida Khan"];
  const sanjay = staff["Sanjay Patil"];
  const trainer = staff["Rohini Deshpande"];

  let n = 0;
  async function candidate(name: string, phone: string, location: string, stageKey: string, enteredDaysAgo: number, status = "in_progress") {
    const cid = id("hca");
    await db.insert(hireCandidates).values({ id: cid, code: `C-${2100 + n}`, fullName: name, primaryPhone: `+91${phone}`, location, source: "Referral" });
    const appId = id("hap");
    await db.insert(hireApplications).values({ id: appId, candidateId: cid, blueprintId: bp.id, stageKey, stageEnteredAt: daysAgo(enteredDaysAgo), appliedAt: daysAgo(enteredDaysAgo + 20), status, location, recruiterId: priya, hiringManagerId: sanjay });
    await db.insert(hireDecisions).values({ id: id("hde"), applicationId: appId, decisionPoint: GATE_POINT, decidedById: sanjay, decidedByRole: "Hiring Manager", decision: "advance", reasoning: "Scored well at every level and agreed every briefing point.", agreedWithAi: true, evidenceReviewed: ["scores", "briefing"], decidedAt: daysAgo(enteredDaysAgo + 1) });
    n++;
    return { cid, appId, name, location };
  }

  const comps = [{ key: "ta", label: "Travel allowance", amountPaise: 2_500 * L, per: "month" as const }, { key: "mobile", label: "Mobile reimbursement", amountPaise: 500 * L, per: "month" as const }];
  const letter = (who: string, loc: string, basicPaise: number) =>
    renderLetter({ def, roleTitle: bp.title, candidateName: who, location: loc, grade: "S1", gradeLabel: "Sales Executive (S1)", basicPaise, ctcPaise: null, incentive: plan?.title ?? null, joiningDate: ymd(daysAgo(-10)), expiryDate: ymd(daysAgo(-5)), incentiveApplicable: true, incentiveSlabs: plan ? slabLines(plan) : null, components: comps });
  async function offer(appId: string, who: string, loc: string, o: { status: string; basic: number; proposed?: number; approval?: string; issued?: number; responded?: number; requestedBy?: string }) {
    const oid = id("hof");
    await db.insert(hireOffers).values({
      id: oid,
      applicationId: appId,
      status: o.status,
      grade: "S1",
      gradeLabel: "Sales Executive (S1)",
      basicPaise: o.basic * L,
      proposedBasicPaise: (o.proposed ?? o.basic) * L,
      incentive: plan?.title ?? null,
      incentiveApplicable: true,
      incentivePlanId: plan?.id ?? null,
      components: comps,
      growth: def.offer.growth,
      letter: letter(who, loc, o.basic * L),
      joiningDate: ymd(daysAgo(-10)),
      expiryDate: ymd(daysAgo(-5)),
      effectiveDate: ymd(daysAgo(-10)),
      approvalStatus: o.approval ?? "not_needed",
      approvalRequestedAt: o.approval === "pending" ? daysAgo(0, 9) : null,
      approvalRequestedById: o.requestedBy ?? null,
      issuedAt: o.issued != null ? daysAgo(o.issued) : null,
      issuedById: o.issued != null ? priya : null,
      respondedAt: o.responded != null ? daysAgo(o.responded) : null,
      response: o.status === "accepted" ? "accepted" : null,
      changeReason: o.proposed && o.proposed !== o.basic ? "Matched his current fixed pay from the last six payslips." : null,
      createdById: priya,
    });
    return oid;
  }
  async function docs(appId: string, states: Record<string, { st: string; asked?: number }>) {
    for (const d of def.documents) {
      const s = states[d.key] ?? { st: "verified" };
      await db.insert(hireDocuments).values({ id: id("hdo"), applicationId: appId, requirementKey: d.key, verificationStatus: s.st, requestedAt: daysAgo(s.asked ?? 8), requestedById: farida, verifiedById: s.st === "verified" || s.st === "waived" || s.st === "failed" ? farida : null, verifiedAt: s.st === "verified" || s.st === "waived" ? daysAgo(5) : null, verificationNotes: s.st === "failed" ? "Statement older than three months" : s.st === "waived" ? "Not needed for this beat" : null, createdById: farida });
    }
  }
  const bgv = (appId: string, status: string) => db.insert(hireBackgroundChecks).values({ id: id("hbg"), applicationId: appId, required: true, status, method: "Previous-employer call and address check", initiatedOn: ymd(daysAgo(6)), completedOn: status === "clear" ? ymd(daysAgo(4)) : null, checkedById: farida, createdById: farida });

  /* 1 — negotiated past the line, waiting for Sanjay */
  const rohit = await candidate("Rohit Patil", "9822110001", "Pune West", "comp", 2);
  await offer(rohit.appId, rohit.name, rohit.location, { status: "draft", basic: 21_000, proposed: 19_500, approval: "pending", requestedBy: priya });
  /* 2 — issued, waiting for an answer */
  const arjun = await candidate("Arjun Pawar", "9822110002", "Nashik", "comp", 5);
  await offer(arjun.appId, arjun.name, arjun.location, { status: "issued", basic: 19_000, issued: 5 });
  /* 3 — documents half in */
  const sneha = await candidate("Sneha Kulkarni", "9822110003", "Pune West", "doc", 4);
  await offer(sneha.appId, sneha.name, sneha.location, { status: "accepted", basic: 20_000, issued: 9, responded: 7 });
  await docs(sneha.appId, { experience: { st: "requested", asked: 4 }, payslips: { st: "requested", asked: 4 }, bank: { st: "failed" }, pan: { st: "manual_review" }, education: { st: "pending" } });
  await bgv(sneha.appId, "in_progress");
  /* 4 — employment documents out, courier delivered, signed copies awaited */
  const amit = await candidate("Amit Jadhav", "9822110004", "Kolhapur", "empdocs", 3);
  await offer(amit.appId, amit.name, amit.location, { status: "accepted", basic: 20_000, issued: 14, responded: 12 });
  await docs(amit.appId, {});
  await bgv(amit.appId, "clear");
  const tpls = await db.select().from(hireDocTemplates).where(eq(hireDocTemplates.status, "published"));
  const values: Record<string, string> = { name: amit.name, first_name: "Amit", role: bp.title, grade: "Sales Executive (S1)", location: amit.location, basic: "₹20,000 a month", ctc: "[not stated]", components: "Travel allowance: ₹2,500 a month\nMobile reimbursement: ₹500 a month", incentive: plan?.title ?? "", incentive_slabs: plan ? slabLines(plan).join("\n") : "", growth_plan: "", joining_date: ymd(daysAgo(-10)), effective_date: ymd(daysAgo(-10)), today: ymd(new Date()) };
  const empState: Record<string, string> = { offer: "signed", contract: "sent", rr: "filed", growth: "filed", rulebook: "prepared" };
  for (const d of def.employmentDocs ?? []) {
    const t = tpls.find((x) => x.key === d.templateKey);
    const st = empState[d.key];
    await db.insert(hireEmploymentDocs).values({ id: id("hed"), applicationId: amit.appId, docKey: d.key, label: d.label, templateId: t?.id ?? null, templateVersion: t?.version ?? null, body: t ? fillTemplate(t.body, values) : "", status: st, hardCopy: d.hardCopy, preparedById: farida, preparedAt: daysAgo(3), approvedById: st === "prepared" ? null : head, approvedAt: st === "prepared" ? null : daysAgo(3), sentById: ["sent", "signed", "filed"].includes(st) ? farida : null, sentAt: ["sent", "signed", "filed"].includes(st) ? daysAgo(3) : null, signedOn: ["signed", "filed"].includes(st) ? ymd(daysAgo(1)) : null, filedById: st === "filed" ? farida : null, filedAt: st === "filed" ? daysAgo(1) : null, createdById: farida });
  }
  const out = id("hcs");
  await db.insert(hireCourierShipments).values({ id: out, applicationId: amit.appId, direction: "outbound", company: "DTDC", trackingNo: "D41239876", status: "delivered", docKeys: ["offer", "contract", "rulebook"], createdById: farida });
  await db.insert(hireCourierEvents).values([
    { id: id("hce"), shipmentId: out, status: "sent", eventOn: ymd(daysAgo(3)), byId: farida, at: daysAgo(3) },
    { id: id("hce"), shipmentId: out, status: "delivered", eventOn: ymd(daysAgo(1)), byId: farida, at: daysAgo(1) },
  ]);
  const ret = id("hcs");
  await db.insert(hireCourierShipments).values({ id: ret, applicationId: amit.appId, direction: "return", status: "awaited", dueOn: ymd(daysAgo(-4)), docKeys: ["offer", "contract", "rulebook"], createdById: farida });
  await db.insert(hireCourierEvents).values({ id: id("hce"), shipmentId: ret, status: "awaited", eventOn: ymd(daysAgo(1)), remarks: "Opened when the outbound copies were delivered", byId: farida, at: daysAgo(1) });

  /* 5 & 6 — hired, with accounts they can sign in with */
  const pw = await hashPassword("mahek1234");
  const learner = async (l: (typeof LEARNERS)[number], stageKey: string, hiredDaysAgo: number) => {
    const c = await candidate(l.name, l.phone, "Pune West", stageKey, hiredDaysAgo, "hired");
    await offer(c.appId, c.name, c.location, { status: "accepted", basic: 20_000, issued: hiredDaysAgo + 14, responded: hiredDaysAgo + 12 });
    await docs(c.appId, {});
    await bgv(c.appId, "clear");
    const [have] = await db.select({ id: users.id }).from(users).where(or(eq(users.email, l.email), eq(users.phone, l.phone))).limit(1);
    const uid = have?.id ?? `usr_demo_${l.email.split("@")[0].replace(/\W/g, "")}`;
    if (!have) await db.insert(users).values({ id: uid, name: l.name, email: l.email, phone: l.phone, passwordHash: pw, role: "associate", initials: l.name.split(" ").map((w) => w[0]).join("") });
    await db.delete(appAccess).where(and(eq(appAccess.userId, uid), inArray(appAccess.app, ["field", "hrms"])));
    await db.insert(appAccess).values([{ id: id("acc"), userId: uid, app: "field", role: "associate" }, { id: id("acc"), userId: uid, app: "hrms", role: "associate" }]);
    await db.update(hireApplications).set({ hiredAt: daysAgo(hiredDaysAgo), employeeUserId: uid, closedAt: daysAgo(hiredDaysAgo) }).where(eq(hireApplications.id, c.appId));
    return { ...c, uid };
  };
  const kiran = await learner(LEARNERS[0], "kit", 2);
  const tejas = await learner(LEARNERS[1], "training", 9);

  const assetsFor = async (appId: string, ackKeys: string[] | "all") => {
    for (const a of def.onboarding.assets) {
      const applicable = a.applicableByDefault ?? true;
      const ack = ackKeys === "all" || ackKeys.includes(a.key);
      await db.insert(hireAssetIssues).values({ id: id("hai"), applicationId: appId, assetKey: a.key, label: a.label, applicable, notApplicableReason: applicable ? null : "Samples come from the depot on this beat", serial: applicable && a.serial ? `${a.key.toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}` : null, issuedOn: applicable && a.key !== "vouchers" ? ymd(daysAgo(1)) : null, issuedById: applicable ? farida : null, acknowledgedAt: applicable && ack && a.key !== "vouchers" ? daysAgo(0, 10) : null, ackMethod: applicable && ack && a.key !== "vouchers" ? "in_app" : null, createdById: farida });
    }
  };
  await assetsFor(kiran.appId, ["sim", "idcard", "phone"]);
  await assetsFor(tejas.appId, "all");
  await db.update(hireAssetIssues).set({ issuedOn: ymd(daysAgo(8)), acknowledgedAt: daysAgo(7), ackMethod: "in_app" }).where(and(eq(hireAssetIssues.applicationId, tejas.appId), eq(hireAssetIssues.assetKey, "vouchers")));
  for (const app of [kiran, tejas]) {
    const intros = (def.onboarding.intros ?? []).slice(0, app === kiran ? 3 : 99);
    for (const i of intros) await db.insert(hireOnboardingItems).values({ id: id("hon"), applicationId: app.appId, kind: "intro", groupKey: "dept", itemKey: i.key, done: true, doneById: farida, doneAt: daysAgo(1) });
    if (app === tejas) for (const g of def.onboarding.setup) for (const s of g.steps) await db.insert(hireOnboardingItems).values({ id: id("hon"), applicationId: app.appId, kind: "setup", groupKey: g.key, itemKey: s.key, done: true, doneById: farida, doneAt: daysAgo(7) });
  }

  /* Training: both enrolled; Tejas passed four and failed Nano. */
  const [tv] = await db.select().from(trainingTrackVersions).where(and(eq(trainingTrackVersions.id, "ttv_sales-executive-onboarding_v1"))).limit(1);
  if (tv) {
    const mods = await db.select({ key: trainingModules.key, vid: trainingModuleVersions.id, def: trainingModuleVersions.definition }).from(trainingModules).innerJoin(trainingModuleVersions, eq(trainingModuleVersions.moduleId, trainingModules.id)).where(eq(trainingModuleVersions.status, "published"));
    for (const [who, days] of [[kiran, 2], [tejas, 9]] as const) {
      const eid = id("ten");
      await db.insert(trainingEnrollments).values({ id: eid, userId: who.uid, applicationId: who.appId, trackVersionId: tv.id, trainerId: trainer, assignedById: farida, assignedAt: daysAgo(days), dueOn: ymd(daysAgo(days - 30)) });
      const passes = who === tejas ? ["thinner-basics", "product-universal", "product-nc", "company-induction"] : ["thinner-basics"];
      let day: number = days;
      for (const key of [...passes, ...(who === tejas ? ["product-nano"] : [])]) {
        const m = mods.find((x) => x.key === key);
        if (!m) continue;
        const aid = id("tat");
        const items = drawAttempt(m.def, seedFrom(aid));
        const fail = key === "product-nano";
        const answers = items.map((it, i) => {
          const q = m.def.questions.find((x) => x.key === it.questionKey)!;
          const right = !fail || i % 3 === 0;
          return { questionKey: q.key, optionKey: right ? q.correctKey : (q.options.find((o) => o.key !== q.correctKey)?.key ?? q.correctKey), correct: right, at: daysAgo(day).toISOString() };
        });
        const correct = answers.filter((a) => a.correct).length;
        const s = score(correct, items.length, m.def.passMarkPercent);
        await db.insert(trainingEvents).values({ id: id("tev"), enrollmentId: eid, moduleKey: key, kind: "studied", seconds: 900, actorId: who.uid, at: daysAgo(day, 9) });
        await db.insert(trainingAttempts).values({ id: aid, enrollmentId: eid, moduleKey: key, moduleVersionId: m.vid, attemptNo: 1, startedAt: daysAgo(day, 10), submittedAt: daysAgo(day, 10.3), items, answers, totalQuestions: items.length, correctAnswers: correct, scorePercent: s.percent, passMark: m.def.passMarkPercent, result: s.result, trainerId: trainer });
        day = Math.max(0, day - 1);
      }
    }
  }
  return n;
}
