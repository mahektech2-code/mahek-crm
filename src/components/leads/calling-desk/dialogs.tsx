"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Badge, Button, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { ProductField } from "@/components/products/product-field";
import { NO_ANSWER_REASONS } from "@/lib/call-outcomes";
import { displayAnswer, MESSAGE_KINDS } from "@/lib/calling-desk-labels";
import {
  CALL_OUTCOMES,
  afterCall,
  DESK_FIELDS,
  DESK_LOST_REASONS,
  MAX_QUALIFICATION_CALLS,
  isAnswered,
  isWorkingStage,
  lostCodeForCause,
  nextActionKindOf,
  prospectProgress,
  questionsForCall,
  requiredProgress,
  suggestedLostCode,
  type CallOutcome,
  type DeskField,
  type DeskFieldKey,
  type DeskValues,
  type NextActionKind,
} from "@/lib/engines/lead-calling-desk";
import {
  convertLeadToProspect,
  logDeskMessage,
  logQualificationCall,
  markDeskLost,
  reopenDeskLead,
  requestProspect,
  setDeskNextAction,
} from "@/lib/actions/lead-calling-desk";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import { OwnerOptions, UNASSIGNED, ownerIdFor, type OwnerPerson } from "@/components/leads/owner-options";
import type { DeskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import { LeadCallAssistant } from "@/components/leads/calling-desk/lead-call-assistant";

/** The outcome as the call dialog's pills say it; the full words ride on the hover. */
const OUTCOME_SHORT: Record<(typeof CALL_OUTCOMES)[number]["code"], string> = {
  spoke_collected: "Spoke",
  spoke_callback: "Call back",
  no_answer: "No answer",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
};

type Coded = { code: string; label: string };

/* ---------------------------------------------------------------------------
 * The five Telecaller dialogs — Log call, Log a message, Set next action,
 * Request Prospect (or Resubmit) and Mark Lost.
 *
 * Version 6's own, in its own words and order. They decide nothing: the rules
 * are `engines/lead-calling-desk.ts` and every write is
 * `actions/lead-calling-desk.ts`, which checks it all again — a dialog is not a
 * permission. Each is mounted only while open, so every open starts from fresh
 * state rather than resetting it in an effect.
 * ------------------------------------------------------------------------- */

const Choice = ({
  name,
  checked,
  onChange,
  children,
  className,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
  className?: string;
}) => (
  <label
    className={cx(
      "flex cursor-pointer items-start gap-2.5 rounded-[6px] border px-3 py-2 text-sm",
      checked ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong",
      className,
    )}
  >
    <input
      type="radio"
      name={name}
      checked={checked}
      onChange={onChange}
      className="mt-0.5 h-[15px] w-[15px] flex-none accent-[#6835FB]"
    />
    <span className="text-body">{children}</span>
  </label>
);

const FieldLabel = ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) => (
  <label className={cx("block", className)}>
    <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
    <span className="block">{children}</span>
  </label>
);

const Note = ({ tone, children }: { tone: "brand" | "success" | "danger" | "warn"; children: React.ReactNode }) => (
  <div
    className={cx(
      "mb-2 rounded-[4px] border px-4 py-2.5 text-[13px]",
      tone === "brand" && "border-brand-softer border-l-[3px] border-l-brand bg-brand-soft",
      tone === "success" && "border-success/30 bg-success-soft",
      tone === "danger" && "border-danger-soft border-l-[3px] border-l-danger bg-danger-soft",
      tone === "warn" && "border-warn-line border-l-[3px] border-l-warn bg-warn-soft",
    )}
  >
    {children}
  </div>
);

