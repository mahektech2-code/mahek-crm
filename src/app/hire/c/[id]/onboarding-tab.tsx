import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { cx } from "@/components/ui/primitives";
import { nowMs } from "@/lib/format";
import type { HireContext } from "@/lib/hire/access";
import { COURIER_STATUS_LABEL, EMP_DOC_LABEL, ONBOARDING_LABEL, courierOverall, empDocSigned, type CourierStatus, type EmpDocStep, type OnboardingStatus } from "@/lib/hire/engines/onboarding";
import type { AppBundle } from "@/lib/hire/services/core";
import { compensationHistory, currentOffer, approverName, rupees } from "@/lib/hire/services/offers";
import { documentRows } from "@/lib/hire/services/onboarding";
import { onboardingRows } from "@/lib/hire/services/onboarding-board";
import { BGV_LABEL, assetRows, currentBgv, employmentDocRows, planById, shipments } from "@/lib/hire/services/onboarding-records";
import { enrollmentForApplication, enrollmentView } from "@/lib/training/service";
import { MODULE_STATE_LABEL, type ModuleState } from "@/lib/training/types";
import { Panel, Pill, fd, type Tone } from "../../_ui/kit";

/** The PRD's statuses in the order a person passes through them. */
const FLOW: OnboardingStatus[] = [
  "selected",
  "compensation_discussion",
  "awaiting_acceptance",
  "accepted",
  "document_collection",
  "verification",
  "employment_documents",
  "courier_pending",
  "ready_to_provision",
  "assets_pending",
  "training",
  "training_completed",
  "onboarding_completed",
];

/** The trail event that first marks each status reached. */
const FIRST_EVENT: Partial<Record<OnboardingStatus, string[]>> = {
  selected: ["gate_decision", "stage_move"],
  compensation_discussion: ["offer_drafted"],
  awaiting_acceptance: ["offer_issued"],
  accepted: ["offer_accepted"],
  document_collection: ["documents_requested", "document_uploaded"],
  verification: ["document_verified", "background_check_saved"],
  employment_documents: ["employment_docs_prepared"],
  courier_pending: ["courier_added", "employment_docs_sent"],
  ready_to_provision: ["courier_status"],
  assets_pending: ["provisioned"],
  training: ["asset_issued"],
  training_completed: ["training_completed", "onboarding_completed"],
  onboarding_completed: ["onboarding_completed"],
};

const STATE_TONE: Record<ModuleState, Tone> = {
  locked: "muted",
  available: "info",
  in_progress: "info",
  assessment_pending: "info",
  passed: "success",
  retraining_required: "danger",
  retake_open: "warn",
};

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-canvas py-1.5 text-[13px] last:border-b-0">
      <span className="text-muted">{k}</span>
      <span className="text-right font-medium text-heading">{v}</span>
    </div>
  );
}

