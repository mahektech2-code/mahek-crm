"use client";

import * as React from "react";
import { Button, Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { RadioCard, FindingFieldRow, FindingFieldInput, SalesmanFindingsCard, initialFindingState, type FindingRowState } from "./radio-card";
import { useLeadPipeline, peopleForReassign } from "./provider";
import { LOST_REASONS, ORDER_BLOCKERS, PEOPLE_LIST, PROSPECT_REASONS, QUALIFICATION_CONDITIONS, SAMPLE_REASONS } from "@/lib/sales-lead-pipeline/reference";
import { CONVERSION_FIELD_KEYS, SALESMAN_FINDING_FIELDS, qualificationStatus } from "@/lib/sales-lead-pipeline/engine";
import type { Lead } from "@/lib/sales-lead-pipeline/types";
import type { FieldReview } from "./provider";

/**
 * Every Sales-Manager-side modal from the prototype, as one file: each is
 * small (one form, one save action) and they all share the same
 * open/close/save shape, so ten separate files would be ten places to keep
 * that shape in sync rather than one.
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
    default:
      return null;
  }
}

type ModalProps = { lead: Lead; onClose: () => void };

const CONVERSION_FIELDS = SALESMAN_FINDING_FIELDS.filter((f) => CONVERSION_FIELD_KEYS.includes(f.key));

function ConvertModal({ lead, onClose }: ModalProps) {
  const { doConvert } = useLeadPipeline();
  const [reason, setReason] = React.useState(PROSPECT_REASONS[2].code);
  const [showAll, setShowAll] = React.useState(false);
  const [rows, setRows] = React.useState<Record<string, FindingRowState>>(() =>
    Object.fromEntries(CONVERSION_FIELDS.map((f) => [f.key, initialFindingState(f.get(lead) ?? "")])),
  );
  const [freeEntry, setFreeEntry] = React.useState<Record<string, string>>({});

  const save = () => {
    const fields: FieldReview[] = CONVERSION_FIELDS.map((f) => {
      const onFile = f.get(lead);
      if (!onFile) {
        const entered = freeEntry[f.key]?.trim();
        return { key: f.key, label: f.label, value: entered || "", corrected: false, firstCapture: !!entered };
      }
      const row = rows[f.key];
      if (row.choice === "correct" && row.value.trim()) {
        return { key: f.key, label: f.label, value: row.value.trim(), corrected: true, original: onFile, reason: row.reason };
      }
      return { key: f.key, label: f.label, value: onFile, corrected: false };
    });
    doConvert(lead.id, reason, fields);
  };

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
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Convert to Prospect</Button>
        </>
      }
    >
      <div>
        {CONVERSION_FIELDS.map((f) => {
          const onFile = f.get(lead);
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

        <Callout tone="brand">Next action is set automatically once converted: a Manager verification call.</Callout>

        <Field label="Conversion reason">
          <div className="mt-1.5 flex flex-col gap-1.5">
            {(showAll ? PROSPECT_REASONS : PROSPECT_REASONS.slice(0, 5)).map((r) => (
              <RadioCard key={r.code} name="pr" label={r.label} checked={reason === r.code} onChange={() => setReason(r.code)} />
            ))}
          </div>
          {!showAll ? (
            <button type="button" onClick={() => setShowAll(true)} className="mt-1 text-[12.5px] font-medium text-brand hover:text-brand-hover">
              Show all {PROSPECT_REASONS.length} reasons
            </button>
          ) : null}
        </Field>
      </div>
    </Modal>
  );
}

function OnFileRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-divider py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{value || "Not Yet Confirmed"}</span>
    </div>
  );
}

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

function VerifyModal({ lead, onClose }: ModalProps) {
  const { doVerify } = useLeadPipeline();
  const findingFields = SALESMAN_FINDING_FIELDS.filter((f) => f.get(lead));
  const [rows, setRows] = React.useState<Record<string, FindingRowState>>(() =>
    Object.fromEntries(findingFields.map((f) => [f.key, initialFindingState(f.get(lead) ?? "")])),
  );
  const [visited, setVisited] = React.useState(true);
  const [explained, setExplained] = React.useState(true);
  const [impression, setImpression] = React.useState("");
  const [requirementGenuine, setRequirementGenuine] = React.useState(true);
  const [genuineInterest, setGenuineInterest] = React.useState(true);
  const [realBuyingIntent, setRealBuyingIntent] = React.useState(true);
  const [priceConcern, setPriceConcern] = React.useState(false);
  const [creditConcern, setCreditConcern] = React.useState(false);
  const [deliveryConcern, setDeliveryConcern] = React.useState(false);
  const [serviceConcern, setServiceConcern] = React.useState(false);
  const [competitorConcern, setCompetitorConcern] = React.useState(false);
  const [readyForTrial, setReadyForTrial] = React.useState(true);
  const [readyForCommercial, setReadyForCommercial] = React.useState(false);
  const [readyForOrder, setReadyForOrder] = React.useState(false);
  const [result, setResult] = React.useState("verified");

  const doSave = () => {
    const corrections: FieldReview[] = findingFields
      .filter((f) => rows[f.key].choice === "correct" && rows[f.key].value.trim())
      .map((f) => ({
        key: f.key,
        label: f.label,
        value: rows[f.key].value.trim(),
        corrected: true,
        original: f.get(lead) ?? "",
        reason: rows[f.key].reason || "Not specified",
      }));
    doVerify(lead.id, result, corrections, {
      visitedConfirmed: visited,
      explainedWell: explained,
      impression,
      requirementGenuine,
      genuineInterest,
      realBuyingIntent,
      priceConcern,
      creditConcern,
      deliveryConcern,
      serviceConcern,
      competitorConcern,
      readyForTrial,
      readyForCommercial,
      readyForOrder,
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
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={doSave}>Save verification</Button>
        </>
      }
    >
      <SalesmanFindingsCard lead={lead} fields={SALESMAN_FINDING_FIELDS} />

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Confirm salesman findings</div>
      {findingFields.map((f) => (
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
      <YesNo label="Is the requirement genuine?" value={requirementGenuine} onChange={setRequirementGenuine} />
      <YesNo label="Is the customer genuinely interested?" value={genuineInterest} onChange={setGenuineInterest} />
      <YesNo label="Is there real buying intent?" value={realBuyingIntent} onChange={setRealBuyingIntent} />

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">C. Objections</div>
      <div className="mb-3 flex flex-wrap gap-3.5">
        <CheckField label="Price concern" checked={priceConcern} onChange={setPriceConcern} />
        <CheckField label="Credit concern" checked={creditConcern} onChange={setCreditConcern} />
        <CheckField label="Delivery concern" checked={deliveryConcern} onChange={setDeliveryConcern} />
        <CheckField label="Service concern" checked={serviceConcern} onChange={setServiceConcern} />
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
        {Object.entries({
          verified: "Verified",
          verified_with_corrections: "Verified With Corrections",
          followup_required: "Follow-Up Required",
          verification_failed: "Verification Failed",
        }).map(([code, label]) => (
          <RadioCard key={code} name="vres" label={label} checked={result === code} onChange={() => setResult(code)} />
        ))}
      </div>
    </Modal>
  );
}

function QualifyModal({ lead, onClose }: ModalProps) {
  const { doQualifyToggle } = useLeadPipeline();
  const status = qualificationStatus(lead);
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <div>
          <div>Qualification checklist</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · all conditions unlock Sample / Trial</div>
        </div>
      }
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <Callout tone={status.allDone ? "brand" : "warn"}>
        {status.done} of {status.total} conditions marked done{status.allDone ? " — ready for Sample / Trial." : "."}
      </Callout>
      <div className="mt-3 flex flex-col gap-2">
        {QUALIFICATION_CONDITIONS.map((c) => {
          const done = !!lead.qualChecks[c.id];
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => doQualifyToggle(lead.id, c.id)}
              className="flex items-start gap-2.5 rounded-[4px] border border-line px-3 py-2 text-left text-sm hover:bg-canvas"
            >
              <span
                className={
                  "mt-0.5 flex h-4.5 w-4.5 flex-none items-center justify-center rounded-[3px] border " +
                  (done ? "border-brand bg-brand text-white" : "border-line-strong bg-surface")
                }
              >
                {done ? "✓" : ""}
              </span>
              <span className={done ? "text-body" : "text-ink"}>{c.says}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function RequestSampleModal({ lead, onClose }: ModalProps) {
  const { doRequestSample } = useLeadPipeline();
  const [qty, setQty] = React.useState("");
  const [reason, setReason] = React.useState(SAMPLE_REASONS[0]);
  return (
    <Modal
      open
      onClose={onClose}
      width={500}
      title={
        <div>
          <div>Proceed to Sample / Trial</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · Product and Application carry forward — only Quantity and Reason are new</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!qty} onClick={() => doRequestSample(lead.id, qty, reason)}>
            Send for dispatch
          </Button>
        </>
      }
    >
      <div className="mb-3 space-y-2">
        <OnFileRow label="Product" value={lead.product} />
        <OnFileRow label="Application" value={lead.application} />
      </div>
      <Field label="Sample quantity" className="mb-3">
        <Input placeholder="e.g. 5 L can" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Field label="Reason for sample" className="mb-3">
        <Select value={reason} onChange={(e) => setReason(e.target.value)}>
          {SAMPLE_REASONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </Field>
      <Callout tone="brand">All qualification conditions are satisfied — this is unblocked.</Callout>
    </Modal>
  );
}

function SampleReviewModal({ lead, onClose }: ModalProps) {
  const { doSampleReview } = useLeadPipeline();
  const [quality, setQuality] = React.useState("");
  const [performance, setPerformance] = React.useState("");
  const [drying, setDrying] = React.useState("");
  const [vsCurrent, setVsCurrent] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [outcome, setOutcome] = React.useState<"approved" | "more_testing" | "rejected">("approved");

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={lead.name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => doSampleReview(lead.id, { quality, performance, drying, vsCurrent, price }, outcome)}>
            Save review
          </Button>
        </>
      }
    >
      <Field label="Quality" className="mb-2.5">
        <Input placeholder="e.g. Matched their benchmark" value={quality} onChange={(e) => setQuality(e.target.value)} />
      </Field>
      <Field label="Performance" className="mb-2.5">
        <Input value={performance} onChange={(e) => setPerformance(e.target.value)} />
      </Field>
      <Field label="Drying" className="mb-2.5">
        <Input value={drying} onChange={(e) => setDrying(e.target.value)} />
      </Field>
      <Field label="Against what they use now" className="mb-2.5">
        <Input value={vsCurrent} onChange={(e) => setVsCurrent(e.target.value)} />
      </Field>
      <Field label="Price feedback" className="mb-3">
        <Input value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <Field label="Trial result">
        <div className="mt-1.5 flex flex-col gap-1.5">
          <RadioCard name="tr" label="Approved" checked={outcome === "approved"} onChange={() => setOutcome("approved")} />
          <RadioCard name="tr" label="More testing required" checked={outcome === "more_testing"} onChange={() => setOutcome("more_testing")} />
          <RadioCard name="tr" label="Rejected" checked={outcome === "rejected"} onChange={() => setOutcome("rejected")} />
        </div>
      </Field>
    </Modal>
  );
}

function AskOrderModal({ lead, onClose }: ModalProps) {
  const { doAskOrder } = useLeadPipeline();
  const [qty, setQty] = React.useState(lead.commitment?.quantity ?? "");
  const [date, setDate] = React.useState(lead.commitment?.expectedOrderDate ?? "2026-09-30");
  const [blocker, setBlocker] = React.useState(ORDER_BLOCKERS[4]);

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={
        <div>
          <div>Record Commitment / Expected Order</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · a forecast, not a sale — confirming the actual order is a separate step</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => doAskOrder(lead.id, qty, date, blocker)}>Save Commitment</Button>
        </>
      }
    >
      <Callout tone="brand">
        Product carries forward from Sample Review ({lead.product ?? "Not Yet Confirmed"}). This records what the customer has
        committed to — it does not open First Order by itself.
      </Callout>
      <Field label="Expected quantity" className="mt-3 mb-2.5">
        <Input placeholder="e.g. 450 Litres" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Field label="Expected order date" className="mb-3">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Blocker, if any">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {ORDER_BLOCKERS.map((b) => (
            <RadioCard key={b} name="bl" label={b} checked={blocker === b} onChange={() => setBlocker(b)} />
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function ConfirmOrderModal({ lead, onClose }: ModalProps) {
  const { doConfirmOrder } = useLeadPipeline();
  const [product, setProduct] = React.useState(lead.product ?? "");
  const [qty, setQty] = React.useState(lead.commitment?.quantity?.replace(/\D/g, "") ?? "");
  const [value, setValue] = React.useState("");
  const [ref, setRef] = React.useState("");

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={
        <div>
          <div>Confirm Actual Order</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · only once the order has genuinely arrived or been confirmed</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => doConfirmOrder(lead.id, product, qty, Number(value) || 0, ref)}>
            Confirm Actual Order → First Order
          </Button>
        </>
      }
    >
      <Callout tone="warn">
        The commitment on file was {lead.commitment ? `${lead.commitment.quantity} by ${lead.commitment.expectedOrderDate}` : "not yet recorded"} —
        that was a forecast. This form is for the order Mahek has actually received or confirmed.
      </Callout>
      <Field label="Product" className="mt-3 mb-2.5">
        <Input value={product} onChange={(e) => setProduct(e.target.value)} />
      </Field>
      <Field label="Quantity" className="mb-2.5">
        <Input placeholder="e.g. 450" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Field label="Order value (₹)" className="mb-2.5">
        <Input type="number" placeholder="e.g. 45000" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field label="Order reference / confirmation no.">
        <Input placeholder="e.g. PO number or confirmation reference" value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
    </Modal>
  );
}

function LostModal({ lead, onClose }: ModalProps) {
  const { doLost } = useLeadPipeline();
  const [reason, setReason] = React.useState(LOST_REASONS[0].code);
  const [note, setNote] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <div>
          <div>Mark Lost</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · the record and its timeline are preserved, never deleted</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => doLost(lead.id, reason, note)}>Mark Lost</Button>
        </>
      }
    >
      <Field label="Reason" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {LOST_REASONS.map((r) => (
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
  const { doReassign } = useLeadPipeline();
  const salesmen = peopleForReassign();
  const [owner, setOwner] = React.useState(lead.owner);
  const [reason, setReason] = React.useState("");
  const manager = PEOPLE_LIST.find((p) => p.id === lead.manager);
  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={lead.name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => doReassign(lead.id, owner, reason)}>Reassign</Button>
        </>
      }
    >
      <Field label="New owner" className="mb-3">
        <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
          {salesmen.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Sales manager" className="mb-3">
        <Select value={manager?.id} disabled>
          <option value={manager?.id}>{manager?.name}</option>
        </Select>
      </Field>
      <Field label="Reason">
        <Input placeholder="e.g. Territory realignment" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

function NextActionModal({ lead, onClose }: ModalProps) {
  const { doNextAction } = useLeadPipeline();
  const [text, setText] = React.useState(lead.nextAction ?? "");
  const [date, setDate] = React.useState(lead.nextActionDate ?? "2026-09-24");
  const [resp, setResp] = React.useState(lead.nextActionResp ?? lead.manager);
  const [outcome, setOutcome] = React.useState(lead.expectedOutcome ?? "");

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="Set next action"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => doNextAction(lead.id, text, date, resp, outcome)}>Save</Button>
        </>
      }
    >
      <Field label="Next action" className="mb-2.5">
        <Input placeholder="What happens next?" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Date" className="mb-2.5">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Responsible person" className="mb-2.5">
        <Select value={resp} onChange={(e) => setResp(e.target.value)}>
          {PEOPLE_LIST.map((p) => (
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
