import "server-only";
import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireAssetIssues, hireBackgroundChecks, hireCourierShipments, hireDocuments, hireEmploymentDocs, hireOffers, trainingEnrollments } from "@/db/schema";
import { enrollmentView } from "@/lib/training/service";
import type { HireContext } from "../access";
import { isOnboardingFlow, type BlueprintDefinition } from "../blueprint-types";
import { courierOverall, empDocSigned, onboardingStatus, type OnboardingFacts, type OnboardingStatus } from "../engines/onboarding";
import { loadBlueprint } from "./core";
import { boardRows, type BoardRow } from "./pipeline";

/* ---------------------------------------------------------------------------
 * THE ONBOARDING BOARD (PRD §19, HR dashboard). One row per person between an
 * advanced decision gate and a finished onboarding, with the PRD status read
 * off their records by the pure engine. The tiles above the board count these
 * same rows, so a tile and its column cannot disagree.
 * ------------------------------------------------------------------------- */

export type OnboardRow = BoardRow & {
  ob: OnboardingStatus;
  line: string;
  late: boolean;
  training: { passed: number; required: number; retraining: number } | null;
};

const DAY = 86_400_000;

export async function onboardingRows(ctx: HireContext, nowMs: number): Promise<OnboardRow[]> {
  const all = await boardRows(ctx);
  const defs = new Map<string, BlueprintDefinition>();
  for (const id of new Set(all.map((r) => r.blueprintId))) {
    const b = await loadBlueprint(id);
    if (b) defs.set(id, b.definition);
  }
  const offerStage = (def: BlueprintDefinition) => def.stages.findIndex((s) => s.type === (isOnboardingFlow(def) ? "compensation" : "document_collection"));
  const rows = all.filter((r) => {
    const def = defs.get(r.blueprintId);
    if (!def) return false;
    if (r.status === "hired") return !r.onboardingCompletedAt || nowMs - new Date(r.onboardingCompletedAt).getTime() < 30 * DAY;
    if (r.status !== "in_progress" && r.status !== "on_hold") return false;
    const at = def.stages.findIndex((s) => s.key === r.stageKey);
    const o = offerStage(def);
    return o >= 0 && at >= o;
  });
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [offers, docs, bgvs, emps, ships, assets, enrols] = await Promise.all([
    db.select({ app: hireOffers.applicationId, status: hireOffers.status, approval: hireOffers.approvalStatus, issuedAt: hireOffers.issuedAt, basic: hireOffers.basicPaise, proposed: hireOffers.proposedBasicPaise, createdAt: hireOffers.createdAt }).from(hireOffers).where(and(inArray(hireOffers.applicationId, ids), isNull(hireOffers.supersededById))),
    db.select({ app: hireDocuments.applicationId, key: hireDocuments.requirementKey, st: hireDocuments.verificationStatus, requestedAt: hireDocuments.requestedAt }).from(hireDocuments).where(and(inArray(hireDocuments.applicationId, ids), isNull(hireDocuments.supersededById))),
    db.select({ app: hireBackgroundChecks.applicationId, required: hireBackgroundChecks.required, status: hireBackgroundChecks.status }).from(hireBackgroundChecks).where(and(inArray(hireBackgroundChecks.applicationId, ids), isNull(hireBackgroundChecks.supersededById))),
    db.select({ app: hireEmploymentDocs.applicationId, key: hireEmploymentDocs.docKey, status: hireEmploymentDocs.status, hard: hireEmploymentDocs.hardCopy, preparedById: hireEmploymentDocs.preparedById }).from(hireEmploymentDocs).where(and(inArray(hireEmploymentDocs.applicationId, ids), isNull(hireEmploymentDocs.supersededById))),
    db.select({ app: hireCourierShipments.applicationId, direction: hireCourierShipments.direction, status: hireCourierShipments.status, dueOn: hireCourierShipments.dueOn }).from(hireCourierShipments).where(inArray(hireCourierShipments.applicationId, ids)),
    db.select({ app: hireAssetIssues.applicationId, key: hireAssetIssues.assetKey, applicable: hireAssetIssues.applicable, issuedOn: hireAssetIssues.issuedOn, ack: hireAssetIssues.acknowledgedAt }).from(hireAssetIssues).where(and(inArray(hireAssetIssues.applicationId, ids), isNull(hireAssetIssues.supersededById))),
    db.select({ id: trainingEnrollments.id, app: trainingEnrollments.applicationId, status: trainingEnrollments.status }).from(trainingEnrollments).where(inArray(trainingEnrollments.applicationId, ids)),
  ]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(nowMs));

  const out: OnboardRow[] = [];
  for (const r of rows) {
    const def = defs.get(r.blueprintId)!;
    const offer = offers.filter((o) => o.app === r.id).sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null;
    const myDocs = docs.filter((d) => d.app === r.id);
    const okDocs = new Set(myDocs.filter((d) => d.st === "verified" || d.st === "waived").map((d) => d.key));
    const mandatoryOpen = def.documents.filter((d) => d.mandatory && !okDocs.has(d.key)).length;
    const requestedOpen = myDocs.filter((d) => d.st === "requested").length;
    const underReview = myDocs.filter((d) => d.st === "pending" || d.st === "manual_review").length;
    const bg = bgvs.find((b) => b.app === r.id) ?? null;
    const myEmp = emps.filter((e) => e.app === r.id);
    const wantEmp = (def.employmentDocs ?? []).filter((d) => d.required);
    const signed = wantEmp.filter((d) => myEmp.some((e) => e.key === d.key && empDocSigned(e.status))).length;
    const myShips = ships.filter((s) => s.app === r.id);
    const courier = courierOverall(myEmp.some((e) => e.hard), myShips);
    const myAssets = assets.filter((a) => a.app === r.id);
    let applicable = 0, issued = 0, ackNeeded = 0, acked = 0;
    for (const a of def.onboarding.assets) {
      const row = myAssets.find((x) => x.key === a.key);
      if (!(row ? row.applicable : (a.applicableByDefault ?? true))) continue;
      applicable++;
      if (row?.issuedOn) issued++;
      if (a.acknowledge) {
        ackNeeded++;
        if (row?.ack) acked++;
      }
    }
    const en = enrols.find((e) => e.app === r.id && e.status !== "withdrawn") ?? null;
    let training: OnboardRow["training"] = null;
    if (en) {
      const v = await enrollmentView(en.id, nowMs);
      if (v) training = { passed: v.summary.passed, required: v.summary.required, retraining: v.modules.filter((m) => m.state === "retraining_required").length };
    }
    const facts: OnboardingFacts = {
      appStatus: r.status,
      stageType: r.liveStageType,
      pastGate: true,
      offer: offer ? { status: offer.status, approvalStatus: offer.approval } : null,
      docs: { mandatoryOpen, requestedOpen, underReview },
      bgv: bg,
      empDocs: { required: wantEmp.length, signed },
      courier,
      assets: { applicable, issued, acknowledgedNeeded: ackNeeded, acknowledged: acked },
      training: training ? { enrolled: true, required: training.required, passed: training.passed } : null,
      onboardingCompleted: Boolean(r.onboardingCompletedAt),
    };
    /* An old blueprint version has no compensation or employment-documents stage; read it the old way. */
    if (!isOnboardingFlow(def)) {
      facts.empDocs = { required: 0, signed: 0 };
      facts.bgv = null;
    }
    const ob = onboardingStatus(facts);
    let line = "";
    let late = false;
    switch (ob) {
      case "compensation_discussion":
        line = offer?.approval === "pending" ? "Negotiated figure waiting for approval" : "Offer being drafted";
        break;
      case "awaiting_acceptance":
        line = offer?.issuedAt ? `Issued ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(offer.issuedAt)}` : "Issued";
        late = Boolean(offer?.issuedAt && nowMs - offer.issuedAt.getTime() > 3 * DAY);
        break;
      case "document_collection":
        line = `${mandatoryOpen} required document${mandatoryOpen === 1 ? "" : "s"} not in${requestedOpen ? ` · ${requestedOpen} requested` : ""}`;
        late = myDocs.some((d) => d.st === "requested" && d.requestedAt && nowMs - d.requestedAt.getTime() > 3 * DAY);
        break;
      case "verification":
        line = mandatoryOpen ? `${underReview} document${underReview === 1 ? "" : "s"} to verify` : `Background check ${bg ? bg.status.replace("_", " ") : "not recorded"}`;
        break;
      case "employment_documents":
        line = `${signed} of ${wantEmp.length} signed${myEmp.some((e) => e.status === "prepared") ? " · some waiting for a second approver" : ""}`;
        break;
      case "courier_pending": {
        const ret = myShips.find((s) => s.direction === "return" && s.status !== "received");
        line = ret ? `Return courier: ${ret.status.replace("_", " ")}` : "Hard copies to go out";
        late = courier === "issue" || Boolean(ret?.dueOn && ret.dueOn < today);
        break;
      }
      case "ready_to_provision":
        line = "Everything is back — create the account";
        break;
      case "assets_pending":
        line = `${acked} of ${ackNeeded} assets acknowledged · ${issued} of ${applicable} issued`;
        break;
      case "training":
        line = training ? `${training.passed} of ${training.required} modules${training.retraining ? ` · ${training.retraining} retraining` : ""}` : "Not enrolled";
        late = Boolean(training?.retraining);
        break;
      case "training_completed":
        line = "Every required module passed";
        break;
      case "onboarding_completed":
        line = "Onboarding complete";
        break;
      default:
        line = r.stageName;
    }
    out.push({ ...r, ob, line, late, training });
  }
  return out;
}
