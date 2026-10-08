"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import type { OfferModel } from "@/lib/hire/blueprint-types";
import { issueOfferAction, offerResponseAction, offerTrackingAction, saveOfferAction } from "@/lib/hire/actions/onboarding";
import { Btn, Callout, Icon, Label, Locked, Panel, Pill, fd } from "../_ui/kit";
import { growthLadder, renderLetter, rupees } from "../_onboard/letter";

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
};

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

const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";

export function OfferPanel({
  applicationId,
  status,
  atOfferStage,
  offerModel,
  roleTitle,
  candidateName,
  location,
  offer,
  history,
  canOffer,
  lockedWhy,
}: {
  applicationId: string;
  status: string;
  atOfferStage: boolean;
  offerModel: OfferModel;
  roleTitle: string;
  candidateName: string;
  location: string | null;
  offer: OfferView | null;
  history: { id: string; status: string; gradeLabel: string; basicPaise: number; response: string | null; at: string }[];
  canOffer: boolean;
  lockedWhy: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const grades = offerModel.grades;
  const [grade, setGrade] = useState(offer?.grade ?? grades[0]?.key ?? "");
  const g = grades.find((x) => x.key === grade);
  const [basic, setBasic] = useState(String(Math.round((offer?.basicPaise ?? g?.basicMinPaise ?? 0) / 100)));
  const [ctc, setCtc] = useState(offer?.ctcPaise ? String(Math.round(offer.ctcPaise / 100)) : "");
  const [incentive, setIncentive] = useState(offer?.incentive ?? offerModel.incentive);
  const [joining, setJoining] = useState(offer?.joiningDate ?? "");
  const [expiry, setExpiry] = useState(offer?.expiryDate ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resp, setResp] = useState<"accepted" | "declined" | "negotiating" | "">("");
  const [gc, setGc] = useState(offer?.growthConfirmation ?? "");
  const [lc, setLc] = useState(offer?.letterConfirmation ?? "");
  const [note, setNote] = useState("");

  const editable = canOffer && (!offer || offer.status === "draft") && (status === "in_progress" || status === "on_hold") && atOfferStage;
  const basicPaise = Math.round((Number(basic) || 0) * 100);
  const inBand = g ? basicPaise >= g.basicMinPaise && basicPaise <= g.basicMaxPaise : false;
  const ladder = g ? growthLadder({ offer: offerModel }, grade, basicPaise || g.basicMinPaise) : [];
  const letter =
    offer && offer.status !== "draft" && offer.letter
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
            incentive,
            joiningDate: joining || null,
            expiryDate: expiry || null,
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

  const draftInput = () => ({ grade, basicRupees: Number(basic), ctcRupees: ctc ? Number(ctc) : null, incentive, joiningDate: joining, expiryDate: expiry });
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
  if (!atOfferStage && status === "in_progress") warn.push("This candidate has not passed the decision gate. An offer is made at Documents & offer.");
  if (offer?.negotiatedFrom && offer.status === "draft") warn.push("A revised draft after negotiation — change the figures and issue it again.");
  if (offer?.status === "accepted" && !["received", "received_by_staff"].includes(offer.courierStatus)) warn.push("Accepted. The signed letter has not come back by courier yet — the Documents & offer stage stays open until it is received.");

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
                  setBasic(String(Math.round(x.basicMinPaise / 100)));
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
          <label className="mb-3 block">
            <Label className="mb-1.5">Basic salary · ₹ a month · INR</Label>
            <span className="flex items-center gap-2">
              <span className="text-muted">₹</span>
              <input disabled={!editable} inputMode="numeric" value={basic} onChange={(e) => setBasic(e.target.value.replace(/[^\d]/g, ""))} className={cx(inputCls, "tabular-nums", errors.basic ? "border-danger" : "")} />
            </span>
            <span className={cx("mt-1 block text-xs", inBand ? "text-muted" : "text-danger")}>
              {g ? (inBand ? `Inside the ${g.key} band.` : `Outside ${g.label}’s band of ${rupees(g.basicMinPaise)}–${rupees(g.basicMaxPaise)}.`) : "Pick a grade."}
            </span>
          </label>
          <label className="mb-3 block">
            <Label className="mb-1.5">Total CTC · ₹ a year · INR · optional</Label>
            <input disabled={!editable} inputMode="numeric" value={ctc} onChange={(e) => setCtc(e.target.value.replace(/[^\d]/g, ""))} className={cx(inputCls, "tabular-nums", errors.ctc ? "border-danger" : "")} />
            {errors.ctc ? <span className="mt-1 block text-xs text-danger">{errors.ctc}</span> : null}
          </label>
          <label className="mb-3 block">
            <Label className="mb-1.5">Incentive</Label>
            <textarea disabled={!editable} value={incentive} onChange={(e) => setIncentive(e.target.value)} rows={2} className={cx(inputCls, "h-auto py-2")} />
          </label>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <label>
              <Label className="mb-1.5">Joining date</Label>
              <input type="date" disabled={!editable} value={joining} onChange={(e) => setJoining(e.target.value)} className={inputCls} />
            </label>
            <label>
              <Label className="mb-1.5">Offer open until</Label>
              <input type="date" disabled={!editable} value={expiry} onChange={(e) => setExpiry(e.target.value)} className={cx(inputCls, errors.expiryDate ? "border-danger" : "")} />
            </label>
          </div>
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
              <Btn kind="primary" disabled={pending || !inBand} onClick={saveAndIssue} title={!inBand ? "The basic must sit inside the grade’s band" : undefined}>
                Issue offer
              </Btn>
              <Btn disabled={pending} onClick={save}>
                Save draft
              </Btn>
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

          {offer && offer.status !== "draft" ? (
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
