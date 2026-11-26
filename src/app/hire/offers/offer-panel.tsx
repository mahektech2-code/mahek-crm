"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import type { OfferModel } from "@/lib/hire/blueprint-types";
import { decideApprovalAction, issueOfferAction, offerResponseAction, offerTrackingAction, saveOfferAction, withdrawOfferAction } from "@/lib/hire/actions/onboarding";
import { incentiveApplies } from "@/lib/hire/blueprint-types";
import { basicDelta, needsApproval } from "@/lib/hire/engines/onboarding";
import { ReasonButton } from "../c/[id]/client";
import { Btn, Callout, Icon, Label, Locked, Panel, Pill, fd } from "../_ui/kit";
import { growthLadder, renderLetter, rupees } from "../_onboard/letter";
import { cleanDecimal, rupeesFromPaise } from "@/lib/format";

type OfferView = {
  id: string;
  status: string;
  grade: string;
  basicPaise: number;
  ctcPaise: number | null;
  incentive: string | null;
  joiningDate: string | null;
  expiryDate: string | null;
  courierStatus: string;
  backgroundCheck: string;
  growthConfirmation: string | null;
  letterConfirmation: string | null;
  issuedAt: string | null;
  negotiatedFrom: boolean;
  letter: string | null;
  incentiveApplicable: boolean;
  incentivePlanId: string | null;
  components: { key: string; label: string; amountPaise: number; per: "month" | "year" | "one_time" }[];
  effectiveDate: string | null;
  proposedBasicPaise: number | null;
  approvalStatus: string;
  approvalNote: string | null;
  approvedByName: string | null;
  approvalRequestedAt: string | null;
  approvalRequestedByName: string | null;
  approvalRequestedByMe: boolean;
  changeReason: string | null;
};

export type PlanView = { id: string; key: string; title: string; version: number; basis: string; lines: string[] };
export type HistoryLine = { event: string; summary: string; by: string; at: string };

const COURIER: [string, string][] = [
  ["not_sent", "Not sent"],
  ["sent", "Sent"],
  ["received", "Received by candidate"],
  ["received_by_staff", "Received by staff"],
];
const BG: [string, string][] = [
  ["needed", "Needed"],
  ["not_necessary", "Not necessary"],
  ["in_progress", "In progress"],
  ["clear", "Clear"],
  ["flagged", "Flagged — a person reviews it"],
];
const CONF: [string, string][] = [
  ["", "Not asked"],
  ["agree", "Agree"],
  ["disagree", "Disagree"],
  ["may_be", "May be"],
];
const PER: [string, string][] = [
  ["month", "a month"],
  ["year", "a year"],
  ["one_time", "once"],
];

const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";

type CompRow = { key: string; label: string; amount: string; per: "month" | "year" | "one_time" };

