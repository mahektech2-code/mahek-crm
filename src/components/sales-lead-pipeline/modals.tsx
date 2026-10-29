"use client";

import * as React from "react";
import { Button, Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { ProductField } from "@/components/products/product-field";
import { RadioCard, FindingFieldRow, FindingFieldInput, SalesmanFindingsCard, initialFindingState, type FindingRowState } from "./radio-card";
import { useLeadPipeline } from "./provider";
import { VerifyAssistant } from "./verify-assistant";
import { ConvertAssistant } from "./convert-assistant";
import type { ConvertApplyContext, ConvertItem } from "@/lib/engines/convert-intel-decide";
import type { ConvertFieldKey } from "@/lib/convert-intel-schema";
import type { ApplyContext } from "@/lib/engines/verify-intel-decide";
import type { VerifyAnswerKey, VerifyFindingKey } from "@/lib/verify-intel-schema";

/**
 * A dialog's width: the Sales Dashboard's own, or the prototype's where the
 * CRM's mounting draws it. The dialogs are the same; only the box differs.
 */
function useProtoWidth(sales: number, crm: number): number {
  return useLeadPipeline().workspace === "crm" ? crm : sales;
}
import {
  ACTIVE_FEEDBACK_FIELDS,
  FIRST_ORDER_QUESTIONS,
  SAMPLE_SENDING_MODES,
  VERIFICATION_FAILED_CODE,
  trialReviewProblem,
} from "@/lib/lead-labels";
import {
  CONVERSION_FIELD_KEYS,
  SALESMAN_FINDING_FIELDS,
  VERIFY_FINDING_FIELDS,
  qualificationStatus,
  type FindingField,
} from "@/lib/sales-lead-pipeline/engine";
import { STAGE_LABEL } from "@/lib/sales-lead-pipeline/reference";
import type { Lead } from "@/lib/sales-lead-pipeline/types";
import { buyerNeedsCheck } from "@/lib/verification-buyer";
import { isActiveFinding } from "@/lib/verification-form";
import { cleanDecimal, cleanWhole, parseDecimal, rupeesFromPaise } from "@/lib/format";
import { money as inrText } from "@/lib/format";

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
    case "reopen":
      return <ReopenModal key={key} lead={lead} onClose={closeModal} />;
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
/** Litres and percentages take a fraction; cans and days do not. */
const decimalNumber = (v: string): number | undefined => {
  const n = parseDecimal(v);
  return n !== null && n >= 0 ? n : undefined;
};

const CUSTOMER_TYPES = [
  { value: "retailer", label: "Retailer" },
  { value: "dealer", label: "Dealer" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "private_limited_user", label: "Private Limited(User)" },
  { value: "distributor", label: "Distributor" },
] as const;

const CONVERSION_FIELDS = SALESMAN_FINDING_FIELDS.filter((f) => CONVERSION_FIELD_KEYS.includes(f.key));

/* ------------------------------------------------------------- convert */

function ConvertModal({ lead, onClose }: ModalProps) {
  const { doConvert, refs, workspace } = useLeadPipeline();
  const [reason, setReason] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  /* REQUIRED at Prospect. Where the lead already has one it is shown, not asked. */
  const [gstin, setGstin] = React.useState("");
  const [customerType, setCustomerType] = React.useState(lead.customerType ?? "");
  const [productId, setProductId] = React.useState<string | null>(lead.productId ?? null);
  const [rows, setRows] = React.useState<Record<string, FindingRowState>>(() =>
    Object.fromEntries(CONVERSION_FIELDS.map((f) => [f.key, initialFindingState(f.get(lead) ?? "")])),
  );
  const [freeEntry, setFreeEntry] = React.useState<Record<string, string>>({});

  /* WHICH FACTS THE MANAGER HAS CHANGED BY HAND, or that voice has already
     applied. The voice assistant may fill a fact nobody has touched and never one
     somebody has, and `convertProspect` keeps no record of what a Convert
     overwrites — so a fact the manager changed is theirs for the rest of the
     dialog, whatever it now holds. */
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));
  /* The picker shows the name it was MOUNTED with, so a product applied from
     outside has to remount it under the new name. */
  const [voiceProductName, setVoiceProductName] = React.useState<string | null>(null);

  /* What the assistant is allowed to do to this dialog: put a value into a fact
     the lead has nothing for (applyConvertFill), or switch a fact the lead already
     has to Correct with the customer's value (markConvertCorrected). Neither
     writes anything; neither chooses the conversion reason or any
     Confirm / Unable To Verify. */
  const applyConvertFill = (item: ConvertItem) => {
    if (item.applyValue === null) return;
    const key: ConvertFieldKey = item.key;
    if (key === "customerType") setCustomerType(item.applyValue);
    else if (key === "product") {
      setProductId(item.applyValue);
      setVoiceProductName(item.productName ?? null);
    } else setFreeEntry((r) => ({ ...r, [key]: item.applyValue ?? "" }));
    touch(key);
  };
  const markConvertCorrected = (item: ConvertItem) => {
    if (item.applyValue === null) return;
    const key: ConvertFieldKey = item.key;
    if (key === "customerType") setCustomerType(item.applyValue);
    else if (key === "product") {
      setProductId(item.applyValue);
      setVoiceProductName(item.productName ?? null);
    } else setRows((r) => (r[key] ? { ...r, [key]: { ...r[key], choice: "correct", value: item.applyValue ?? "" } } : r));
    touch(key);
  };
  const convertVoiceContext: ConvertApplyContext = {
    touched,
    customerType,
    productId,
    rows: rows as ConvertApplyContext["rows"],
    freeEntry: freeEntry as ConvertApplyContext["freeEntry"],
  };

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
  /* The reason and the contact person are OPTIONAL: asked, never required. */
  if (!customerType) missing.push("the customer type");
  if (!lead.gstin && !gstin.trim()) missing.push("the GST number");
  for (const f of CONVERSION_FIELDS) {
    /* Neither is needed for a Prospect: the decision maker is asked if known,
       and the rupee estimate is no longer a question — the monthly requirement
       in litres is the one monthly figure the gate wants. Both stay on the card
       to confirm or correct where somebody recorded them. */
    if (f.key === "decisionMaker" || f.key === "potentialPaise" || f.key === "contact") continue;
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
    if (litres) fields.monthlyLitres = decimalNumber(litres);
    const potential = valueFor(CONVERSION_FIELDS.find((f) => f.key === "potentialPaise")!);
    if (potential) fields.potentialPaise = rupeesToPaise(potential);
    const competitor = valueFor(CONVERSION_FIELDS.find((f) => f.key === "competitor")!);
    if (competitor) fields.competitor = competitor;
    const contact = valueFor(CONVERSION_FIELDS.find((f) => f.key === "contact")!);
    if (contact) fields.contactPerson = contact;
    const decision = valueFor(CONVERSION_FIELDS.find((f) => f.key === "decisionMaker")!);
    if (decision) fields.decisionMaker = decision;
    /* Written only where the lead had none — an existing number is never replaced. */
    if (!lead.gstin && gstin.trim()) fields.gstin = gstin.trim();
    void doConvert({ reasonCode: reason || undefined, fields });
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
      {/* The assistant belongs to the CRM Sales Manager workspace only. This
          dialog is shared with the Sales Dashboard's pipeline, which does not
          draw it — and the action refuses a request from there as well. */}
      {workspace === "crm" ? (
        <ConvertAssistant
          customerId={lead.id}
          context={convertVoiceContext}
          onFile={{ customerType: lead.customerType ?? null, productId: lead.productId ?? null }}
          onFill={applyConvertFill}
          onCorrect={markConvertCorrected}
        />
      ) : null}
      <div>
        <Field label="Customer type" className="mb-3.5">
          <Select
            value={customerType}
            onChange={(e) => {
              setCustomerType(e.target.value);
              touch("customerType");
            }}
          >
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
                  key={voiceProductName ?? "lead"}
                  customerId={lead.id}
                  productId={productId}
                  productName={voiceProductName ?? lead.product ?? null}
                  disabled={false}
                  onPick={(id) => {
                    setProductId(id);
                    touch("product");
                  }}
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
              onChange={(next) => {
                setRows((r) => ({ ...r, [f.key]: next }));
                touch(f.key);
              }}
            />
          ) : (
            <FindingFieldInput
              key={f.key}
              label={f.label}
              value={freeEntry[f.key] ?? ""}
              onChange={(v) => {
                setFreeEntry((r) => ({ ...r, [f.key]: v }));
                touch(f.key);
              }}
            />
          );
        })}

        <Field label="GST number" className="mb-3.5">
          {lead.gstin ? (
            <div className="mt-1 text-[13px] text-ink">{lead.gstin} <span className="text-muted">· on the record</span></div>
          ) : (
            <Input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="Needed for a Prospect" maxLength={20} />
          )}
        </Field>

        <Callout tone="brand">Next action is set once converted: a Manager verification call, on your list.</Callout>

        <Field label="Conversion reason (optional)">
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