export async function OnboardingTab({ ctx, b }: { ctx: HireContext; b: AppBundle }) {
  const now = nowMs();
  const id = b.app.id;
  const [rows, offer, history, docs, bg, emp, ships, assets, enr, trail] = await Promise.all([
    onboardingRows(ctx, now),
    currentOffer(id),
    compensationHistory(id),
    documentRows(b),
    currentBgv(id),
    employmentDocRows(id),
    shipments(id),
    assetRows(b),
    enrollmentForApplication(id),
    db.execute(sql`select event_type, min(at) as at from hire_audit where application_id = ${id} group by event_type`) as unknown as Promise<{ event_type: string; at: string }[]>,
  ]);
  const row = rows.find((r) => r.id === id) ?? null;
  const status = row?.ob ?? null;
  const plan = await planById(offer?.incentivePlanId);
  const approver = await approverName(offer?.approvedById);
  const view = enr ? await enrollmentView(enr.id, now) : null;
  const firstAt = (s: OnboardingStatus) => {
    const evs = FIRST_EVENT[s] ?? [];
    const at = trail.filter((t) => evs.includes(t.event_type)).map((t) => new Date(t.at).getTime());
    return at.length ? new Date(Math.min(...at)).toISOString() : null;
  };
  const at = status ? FLOW.indexOf(status) : -1;
  const changes = history.filter((h) => h.event === "compensation_changed").length;

  const okDocs = docs.filter((d) => d.doc?.verificationStatus === "verified" || d.doc?.verificationStatus === "waived").length;
  const req = docs.filter((d) => d.req.mandatory).length;
  const wantEmp = (b.def.employmentDocs ?? []).filter((d) => d.required);
  const signed = wantEmp.filter((d) => emp.some((e) => e.docKey === d.key && empDocSigned(e.status))).length;
  const courier = courierOverall(emp.some((e) => e.hardCopy), ships);
  const applicable = assets.filter((a) => a.applicable);
  const acked = applicable.filter((a) => a.acknowledge && a.row?.acknowledgedAt);
  const ackNeeded = applicable.filter((a) => a.acknowledge);
  const waiting = applicable.filter((a) => a.row?.issuedOn && a.acknowledge && !a.row.acknowledgedAt);
  const notIssued = applicable.filter((a) => !a.row?.issuedOn);

  return (
    <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-5">
      <Panel title="Onboarding status" sub="Read from the records — not typed">
        {status === "on_hold" || status === "closed" ? <div className="mb-3"><Pill tone="warn">{ONBOARDING_LABEL[status]}</Pill></div> : null}
        <ol className="m-0 list-none p-0">
          {FLOW.map((s, i) => {
            const state = at < 0 ? "next" : i < at ? "done" : i === at ? "now" : "next";
            const when = state === "next" ? null : firstAt(s);
            return (
              <li key={s} className="flex min-h-10 gap-3">
                <span className="flex flex-col items-center">
                  <span className={cx("mt-0.5 h-3.5 w-3.5 flex-none rounded-full border-2", state === "done" ? "border-success bg-success" : state === "now" ? "border-brand bg-surface" : "border-line-strong bg-surface")} />
                  {i < FLOW.length - 1 ? <span className={cx("my-0.5 w-0.5 flex-1", state === "done" ? "bg-success" : "bg-line")} /> : null}
                </span>
                <span className="pb-2.5">
                  <span className={cx("block text-sm", state === "now" ? "font-semibold text-heading" : state === "next" ? "text-muted" : "text-heading")}>{ONBOARDING_LABEL[s]}</span>
                  <span className="block text-xs text-muted">{state === "now" ? (row?.line ?? "") : when ? fd(when) : ""}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </Panel>

      <div className="grid grid-cols-2 items-start gap-4">
        <Panel title="Compensation" sub={offer ? `Offer ${offer.status}${offer.respondedAt ? ` · ${fd(offer.respondedAt)}` : ""}` : "No offer yet"} actions={<Link href={`/hire/offers?app=${id}`} className="text-[13px]">Offers</Link>}>
          {offer ? (
            <>
              <Kv k="Grade" v={offer.gradeLabel} />
              <Kv k="Basic" v={`${rupees(offer.basicPaise)} / month${offer.proposedBasicPaise && offer.proposedBasicPaise !== offer.basicPaise ? ` · proposed ${rupees(offer.proposedBasicPaise)}` : ""}`} />
              <Kv k="Other pay" v={offer.components.length ? offer.components.map((c) => `${c.label} ${rupees(c.amountPaise)}`).join(" · ") : "None"} />
              <Kv k="Incentive" v={offer.incentiveApplicable ? (plan ? `${plan.title} · v${plan.version}` : (offer.incentive ?? "—")) : "Not applicable"} />
              <Kv k="Approval" v={offer.approvalStatus === "not_needed" ? "Not needed" : offer.approvalStatus === "approved" ? `${approver ?? "Approved"} · ${fd(offer.approvedAt)}` : offer.approvalStatus === "pending" ? "Waiting" : "Refused"} />
              <Kv k="Changes" v={changes ? `${changes} in the history` : "None"} />
            </>
          ) : (
            <div className="text-[13px] text-muted">Drafted on Offers once the gate advances them.</div>
          )}
        </Panel>

        <Panel title="Documents & verification" sub={`${okDocs} of ${docs.length} in and verified`} actions={<Pill tone={okDocs >= req ? "success" : "warn"}>{`${okDocs} / ${req} required`}</Pill>}>
          <Kv k="Soft documents" v={`${okDocs} verified or waived · ${docs.filter((d) => d.doc?.verificationStatus === "requested").length} requested`} />
          <Kv k="Background check" v={bg ? `${bg.required ? BGV_LABEL[bg.status] : "Not required"}${bg.completedOn ? ` · ${fd(bg.completedOn)}` : ""}` : "Not recorded"} />
          <Kv k="Method" v={bg?.method ?? "—"} />
        </Panel>

        <Panel title="Employment documents & courier" sub={emp.length ? `${emp.length} prepared` : "Not prepared yet"} actions={<Pill tone={wantEmp.length && signed === wantEmp.length ? "success" : "warn"}>{`${signed} / ${wantEmp.length} signed`}</Pill>}>
          {emp.map((e) => (
            <Kv key={e.id} k={e.label} v={`${EMP_DOC_LABEL[e.status as EmpDocStep] ?? e.status}${e.signedOn ? ` · ${fd(e.signedOn)}` : ""}`} />
          ))}
          <Kv k="Courier" v={courier === "not_required" ? "Not required" : courier === "completed" ? "Completed" : COURIER_STATUS_LABEL[courier as CourierStatus]} />
          {ships.map((s) => (
            <Kv key={s.id} k={s.direction === "outbound" ? "Outbound" : "Return"} v={[s.company, s.trackingNo, COURIER_STATUS_LABEL[s.status as CourierStatus]].filter(Boolean).join(" · ")} />
          ))}
        </Panel>

        <Panel title="Assets" sub={b.app.hiredAt ? `Hired ${fd(b.app.hiredAt)}` : "Issued after the account is created"} actions={<Pill tone={ackNeeded.length && acked.length === ackNeeded.length ? "success" : "warn"}>{`${acked.length} / ${ackNeeded.length} acknowledged`}</Pill>}>
          <Kv k="Acknowledged" v={acked.map((a) => a.label).join(" · ") || "—"} />
          <Kv k="Waiting" v={waiting.map((a) => a.label).join(" · ") || "—"} />
          <Kv k="Not issued" v={notIssued.map((a) => a.label).join(" · ") || "—"} />
        </Panel>

        <section className="col-span-2">
          <Panel
            title="Training"
            sub={view ? `${view.track.title} · v${view.track.version}${view.trainerName ? ` · trainer ${view.trainerName}` : ""} · started ${fd(view.enrollment.assignedAt)}` : "Enrolled when the account is created"}
            actions={view ? <Link href={`/hire/train/retakes?enrollment=${view.enrollment.id}`} className="text-[13px]">Retakes</Link> : null}
          >
            {view ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded bg-divider">
                    <div className="h-full bg-brand" style={{ width: `${view.summary.percent}%` }} />
                  </div>
                  <span className="text-[13px] font-medium text-heading tabular-nums">
                    {view.summary.passed} of {view.summary.required} · {view.summary.percent}%
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                  {view.modules.map((m) => (
                    <div key={m.moduleKey} className="rounded-[4px] border border-divider px-2.5 py-2" title={m.why}>
                      <div className="text-xs leading-4 font-medium text-heading">
                        {m.n}. {m.title}
                      </div>
                      <div className="mt-1.5">
                        <Pill tone={STATE_TONE[m.state]}>{m.state === "passed" && m.bestScore != null ? `Passed ${m.bestScore}%` : m.state === "retraining_required" && m.lastScore != null ? `Retraining · ${m.lastScore}%` : MODULE_STATE_LABEL[m.state]}</Pill>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-muted">No training enrolment yet.</div>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}
