"use client";

import * as React from "react";
import { Button, Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { ProductField } from "@/components/products/product-field";
import { RadioCard, FindingFieldRow, FindingFieldInput, SalesmanFindingsCard, initialFindingState, type FindingRowState } from "./radio-card";
import { useLeadPipeline } from "./provider";
import { FEEDBACK_FIELDS, FIRST_ORDER_QUESTIONS, VERIFICATION_FAILED_CODE } from "@/lib/lead-labels";
import {
  CONVERSION_FIELD_KEYS,
  SALESMAN_FINDING_FIELDS,
  qualificationStatus,
  type FindingField,
} from "@/lib/sales-lead-pipeline/engine";
import { STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";
import type { Lead } from "@/lib/sales-lead-pipeline/types";

/**
 * Every Sales-Manager-side dialog, as one file: each is one small form and one
 * save, and they share the open / close / save shape — ten files would be ten
 * places to keep that shape in sync rather than one.
 *
 * WHAT A DIALOG DOES NOT DO: decide. Each collects what its action takes and
 * hands it to `useLeadPipeline()`, which calls the SERVER ACTION and refreshes
 * from the database. The gate engine and the capability check are inside those
 * actions, so a dialog that offers something they refuse simply shows their
 * sentence — in the red box at the top, kept open, nothing lost.
 */

export function LeadModals() {
  const { modal, getLead, closeModal } = useLeadPipeline();
  const lead = modal.leadId ? getLead(modal.leadId) : undefined;
  if (!lead || !modal.kind) return null;

  // Keyed by lead id + kind so switching targets never leaks one lead's typed
  // draft into another's form — the React Compiler convention this codebase
  // uses instead of resetting state inside an effect.
  const key = `${modal.kind}:${lead.id}`;

  switch (modal.kind) {
    case "convert":
      return <ConvertModal key={key} lead={lead} onClose={closeModal} />;
    case "verify":
      return <VerifyModal key={key} lead={lead} onClose={closeModal} />;
    case "qualify":
      return <QualifyModal key={key} lead={lead} onClose={closeModal} />;
    case "requestSample":
      return <RequestSampleModal key={key} lead={lead} onClose={closeModal} />;
    case "approveSample":
      return <ApproveSampleModal key={key} lead={lead} onClose={closeModal} />;
    case "dispatchSample":
      return <DispatchSampleModal key={key} lead={lead} onClose={closeModal} />;
    case "sampleReview":
      return <SampleReviewModal key={key} lead={lead} onClose={closeModal} />;
    case "askOrder":
      return <AskOrderModal key={key} lead={lead} onClose={closeModal} />;
    case "confirmOrder":
      return <ConfirmOrderModal key={key} lead={lead} onClose={closeModal} />;
    case "lost":
      return <LostModal key={key} lead={lead} onClose={closeModal} />;
    case "reassign":
      return <ReassignModal key={key} lead={lead} onClose={closeModal} />;
    case "nextaction":
      return <NextActionModal key={key} lead={lead} onClose={closeModal} />;
    case "distributorTerms":
      return <DistributorTermsModal key={key} lead={lead} onClose={closeModal} />;
    case "distributorDecide":
      return <DistributorDecideModal key={key} lead={lead} onClose={closeModal} />;
    default:
      return null;
  }
}

type ModalProps = { lead: Lead; onClose: () => void };

/** The last refusal, in the dialog it happened in. The dialog stays open so nothing typed is lost. */
function FormError() {
  const { error } = useLeadPipeline();
  return error ? (
    <Callout tone="danger" className="mb-3">
      <div role="alert">{error}</div>
    </Callout>
  ) : null;
}

/** Cancel + one primary action, disabled while a save is in flight or the form is not yet answerable. */
function Footer({
  onClose,
  label,
  onSave,
  disabled,
  variant = "primary",
}: {
  onClose: () => void;
  label: string;
  onSave: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger";
}) {
  const { busy } = useLeadPipeline();
  return (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant={variant} disabled={busy || disabled} onClick={onSave}>
        {busy ? "Saving…" : label}
      </Button>
    </>
  );
}

const rupeesToPaise = (v: string): number | undefined => {
  const n = Number(v.replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};
const wholeNumber = (v: string): number | undefined => {
  const n = Number(v.replace(/[,\s]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

const CUSTOMER_TYPES = [
  { value: "retailer", label: "Retailer" },
  { value: "dealer", label: "Dealer" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "distributor", label: "Distributor" },
] as const;

const CONVERSION_FIELDS = SALESMAN_FINDING_FIELDS.filter((f) => CONVERSION_FIELD_KEYS.includes(f.key));

/* ------------------------------------------------------------- convert */

function ConvertModal({ lead, onClose }: ModalProps) {
  const { doConvert, refs } = useLeadPipeline();
  const [reason, setReason] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const [customerType, setCustomerType] = React.useState(lead.customerType ?? "");
  const [productId, setProductId] = React.useState<string | null>(lead.productId ?? null);
  const [rows, setRows] = React.useState<Record<string, FindingRowState>>(() =>
    Object.fromEntries(CONVERSION_FIELDS.map((f) => [f.key, initialFindingState(f.get(lead) ?? "")])),
  );
  const [freeEntry, setFreeEntry] = React.useState<Record<string, string>>({});

  /* What to send for ONE field: nothing where the salesman's value is confirmed
     (the gate already reads it), the new value where it was corrected or
     entered for the first time. */
  const valueFor = (f: FindingField): string | undefined => {
    const onFile = f.get(lead);
    if (!onFile) return freeEntry[f.key]?.trim() || undefined;
    const row = rows[f.key];
    return row.choice === "correct" && row.value.trim() ? row.value.trim() : undefined;
  };

  const missing: string[] = [];
  if (!reason) missing.push("a reason");
  if (!customerType) missing.push("the customer type");
  for (const f of CONVERSION_FIELDS) {
    if (f.key === "decisionMaker") continue;
    if (f.key === "product") {
      if (!productId) missing.push(f.label);
    } else if (!f.get(lead) && !valueFor(f)) missing.push(f.label);
  }

  const save = () => {
    const fields: Parameters<typeof doConvert>[0]["fields"] = {};
    if (customerType && customerType !== lead.customerType) {
      fields.customerType = customerType as (typeof CUSTOMER_TYPES)[number]["value"];
    }
    if (productId && productId !== lead.productId) fields.requiredProductId = productId;
    const litres = valueFor(CONVERSION_FIELDS.find((f) => f.key === "monthlyLitres")!);
    if (litres) fields.monthlyLitres = wholeNumber(litres);
    const potential = valueFor(CONVERSION_FIELDS.find((f) => f.key === "potentialPaise")!);
    if (potential) fields.potentialPaise = rupeesToPaise(potential);
    const competitor = valueFor(CONVERSION_FIELDS.find((f) => f.key === "competitor")!);
    if (competitor) fields.competitor = competitor;
    const contact = valueFor(CONVERSION_FIELDS.find((f) => f.key === "contact")!);
    if (contact) fields.contactPerson = contact;
    const decision = valueFor(CONVERSION_FIELDS.find((f) => f.key === "decisionMaker")!);
    if (decision) fields.decisionMaker = decision;
    void doConvert({ reasonCode: reason, fields });
  };

  const reasons = showAll ? refs.prospectReasons : refs.prospectReasons.slice(0, 5);

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <div>
          <div>Convert to Prospect</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · shows what&rsquo;s already known from the Suspect visits — only asks for what&rsquo;s genuinely still missing
          </div>
        </div>
      }
      footer={<Footer onClose={onClose} label="Convert to Prospect" onSave={save} disabled={missing.length > 0} />}
    >
      <FormError />
      <div>
        <Field label="Customer type" className="mb-3.5">
          <Select value={customerType} onChange={(e) => setCustomerType(e.target.value)}>
            <option value="">Choose…</option>
            {CUSTOMER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
        </Field>

        {CONVERSION_FIELDS.map((f) => {
          const onFile = f.get(lead);
          if (f.key === "product") {
            return (
              <div key={f.key} className="mb-3.5">
                <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{f.label}</div>
                <ProductField
                  customerId={lead.id}
                  productId={productId}
                  productName={lead.product ?? null}
                  disabled={false}
                  onPick={setProductId}
                />
              </div>
            );
          }
          return onFile ? (
            <FindingFieldRow
              key={f.key}
              label={f.label}
              onFile={onFile}
              state={rows[f.key]}
              onChange={(next) => setRows((r) => ({ ...r, [f.key]: next }))}
            />
          ) : (
            <FindingFieldInput
              key={f.key}
              label={f.label}
              value={freeEntry[f.key] ?? ""}
              onChange={(v) => setFreeEntry((r) => ({ ...r, [f.key]: v }))}
            />
          );
        })}

        <Callout tone="brand">Next action is set once converted: a Manager verification call, on your list.</Callout>

        <Field label="Conversion reason">
          <div className="mt-1.5 flex flex-col gap-1.5">
            {reasons.map((r) => (
              <RadioCard key={r.code} name="pr" label={r.label} checked={reason === r.code} onChange={() => setReason(r.code)} />
            ))}
          </div>
          {!showAll && refs.prospectReasons.length > 5 ? (
            <button type="button" onClick={() => setShowAll(true)} className="mt-1 text-[12.5px] font-medium text-brand hover:text-brand-hover">
              Show all {refs.prospectReasons.length} reasons
            </button>
          ) : null}
        </Field>
        {missing.length ? (
          <p className="mt-2 text-[12.5px] text-muted">Still needed before this can move: {missing.join(", ")}.</p>
        ) : null}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- verify */

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-body">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[15px] w-[15px] accent-[#6835FB]"
      />
      {label}
    </label>
  );
}

function YesNo({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[13px] font-medium text-ink">{label}</div>
      <div className="flex gap-2">
        <RadioCard className="flex-1" label="Yes" checked={value} onChange={() => onChange(true)} />
        <RadioCard className="flex-1" label="No" checked={!value} onChange={() => onChange(false)} />
      </div>
    </div>
  );
}

const yn = (v: boolean) => (v ? "Yes" : "No");
const concernText = (v: boolean) => (v ? "Yes — a concern was raised" : "No concern");

const RESULTS: { code: string; label: string }[] = [
  { code: "verified", label: "Verified" },
  { code: "verified_with_corrections", label: "Verified With Corrections" },
  { code: "followup_required", label: "Follow-Up Required" },
  { code: "verification_failed", label: "Verification Failed" },
];

function VerifyModal({ lead, onClose }: ModalProps) {
  const { doVerify, refs } = useLeadPipeline();
  const findingFields = SALESMAN_FINDING_FIELDS.filter((f) => f.get(lead));
  const [rows, setRows] = React.useState<Record<string, FindingRowState>>(() =>
    Object.fromEntries(findingFields.map((f) => [f.key, initialFindingState(f.get(lead) ?? "")])),
  );
  const [visited, setVisited] = React.useState(true);
  const [explained, setExplained] = React.useState(true);
  const [impression, setImpression] = React.useState("");
  const [genuineInterest, setGenuineInterest] = React.useState(true);
  const [priceConcern, setPriceConcern] = React.useState(false);
  const [qualityConcern, setQualityConcern] = React.useState(false);
  const [creditConcern, setCreditConcern] = React.useState(false);
  const [serviceConcern, setServiceConcern] = React.useState(false);
  const [competitorConcern, setCompetitorConcern] = React.useState(false);
  const [readyForTrial, setReadyForTrial] = React.useState(true);
  const [readyForCommercial, setReadyForCommercial] = React.useState(false);
  const [readyForOrder, setReadyForOrder] = React.useState(false);
  const [result, setResult] = React.useState("verified");
  const [note, setNote] = React.useState("");
  const [failure, setFailure] = React.useState("");

  const corrected = findingFields.filter((f) => rows[f.key].choice === "correct" && rows[f.key].value.trim() && f.findingId);
  const unable = findingFields.filter((f) => rows[f.key].choice === "unable");
  const needsReason = corrected.some((f) => !rows[f.key].reason.trim());

  const problem =
    needsReason
      ? "Every correction needs a reason — it is what settles the salesman's word against the shop's."
      : result === "followup_required" && !note.trim()
        ? "Say what the salesman should do about it — that sentence is what lands on his list."
        : result === "verification_failed" && (!note.trim() || !failure)
          ? "Say what the call found and what the shop actually said — that is the only record of why the lead was closed."
          : result === "verified_with_corrections" && corrected.length === 0
            ? "No field is marked Correct. Choose Verified, or correct at least one finding."
            : null;

  const doSave = () => {
    /* The shop's own answer to the three figures the call re-asks: what was
       confirmed, or what it was corrected to; nothing where it could not be
       confirmed. */
    const shopSays = (key: string): string | undefined => {
      const f = findingFields.find((x) => x.key === key);
      if (!f) return undefined;
      const row = rows[key];
      if (row.choice === "unable") return undefined;
      return row.choice === "correct" && row.value.trim() ? row.value.trim() : (f.get(lead) ?? undefined);
    };
    const answers: Record<string, string> = {
      visited: yn(visited),
      explained: yn(explained),
      genuine_interest: yn(genuineInterest),
      price_issue: concernText(priceConcern),
      quality_issue: concernText(qualityConcern),
      credit_concern: concernText(creditConcern),
      service_issue: concernText(serviceConcern),
      competitor_concern: concernText(competitorConcern),
      ready_for_trial: yn(readyForTrial),
      ready_for_commercial: yn(readyForCommercial),
      ready_for_order: yn(readyForOrder),
    };
    if (impression.trim()) answers.impression = impression.trim();
    const competitor = shopSays("competitor");
    if (competitor) answers.competitor = competitor;
    const litres = shopSays("monthlyLitres");
    if (litres) answers.monthly_requirement = litres;
    const potential = shopSays("potentialPaise");
    if (potential) answers.potential = potential;

    void doVerify({
      outcome: result === "followup_required" ? "follow_up" : result === "verification_failed" ? "not_qualified" : "verified",
      expectCorrections: result === "verified_with_corrections",
      answers,
      corrections: corrected.map((f) => ({
        field: f.findingId!,
        original: f.get(lead) ?? null,
        corrected: rows[f.key].value.trim(),
        reason: rows[f.key].reason.trim(),
      })),
      unableToVerify: unable.map((f) => f.label),
      followUpNote: note.trim() || undefined,
      failureReasonCode: result === "verification_failed" ? failure : undefined,
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={
        <div>
          <div>Manager verification</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · verify what the salesman already collected — never re-ask the customer</div>
        </div>
      }
      footer={<Footer onClose={onClose} label="Save verification" onSave={doSave} disabled={Boolean(problem)} />}
    >
      <FormError />
      <SalesmanFindingsCard lead={lead} fields={SALESMAN_FINDING_FIELDS} />

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Confirm salesman findings</div>
      {findingFields
        .filter((f) => f.findingId)
        .map((f) => (
          <FindingFieldRow
            key={f.key}
            label={f.label}
            onFile={f.get(lead) ?? ""}
            state={rows[f.key]}
            onChange={(next) => setRows((r) => ({ ...r, [f.key]: next }))}
          />
        ))}

      <div className="mt-4.5 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">A. Salesman verification</div>
      <YesNo label="Did the salesman visit?" value={visited} onChange={setVisited} />
      <YesNo label="Did the salesman explain Mahek properly?" value={explained} onChange={setExplained} />
      <Field label="Customer's impression of the salesman?" className="mb-3">
        <Input placeholder="Free notes" value={impression} onChange={(e) => setImpression(e.target.value)} />
      </Field>

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">B. Opportunity verification</div>
      <YesNo label="Is the customer genuinely interested in trying it?" value={genuineInterest} onChange={setGenuineInterest} />

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">C. Objections</div>
      <div className="mb-3 flex flex-wrap gap-3.5">
        <CheckField label="Price concern" checked={priceConcern} onChange={setPriceConcern} />
        <CheckField label="Quality concern" checked={qualityConcern} onChange={setQualityConcern} />
        <CheckField label="Credit concern" checked={creditConcern} onChange={setCreditConcern} />
        <CheckField label="Delivery / service concern" checked={serviceConcern} onChange={setServiceConcern} />
        <CheckField label="Competitor concern" checked={competitorConcern} onChange={setCompetitorConcern} />
      </div>

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">D. Readiness</div>
      <div className="mb-3 flex flex-wrap gap-3.5">
        <CheckField label="Ready for trial" checked={readyForTrial} onChange={setReadyForTrial} />
        <CheckField label="Ready for commercial discussion" checked={readyForCommercial} onChange={setReadyForCommercial} />
        <CheckField label="Ready for order discussion" checked={readyForOrder} onChange={setReadyForOrder} />
      </div>

      <div className="mt-4 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Verification result</div>
      <div className="flex flex-col gap-1.5">
        {RESULTS.map((r) => (
          <RadioCard key={r.code} name="vres" label={r.label} checked={result === r.code} onChange={() => setResult(r.code)} />
        ))}
      </div>

      {result === "followup_required" ? (
        <Field label="What should the salesman do about it?" className="mt-3">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="This lands on his task list as written" />
        </Field>
      ) : null}
      {result === "verification_failed" ? (
        <div className="mt-3 space-y-3">
          <Callout tone="danger" className="mb-0">
            This closes the lead as lost (&ldquo;{refs.lostReasons.find((r) => r.code === VERIFICATION_FAILED_CODE)?.label ?? "Verification failed"}&rdquo;). Use it when the opportunity itself is false — not when you simply could not reach the salesman; that is a follow-up.
          </Callout>
          <Field label="What did the call find?">
            <Select value={failure} onChange={(e) => setFailure(e.target.value)}>
              <option value="">Choose…</option>
              {refs.failureReasons.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="What the shop actually said">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {problem ? <p className="mt-3 text-[12.5px] text-muted">{problem}</p> : null}
    </Modal>
  );
}

/* ------------------------------------------------------- qualification */

function QualifyModal({ lead, onClose }: ModalProps) {
  const { doSaveChecklist, doReviewChecklist, busy } = useLeadPipeline();
  const status = qualificationStatus(lead);
  const tickable = lead.qualItems.filter((c) => c.tickable);
  const [ticks, setTicks] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(tickable.map((c) => [c.id, c.done])),
  );
  const [verdict, setVerdict] = React.useState<"verified" | "incomplete" | "clarification">(lead.qualReview?.verdict ?? "verified");
  const [note, setNote] = React.useState("");
  const dirty = tickable.some((c) => ticks[c.id] !== c.done);
  const reviewOpen = lead.stage === "qualification" || lead.stage === "qualified";
  const noteMissing = verdict !== "verified" && !note.trim();

  return (
    <Modal
      open
      onClose={onClose}
      width={580}
      title={
        <div>
          <div>Qualification checklist</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · every condition unlocks Sample / Trial</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {tickable.length ? (
            <Button variant="primary" disabled={busy || !dirty || !lead.caps.canWork} onClick={() => void doSaveChecklist(ticks)}>
              {busy ? "Saving…" : "Save ticks"}
            </Button>
          ) : null}
        </>
      }
    >
      <FormError />
      <Callout tone={status.allDone ? "brand" : "warn"}>
        {status.done} of {status.total} conditions met{status.allDone ? " — ready for Sample / Trial." : "."}
      </Callout>
      <div className="mt-3 flex flex-col gap-2">
        {lead.qualItems.map((c) => {
          const done = c.tickable ? ticks[c.id] : c.done;
          const box = (
            <span
              className={
                "mt-0.5 flex h-4.5 w-4.5 flex-none items-center justify-center rounded-[3px] border " +
                (done ? "border-brand bg-brand text-white" : "border-line-strong bg-surface")
              }
            >
              {done ? "✓" : ""}
            </span>
          );
          return c.tickable ? (
            <button
              key={c.id}
              type="button"
              onClick={() => setTicks((t) => ({ ...t, [c.id]: !t[c.id] }))}
              className="flex items-start gap-2.5 rounded-[4px] border border-line px-3 py-2 text-left text-sm hover:bg-canvas"
            >
              {box}
              <span className={done ? "text-body" : "text-ink"}>{c.says}</span>
            </button>
          ) : (
            <div key={c.id} className="flex items-start gap-2.5 rounded-[4px] border border-divider bg-canvas px-3 py-2 text-sm">
              {box}
              <span className={done ? "text-body" : "text-ink"}>
                {c.says}
                <span className="block text-[12px] text-muted">
                  {done ? "Answered on the record." : "Answered by a value on the record, not a tick — it is filled in from the lead's own details."}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {reviewOpen ? (
        <div className="mt-5 border-t border-divider pt-4">
          <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">Manager review</div>
          {lead.qualReview ? (
            <p className="mb-2 text-[13px] text-body">
              Last review: <b>{lead.qualReview.verdict}</b>
              {lead.qualReview.by ? ` by ${lead.qualReview.by}` : ""}
              {lead.qualReview.note ? ` — ${lead.qualReview.note}` : ""}
            </p>
          ) : (
            <p className="mb-2 text-[13px] text-muted">The salesman completes the checklist; you review it. An unreviewed checklist does not hold the lead.</p>
          )}
          {lead.caps.canVerify ? (
            <>
              <div className="flex flex-col gap-1.5">
                <RadioCard name="qrv" label="Verified — it is complete" checked={verdict === "verified"} onChange={() => setVerdict("verified")} />
                <RadioCard name="qrv" label="Incomplete — hold the lead here" checked={verdict === "incomplete"} onChange={() => setVerdict("incomplete")} />
                <RadioCard name="qrv" label="Needs clarification" checked={verdict === "clarification"} onChange={() => setVerdict("clarification")} />
              </div>
              {verdict !== "verified" ? (
                <Field label="What does he need to do?" className="mt-2">
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              ) : null}
              <div className="mt-2">
                <Button variant="secondary" size="sm" disabled={busy || noteMissing} onClick={() => void doReviewChecklist(verdict, note)}>
                  Record review
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[12.5px] text-muted">Reviewing a checklist is a sales manager&rsquo;s. Yours is not a hat that carries it.</p>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

/* --------------------------------------------------------------- samples */

function OnFileRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-divider py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{value || "Not Yet Confirmed"}</span>
    </div>
  );
}

function RequestSampleModal({ lead, onClose }: ModalProps) {
  const { doRequestSample, refs } = useLeadPipeline();
  const [productId, setProductId] = React.useState<string | null>(lead.productId ?? null);
  const [qty, setQty] = React.useState("");
  const [application, setApplication] = React.useState(lead.application ?? "");
  const [reason, setReason] = React.useState(refs.sampleReasons[0]?.code ?? "");
  const cans = wholeNumber(qty);
  const ready = Boolean(productId && cans && cans > 0 && application.trim() && reason);

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={
        <div>
          <div>Proceed to Sample / Trial</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · Product and Application carry forward — only Quantity and Reason are new</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label="Send for approval"
          disabled={!ready}
          onSave={() => void doRequestSample({ productId: productId!, quantityCans: cans!, application: application.trim(), reasonCode: reason })}
        />
      }
    >
      <FormError />
      <div className="mb-3">
        <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">Product</div>
        <ProductField customerId={lead.id} productId={productId} productName={lead.product ?? null} disabled={false} onPick={setProductId} />
      </div>
      <Field label="Application" className="mb-3">
        <Input value={application} onChange={(e) => setApplication(e.target.value)} placeholder="What they will use it on" />
      </Field>
      <Field label="Sample quantity (cans)" className="mb-3">
        <Input inputMode="numeric" placeholder="e.g. 2" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Field label="Reason for sample" className="mb-3">
        <Select value={reason} onChange={(e) => setReason(e.target.value)}>
          {refs.sampleReasons.map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </Select>
      </Field>
      <Callout tone="brand">A sample request goes to a manager for approval before the godown packs anything.</Callout>
    </Modal>
  );
}

function ApproveSampleModal({ lead, onClose }: ModalProps) {
  const { doDecideSample } = useLeadPipeline();
  const [approve, setApprove] = React.useState(true);
  const [note, setNote] = React.useState("");
  const s = lead.sample;
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <div>
          <div>Sample request</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name}</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label={approve ? "Approve sample" : "Refuse sample"}
          variant={approve ? "primary" : "danger"}
          disabled={!approve && !note.trim()}
          onSave={() => void doDecideSample(approve, note)}
        />
      }
    >
      <FormError />
      <div className="mb-3 space-y-1">
        <OnFileRow label="Product" value={lead.product} />
        <OnFileRow label="Quantity" value={s?.quantity} />
        <OnFileRow label="Application" value={lead.application} />
        <OnFileRow label="Reason" value={s?.reason} />
      </div>
      <div className="flex flex-col gap-1.5">
        <RadioCard name="sd" label="Approve — the godown can dispatch it" checked={approve} onChange={() => setApprove(true)} />
        <RadioCard name="sd" label="Refuse — the salesman has to tell the customer something" checked={!approve} onChange={() => setApprove(false)} />
      </div>
      <Field label={approve ? "Note (optional)" : "Why is it refused?"} className="mt-3">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function DispatchSampleModal({ lead, onClose }: ModalProps) {
  const { doDispatchSample } = useLeadPipeline();
  const [courier, setCourier] = React.useState("");
  const [docket, setDocket] = React.useState("");
  const [expected, setExpected] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={
        <div>
          <div>Record dispatch</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name}</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label="Mark dispatched"
          disabled={!courier.trim() || !docket.trim() || !expected}
          onSave={() => void doDispatchSample({ courierName: courier.trim(), trackingNumber: docket.trim(), expectedDeliveryDate: expected })}
        />
      }
    >
      <FormError />
      <Field label="Courier" className="mb-3">
        <Input value={courier} onChange={(e) => setCourier(e.target.value)} />
      </Field>
      <Field label="Docket / tracking number" className="mb-3">
        <Input value={docket} onChange={(e) => setDocket(e.target.value)} />
      </Field>
      <Field label="Delivery promised for" hint="What the courier promised — the delivery is watched against it.">
        <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
      </Field>
    </Modal>
  );
}

function SampleReviewModal({ lead, onClose }: ModalProps) {
  const { doSampleReview } = useLeadPipeline();
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [outcome, setOutcome] = React.useState<"approved" | "more_testing" | "rejected">("approved");
  const said = Object.values(fields).some((v) => v.trim());
  const why = [fields.otherComments, fields.priceFeedback, fields.competitorComparison].some((v) => v?.trim());
  const blocked = !said || (outcome === "rejected" && !why);

  return (
    <Modal
      open
      onClose={onClose}
      width={540}
      title={lead.name}
      footer={
        <Footer
          onClose={onClose}
          label="Save review"
          disabled={blocked}
          onSave={() =>
            void doSampleReview(
              Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim())),
              outcome,
            )
          }
        />
      }
    >
      <FormError />
      {FEEDBACK_FIELDS.map((f) => (
        <Field key={f.id} label={f.label} className="mb-2.5">
          <Input value={fields[f.id] ?? ""} onChange={(e) => setFields((s) => ({ ...s, [f.id]: e.target.value }))} />
        </Field>
      ))}
      <Field label="Trial result" className="mt-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          <RadioCard name="tr" label="Approved" checked={outcome === "approved"} onChange={() => setOutcome("approved")} />
          <RadioCard name="tr" label="More testing required" checked={outcome === "more_testing"} onChange={() => setOutcome("more_testing")} />
          <RadioCard name="tr" label="Rejected" checked={outcome === "rejected"} onChange={() => setOutcome("rejected")} />
        </div>
      </Field>
      {!said ? <p className="mt-2 text-[12.5px] text-muted">Write down at least one thing they said about it.</p> : null}
      {outcome === "rejected" && !why ? (
        <p className="mt-2 text-[12.5px] text-muted">A rejected trial has to say why — the price, the comparison, or in your own words.</p>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------- commitment and first order */

const answerId = (id: string) => FIRST_ORDER_QUESTIONS.find((q) => q.id === id)?.id ?? id;

function AskOrderModal({ lead, onClose }: ModalProps) {
  const { doAskOrder, refs } = useLeadPipeline();
  const [product, setProduct] = React.useState(lead.product ?? "");
  const [qty, setQty] = React.useState("");
  const [date, setDate] = React.useState(lead.commitment?.expectedOrderDate ?? "");
  const [cans, setCans] = React.useState(lead.commitment?.cans ? String(lead.commitment.cans) : "");
  const [value, setValue] = React.useState(lead.commitment?.valuePaise ? String(Math.round(lead.commitment.valuePaise / 100)) : "");
  const [blocker, setBlocker] = React.useState("");

  const canCount = cans ? wholeNumber(cans) : undefined;
  const paise = value ? rupeesToPaise(value) : undefined;
  const sized = Boolean(canCount || paise);

  const save = () => {
    const answers: Record<string, string> = { [answerId("product")]: product.trim() };
    if (qty.trim()) answers[answerId("quantity")] = qty.trim();
    if (date) answers[answerId("when")] = date;
    if (blocker) answers[answerId("blocker")] = blocker;
    void doAskOrder({ answers, expectedDate: date, expectedCans: canCount || undefined, expectedValuePaise: paise });
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={540}
      title={
        <div>
          <div>Record Commitment / Expected Order</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · a forecast, not a sale — confirming the actual order is a separate step</div>
        </div>
      }
      footer={<Footer onClose={onClose} label="Save Commitment" disabled={!product.trim() || !date} onSave={save} />}
    >
      <FormError />
      <Callout tone="brand">
        A day AND a size make a commitment. A day on its own is saved as an expected order — a follow-up to make, not a promise. It creates no order and moves no rung.
      </Callout>
      <Field label="Which product" className="mt-3 mb-2.5">
        <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="e.g. Nano Thinner" />
      </Field>
      <Field label="How much (their words)" className="mb-2.5">
        <Input placeholder="e.g. 450 Litres" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Field label="Expected order date" className="mb-2.5">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Field label="Expected cans" hint="A size, in cans">
          <Input inputMode="numeric" value={cans} onChange={(e) => setCans(e.target.value)} />
        </Field>
        <Field label="Expected value (₹)" hint="Or a size in rupees">
          <Input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      {!sized ? <p className="mb-3 text-[12.5px] text-muted">No size given — this will be recorded as an expected order, not a commitment.</p> : null}
      <Field label="What is stopping it today, if anything?">
        <div className="mt-1.5 flex flex-col gap-1.5">
          <RadioCard name="bl" label="Nothing" checked={blocker === ""} onChange={() => setBlocker("")} />
          {refs.orderBlockers.map((b) => (
            <RadioCard key={b.code} name="bl" label={b.label} checked={blocker === b.label} onChange={() => setBlocker(b.label)} />
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function ConfirmOrderModal({ lead, onClose }: ModalProps) {
  const { doConfirmOrder, today } = useLeadPipeline();
  const [orderedOn, setOrderedOn] = React.useState(today);
  const [value, setValue] = React.useState("");
  const [ref, setRef] = React.useState("");
  const [cans, setCans] = React.useState(lead.commitment?.cans ? String(lead.commitment.cans) : "");
  const paise = rupeesToPaise(value);
  const canCount = cans ? wholeNumber(cans) : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      width={540}
      title={
        <div>
          <div>Confirm Actual Order</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · only once the order has genuinely arrived or been confirmed</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label="Create order for approval"
          disabled={!paise || !ref.trim() || !orderedOn || !lead.caps.canCaptureOrder}
          onSave={() => void doConfirmOrder({ orderedOn, valuePaise: paise!, reference: ref.trim(), cans: canCount || undefined })}
        />
      }
    >
      <FormError />
      <Callout tone="warn">
        This creates a <b>real order</b> at &ldquo;pending approval&rdquo; and sends it to Accounts. It counts as a sale — and moves the rung — only when Accounts accept it.
        The commitment on file
        {lead.commitment
          ? ` was ${lead.commitment.cans ? `${lead.commitment.cans} cans` : "a day with no size"} by ${lead.commitment.expectedOrderDate}`
          : " is not recorded"}
        ; that was a forecast.
      </Callout>
      {!lead.caps.canCaptureOrder ? (
        <p className="mt-2 text-[12.5px] text-muted">Recording an order is not a hat you hold, so this cannot be saved from your account.</p>
      ) : null}
      <Field label="Day they placed it" className="mt-3 mb-2.5">
        <Input type="date" value={orderedOn} max={today} onChange={(e) => setOrderedOn(e.target.value)} />
      </Field>
      <Field label="Order value (₹)" className="mb-2.5">
        <Input inputMode="numeric" placeholder="e.g. 45000" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field label="Quantity (cans, optional)" className="mb-2.5">
        <Input inputMode="numeric" value={cans} onChange={(e) => setCans(e.target.value)} />
      </Field>
      <Field label="Order reference / confirmation no.">
        <Input placeholder="e.g. PO number or confirmation reference" value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------- lost / reassign / next */

function LostModal({ lead, onClose }: ModalProps) {
  const { doLost, refs } = useLeadPipeline();
  /* The verification-failed reason is FIXED and reserved for the verification
     call; offering it here would file an ordinary loss under it. */
  const options = refs.lostReasons.filter((r) => r.code !== VERIFICATION_FAILED_CODE);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <div>
          <div>{lead.stage === "suspect" || lead.stage === "new" ? "Not a Prospect" : "Mark Lost"}</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · the record and its timeline are preserved, never deleted</div>
        </div>
      }
      footer={<Footer onClose={onClose} label="Mark Lost" variant="danger" disabled={!reason} onSave={() => void doLost(reason, note)} />}
    >
      <FormError />
      <Field label="Reason" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {options.map((r) => (
            <RadioCard key={r.code} name="lr" label={r.label} checked={reason === r.code} onChange={() => setReason(r.code)} />
          ))}
        </div>
      </Field>
      <Field label="Note">
        <Textarea placeholder="Optional detail" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      </Field>
    </Modal>
  );
}

function ReassignModal({ lead, onClose }: ModalProps) {
  const { doReassign, refs } = useLeadPipeline();
  const [owner, setOwner] = React.useState(lead.ownerId ?? "");
  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={lead.name}
      footer={<Footer onClose={onClose} label="Reassign" disabled={!owner || owner === lead.ownerId} onSave={() => void doReassign(owner)} />}
    >
      <FormError />
      <Field label="New owner" className="mb-3" hint="Only people who hold the Salesman App can be given a lead.">
        <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Choose…</option>
          {refs.salesmen.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Sales manager" className="mb-1">
        <Select value={lead.managerId ?? ""} disabled>
          <option value={lead.managerId ?? ""}>{lead.manager || "Nobody holds this seat yet"}</option>
        </Select>
      </Field>
    </Modal>
  );
}

function NextActionModal({ lead, onClose }: ModalProps) {
  const { doNextAction, refs, today } = useLeadPipeline();
  const [text, setText] = React.useState(lead.nextAction ?? "");
  const [date, setDate] = React.useState(lead.nextActionDate ?? "");
  const [resp, setResp] = React.useState(lead.nextActionOwnerId ?? lead.managerId ?? refs.me.id);
  const [outcome, setOutcome] = React.useState(lead.expectedOutcome ?? "");

  /* The current owner is offered even where they hold no seat on a working lead
     any more, so the form never opens on a person who is not in its own list. */
  const people = React.useMemo(() => {
    const list = [...refs.actionOwners];
    for (const p of [refs.me, lead.nextActionOwnerId ? { id: lead.nextActionOwnerId, name: lead.nextActionResp ?? "Current owner" } : null]) {
      if (p && !list.some((x) => x.id === p.id)) list.push(p);
    }
    return list;
  }, [refs, lead.nextActionOwnerId, lead.nextActionResp]);

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="Set next action"
      footer={
        <Footer
          onClose={onClose}
          label="Save"
          disabled={!text.trim() || !date || !resp}
          onSave={() => void doNextAction({ action: text.trim(), date, ownerId: resp, outcome: outcome.trim() || undefined })}
        />
      }
    >
      <FormError />
      <Field label="Next action" className="mb-2.5">
        <Input placeholder="What happens next?" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Date" className="mb-2.5" hint={date && date < today ? "That day has already passed — the lead will show as overdue." : undefined}>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Responsible person" className="mb-2.5" hint="They are told the moment you save.">
        <Select value={resp} onChange={(e) => setResp(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Expected outcome">
        <Input value={outcome} onChange={(e) => setOutcome(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------ the distributor track */

function DistributorTermsModal({ lead, onClose }: ModalProps) {
  const { doAgreeTerms } = useLeadPipeline();
  const t = lead.approvalThresholds;
  const [discount, setDiscount] = React.useState(lead.distributorProfile?.agreedDiscountPercent != null ? String(lead.distributorProfile.agreedDiscountPercent) : "");
  const [credit, setCredit] = React.useState(lead.distributorProfile?.agreedCreditLimitPaise ? String(Math.round(lead.distributorProfile.agreedCreditLimitPaise / 100)) : "");
  const [exclusive, setExclusive] = React.useState(lead.distributorProfile?.exclusivityGranted ?? false);
  const [note, setNote] = React.useState(lead.distributorProfile?.termsNote ?? "");

  const pct = discount === "" ? undefined : wholeNumber(discount);
  const paise = credit === "" ? undefined : rupeesToPaise(credit) ?? (Number(credit) === 0 ? 0 : undefined);
  const ready = pct !== undefined && pct <= 100 && paise !== undefined;

  const escalates =
    ready && t
      ? [
          exclusive && "exclusivity",
          pct! > t.discountPercent && `a discount above ${t.discountPercent}%`,
          paise! > t.creditLimitPaise && `a credit limit above ₹${Math.round(t.creditLimitPaise / 100).toLocaleString("en-IN")}`,
        ].filter(Boolean)
      : [];

  return (
    <Modal
      open
      onClose={onClose}
      width={500}
      title={
        <div>
          <div>Agree commercial terms</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · what was agreed after management&rsquo;s first clearance</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label="Record terms"
          disabled={!ready}
          onSave={() => void doAgreeTerms({ discountPercent: pct!, creditLimitPaise: paise!, exclusivity: exclusive, note: note.trim() })}
        />
      }
    >
      <FormError />
      <Field label="Special discount (%)" className="mb-2.5">
        <Input inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} />
      </Field>
      <Field label="Credit limit (₹)" className="mb-2.5">
        <Input inputMode="numeric" value={credit} onChange={(e) => setCredit(e.target.value)} />
      </Field>
      <YesNo label="Territorial exclusivity granted?" value={exclusive} onChange={setExclusive} />
      <Field label="Note" className="mb-3">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {escalates.length ? (
        <Callout tone="warn" className="mb-0">
          This goes to management for a second signature because of {escalates.join(", ")}. The person carrying the target must not be the one allowing the discount that hits it.
        </Callout>
      ) : null}
    </Modal>
  );
}

function DistributorDecideModal({ lead, onClose }: ModalProps) {
  const { doDecideDistributor, doSendBack } = useLeadPipeline();
  const approval = lead.approval;
  const [choice, setChoice] = React.useState<"approve" | "refuse" | "sendback">("approve");
  const [note, setNote] = React.useState("");
  if (!approval) return null;

  const needsNote = choice !== "approve";
  return (
    <Modal
      open
      onClose={onClose}
      width={500}
      title={
        <div>
          <div>{approval.stepIndex === 0 ? "Recommend this appointment" : "Management's decision"}</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name}{approval.reason ? ` · ${approval.reason}` : ""}</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label={choice === "approve" ? "Approve" : choice === "refuse" ? "Refuse" : "Send back"}
          variant={choice === "refuse" ? "danger" : "primary"}
          disabled={needsNote && !note.trim()}
          onSave={() =>
            void (choice === "sendback"
              ? doSendBack(approval.id, note.trim())
              : doDecideDistributor(approval.id, choice === "approve", note))
          }
        />
      }
    >
      <FormError />
      <div className="flex flex-col gap-1.5">
        <RadioCard name="dd" label="Approve" checked={choice === "approve"} onChange={() => setChoice("approve")} />
        <RadioCard name="dd" label="Send back for correction" checked={choice === "sendback"} onChange={() => setChoice("sendback")} />
        <RadioCard name="dd" label="Refuse" checked={choice === "refuse"} onChange={() => setChoice("refuse")} />
      </div>
      <Field label={needsNote ? "What has to change, or why" : "Note (optional)"} className="mt-3">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="mt-2 text-[12.5px] text-muted">
        {STAGE_LABEL[lead.stage]} · the action re-checks who may decide this step — a sales manager may recommend an appointment and may not make it.
      </p>
    </Modal>
  );
}