function CheckField({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 text-sm text-body${disabled ? " opacity-60" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[15px] w-[15px] accent-[#6835FB] disabled:cursor-not-allowed"
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

const RESULTS: { code: string; label: string }[] = [
  { code: "verified", label: "Verified" },
  { code: "verified_with_corrections", label: "Verified With Corrections" },
  { code: "followup_required", label: "Follow-Up Required" },
  { code: "verification_failed", label: "Verification Failed" },
];

function VerifyModal({ lead, onClose }: ModalProps) {
  const { doVerify, refs, workspace } = useLeadPipeline();
  /* The SAME findings and questions as the Verification popup: the shared active
     list decides, the buyer is a finding only where it is a different person
     (compared on the stored values), and what the shop uses now is asked of a
     successful verification. */
  const activeFields = VERIFY_FINDING_FIELDS.filter(
    (f) =>
      isActiveFinding(f.findingId ?? "") &&
      (f.key !== "buyer" || buyerNeedsCheck(lead.buyer, lead.decisionMaker)),
  );
  const findingFields = activeFields.filter((f) => f.get(lead));
  const [rows, setRows] = React.useState<Record<string, FindingRowState>>(() =>
    Object.fromEntries(findingFields.map((f) => [f.key, initialFindingState(f.get(lead) ?? "")])),
  );
  const [currentProduct, setCurrentProduct] = React.useState("");
  const [readyForTrial, setReadyForTrial] = React.useState(false);
  const [readyForCommercial, setReadyForCommercial] = React.useState(false);
  const [readyForOrder, setReadyForOrder] = React.useState(false);
  const [result, setResult] = React.useState("verified");
  const [note, setNote] = React.useState("");
  const [failure, setFailure] = React.useState("");

  /* WHICH ANSWERS THE MANAGER HAS ANSWERED. The dialog starts with the salesman
     having visited and explained and the shop interested, so a Yes sitting in a
     box is a default and not an answer until somebody touches it. The voice
     assistant may set an untouched answer and never a touched one. */
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setTouched((s) => (s.has(key) ? s : new Set(s).add(key)));
  const answer = (key: string, set: (v: boolean) => void) => (v: boolean) => {
    set(v);
    touch(key);
  };

  /* What the assistant is allowed to do to this dialog: set an answer, or switch
     a finding row to Correct with the shop's value. The reason on that row, the
     result, the failure reason and every note are written by the manager. */
  const applyVoiceAnswer = (key: VerifyAnswerKey, value: boolean | string) => {
    /* Only the readiness answers are still asked; a suggestion for any other
       slot is ignored rather than written into a question nobody sees. */
    switch (key) {
      /* One readiness answer at a time: a suggestion that would make a second
         one positive is left for the manager to choose between. */
      case "readyForTrial":
        if (value === true && (readyForCommercial || readyForOrder)) return;
        setReadyForTrial(value === true);
        break;
      case "readyForCommercial":
        if (value === true && (readyForTrial || readyForOrder)) return;
        setReadyForCommercial(value === true);
        break;
      case "readyForOrder":
        if (value === true && (readyForTrial || readyForCommercial)) return;
        setReadyForOrder(value === true);
        break;
      default: return;
    }
    touch(key);
  };
  const markVoiceCorrected = (key: VerifyFindingKey, value: string) =>
    setRows((r) => (r[key] ? { ...r, [key]: { ...r[key], choice: "correct", value } } : r));
  const voiceContext: ApplyContext = {
    touched,
    current: { readyForTrial, readyForCommercial, readyForOrder },
    rows: rows as ApplyContext["rows"],
  };

  const corrected = findingFields.filter((f) => rows[f.key].choice === "correct" && rows[f.key].value.trim() && f.findingId);
  const unable = findingFields.filter((f) => rows[f.key].choice === "unable");
  const needsReason = corrected.some((f) => !rows[f.key].reason.trim());

  const successful = result === "verified" || result === "verified_with_corrections";
  const problem =
    needsReason
      ? "Every correction needs a reason — it is what settles the salesman's word against the shop's."
      : successful && !currentProduct.trim()
        ? "Say what the shop is using now — a verification cannot be recorded without it."
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
    /* Only the readiness answers the manager gave: an untouched box is not an
       answer, and a Yes is what asks for a stage move. */
    const answers: Record<string, string> = {};
    if (touched.has("readyForTrial")) answers.ready_for_trial = yn(readyForTrial);
    if (touched.has("readyForCommercial")) answers.ready_for_commercial = yn(readyForCommercial);
    if (touched.has("readyForOrder")) answers.ready_for_order = yn(readyForOrder);
    if (currentProduct.trim()) answers.current_product = currentProduct.trim();
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
      {/* The assistant belongs to the CRM Sales Manager workspace only. This
          dialog is shared with the Sales Dashboard's pipeline, which does not
          draw it — and the action refuses a request from there as well. */}
      {workspace === "crm" ? (
        <VerifyAssistant
          customerId={lead.id}
          context={voiceContext}
          onAnswer={applyVoiceAnswer}
          onCorrect={markVoiceCorrected}
        />
      ) : null}
      <SalesmanFindingsCard lead={lead} fields={activeFields} />

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

      <div className="mt-4.5 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">About the business</div>
      <Field label={`What are you using now?${successful ? " — required" : ""}`} className="mb-3">
        <Input placeholder="The product or brand the shop uses today" value={currentProduct} onChange={(e) => setCurrentProduct(e.target.value)} />
      </Field>

      <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">What they are ready for</div>
      <div className="mb-3 flex flex-wrap gap-3.5">
        <CheckField label="Ready for trial" checked={readyForTrial} disabled={readyForCommercial || readyForOrder} onChange={answer("readyForTrial", setReadyForTrial)} />
        <CheckField label="Ready for commercial discussion" checked={readyForCommercial} disabled={readyForTrial || readyForOrder} onChange={answer("readyForCommercial", setReadyForCommercial)} />
        <CheckField label="Ready for order discussion" checked={readyForOrder} disabled={readyForTrial || readyForCommercial} onChange={answer("readyForOrder", setReadyForOrder)} />
      </div>

      <div className="mt-4 mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Verification result</div>
      <div className="flex flex-col gap-1.5">
        {RESULTS.map((r) => (
          <RadioCard key={r.code} name="vres" label={r.label} checked={result === r.code} onChange={() => setResult(r.code)} />
        ))}
      </div>

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
        </div>
      ) : null}
      {/* Remarks / Next Action: the call's note — optional for Verified, required for
          a follow-up (it becomes the salesman's task) and for a failed verification
          (the only record of why the lead was closed). Not a numbered question. */}
      <Field
        label={`Remarks / Next Action${result === "followup_required" || result === "verification_failed" ? " — required" : " — optional"}`}
        className="mt-3"
      >
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            result === "followup_required"
              ? "What should the salesman do? This lands on his task list as written"
              : result === "verification_failed"
                ? "What the shop actually said"
                : undefined
          }
        />
      </Field>
      {problem ? <p className="mt-3 text-[12.5px] text-muted">{problem}</p> : null}
    </Modal>
  );
}