/** Rupees typed by a person, as paise. Null where it is not a positive number. */
function paiseFrom(text: string): number | null {
  const cleaned = text.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function useDone() {
  const router = useRouter();
  const toast = useToast();
  return (message: string | undefined, onClose: () => void, opts?: { scrollTop?: boolean }) => {
    onClose();
    toast.push(message ?? "Saved.");
    router.refresh();
    /* V6 lifts the desk back to the top when the last answer lands, because the
       card that says "Ready for Prospect" — and the button — are up there. */
    if (opts?.scrollTop) window.scrollTo({ top: 0, behavior: "smooth" });
  };
}

/* ------------------------------------------------------------------ Log call */

/** The unit an answer is typed in, said in the label so the box can stay a plain "Not Yet Confirmed". */
function unitOf(field: DeskField): string | null {
  switch (field.kind) {
    case "litres":
      return "litres a month";
    case "money":
      return "₹ a month";
    case "days":
      return "days";
    default:
      return null;
  }
}

/**
 * One question in the "Ask on this call" grid: the label and its pills above,
 * the control below. The PRODUCT field opens a results list, so it takes the
 * whole row; everything else is one cell of three.
 */
function QuestionCell({
  field,
  customerId,
  text,
  productId,
  productName,
  onText,
  onProduct,
}: {
  field: DeskField;
  customerId: string;
  text: string;
  productId: string | null;
  productName: string | null;
  onText: (v: string) => void;
  onProduct: (id: string | null) => void;
}) {
  const isProduct = field.kind === "product";
  return (
    <div className={cx("min-w-0", isProduct && "sm:col-span-3")}>
      <span className="mb-1.5 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={field.label}>
          {field.label}
        </span>
        {field.required ? (
          <Badge tone="warn">Required</Badge>
        ) : field.prospect ? (
          <Badge tone="neutral" title="Needed for Prospect — leave it blank if the customer does not know yet">
            Prospect
          </Badge>
        ) : null}
      </span>
      {field.kind === "product" ? (
        <ProductField
          /* Keyed on `productName`, never on `productId`. `ProductField` reads
             `productName` only once, at mount, to seed its own display — fine
             for a manual pick, wrong for the voice assistant, which sets a
             resolved match from OUTSIDE the field and has no other way to make
             it show. Keying on `productId` would remount on every manual pick
             and wipe the name the field had just set for itself. */
          key={productName ?? "none"}
          customerId={customerId}
          productId={productId}
          productName={productName}
          disabled={false}
          onPick={onProduct}
        />
      ) : field.kind === "choice" ? (
        <Select value={text} onChange={(e) => onText(e.target.value)} className="w-full">
          <option value="">Not confirmed</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          value={text}
          inputMode={field.kind === "litres" || field.kind === "money" || field.kind === "days" ? "numeric" : undefined}
          /* The unit rides in the box, so the label row stays one line. */
          placeholder={unitOf(field) ? `Not confirmed · ${unitOf(field)}` : "Not confirmed"}
          aria-label={unitOf(field) ? `${field.label} (${unitOf(field)})` : undefined}
          onChange={(e) => onText(e.target.value)}
        />
      )}
    </div>
  );
}

/** An answer already on file: shown in the grid, marked Known, not asked again. */
function KnownCell({ label, value, from }: { label: string; value: string; from: string }) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={label}>
          {label}
        </span>
        <Badge tone="success" title={from}>
          Known
        </Badge>
      </span>
      <span className="flex h-9 items-center truncate rounded-[6px] border border-line bg-canvas px-3 text-sm text-body">
        {value}
      </span>
    </div>
  );
}

function QuestionGrid({
  list,
  ...rest
}: {
  list: DeskField[];
  customerId: string;
  text: Partial<Record<DeskFieldKey, string>>;
  productId: string | null;
  productName: string | null;
  onText: (key: DeskFieldKey, v: string) => void;
  onProduct: (id: string | null) => void;
}) {
  return (
    <>
      {list.map((f) => (
        <QuestionCell
          key={f.key}
          field={f}
          customerId={rest.customerId}
          text={rest.text[f.key] ?? ""}
          productId={rest.productId}
          productName={rest.productName}
          onText={(v) => rest.onText(f.key, v)}
          onProduct={rest.onProduct}
        />
      ))}
    </>
  );
}

const SEC = "mb-2.5 text-[11px] font-semibold tracking-[0.05em] text-muted uppercase";