export function OfferPanel({
  applicationId,
  status,
  atOfferStage,
  offerStageName,
  flow,
  offerModel,
  roleTitle,
  candidateName,
  location,
  offer,
  history,
  compHistory,
  plans,
  approvalAbovePercent,
  canOffer,
  lockedWhy,
  canApprove,
  approveWhy,
}: {
  applicationId: string;
  status: string;
  atOfferStage: boolean;
  offerStageName: string;
  /** The blueprint runs the onboarding PRD's flow. */
  flow: boolean;
  offerModel: OfferModel;
  roleTitle: string;
  candidateName: string;
  location: string | null;
  offer: OfferView | null;
  history: { id: string; status: string; gradeLabel: string; basicPaise: number; response: string | null; at: string }[];
  compHistory: HistoryLine[];
  plans: PlanView[];
  approvalAbovePercent: number;
  canOffer: boolean;
  lockedWhy: string;
  canApprove: boolean;
  approveWhy: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const grades = offerModel.grades;
  const [grade, setGrade] = useState(offer?.grade ?? grades[0]?.key ?? "");
  const g = grades.find((x) => x.key === grade);
  const [basic, setBasic] = useState(rupeesFromPaise(offer?.basicPaise ?? g?.basicMinPaise ?? 0));
  const [ctc, setCtc] = useState(offer?.ctcPaise ? rupeesFromPaise(offer.ctcPaise) : "");
  const [incentive, setIncentive] = useState(offer?.incentive ?? offerModel.incentive);
  const [joining, setJoining] = useState(offer?.joiningDate ?? "");
  const [expiry, setExpiry] = useState(offer?.expiryDate ?? "");
  const [effective, setEffective] = useState(offer?.effectiveDate ?? "");
  const [incOn, setIncOn] = useState(offer ? offer.incentiveApplicable : incentiveApplies(offerModel));
  const [planId, setPlanId] = useState(offer?.incentivePlanId ?? plans[0]?.id ?? "");
  const [comps, setComps] = useState<CompRow[]>(
    offer?.components.length
      ? offer.components.map((c) => ({ key: c.key, label: c.label, amount: rupeesFromPaise(c.amountPaise), per: c.per }))
      : (offerModel.components ?? []).map((c) => ({ key: c.key, label: c.label, amount: "", per: "month" as const })),
  );
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resp, setResp] = useState<"accepted" | "declined" | "negotiating" | "">("");
  const [gc, setGc] = useState(offer?.growthConfirmation ?? "");
  const [lc, setLc] = useState(offer?.letterConfirmation ?? "");
  const [note, setNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");

  /* A withdrawn offer is history: the form opens again to make a new one. */
  const editable = canOffer && (!offer || offer.status === "draft" || offer.status === "withdrawn") && (status === "in_progress" || status === "on_hold") && atOfferStage;
  const basicPaise = Math.round((Number(basic) || 0) * 100);
  const inBand = g ? basicPaise >= g.basicMinPaise && basicPaise <= g.basicMaxPaise : false;
  const ladder = g ? growthLadder({ offer: offerModel }, grade, basicPaise || g.basicMinPaise) : [];
  const plan = plans.find((p) => p.id === planId) ?? null;
  const proposed = offer && offer.status !== "withdrawn" ? offer.proposedBasicPaise : null;
  const delta = basicDelta(proposed, basicPaise);
  const needs = flow && needsApproval(proposed, basicPaise, approvalAbovePercent);
  const figuresMoved = !offer || offer.basicPaise !== basicPaise || offer.grade !== grade;
  const approvedForThis = offer?.approvalStatus === "approved" && !figuresMoved;
  const blockedByApproval = needs && !approvedForThis;
  const compPaise = comps
    .filter((c) => c.label.trim() && Number(c.amount) > 0)
    .map((c) => ({ label: c.label.trim(), amountPaise: Math.round(Number(c.amount) * 100), per: c.per }));
  const letter =
    offer && offer.status !== "draft" && offer.status !== "withdrawn" && offer.letter
      ? offer.letter
      : g
        ? renderLetter({
            def: { offer: offerModel },
            roleTitle,
            candidateName,
            location,
            grade,
            gradeLabel: g.label,
            basicPaise: basicPaise || g.basicMinPaise,
            ctcPaise: ctc ? Math.round(Number(ctc) * 100) : null,
            incentive: flow ? (incOn ? (plan?.title ?? incentive) : "Not applicable") : incentive,
            joiningDate: joining || null,
            expiryDate: expiry || null,
            incentiveApplicable: flow ? incOn : true,
            incentiveSlabs: flow && incOn && plan ? plan.lines : null,
            components: flow ? compPaise : [],
            effectiveDate: flow ? effective || null : null,
          })
        : "";

  const run = (p: Promise<{ ok: boolean; message?: string; error?: string; fieldErrors?: { field: string; message: string }[] }>, after?: () => void) =>
    start(async () => {
      const r = await p;
      if (r.ok) {
        setErrors({});
        if (r.message) toast.push(r.message);
        after?.();
        router.refresh();
      } else {
        setErrors(Object.fromEntries((r.fieldErrors ?? []).map((f) => [f.field, f.message])));
        toast.push(r.error ?? "That did not save.", "error");
      }
    });

  const draftInput = () => ({
    grade,
    basicRupees: Number(basic),
    ctcRupees: ctc ? Number(ctc) : null,
    incentive,
    joiningDate: joining,
    expiryDate: expiry,
    ...(flow
      ? {
          incentiveApplicable: incOn,
          incentivePlanId: incOn ? planId || null : null,
          components: comps.map((c) => ({ key: c.key, label: c.label, amountRupees: Number(c.amount), per: c.per })),
          effectiveDate: effective,
          changeReason: reason,
        }
      : {}),
  });
  const save = () => run(saveOfferAction(applicationId, draftInput()));
  const saveAndIssue = () =>
    start(async () => {
      const s = await saveOfferAction(applicationId, draftInput());
      if (!s.ok) {
        setErrors(Object.fromEntries((s.fieldErrors ?? []).map((f) => [f.field, f.message])));
        toast.push(s.error ?? "That did not save.", "error");
        return;
      }
      const r = await issueOfferAction(applicationId);
      toast.push(r.ok ? (r.message ?? "Issued.") : (r.error ?? "Could not issue."), r.ok ? "info" : "error");
      router.refresh();
    });

  const warn: string[] = [];
  if (!atOfferStage && status === "in_progress") warn.push(`This candidate has not passed the decision gate. An offer is made at ${offerStageName}.`);
  if (offer?.negotiatedFrom && offer.status === "draft") warn.push("A revised draft after negotiation — change the figures and issue it again.");
  if (!flow && offer?.status === "accepted" && !["received", "received_by_staff"].includes(offer.courierStatus)) warn.push("Accepted. The signed letter has not come back by courier yet — the Documents & offer stage stays open until it is received.");
  if (editable && blockedByApproval && delta)
    warn.push(`Negotiated basic is ${rupees(delta.paise)} (${delta.percent}%) above the first offer — over the ${approvalAbovePercent}% that needs approval. It cannot be issued until a Hiring Manager, Sales Head, HR Head or Admin approves it.`);
  if (offer?.approvalStatus === "refused" && !figuresMoved) warn.push(`The figure was refused${offer.approvedByName ? ` by ${offer.approvedByName}` : ""}${offer.approvalNote ? ` — “${offer.approvalNote}”` : ""}. Revise it and it asks again.`);

  const issueWhy = !inBand ? "The basic must sit inside the grade’s band" : blockedByApproval ? (offer?.approvalStatus === "refused" && !figuresMoved ? "The figure was refused — revise it" : "Waiting for approval of the negotiated figure") : undefined;

  return (
    <div className="flex flex-col gap-4">
      {warn.map((w) => (
        <Callout key={w} tone="warn">
          {w}
        </Callout>
      ))}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4">
        <Panel title="Offer" sub={offer ? `Status: ${offer.status}${offer.issuedAt ? ` · issued ${fd(offer.issuedAt)}` : ""}` : "Nothing drafted yet"} actions={offer ? <a className="text-[13px]" href={`/api/hire/offer/${offer.id}`} target="_blank" rel="noreferrer">PDF</a> : null}>
          <Label className="mb-2">Grade</Label>
          <div className="mb-4 flex flex-wrap gap-2">
            {grades.map((x) => (
              <button
                key={x.key}
                disabled={!editable}
                onClick={() => {
                  setGrade(x.key);
                  setBasic(rupeesFromPaise(x.basicMinPaise));
                }}
                className={cx(
                  "flex cursor-pointer flex-col items-start rounded-[4px] border px-3 py-2 text-left disabled:cursor-default",
                  grade === x.key ? "border-brand bg-brand-soft" : "border-line bg-surface",
                )}
              >
                <span className="text-sm font-medium text-heading">{x.label}</span>
                <span className="text-xs text-muted tabular-nums">
                  {rupees(x.basicMinPaise)}–{rupees(x.basicMaxPaise)}
                </span>
              </button>
            ))}
          </div>
          {flow && proposed ? (
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-1.5">Proposed basic · first offer</Label>
                <div className="flex h-9 items-center rounded-[4px] border border-divider bg-canvas px-2.5 text-sm text-body tabular-nums">{rupees(proposed)}</div>
              </div>
              <label>
                <Label className="mb-1.5">Negotiated basic · ₹ a month</Label>
                <input disabled={!editable} inputMode="decimal" value={basic} onChange={(e) => setBasic(cleanDecimal(e.target.value))} className={cx(inputCls, "tabular-nums", errors.basic ? "border-danger" : needs ? "border-warn" : "")} />
              </label>
            </div>
          ) : (
            <label className="mb-3 block">
              <Label className="mb-1.5">Basic salary · ₹ a month · INR</Label>
              <span className="flex items-center gap-2">
                <span className="text-muted">₹</span>
                <input disabled={!editable} inputMode="decimal" value={basic} onChange={(e) => setBasic(cleanDecimal(e.target.value))} className={cx(inputCls, "tabular-nums", errors.basic ? "border-danger" : "")} />
              </span>
            </label>
          )}
          <div className="-mt-1.5 mb-3 flex flex-wrap items-center gap-2 text-xs">
            {flow && delta && delta.paise !== 0 ? (
              <Pill tone={needs ? "warn" : "neutral"}>
                {delta.paise > 0 ? "+" : "−"}
                {rupees(Math.abs(delta.paise))} · {delta.percent > 0 ? "+" : ""}
                {delta.percent}%
              </Pill>
            ) : null}
            <span className={inBand ? "text-muted" : "text-danger"}>
              {g ? (inBand ? `Inside the ${g.key} band.` : `Outside ${g.label}’s band of ${rupees(g.basicMinPaise)}–${rupees(g.basicMaxPaise)}.`) : "Pick a grade."}
              {flow && proposed ? ` Approval needed above +${approvalAbovePercent}%.` : ""}
            </span>
          </div>
          <label className="mb-3 block">
            <Label className="mb-1.5">Total CTC · ₹ a year · INR · optional</Label>
            <input disabled={!editable} inputMode="decimal" value={ctc} onChange={(e) => setCtc(cleanDecimal(e.target.value))} className={cx(inputCls, "tabular-nums", errors.ctc ? "border-danger" : "")} />
            {errors.ctc ? <span className="mt-1 block text-xs text-danger">{errors.ctc}</span> : null}
          </label>
          {flow ? (
            <div className="mb-3 border-t border-divider pt-4">
              <div className="mb-2.5 flex items-center justify-between">
                <Label>Incentive applicable</Label>
                <span role="group" aria-label="Incentive applicable" className="inline-flex gap-0.5 rounded-[6px] border border-line p-[3px]">
                  {([true, false] as const).map((v) => (
                    <button
                      key={String(v)}
                      type="button"
                      disabled={!editable}
                      onClick={() => setIncOn(v)}
                      className={cx("h-[26px] cursor-pointer rounded-[4px] border-0 px-3.5 text-xs font-medium disabled:cursor-default", incOn === v ? "bg-heading text-white" : "bg-transparent text-body")}
                    >
                      {v ? "Yes" : "No"}
                    </button>
                  ))}
                </span>
              </div>
              {incOn ? (
                plans.length ? (
                  <>
                    <label className="block">
                      <Label className="mb-1.5">Incentive plan</Label>
                      <select disabled={!editable} value={planId} onChange={(e) => setPlanId(e.target.value)} className={cx(inputCls, errors.plan ? "border-danger" : "")}>
                        {plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title} · v{p.version}
                          </option>
                        ))}
                      </select>
                    </label>
                    {plan ? (
                      <div className="mt-2.5 overflow-hidden rounded-[4px] border border-divider">
                        {plan.lines.map((l) => {
                          const [range, pay] = l.split(": ");
                          return (
                            <div key={l} className="flex justify-between border-t border-canvas px-2.5 py-1.5 text-[13px] first:border-t-0">
                              <span className="text-heading tabular-nums">{range}</span>
                              <span className={cx("tabular-nums", pay === "Nil" ? "text-muted" : "text-heading")}>{pay}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="mt-1.5 text-xs text-muted">Read from the plan{plan?.basis ? ` · on ${plan.basis.toLowerCase()}` : ""} — edited on Incentive plans, never here.</div>
                  </>
                ) : (
                  <label className="block">
                    <Label className="mb-1.5">Incentive · in words</Label>
                    <textarea disabled={!editable} value={incentive} onChange={(e) => setIncentive(e.target.value)} rows={2} className={cx(inputCls, "h-auto py-2")} />
                    <span className="mt-1 block text-xs text-muted">This role names no published incentive plan, so the offer carries these words.</span>
                  </label>
                )
              ) : (
                <div className="text-[13px] text-muted">Incentive scheme: Not applicable. The letter says so.</div>
              )}
            </div>
          ) : (
            <label className="mb-3 block">
              <Label className="mb-1.5">Incentive</Label>
              <textarea disabled={!editable} value={incentive} onChange={(e) => setIncentive(e.target.value)} rows={2} className={cx(inputCls, "h-auto py-2")} />
            </label>
          )}
          {flow ? (
            <div className="mb-3 border-t border-divider pt-4">
              <div className="mb-2 flex items-center justify-between">
                <Label>Other agreed components</Label>
                {editable ? (
                  <Btn kind="ghost" size="sm" onClick={() => setComps((c) => [...c, { key: `c${c.length + 1}`, label: "", amount: "", per: "month" }])}>
                    + Add component
                  </Btn>
                ) : null}
              </div>
              {comps.length ? (
                <div className="grid grid-cols-[minmax(0,1fr)_120px_100px_30px] items-center gap-2">
                  {comps.map((c, i) => (
                    <div key={c.key} className="contents">
                      <input aria-label="Component" disabled={!editable} value={c.label} onChange={(e) => setComps((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} className={inputCls} placeholder="Travel allowance" />
                      <input aria-label="Amount in rupees" disabled={!editable} inputMode="decimal" value={c.amount} onChange={(e) => setComps((x) => x.map((y, j) => (j === i ? { ...y, amount: cleanDecimal(e.target.value) } : y)))} className={cx(inputCls, "tabular-nums", errors[`component:${c.key}`] ? "border-danger" : "")} placeholder="₹" />
                      <select aria-label="How often" disabled={!editable} value={c.per} onChange={(e) => setComps((x) => x.map((y, j) => (j === i ? { ...y, per: e.target.value as CompRow["per"] } : y)))} className={inputCls}>
                        {PER.map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                      <button type="button" aria-label={`Remove ${c.label || "component"}`} disabled={!editable} title={editable ? "Remove" : "The offer is issued"} onClick={() => setComps((x) => x.filter((_, j) => j !== i))} className="h-[30px] w-[30px] cursor-pointer rounded-[4px] border-0 bg-transparent text-muted hover:bg-canvas disabled:cursor-default">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[13px] text-muted">None.</div>
              )}
            </div>
          ) : null}
          <div className={cx("mb-4 grid gap-3", flow ? "grid-cols-3" : "grid-cols-2")}>
            {flow ? (
              <label>
                <Label className="mb-1.5">Salary effective</Label>
                <input type="date" disabled={!editable} value={effective} onChange={(e) => setEffective(e.target.value)} className={inputCls} />
              </label>
            ) : null}
            <label>
              <Label className="mb-1.5">Joining date</Label>
              <input type="date" disabled={!editable} value={joining} onChange={(e) => setJoining(e.target.value)} className={inputCls} />
            </label>
            <label>
              <Label className="mb-1.5">Offer open until</Label>
              <input type="date" disabled={!editable} value={expiry} onChange={(e) => setExpiry(e.target.value)} className={cx(inputCls, errors.expiryDate ? "border-danger" : "")} />
            </label>
          </div>
          {flow && editable && (offer?.negotiatedFrom || figuresMoved) && offer ? (
            <label className="mb-4 block">
              <Label className="mb-1.5">Reason for the change · kept on the record</Label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={offer.changeReason ?? "Why the figure moved"} className={cx(inputCls, "h-auto py-2", errors.reason ? "border-danger" : "")} />
            </label>
          ) : null}
          <div className="mb-4 rounded-[4px] bg-page px-3 py-2.5 text-[13px]">
            {[
              ["Basic, monthly", rupees(basicPaise)],
              ["Basic, yearly", rupees(basicPaise * 12)],
              ["CTC, yearly", ctc ? rupees(Math.round(Number(ctc) * 100)) : "—"],
              ["Currency", "INR"],
            ].map(([l, v]) => (
              <div key={l} className="flex justify-between py-0.5">
                <span className="text-muted">{l}</span>
                <span className="font-medium text-heading tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          {editable ? (
            <div className="flex flex-wrap items-center gap-2">
              {blockedByApproval ? (
                <>
                  <Btn kind="primary" disabled={pending || !inBand} onClick={save} title={!inBand ? "The basic must sit inside the grade’s band" : undefined}>
                    {offer?.approvalStatus === "pending" && !figuresMoved ? "Save draft" : "Send for approval"}
                  </Btn>
                  <Btn disabled title={issueWhy}>
                    <Icon n="lock" s={14} />
                    Issue offer
                  </Btn>
                </>
              ) : (
                <>
                  <Btn kind="primary" disabled={pending || !inBand} onClick={saveAndIssue} title={issueWhy}>
                    Issue offer
                  </Btn>
                  <Btn disabled={pending} onClick={save}>
                    Save draft
                  </Btn>
                </>
              )}
              <span className="text-xs text-muted">Issuing needs both dates. The figures cannot change once it is issued — a negotiation opens a revised offer.</span>
            </div>
          ) : !canOffer ? (
            <Locked why={lockedWhy}>Issue offer</Locked>
          ) : null}

          {offer?.status === "issued" && canOffer ? (
            <div className="mt-4 flex flex-col gap-3 rounded-[6px] border border-line bg-page p-3">
              <div className="text-sm font-medium text-heading">The candidate’s answer</div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["accepted", "Accepted"],
                    ["negotiating", "Wants to negotiate"],
                    ["declined", "Declined"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} onClick={() => setResp(k)} className={cx("h-8 cursor-pointer rounded-[4px] border px-3 text-[13px]", resp === k ? "border-brand bg-brand-soft text-brand-hover" : "border-line-strong bg-surface")}>
                    {l}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <Label className="mb-1">Growth plan</Label>
                  <select value={gc} onChange={(e) => setGc(e.target.value)} className={inputCls}>
                    {CONF.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <Label className="mb-1">Offer letter</Label>
                  <select value={lc} onChange={(e) => setLc(e.target.value)} className={inputCls}>
                    {CONF.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                <Label className="mb-1">What they said {resp && resp !== "accepted" ? "· required" : "· optional"}</Label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={cx(inputCls, "h-auto py-2", errors.note ? "border-danger" : "")} />
              </label>
              <div>
                <Btn kind={resp === "declined" ? "danger" : "primary"} size="sm" disabled={!resp || pending} onClick={() => resp && run(offerResponseAction(applicationId, { response: resp, growthConfirmation: gc, letterConfirmation: lc, note }))}>
                  Record answer
                </Btn>
              </div>
            </div>
          ) : null}

          {(offer?.status === "issued" || offer?.status === "accepted") && canOffer && (status === "in_progress" || status === "on_hold") ? (
            <div className="mt-3">
              <ReasonButton
                label="Withdraw offer"
                danger
                kind="ghost"
                title="Withdraw this offer"
                sub={`Use this when the business takes the offer back — the role closed, a check came back flagged. ${candidateName} is told. The application stays open: make a new offer, or close it as a separate decision.`}
                okLabel="Continue"
                impact={{ kind: "hire-offer-withdraw", id: applicationId }}
                onSubmit={(r, c) => withdrawOfferAction(applicationId, r, c)}
              />
            </div>
          ) : null}

          {!flow && offer && offer.status !== "draft" && offer.status !== "withdrawn" ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label>
                <Label className="mb-1">Courier</Label>
                <select disabled={!canOffer || pending} value={offer.courierStatus} onChange={(e) => run(offerTrackingAction(applicationId, { courierStatus: e.target.value }))} className={inputCls}>
                  {COURIER.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <Label className="mb-1">Background check</Label>
                <select disabled={!canOffer || pending} value={offer.backgroundCheck} onChange={(e) => run(offerTrackingAction(applicationId, { backgroundCheck: e.target.value }))} className={inputCls}>
                  {BG.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </Panel>

        <div className="flex flex-col gap-4">
          {flow && offer && offer.approvalStatus !== "not_needed" ? (
            <Panel
              title="Approval"
              sub={`Needed because the basic moved more than ${approvalAbovePercent}% from the first proposal`}
              actions={<Pill tone={offer.approvalStatus === "approved" ? "success" : offer.approvalStatus === "refused" ? "danger" : "warn"}>{offer.approvalStatus === "approved" ? "Approved" : offer.approvalStatus === "refused" ? "Refused" : "Pending"}</Pill>}
            >
              {offer.approvalStatus === "pending" ? (
                <div className="flex flex-col gap-3">
                  <div className="text-[13px] text-muted">
                    Asked{offer.approvalRequestedByName ? ` by ${offer.approvalRequestedByName}` : ""}
                    {offer.approvalRequestedAt ? ` on ${fd(offer.approvalRequestedAt)}` : ""} for <span className="font-medium text-heading tabular-nums">{rupees(offer.basicPaise)}</span> a month.
                  </div>
                  {canApprove && !offer.approvalRequestedByMe ? (
                    <>
                      <label className="block">
                        <Label className="mb-1.5">Approver’s note</Label>
                        <textarea value={approvalNote} onChange={(e) => setApprovalNote(e.target.value)} rows={2} placeholder="At least 20 characters — why this figure is right" className={cx(inputCls, "h-auto py-2", errors.note ? "border-danger" : "")} />
                      </label>
                      <div className="flex gap-2">
                        <Btn kind="primary" size="sm" disabled={pending || approvalNote.trim().length < 20} title={approvalNote.trim().length < 20 ? "Write the note first — at least 20 characters" : undefined} onClick={() => run(decideApprovalAction(applicationId, "approved", approvalNote), () => setApprovalNote(""))}>
                          Approve {rupees(offer.basicPaise)}
                        </Btn>
                        <Btn size="sm" disabled={pending || approvalNote.trim().length < 20} title={approvalNote.trim().length < 20 ? "Write the note first — at least 20 characters" : undefined} onClick={() => run(decideApprovalAction(applicationId, "refused", approvalNote), () => setApprovalNote(""))}>
                          Refuse
                        </Btn>
                      </div>
                    </>
                  ) : canApprove ? (
                    <div className="text-[13px] text-muted">You asked for this approval — somebody else gives it.</div>
                  ) : (
                    <Locked why={approveWhy} size="sm">
                      Approve
                    </Locked>
                  )}
                </div>
              ) : (
                <div className="text-[13px] text-body">
                  {offer.approvalStatus === "approved" ? "Approved" : "Refused"}
                  {offer.approvedByName ? ` by ${offer.approvedByName}` : ""}
                  {offer.approvalNote ? ` · “${offer.approvalNote}”` : ""}
                </div>
              )}
            </Panel>
          ) : null}
          {flow && compHistory.length ? (
            <Panel title="Compensation history" sub="From the audit trail · nothing is overwritten">
              <ol className="m-0 flex list-none flex-col gap-3 p-0">
                {compHistory.map((h, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className={cx("mt-1.5 h-2 w-2 flex-none rounded-full", /changed|negotiat|approval_requested/.test(h.event) ? "bg-warn" : /issued|accepted|approved/.test(h.event) ? "bg-success" : "bg-line-strong")} />
                    <span className="text-[13px] leading-[19px]">
                      <span className="text-heading">{h.summary}</span>
                      <br />
                      <span className="text-muted">
                        {h.by} · {fd(h.at)}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}
          <Panel title="Growth plan" sub="From the blueprint’s offer model · the briefing and this letter use the same definition">
            {ladder.length ? (
              <div className="flex flex-col">
                {ladder.map((r, i) => (
                  <div key={i} className="grid grid-cols-[150px_minmax(0,1fr)_auto] gap-3 border-t border-divider py-2 text-[13px] first:border-t-0">
                    <span className="font-medium text-heading">{r.grade}</span>
                    <span className="text-muted">{r.when}</span>
                    <span className="text-heading tabular-nums">{r.pay}</span>
                  </div>
                ))}
                {offerModel.growth.length === 0 ? <div className="text-[13px] text-muted">The role defines no promotion steps.</div> : null}
              </div>
            ) : (
              <div className="text-[13px] text-muted">Pick a grade.</div>
            )}
          </Panel>
          <Panel
            title="Offer letter preview · English"
            actions={
              <span className="flex items-center gap-1 text-xs text-muted">
                <Icon n="doc" s={14} />
                Template · every figure from the offer model
              </span>
            }
          >
            <pre className="m-0 font-[family-name:var(--font-evidence)] text-[15px] leading-6 whitespace-pre-wrap text-heading">{letter}</pre>
          </Panel>
          {history.length ? (
            <Panel title="Earlier offers">
              {history.map((h) => (
                <div key={h.id} className="flex items-center justify-between border-t border-divider py-1.5 text-[13px] first:border-t-0">
                  <span>
                    {h.gradeLabel} · <span className="tabular-nums">{rupees(h.basicPaise)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Pill tone="muted">{h.response ?? h.status}</Pill>
                    <span className="text-muted">{fd(h.at)}</span>
                  </span>
                </div>
              ))}
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