/* ------------------------------------------------------- qualification */

function QualifyModal({ lead, onClose }: ModalProps) {
  const width = useProtoWidth(620, 580);
  const { doReviewChecklist, doValidateGst, busy } = useLeadPipeline();
  const status = qualificationStatus(lead);
  const [verdict, setVerdict] = React.useState<"verified" | "incomplete" | "clarification">(lead.qualReview?.verdict ?? "verified");
  const [note, setNote] = React.useState("");
  const [gstNote, setGstNote] = React.useState("");
  const [refusing, setRefusing] = React.useState(false);
  const reviewOpen = lead.stage === "qualification" || lead.stage === "qualified";
  const noteMissing = verdict !== "verified" && !note.trim();
  const gst = lead.gstState ?? "none";
  /* A "verified" verdict needs every answer in AND the GST number validated; the
     server refuses it otherwise and names what is missing, so the button only
     asks the screen to say the same thing first. */
  const gstOk = gst === "valid";
  const verifyBlocked = verdict === "verified" && (!status.allDone || !gstOk);

  return (
    <Modal
      open
      onClose={onClose}
      width={width}
      title={
        <div>
          <div>Qualification review</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name} · what the Salesman collected, for you to read and approve</div>
        </div>
      }
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <FormError />
      <Callout tone={status.allDone ? "brand" : "warn"}>
        {status.done} of {status.total} answered{status.allDone ? " — ready for your decision." : "."}
      </Callout>
      <div className="mt-3 flex flex-col gap-2">
        {lead.qualItems.map((c) => (
          <div key={c.id} className="flex items-start gap-2.5 rounded-[4px] border border-divider bg-canvas px-3 py-2 text-sm">
            <span
              className={
                "mt-0.5 flex h-4.5 w-4.5 flex-none items-center justify-center rounded-[3px] border " +
                (c.done ? "border-brand bg-brand text-white" : "border-line-strong bg-surface")
              }
            >
              {c.done ? "✓" : ""}
            </span>
            <span className={c.done ? "text-body" : "text-ink"}>
              {c.says}
              {c.answer ? <span className="block text-[13px] font-medium text-ink">{c.answer}</span> : null}
              {!c.done && !c.answer ? <span className="block text-[12px] text-muted">Not answered yet.</span> : null}
            </span>
          </div>
        ))}
      </div>

      {reviewOpen ? (
        <div className="mt-5 border-t border-divider pt-4">
          <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">GST number</div>
          <p className="mb-2 text-[13px] text-body">
            {gst === "none"
              ? "The Salesman has not entered a GST number yet."
              : gst === "valid"
                ? `${lead.gstin} — you have validated it.`
                : gst === "refused"
                  ? `${lead.gstin} — you refused it. The Salesman has been told what to correct.`
                  : `${lead.gstin} — entered by the Salesman. Check it, then validate or refuse it. You cannot verify the Qualification until it is validated.`}
          </p>
          {lead.caps.gstRefusal === null && gst !== "none" ? (
            refusing ? (
              <div className="space-y-2">
                <Field label="What is wrong with it?">
                  <Textarea rows={2} value={gstNote} onChange={(e) => setGstNote(e.target.value)} />
                </Field>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={busy || !gstNote.trim()} onClick={() => void doValidateGst(false, gstNote).then((ok) => ok && setRefusing(false))}>
                    Refuse the number
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setRefusing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button variant="primary" size="sm" disabled={busy || gst === "valid"} onClick={() => void doValidateGst(true, "")}>
                  {gst === "valid" ? "Validated" : "Validate the number"}
                </Button>
                <Button variant="secondary" size="sm" disabled={busy || gst === "refused"} onClick={() => setRefusing(true)}>
                  Refuse it
                </Button>
              </div>
            )
          ) : gst !== "none" && lead.caps.gstRefusal ? (
            <p className="text-[12.5px] text-muted">{lead.caps.gstRefusal}</p>
          ) : null}

          <div className="mb-1 mt-5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Your review</div>
          {lead.qualReview ? (
            <p className="mb-2 text-[13px] text-body">
              Last review: <b>{lead.qualReview.verdict}</b>
              {lead.qualReview.by ? ` by ${lead.qualReview.by}` : ""}
              {lead.qualReview.note ? ` — ${lead.qualReview.note}` : ""}
            </p>
          ) : (
            <p className="mb-2 text-[13px] text-muted">The Salesman fills in the answers and you review them. No sample goes out until you verify them.</p>
          )}
          {lead.caps.reviewRefusal === null ? (
            <>
              <div className="flex flex-col gap-1.5">
                <RadioCard name="qrv" label="Verified — complete, GST validated, ready for a sample" checked={verdict === "verified"} onChange={() => setVerdict("verified")} />
                <RadioCard name="qrv" label="Incomplete — something is missing or too thin" checked={verdict === "incomplete"} onChange={() => setVerdict("incomplete")} />
                <RadioCard name="qrv" label="Needs clarification — it is there but I need it explained" checked={verdict === "clarification"} onChange={() => setVerdict("clarification")} />
              </div>
              {verdict !== "verified" ? (
                <Field label="What does the Salesman need to do?" className="mt-2">
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              ) : verifyBlocked ? (
                <p className="mt-2 text-[12.5px] text-muted">
                  {!status.allDone ? "Every answer has to be in before you can verify. " : ""}
                  {!gstOk ? "The GST number has to be validated first." : ""}
                </p>
              ) : null}
              <div className="mt-2">
                <Button variant="secondary" size="sm" disabled={busy || noteMissing || verifyBlocked} onClick={() => void doReviewChecklist(verdict, note)}>
                  Record review
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[12.5px] text-muted">{lead.caps.reviewRefusal}</p>
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

function StepBadge({ stage, name }: { stage: string; name: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-[12px] font-medium tracking-[0.04em] text-muted uppercase">
      <span className="rounded-full bg-brand-soft px-2 py-0.5 text-brand-ink">{stage}</span>
      <span>{name}</span>
    </div>
  );
}

/**
 * SAMPLE / TRIAL, STEP 1 OF 2 — SAMPLE REQUEST.
 *
 * Four questions, in this order: Sample requested?, Product, Sending date and
 * Sending mode. Answering No starts nothing and records the decision on the
 * lead's history; Yes needs the other three. The date is the day it is PLANNED
 * to go and the mode is Courier or Hand Delivery: neither approves, dispatches
 * or receives anything, and the manager's approval still stands between this
 * and the godown. Quantity, application and reason are not asked any more.
 */
function RequestSampleModal({ lead, onClose }: ModalProps) {
  const { doRequestSample, doDeclineSample } = useLeadPipeline();
  const [requested, setRequested] = React.useState<"yes" | "no" | null>(null);
  const [productId, setProductId] = React.useState<string | null>(lead.productId ?? null);
  const [date, setDate] = React.useState("");
  const [mode, setMode] = React.useState<"courier" | "hand_delivery" | null>(null);
  const ready = requested === "no" || (requested === "yes" && Boolean(productId && date && mode));

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={
        <div>
          <div>Sample / Trial</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name}</div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label={requested === "no" ? "Record: no sample" : "Send for approval"}
          disabled={!ready}
          onSave={() =>
            void (requested === "no"
              ? doDeclineSample()
              : doRequestSample({ productId: productId!, sendingDate: date, sendingMode: mode! }))
          }
        />
      }
    >
      <FormError />
      <StepBadge stage="Sample / Trial" name="Sample Request" />
      <Field label="Sample requested?" className="mb-3">
        <div className="mt-1.5 flex gap-2">
          <RadioCard name="sr" label="Yes" checked={requested === "yes"} onChange={() => setRequested("yes")} />
          <RadioCard name="sr" label="No" checked={requested === "no"} onChange={() => setRequested("no")} />
        </div>
      </Field>
      {requested === "no" ? (
        <Callout tone="brand">
          Nothing is started. The answer is written on this lead&apos;s history, and Step 2 stays locked because there is no
          sample for it to be about. A sample can be asked for later.
        </Callout>
      ) : null}
      {requested === "yes" ? (
        <>
          <div className="mb-3">
            <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">Product name</div>
            <ProductField customerId={lead.id} productId={productId} productName={lead.product ?? null} disabled={false} onPick={setProductId} />
          </div>
          <Field label="Sample sending date" hint="The day it is planned to go. This does not mark it as sent." className="mb-3">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Sending mode" className="mb-3">
            <div className="mt-1.5 flex gap-2">
              {SAMPLE_SENDING_MODES.map((m) => (
                <RadioCard
                  key={m.code}
                  name="sm"
                  label={m.label}
                  checked={mode === m.code}
                  onChange={() => setMode(m.code as "courier" | "hand_delivery")}
                />
              ))}
            </div>
          </Field>
          <Callout tone="brand">A sample request goes to a manager for approval before the godown packs anything.</Callout>
        </>
      ) : null}
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
  const [expected, setExpected] = React.useState(lead.sample?.plannedSendDate ?? "");
  /* Step 1 recorded how it is to go. A sample carried by hand leaves no docket. */
  const byHand = lead.sample?.sendingMode === "hand_delivery";
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
          disabled={(!byHand && (!courier.trim() || !docket.trim())) || !expected}
          onSave={() => void doDispatchSample({ courierName: courier.trim(), trackingNumber: docket.trim(), expectedDeliveryDate: expected })}
        />
      }
    >
      <FormError />
      {byHand ? (
        <Callout tone="brand">Hand delivery: there is no courier or docket to record, only the day it is due.</Callout>
      ) : (
        <>
          <Field label="Courier" className="mb-3">
            <Input value={courier} onChange={(e) => setCourier(e.target.value)} />
          </Field>
          <Field label="Docket / tracking number" className="mb-3">
            <Input value={docket} onChange={(e) => setDocket(e.target.value)} />
          </Field>
        </>
      )}
      <Field label={byHand ? "Delivery due on" : "Delivery promised for"} hint={byHand ? "The delivery is watched against it." : "What the courier promised — the delivery is watched against it."}>
        <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * SAMPLE / TRIAL, STEP 2 OF 2 — SAMPLE RECEIVED & REVIEW.
 *
 * The first question is whether the sample has been received. No keeps the
 * review locked and marks nothing; Yes confirms receipt through the existing
 * action (which refuses anything not yet approved and dispatched) and only then
 * opens the review: Quality, Vs. the Brand, Anything Else and the verdict. The
 * lead does not move rung here — Negotiation is its own explicit move.
 */
function SampleReviewModal({ lead, onClose }: ModalProps) {
  const width = useProtoWidth(540, 500);
  const { doSampleReview, doMarkSampleReceived, busy } = useLeadPipeline();
  const state = lead.sample?.state;
  const received = state === "received" || state === "trial_done";
  const arrivable = state === "dispatched";
  const [answer, setAnswer] = React.useState<"yes" | "no" | null>(received ? "yes" : null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [outcome, setOutcome] = React.useState<"approved" | "more_testing" | "rejected" | null>(null);
  const problem = trialReviewProblem(fields, outcome) ??
    (outcome === "rejected" && !ACTIVE_FEEDBACK_FIELDS.some((f) => (fields[f.id] ?? "").trim().length >= 3)
      ? "A rejected trial has to say why."
      : null);

  return (
    <Modal
      open
      onClose={onClose}
      width={width}
      title={
        <div>
          <div>Sample / Trial</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name}</div>
        </div>
      }
      footer={
        received ? (
          <Footer
            onClose={onClose}
            label="Save review"
            disabled={Boolean(problem) || busy}
            onSave={() =>
              void doSampleReview(
                Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim())),
                outcome!,
              )
            }
          />
        ) : (
          <Footer onClose={onClose} label="Close" disabled={false} onSave={onClose} />
        )
      }
    >
      <FormError />
      <StepBadge stage="Sample received & review" name="Receipt and review" />
      <Field label="Has the sample been received?" className="mb-3">
        <div className="mt-1.5 flex gap-2">
          <RadioCard
            name="rc"
            label="Yes"
            checked={answer === "yes"}
            onChange={() => setAnswer("yes")}
          />
          <RadioCard name="rc" label="No" checked={answer === "no"} onChange={() => setAnswer("no")} />
        </div>
      </Field>

      {answer === "no" ? (
        <Callout tone="brand">
          The review is locked. Nothing is marked received or reviewed, and the lead cannot go to Negotiation until the
          sample has arrived and been reviewed.
        </Callout>
      ) : null}

      {answer === "yes" && !received ? (
        arrivable ? (
          <div className="mb-3">
            <Button variant="primary" disabled={busy} onClick={() => void doMarkSampleReceived({ keepOpen: true })}>
              Confirm the sample has arrived
            </Button>
            <p className="mt-2 text-[12.5px] text-muted">The review questions open as soon as the receipt is recorded.</p>
          </div>
        ) : (
          <Callout tone="brand">
            This sample cannot be marked received yet — it has to be approved and sent first (it is{" "}
            {state ? state.replace("_", " ") : "not requested"}).
          </Callout>
        )
      ) : null}

      {received ? (
        <>
          {ACTIVE_FEEDBACK_FIELDS.map((f) => (
            <Field key={f.id} label={f.label} className="mb-2.5">
              <Textarea
                rows={2}
                value={fields[f.id] ?? ""}
                onChange={(e) => setFields((v) => ({ ...v, [f.id]: e.target.value }))}
              />
            </Field>
          ))}
          <Field label="Verdict" className="mt-3">
            <div className="mt-1.5 flex flex-col gap-1.5">
              <RadioCard name="tr" label="Approved" checked={outcome === "approved"} onChange={() => setOutcome("approved")} />
              <RadioCard name="tr" label="More Testing Required" checked={outcome === "more_testing"} onChange={() => setOutcome("more_testing")} />
              <RadioCard name="tr" label="Rejected" checked={outcome === "rejected"} onChange={() => setOutcome("rejected")} />
            </div>
          </Field>
          {problem ? <p className="mt-2 text-[12.5px] text-muted">{problem}</p> : null}
        </>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------- commitment and first order */

const answerId = (id: string) => FIRST_ORDER_QUESTIONS.find((q) => q.id === id)?.id ?? id;

function AskOrderModal({ lead, onClose }: ModalProps) {
  const width = useProtoWidth(540, 520);
  const { doAskOrder, refs } = useLeadPipeline();
  const [product, setProduct] = React.useState(lead.product ?? "");
  const [qty, setQty] = React.useState("");
  const [date, setDate] = React.useState(lead.commitment?.expectedOrderDate ?? "");
  const [cans, setCans] = React.useState(lead.commitment?.cans ? String(lead.commitment.cans) : "");
  const [value, setValue] = React.useState(lead.commitment?.valuePaise ? rupeesFromPaise(lead.commitment.valuePaise) : "");
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
      width={width}
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
          <Input inputMode="numeric" value={cans} onChange={(e) => setCans(cleanWhole(e.target.value))} />
        </Field>
        <Field label="Expected value (₹)" hint="Or a size in rupees">
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(cleanDecimal(e.target.value))} />
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
  const width = useProtoWidth(540, 520);
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
      width={width}
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
        <Input inputMode="decimal" placeholder="e.g. 45000" value={value} onChange={(e) => setValue(cleanDecimal(e.target.value))} />
      </Field>
      <Field label="Quantity (cans, optional)" className="mb-2.5">
        <Input inputMode="numeric" value={cans} onChange={(e) => setCans(cleanWhole(e.target.value))} />
      </Field>
      <Field label="Order reference / confirmation no.">
        <Input placeholder="e.g. PO number or confirmation reference" value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------- lost / reassign / next */

function LostModal({ lead, onClose }: ModalProps) {
  const width = useProtoWidth(480, 520);
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
      width={width}
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

/**
 * REVERSE A LOSS. Shows what it was lost for and exactly where it will go back to
 * — the rung comes from the lead (`lost.reopenTo`, the server's own rule), never
 * from this file — then asks why. The reasons are `leads.reopenReasons`; Other
 * demands the note, which the server refuses without as well.
 */
function ReopenModal({ lead, onClose }: ModalProps) {
  const width = useProtoWidth(480, 520);
  const { doReopen, refs } = useLeadPipeline();
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const needsNote = reason === "other";
  const lost = lead.lost;
  return (
    <Modal
      open
      onClose={onClose}
      width={width}
      title={
        <div>
          <div>Reverse Lead</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · the same record comes back; the loss stays in its history
          </div>
        </div>
      }
      footer={
        <Footer
          onClose={onClose}
          label="Reverse Lead"
          disabled={!reason || (needsNote && !note.trim())}
          onSave={() => void doReopen(reason, note)}
        />
      }
    >
      <FormError />
      {lost ? (
        <Callout className="mb-3">
          <div>
            <div>
              <b>Lost for:</b> {lost.reasonLabel}
              {lost.date ? ` · ${lost.date}` : ""}
            </div>
            <div className="mt-1">
              <b>Goes back to:</b> {lost.reopenTo.label}. {lost.reopenTo.explains}
            </div>
          </div>
        </Callout>
      ) : null}
      <Field label="Why is it being reopened?" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {refs.reopenReasons.map((r) => (
            <RadioCard key={r.code} name="rr" label={r.label} checked={reason === r.code} onChange={() => setReason(r.code)} />
          ))}
        </div>
      </Field>
      <Field label={needsNote ? "Note (required)" : "Note"}>
        <Textarea
          placeholder={needsNote ? "Say what it actually is" : "Optional detail"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
        />
      </Field>
    </Modal>
  );
}

function ReassignModal({ lead, onClose }: ModalProps) {
  const width = useProtoWidth(460, 480);
  const { doReassign, refs } = useLeadPipeline();
  const [owner, setOwner] = React.useState(lead.ownerId ?? "");
  return (
    <Modal
      open
      onClose={onClose}
      width={width}
      title={lead.name}
      footer={<Footer onClose={onClose} label="Reassign" disabled={!owner || owner === lead.ownerId} onSave={() => void doReassign(owner)} />}
    >
      <FormError />
      <Field label="New owner" className="mb-3" hint="Any active CRM or Salesman App person can be given a lead. Where it will appear for them is shown once it is done.">
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
  const width = useProtoWidth(480, 460);
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
      width={width}
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
  const [credit, setCredit] = React.useState(lead.distributorProfile?.agreedCreditLimitPaise ? rupeesFromPaise(lead.distributorProfile.agreedCreditLimitPaise) : "");
  const [exclusive, setExclusive] = React.useState(lead.distributorProfile?.exclusivityGranted ?? false);
  const [note, setNote] = React.useState(lead.distributorProfile?.termsNote ?? "");

  const pct = discount === "" ? undefined : decimalNumber(discount);
  const paise = credit === "" ? undefined : rupeesToPaise(credit) ?? (Number(credit) === 0 ? 0 : undefined);
  const ready = pct !== undefined && pct <= 100 && paise !== undefined;

  const escalates =
    ready && t
      ? [
          exclusive && "exclusivity",
          pct! > t.discountPercent && `a discount above ${t.discountPercent}%`,
          paise! > t.creditLimitPaise && `a credit limit above ${inrText(t.creditLimitPaise)}`,
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
        <Input inputMode="decimal" value={discount} onChange={(e) => setDiscount(cleanDecimal(e.target.value))} />
      </Field>
      <Field label="Credit limit (₹)" className="mb-2.5">
        <Input inputMode="decimal" value={credit} onChange={(e) => setCredit(cleanDecimal(e.target.value))} />
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