/** A radio drawn as a pill — the outcome and the next step's type. */
function OptionPill({
  name,
  checked,
  onChange,
  title,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      title={title}
      className={cx(
        "inline-flex h-9 cursor-pointer items-center rounded-full border px-3.5 text-[13px] font-medium select-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand",
        checked ? "border-brand bg-brand-soft text-brand-deep" : "border-line bg-surface text-body hover:border-line-strong",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      {children}
    </label>
  );
}

/**
 * Log a call — Version 6's dialog, drawn as the Leads frame's design: the
 * outcome as pills, the questions as one grid with what is already known
 * shown beside what is asked, notes, the next step on one row, and what
 * saving does to the lead as a pill in the foot.
 *
 * Every rule is the engine's (`afterCall`, `questionsForCall`,
 * `prospectProgress`) and every write is `logQualificationCall`, which checks
 * it all again. Opened from the Calling desk record and the lead record alike:
 * it needs the desk's own read of the lead (`DeskLeadRecord`), the business
 * day and the default follow-up date.
 */
export function LogCallDialog({
  lead,
  defaultNextDate,
  today,
  onClose,
}: {
  lead: DeskLeadRecord;
  defaultNextDate: string;
  today: string;
  onClose: () => void;
}) {
  const done = useDone();
  const n = lead.callCount + 1;
  const [outcome, setOutcome] = React.useState<CallOutcome | null>(null);
  const [noAnswerReason, setNoAnswerReason] = React.useState("no_response");
  const [text, setText] = React.useState<Partial<Record<DeskFieldKey, string>>>({});
  const [productId, setProductId] = React.useState<string | null>(null);
  /* Set only by the voice assistant applying a resolved product match — see
     the comment on `ProductField`'s `key` in `QuestionCell`. */
  const [voiceProductName, setVoiceProductName] = React.useState<string | null>(null);
  const [showLater, setShowLater] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [nextKind, setNextKind] = React.useState<NextActionKind>("call");
  const [nextText, setNextText] = React.useState(`Call ${n + 1} — the remaining questions`);
  const [nextDate, setNextDate] = React.useState(defaultNextDate);
  const [lostOverride, setLostOverride] = React.useState<string | null>(null);
  const [lostNote, setLostNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const q = questionsForCall(lead.values, n);
  const spoke = outcome === "spoke_collected" || outcome === "spoke_callback";
  const endsLead = outcome === "not_interested" || outcome === "wrong_number";
  const exhausted = n >= MAX_QUALIFICATION_CALLS;

  /* What has been typed on this call, read the way the server reads it, so the
     foot can say what saving is about to do. */
  const typed = (): DeskValues => {
    const out: DeskValues = {};
    if (!spoke) return out;
    for (const f of [...q.askNow, ...q.later]) {
      if (f.kind === "product") {
        if (productId) out[f.key] = productId;
        continue;
      }
      const raw = (text[f.key] ?? "").trim();
      if (!raw) continue;
      if (f.kind === "litres" || f.kind === "days") {
        const num = Number(raw);
        if (Number.isInteger(num) && (f.kind === "days" ? num >= 0 : num > 0)) out[f.key] = num;
      } else if (f.kind === "money") {
        const p = paiseFrom(raw);
        if (p) out[f.key] = p;
      } else out[f.key] = raw;
    }
    return out;
  };
  const draft = typed();
  const merged = { ...lead.values, ...draft };
  const progress = prospectProgress(merged);
  /* THIS ROUND only: calls made before a reopen are history, not part of the three. */
  const priorOutcomes = lead.calls.filter((c) => !c.earlier).map((c) => c.outcome);
  /* What saving does to the lead is the engine's answer, not a second copy of
     it: ready, closed, left a Suspect after Call 3, or another call owed. */
  const after = outcome
    ? afterCall({
        callNumber: n,
        outcome,
        merged,
        priorOutcomes,
      })
    : null;
  const willBeReady = spoke && after?.kind === "ready";
  const willBeLost = after?.kind === "lost";
  const willBeExhausted = after?.kind === "exhausted";
  const needsNext = outcome !== null && !willBeReady && !willBeLost && !willBeExhausted;
  const suggested = suggestedLostCode(priorOutcomes, outcome ?? undefined);
  const lostCode = lostOverride ?? suggested;

  /* "N of M known": what is on file plus what this call has typed, over every
     question the desk asks. */
  const asked = q.answered.length + q.askNow.length + q.later.length;
  const known = q.answered.length + Object.keys(draft).length;

  async function save() {
    if (!outcome) return;
    if (outcome === "no_answer" && !noAnswerReason) {
      setError("Say what kind of no answer it was.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await logQualificationCall({
        customerId: lead.id,
        outcome,
        noAnswerReason: outcome === "no_answer" ? noAnswerReason : undefined,
        notes: notes.trim() || undefined,
        answers: draft as never,
        next: needsNext ? { kind: nextKind, text: nextText, date: nextDate } : undefined,
        lostReasonCode: willBeLost ? lostCode : undefined,
        lostNote: willBeLost ? lostNote.trim() || undefined : undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose, { scrollTop: result.data?.result === "ready" });
  }

  const set = (key: DeskFieldKey, v: string) => setText((t) => ({ ...t, [key]: v }));
  const productName = voiceProductName ?? lead.productName;

  /* What saving does, as one pill in the foot. */
  const verdict: { tone: "success" | "danger" | "warn" | "neutral"; label: string; title?: string } | null =
    !outcome
      ? null
      : willBeReady
        ? { tone: "success", label: "Ready for Prospect" }
        : willBeLost
          ? { tone: "danger", label: "Ends the lead · Lost" }
          : willBeExhausted
            ? {
                tone: "warn",
                label: "Last call · stays a Suspect",
                title: `Not yet captured: ${progress.missing.map((f) => f.label).join(", ")}`,
              }
            : {
                tone: "neutral",
                label: `${progress.done} of ${progress.total} for Prospect`,
                title: progress.missing.length
                  ? `Not yet captured: ${progress.missing.map((f) => f.label).join(", ")}`
                  : undefined,
              };

  return (
    <Modal
      open
      onClose={onClose}
      width={820}
      title={
        <div>
          <div className="flex items-center gap-2">
            Call {n} of {MAX_QUALIFICATION_CALLS}
            {exhausted ? <Badge tone="danger">Last call</Badge> : null}
          </div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {[lead.name, lead.contactPerson, lead.phone].filter(Boolean).join(" · ")}
          </div>
        </div>
      }
      footer={
        <>
          {verdict ? (
            <span className="mr-auto self-center">
              <Badge tone={verdict.tone} title={verdict.title}>
                {verdict.label}
              </Badge>
            </span>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!outcome || busy} onClick={() => void save()}>
            {busy ? "Saving…" : willBeLost ? "Save call and mark Lost" : "Save call"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[22px]">
        {lead.enquiry ? (
          <div className="rounded-[6px] border border-line bg-canvas px-3 py-2 text-[13px] text-body">
            <span className="text-muted">Enquiry: </span>“{lead.enquiry}”
          </div>
        ) : null}

        <div>
          <p className={SEC}>How did it go?</p>
          <div role="radiogroup" aria-label="Outcome" className="flex flex-wrap gap-2">
            {CALL_OUTCOMES.map((o) => (
              <OptionPill
                key={o.code}
                name="outcome"
                checked={outcome === o.code}
                onChange={() => setOutcome(o.code)}
                title={`${o.label}. ${o.hint}`}
              >
                {OUTCOME_SHORT[o.code]}
              </OptionPill>
            ))}
          </div>
          {outcome === "no_answer" ? (
            <div className="mt-3 max-w-[320px]">
              <FieldLabel label="What happened">
                <Select value={noAnswerReason} onChange={(e) => setNoAnswerReason(e.target.value)} className="w-full">
                  {NO_ANSWER_REASONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </FieldLabel>
            </div>
          ) : null}
        </div>

        {spoke ? (
          <>
            <LeadCallAssistant
              customerId={lead.id}
              notes={notes}
              onNotes={setNotes}
              currentText={text}
              currentProductId={productId}
              onFillText={set}
              onFillProduct={(match) => {
                setProductId(match.productId);
                setVoiceProductName(match.name);
              }}
            />

            <div>
              <div className="mb-2.5 flex items-center gap-2.5">
                <p className={cx(SEC, "mb-0 flex-1")}>{exhausted ? "Last call — ask what is missing" : "Ask on this call"}</p>
                <span className="text-[12px] text-muted">
                  {known} of {asked} known
                </span>
              </div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
                {q.answered.map((f) => (
                  <KnownCell
                    key={f.key}
                    label={f.label}
                    value={displayAnswer(f.key, lead.values[f.key], lead.productName, lead.gstVerified)}
                    from={lead.answeredOn[f.key] ? `From call ${lead.answeredOn[f.key]}` : "From the enquiry"}
                  />
                ))}
                <QuestionGrid
                  list={showLater ? [...q.askNow, ...q.later] : q.askNow}
                  customerId={lead.id}
                  text={text}
                  productId={productId}
                  productName={productName}
                  onText={set}
                  onProduct={setProductId}
                />
              </div>
              {q.askNow.length === 0 && !showLater ? (
                <p className="mt-2 mb-0 text-[13px] text-muted">Nothing left to ask on this call.</p>
              ) : null}
              {q.later.length ? (
                <button
                  type="button"
                  onClick={() => setShowLater((v) => !v)}
                  className="mt-3 cursor-pointer text-[12.5px] font-medium text-brand-hover hover:underline"
                >
                  {showLater ? "Hide" : "Also ask"} {q.later.length} for a later call
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {outcome ? (
          <div>
            <label htmlFor="call-notes" className="mb-1.5 block text-[13px] font-medium text-ink">
              Notes
            </label>
            <Textarea id="call-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        ) : null}

        {willBeLost ? (
          <div className="rounded-[8px] border border-danger-soft bg-danger-soft px-4 py-3">
            <div className="text-[13px] text-ink">
              <b>This call ends the lead.</b>{" "}
              {endsLead
                ? "The customer has closed the door."
                : `Last call, and still missing: ${requiredProgress(merged)
                    .missing.map((f) => f.label)
                    .join(", ")}.`}
            </div>
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <FieldLabel label="Lost reason">
                <Select value={lostCode} onChange={(e) => setLostOverride(e.target.value)} className="w-full">
                  {DESK_LOST_REASONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </FieldLabel>
              <FieldLabel label="Note">
                <Input value={lostNote} onChange={(e) => setLostNote(e.target.value)} />
              </FieldLabel>
            </div>
          </div>
        ) : willBeExhausted ? (
          <div className="rounded-[8px] border border-warn-line bg-warn-soft px-4 py-3 text-[13px] text-warn-ink">
            Last of {MAX_QUALIFICATION_CALLS} calls. Not yet captured: {progress.missing.map((f) => f.label).join(", ")}.
          </div>
        ) : needsNext ? (
          <div>
            <p className={SEC}>Next step</p>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[auto_minmax(0,1fr)_180px]">
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-ink">Type</span>
                <div role="radiogroup" aria-label="Next step type" className="flex gap-1.5">
                  {(["call", "message"] as const).map((k) => (
                    <OptionPill
                      key={k}
                      name="next-kind"
                      checked={nextKind === k}
                      onChange={() => {
                        setNextKind(k);
                        setNextText(
                          k === "call"
                            ? `Call ${n + 1} — the remaining questions`
                            : "Send information on WhatsApp, then ring back",
                        );
                      }}
                    >
                      {k === "call" ? `Call ${n + 1}` : "Message"}
                    </OptionPill>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="next-what" className="mb-1.5 block text-[13px] font-medium text-ink">
                  What happens
                </label>
                <Input id="next-what" value={nextText} onChange={(e) => setNextText(e.target.value)} />
              </div>
              <div>
                <label htmlFor="next-on" className="mb-1.5 block text-[13px] font-medium text-ink">
                  On
                </label>
                <Input id="next-on" type="date" min={today} value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
              </div>
            </div>
          </div>
        ) : null}

        {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Message */

export function MessageDialog({
  lead,
  preset,
  onClose,
}: {
  lead: DeskLeadRecord;
  preset: string | null;
  onClose: () => void;
}) {
  const done = useDone();
  const [kind, setKind] = React.useState(preset ?? MESSAGE_KINDS[0].code);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await logDeskMessage({ customerId: lead.id, code: kind, note: note.trim() || undefined });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <div>
          <div>Log a message</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · uses no call attempt ({lead.callCount} of {MAX_QUALIFICATION_CALLS} used)
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Logging…" : "Log message"}
          </Button>
        </>
      }
    >
      <FieldLabel label="What was sent" className="mb-3">
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {MESSAGE_KINDS.map((k) => (
            <Choice key={k.code} name="mk" checked={kind === k.code} onChange={() => setKind(k.code)}>
              {k.label}
            </Choice>
          ))}
        </div>
      </FieldLabel>
      <FieldLabel label="Note">
        <Textarea
          rows={2}
          placeholder="Optional — e.g. what they asked for"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </FieldLabel>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/* --------------------------------------------------------------- Next action */

export function NextActionDialog({
  lead,
  today,
  onClose,
}: {
  lead: DeskLeadRecord;
  today: string;
  onClose: () => void;
}) {
  const done = useDone();
  const upcoming = Math.min(lead.callCount + 1, MAX_QUALIFICATION_CALLS);
  const current = lead.nextAction;
  const [kind, setKind] = React.useState<NextActionKind>(nextActionKindOf(current?.text) === "message" ? "message" : "call");
  const [text, setText] = React.useState(current?.text ?? `Call ${upcoming} — the remaining questions`);
  const [date, setDate] = React.useState(current?.date ?? today);
  const [outcome, setOutcome] = React.useState(current?.outcome ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setDeskNextAction({ customerId: lead.id, kind, text, date, outcome: outcome.trim() || undefined });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message ?? "Next action saved.", onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="Set next action"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <FieldLabel label="Type" className="mb-2.5">
        <Select value={kind} onChange={(e) => setKind(e.target.value as NextActionKind)} className="w-full">
          <option value="call">Phone call — uses call {upcoming} / {MAX_QUALIFICATION_CALLS}</option>
          <option value="message">Message — uses no call</option>
        </Select>
      </FieldLabel>
      <FieldLabel label="Next action" className="mb-2.5">
        <Input placeholder="What happens next?" value={text} onChange={(e) => setText(e.target.value)} />
      </FieldLabel>
      <FieldLabel label="Follow-up date" className="mb-2.5">
        <Input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
      </FieldLabel>
      <FieldLabel label="Expected outcome">
        <Input placeholder="What should this achieve?" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
      </FieldLabel>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/** Sales Type dropdown value for "Private Limited(User)"; submitted as `direct`. */
const PRIVATE_LIMITED_USER = "direct_private_limited_user";

/* ---------------------------------------------------------- Request Prospect */

export function RequestDialog({
  lead,
  prospectReasons,
  onClose,
}: {
  lead: DeskLeadRecord;
  prospectReasons: Coded[];
  onClose: () => void;
}) {
  const done = useDone();
  const resubmit = lead.phase === "returned";
  /* The first configured reason is already chosen, or the one the desk gave last time. */
  const [reason, setReason] = React.useState(lead.requestReason ?? prospectReasons[0]?.code ?? "");
  /* Never defaulted: which ladder a lead climbs decides which gates apply, so a lead nobody
     has typed says so here and the desk picks. */
  const needsSalesType = lead.salesType === null;
  const [salesType, setSalesType] = React.useState("");
  const [note, setNote] = React.useState(lead.requestNote ?? "");
  const needsType = !isAnswered("customerType", lead.values.customerType);
  const needsContact = !lead.contactPerson?.trim();
  const [customerType, setCustomerType] = React.useState("");
  const [contactPerson, setContactPerson] = React.useState("");
  /* THE SEVENTH ANSWER, asked where the lead has none: what happens next and the
     day. A Prospect is never made without it, and the server refuses without it. */
  const hasNextStep = Boolean(lead.nextAction?.text?.trim() && lead.nextAction?.date);
  const [nextText, setNextText] = React.useState("");
  const [nextDate, setNextDate] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const sent = DESK_FIELDS.filter((f) => isAnswered(f.key, lead.values[f.key]));
  const typeField = DESK_FIELDS.find((f) => f.key === "customerType")!;

  async function save() {
    if (!reason) {
      setError("Say why this is worth pursuing.");
      return;
    }
    if (needsSalesType && !salesType) {
      setError("Choose how this lead will be sold — Direct customer or Third Party Customer.");
      return;
    }
    if (needsType && !customerType) {
      setError("Say what kind of business this is.");
      return;
    }
    if (needsContact && !contactPerson.trim()) {
      setError("Say who to ask for when the Sales Manager rings.");
      return;
    }
    if (!hasNextStep && (!nextText.trim() || !nextDate)) {
      setError("Say what happens next, and the day it happens.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await requestProspect({
        customerId: lead.id,
        reasonCode: reason,
        note: note.trim() || undefined,
        salesType: needsSalesType ? (salesType as "direct" | "third_party") : undefined,
        customerType: needsType ? (customerType as never) : undefined,
        contactPerson: needsContact ? contactPerson.trim() : undefined,
        nextAction: hasNextStep ? undefined : nextText.trim(),
        nextActionDate: hasNextStep ? undefined : nextDate,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <div>
          <div>{resubmit ? "Resubmit for verification" : "Request Prospect"}</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · {lead.callCount} call{lead.callCount === 1 ? "" : "s"} used
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Sending…" : resubmit ? "Resubmit for verification" : "Request Prospect"}
          </Button>
        </>
      }
    >
      <Note tone="brand">
        <b>This is a request, not a conversion.</b> {lead.managerName ?? "The Sales Manager"} verifies what you
        collected. The lead becomes a Prospect only when they confirm it.
      </Note>

      <FieldLabel label="Why is this worth pursuing?" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {prospectReasons.map((r) => (
            <Choice key={r.code} name="pr" checked={reason === r.code} onChange={() => setReason(r.code)}>
              {r.label}
            </Choice>
          ))}
        </div>
      </FieldLabel>

      {needsSalesType ? (
        <FieldLabel label="Sales type" className="mb-3">
          <Select value={salesType} onChange={(e) => setSalesType(e.target.value)} className="w-full">
            <option value="">Not Decided — pick one…</option>
            <option value="direct">Direct customer</option>
            <option value="third_party">Third Party Customer</option>
          </Select>
          <span className="mt-1 block text-[12px] text-muted">
            How Mahek will sell to this lead. It decides which steps the Sales Manager takes it through.
          </span>
        </FieldLabel>
      ) : null}
      {needsType ? (
        <FieldLabel label="Kind of business" className="mb-3">
          <Select value={customerType} onChange={(e) => setCustomerType(e.target.value)} className="w-full">
            <option value="">Pick one…</option>
            {(typeField.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FieldLabel>
      ) : null}
      {needsContact ? (
        <FieldLabel label="Who to ask for" className="mb-3">
          <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} />
        </FieldLabel>
      ) : null}
      {!hasNextStep ? (
        <FieldLabel label="What happens next, and when?" className="mb-3">
          <div className="grid grid-cols-[1fr_150px] gap-2">
            <Input value={nextText} onChange={(e) => setNextText(e.target.value)} placeholder="e.g. Call back with the price list" />
            <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </div>
        </FieldLabel>
      ) : null}

      <FieldLabel label="What they said" className="mb-3">
        <Textarea
          rows={2}
          placeholder="Optional — in the customer's words"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </FieldLabel>

      <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        What goes to the Sales Manager for verification
      </div>
      <div className="divide-y divide-divider rounded-[4px] border border-line">
        {sent.map((f) => (
          <div key={f.key} className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-[13px]">
            <span className="text-muted">{f.label}</span>
            <span className="text-right font-medium text-ink">
              {displayAnswer(f.key, lead.values[f.key], lead.productName, lead.gstVerified)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[12.5px] text-muted">
        Nothing here is asked of the customer a second time — the Sales Manager confirms or corrects it.
      </div>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/* -------------------------------------------------------- Convert to Prospect */

/**
 * Convert a ready Suspect straight to Prospect.
 *
 * Every field here is the same one `RequestDialog` asks — the coded reason,
 * the sales type where none is set, the kind of business and who to ask for
 * where the record lacks them — because `convertLeadToProspect` checks the
 * same readiness `requestProspect` does. What differs is only what pressing
 * the button DOES: this moves the lead to Prospect at once, with no Sales
 * Manager verification in between.
 */
export function ConvertDialog({
  lead,
  prospectReasons,
  onClose,
}: {
  lead: DeskLeadRecord;
  prospectReasons: Coded[];
  onClose: () => void;
}) {
  const done = useDone();
  const [reason, setReason] = React.useState(lead.requestReason ?? prospectReasons[0]?.code ?? "");
  const needsSalesType = lead.salesType === null;
  const [salesType, setSalesType] = React.useState("");
  const [note, setNote] = React.useState(lead.requestNote ?? "");
  const needsType = !isAnswered("customerType", lead.values.customerType);
  const needsContact = !lead.contactPerson?.trim();
  const [customerType, setCustomerType] = React.useState("");
  const [contactPerson, setContactPerson] = React.useState("");
  /* THE SEVENTH ANSWER, asked where the lead has none: what happens next and the
     day. A Prospect is never made without it, and the server refuses without it. */
  const hasNextStep = Boolean(lead.nextAction?.text?.trim() && lead.nextAction?.date);
  const [nextText, setNextText] = React.useState("");
  const [nextDate, setNextDate] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const sent = DESK_FIELDS.filter((f) => isAnswered(f.key, lead.values[f.key]));
  const typeField = DESK_FIELDS.find((f) => f.key === "customerType")!;

  async function save() {
    if (!reason) {
      setError("Say why this is worth pursuing.");
      return;
    }
    if (needsSalesType && !salesType) {
      setError("Choose how this lead will be sold — Direct customer or Third Party Customer.");
      return;
    }
    if (needsType && !customerType) {
      setError("Say what kind of business this is.");
      return;
    }
    if (needsContact && !contactPerson.trim()) {
      setError("Say who the Contact Person is.");
      return;
    }
    if (!hasNextStep && (!nextText.trim() || !nextDate)) {
      setError("Say what happens next, and the day it happens.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await convertLeadToProspect({
        customerId: lead.id,
        reasonCode: reason,
        note: note.trim() || undefined,
        /* "Private Limited(User)" is a label for a Direct sale — it climbs the Direct ladder. */
        salesType: needsSalesType
          ? salesType === PRIVATE_LIMITED_USER
            ? "direct"
            : (salesType as "direct" | "third_party")
          : undefined,
        customerType: needsType ? (customerType as never) : undefined,
        contactPerson: needsContact ? contactPerson.trim() : undefined,
        nextAction: hasNextStep ? undefined : nextText.trim(),
        nextActionDate: hasNextStep ? undefined : nextDate,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <div>
          <div>Convert to Prospect</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · {lead.callCount} call{lead.callCount === 1 ? "" : "s"} used
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Converting…" : "Convert to Prospect"}
          </Button>
        </>
      }
    >
      <Note tone="brand">
        <b>This converts the lead immediately.</b> Everything a Prospect needs is in, so pressing this moves{" "}
        {lead.name} to Prospect now — no Sales Manager verification call is needed for this lead.
      </Note>

      <FieldLabel label="Why is this worth pursuing?" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {prospectReasons.map((r) => (
            <Choice key={r.code} name="pr" checked={reason === r.code} onChange={() => setReason(r.code)}>
              {r.label}
            </Choice>
          ))}
        </div>
      </FieldLabel>

      {needsSalesType ? (
        <FieldLabel label="Sales type" className="mb-3">
          <Select value={salesType} onChange={(e) => setSalesType(e.target.value)} className="w-full">
            <option value="">Not Decided — pick one…</option>
            <option value="direct">Direct customer</option>
            <option value="third_party">Third Party Customer</option>
            <option value={PRIVATE_LIMITED_USER}>Private Limited(User)</option>
          </Select>
          <span className="mt-1 block text-[12px] text-muted">
            How Mahek will sell to this lead. It decides which steps come next.
          </span>
        </FieldLabel>
      ) : null}
      {needsType ? (
        <FieldLabel label="Kind of business" className="mb-3">
          <Select value={customerType} onChange={(e) => setCustomerType(e.target.value)} className="w-full">
            <option value="">Pick one…</option>
            {(typeField.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FieldLabel>
      ) : null}
      {needsContact ? (
        <FieldLabel label="Contact Person" className="mb-3">
          <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} />
        </FieldLabel>
      ) : null}
      {!hasNextStep ? (
        <FieldLabel label="What happens next, and when?" className="mb-3">
          <div className="grid grid-cols-[1fr_150px] gap-2">
            <Input value={nextText} onChange={(e) => setNextText(e.target.value)} placeholder="e.g. Call back with the price list" />
            <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </div>
        </FieldLabel>
      ) : null}

      <FieldLabel label="What they said" className="mb-3">
        <VoiceTextarea
          rows={2}
          placeholder="Optional — in the customer's words"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onDictate={setNote}
        />
      </FieldLabel>

      <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Collected during the calls
      </div>
      <div className="divide-y divide-divider rounded-[4px] border border-line">
        {sent.map((f) => (
          <div key={f.key} className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-[13px]">
            <span className="text-muted">{f.label}</span>
            <span className="text-right font-medium text-ink">
              {displayAnswer(f.key, lead.values[f.key], lead.productName, lead.gstVerified)}
            </span>
          </div>
        ))}
      </div>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/* ----------------------------------------------------------------- Mark Lost */

export function LostDialog({ lead, onClose }: { lead: DeskLeadRecord; onClose: () => void }) {
  const done = useDone();
  const [reason, setReason] = React.useState(
    suggestedLostCode(lead.calls.filter((c) => !c.earlier).map((c) => c.outcome)) || lostCodeForCause("no_response"),
  );
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await markDeskLost({ customerId: lead.id, reasonCode: reason, note: note.trim() || undefined });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <div>
          <div>Mark Lost</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · the record and its history are preserved, never deleted
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Mark Lost"}
          </Button>
        </>
      }
    >
      <FieldLabel label="Reason" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {DESK_LOST_REASONS.map((r) => (
            <Choice key={r.code} name="lr" checked={reason === r.code} onChange={() => setReason(r.code)}>
              {r.label}
            </Choice>
          ))}
        </div>
      </FieldLabel>
      <FieldLabel label="Note">
        <Textarea rows={3} placeholder="Optional detail" value={note} onChange={(e) => setNote(e.target.value)} />
      </FieldLabel>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/* -------------------------------------------------------------- Reverse Lead */

/**
 * Bring a Lost lead back to the desk. It names what the lead was lost for and
 * where it goes back to — read off the record (`lost.reopenTo`, the server's own
 * rule) rather than worked out here — then asks why. Other demands the note,
 * which the server refuses without as well.
 */
export function ReopenDialog({
  lead,
  reopenReasons,
  onClose,
}: {
  lead: DeskLeadRecord;
  reopenReasons: { code: string; label: string }[];
  onClose: () => void;
}) {
  const done = useDone();
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const needsNote = reason === "other";
  const lost = lead.lost;

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await reopenDeskLead({ customerId: lead.id, reasonCode: reason, note: note.trim() || undefined });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <div>
          <div>Reverse Lead</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · the same record comes back; the loss and every call stay in its history
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !reason || (needsNote && !note.trim())} onClick={() => void save()}>
            {busy ? "Saving…" : "Reverse Lead"}
          </Button>
        </>
      }
    >
      {lost ? (
        <div className="mb-3 rounded-[4px] border border-line px-3 py-2 text-[13px]">
          <div>
            <b>Lost for:</b>{" "}
            {lost.deskLabel ?? lost.reasonCode ?? "No reason recorded"}
          </div>
          <div className="mt-1">
            <b>Goes back to:</b> {lost.reopenTo.label}. {lost.reopenTo.explains}
            {isWorkingStage(lost.reopenTo.stage) ? " Its three calls start again; the earlier ones are kept." : ""}
          </div>
        </div>
      ) : null}
      <FieldLabel label="Why is it being reopened?" className="mb-3">
        <div className="mt-1.5 flex flex-col gap-1.5">
          {reopenReasons.map((r) => (
            <Choice key={r.code} name="rr" checked={reason === r.code} onChange={() => setReason(r.code)}>
              {r.label}
            </Choice>
          ))}
        </div>
      </FieldLabel>
      <FieldLabel label={needsNote ? "Note (required)" : "Note"}>
        <Textarea
          rows={3}
          placeholder={needsNote ? "Say what it actually is" : "Optional detail"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </FieldLabel>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------- Assign */

/**
 * Hand a lead to a telecaller. Drawn only for somebody who may (`lead.verify`),
 * and only ever lists people who hold the desk — a lead given to somebody who
 * cannot open it would be on a desk nobody can see, which is the failure this
 * exists to prevent. The owner IS the assignment: one write, and the lead is on
 * that person's desk.
 */
export function AssignDialog({
  lead,
  assignees,
  onClose,
}: {
  lead: DeskLeadRecord;
  assignees: OwnerPerson[];
  onClose: () => void;
}) {
  const done = useDone();
  /* Opened on who has it now (or Unassigned), so the list reads the way the lead stands. */
  const current = lead.ownerId ?? UNASSIGNED;
  const [ownerId, setOwnerId] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    if (!ownerId) {
      setError("Pick who it goes to.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await assignDeskLead({ customerId: lead.id, ownerId: ownerIdFor(ownerId) });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done(result.message, onClose);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={
        <div>
          <div>{lead.ownerName ? "Reassign" : "Assign"} lead</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · {lead.ownerName ? `currently ${lead.ownerName}` : "nobody has it yet"}
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || ownerId === current} onClick={() => void save()}>
            {busy ? "Saving…" : "Assign"}
          </Button>
        </>
      }
    >
      <FieldLabel label="Give it to">
        <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <OwnerOptions people={assignees} />
        </Select>
      </FieldLabel>
      <p className="mt-2 mb-0 text-[12.5px] text-muted">
        It lands on their desk and they are told. People marked &ldquo;no Calling desk&rdquo; cannot be chosen until
        they are given it on the Access screen.
      </p>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
