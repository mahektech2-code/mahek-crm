"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Badge, Button, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { ProductField } from "@/components/products/product-field";
import { NO_ANSWER_REASONS } from "@/lib/call-outcomes";
import { displayAnswer, MESSAGE_KINDS } from "@/lib/calling-desk-labels";
import {
  CALL_OUTCOMES,
  DESK_FIELDS,
  DESK_LOST_REASONS,
  MAX_QUALIFICATION_CALLS,
  isAnswered,
  lostCodeForCause,
  nextActionKindOf,
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
  logDeskMessage,
  logQualificationCall,
  markDeskLost,
  requestProspect,
  setDeskNextAction,
} from "@/lib/actions/lead-calling-desk";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import type { DeskLeadRecord } from "@/lib/services/lead-calling-desk-service";

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
  return (
    <label className={cx("block bg-surface px-4 py-3", field.kind === "product" ? "sm:col-span-2" : "")}>
      <span className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold tracking-[0.04em] text-muted uppercase">
          {field.label}
          {unitOf(field) ? (
            <span className="font-normal tracking-normal normal-case"> ({unitOf(field)})</span>
          ) : null}
        </span>
        {field.required ? <Badge tone="warn">Required</Badge> : null}
      </span>
      <span className="mt-1 block">
        {field.kind === "product" ? (
          <ProductField
            customerId={customerId}
            productId={productId}
            productName={productName}
            disabled={false}
            onPick={onProduct}
          />
        ) : field.kind === "choice" ? (
          <Select value={text} onChange={(e) => onText(e.target.value)} className="w-full">
            <option value="">Not Yet Confirmed</option>
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
            placeholder="Not Yet Confirmed"
            onChange={(e) => onText(e.target.value)}
          />
        )}
      </span>
    </label>
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
    <div className="mb-4 overflow-hidden rounded-[6px] border border-line">
      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
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
      </div>
    </div>
  );
}

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
  const askRequired = q.askNow.filter((f) => f.required);
  const askOptional = q.askNow.filter((f) => !f.required);
  const spoke = outcome === "spoke_collected" || outcome === "spoke_callback";
  const endsLead = outcome === "not_interested" || outcome === "wrong_number";
  const exhausted = n >= MAX_QUALIFICATION_CALLS;

  /* What has been typed on this call, read the way the server reads it, so the
     callouts below can say what saving is about to do. */
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
  const progress = requiredProgress({ ...lead.values, ...draft });
  const newCount = Object.keys(draft).length;
  const willBeReady = spoke && progress.complete;
  const willBeLost = endsLead || (!willBeReady && exhausted && outcome !== null);
  const needsNext = outcome !== null && !willBeReady && !willBeLost;
  const priorOutcomes = lead.calls.map((c) => c.outcome);
  const suggested = suggestedLostCode(priorOutcomes, outcome ?? undefined);
  const lostCode = lostOverride ?? suggested;

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

  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      title={
        <div>
          <div className="flex items-center gap-2">
            Call {n} / {MAX_QUALIFICATION_CALLS}
            {exhausted ? <Badge tone="danger">Last call</Badge> : null}
          </div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · {lead.contactPerson || "—"} · {lead.phone || "—"}
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!outcome || busy} onClick={() => void save()}>
            {busy
              ? "Saving…"
              : willBeLost
                ? "Save call and mark Lost"
                : willBeReady
                  ? "Save call — Ready for Prospect"
                  : "Save call"}
          </Button>
        </>
      }
    >
      {lead.enquiry ? (
        <div className="mb-3 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px] text-body">
          <span className="text-muted">The enquiry said: </span>“{lead.enquiry}”
        </div>
      ) : null}

      <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">How did the call go?</div>
      <div className="mb-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {CALL_OUTCOMES.map((o) => (
          <Choice key={o.code} name="outcome" checked={outcome === o.code} onChange={() => setOutcome(o.code)}>
            <span className="block font-medium text-ink">{o.label}</span>
            <span className="block text-[12px] text-muted">{o.hint}</span>
          </Choice>
        ))}
      </div>

      {outcome === "no_answer" ? (
        <FieldLabel label="What happened" className="mb-4">
          <Select value={noAnswerReason} onChange={(e) => setNoAnswerReason(e.target.value)} className="w-full">
            {NO_ANSWER_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </FieldLabel>
      ) : null}

      {spoke ? (
        <>
          <div className="mb-3 rounded-[4px] border border-success/30 bg-success-soft px-3.5 py-2.5">
            <div className="text-[13px] font-medium text-success">
              ✓ {q.answered.length} answer{q.answered.length === 1 ? "" : "s"} already on file — these are not
              asked again
            </div>
            {q.answered.length ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12.5px] text-muted">▸ See what we already have</summary>
                <div className="mt-1.5 divide-y divide-divider rounded-[4px] border border-line bg-surface">
                  {q.answered.map((f) => (
                    <div key={f.key} className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-[12.5px]">
                      <span className="text-muted">{f.label}</span>
                      <span className="flex-none text-right font-medium text-ink">
                        {displayAnswer(f.key, lead.values[f.key], lead.productName, lead.gstVerified)}{" "}
                        <span className="font-normal text-muted">
                          · {lead.answeredOn[f.key] ? `call ${lead.answeredOn[f.key]}` : "from the enquiry"}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <div className="text-[12.5px] text-muted">Nothing yet — this is where the conversation starts.</div>
            )}
          </div>

          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              {exhausted ? "Last call — ask what is still missing" : "Ask on this call"}
            </div>
            <span className="text-[12px] text-muted">
              {newCount} new answer{newCount === 1 ? "" : "s"}
            </span>
          </div>

          {q.askNow.length === 0 ? (
            <div className="mb-3 rounded-[4px] border border-dashed border-line-strong px-4 py-4 text-center text-[13px] text-muted">
              Nothing left worth asking on this call.
            </div>
          ) : (
            <>
              {askRequired.length ? (
                <>
                  <div className="mb-1.5 text-[11px] font-semibold tracking-[0.04em] text-danger uppercase">
                    Required — {askRequired.length} needed for Ready for Prospect
                  </div>
                  <QuestionGrid
                    list={askRequired}
                    customerId={lead.id}
                    text={text}
                    productId={productId}
                    productName={lead.productName}
                    onText={set}
                    onProduct={setProductId}
                  />
                </>
              ) : null}
              {askOptional.length ? (
                <>
                  <div
                    className={cx(
                      "mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase",
                      askRequired.length ? "mt-3" : "",
                    )}
                  >
                    Optional — worth asking, does not block Ready for Prospect
                  </div>
                  <QuestionGrid
                    list={askOptional}
                    customerId={lead.id}
                    text={text}
                    productId={productId}
                    productName={lead.productName}
                    onText={set}
                    onProduct={setProductId}
                  />
                </>
              ) : null}
            </>
          )}

          {q.later.length ? (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowLater((v) => !v)}
                className="cursor-pointer text-[12.5px] font-medium text-brand-hover hover:underline"
              >
                {showLater ? "Hide" : "Also ask"} {q.later.length} question{q.later.length === 1 ? "" : "s"} planned
                for a later call
              </button>
              {showLater ? (
                <div className="mt-3">
                  <QuestionGrid
                    list={q.later}
                    customerId={lead.id}
                    text={text}
                    productId={productId}
                    productName={lead.productName}
                    onText={set}
                    onProduct={setProductId}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {outcome ? (
        <>
          <FieldLabel label="Notes" className="mb-4">
            <Textarea
              rows={3}
              placeholder="Anything worth remembering from this call"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FieldLabel>

          {willBeReady ? (
            <Note tone="brand">
              <b>Ready for Prospect.</b> All {progress.total} required answers will be in after this call — no
              further calls are needed.
            </Note>
          ) : willBeLost ? (
            <Note tone="danger">
              <div className="text-ink">
                <b>This call ends the lead — it will be marked Lost.</b>{" "}
                {endsLead
                  ? "The customer has closed the door."
                  : `That was the last of ${MAX_QUALIFICATION_CALLS} calls and ${progress.missing.length} required answer${
                      progress.missing.length === 1 ? " is" : "s are"
                    } still missing.`}
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
                  <Input placeholder="Optional detail" value={lostNote} onChange={(e) => setLostNote(e.target.value)} />
                </FieldLabel>
              </div>
            </Note>
          ) : (
            <div className="mb-2 rounded-[4px] border border-line bg-canvas px-4 py-3">
              <div className="text-[13px] text-ink">
                <b>
                  {progress.done} / {progress.total} required answers
                </b>{" "}
                after this call. Call {n + 1} / {MAX_QUALIFICATION_CALLS} follows.
              </div>
              {progress.missing.length ? (
                <div className="mt-0.5 text-[12.5px] text-muted">
                  Still open: {progress.missing.map((f) => f.label).slice(0, 4).join(" · ")}
                  {progress.missing.length > 4 ? ` · +${progress.missing.length - 4} more` : ""}
                </div>
              ) : null}
              <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_1.4fr_1fr]">
                <FieldLabel label="Next step">
                  <Select
                    value={nextKind}
                    onChange={(e) => {
                      const k = e.target.value as NextActionKind;
                      setNextKind(k);
                      setNextText(k === "call" ? `Call ${n + 1} — the remaining questions` : "Send information on WhatsApp, then ring back");
                    }}
                    className="w-full"
                  >
                    <option value="call">
                      Call {n + 1} / {MAX_QUALIFICATION_CALLS}
                    </option>
                    <option value="message">Message first</option>
                  </Select>
                </FieldLabel>
                <FieldLabel label="What happens">
                  <Input value={nextText} onChange={(e) => setNextText(e.target.value)} />
                </FieldLabel>
                <FieldLabel label="Follow-up date">
                  <Input type="date" min={today} value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
                </FieldLabel>
              </div>
            </div>
          )}
        </>
      ) : null}

      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
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

/* ----------------------------------------------------------------- Mark Lost */

export function LostDialog({ lead, onClose }: { lead: DeskLeadRecord; onClose: () => void }) {
  const done = useDone();
  const [reason, setReason] = React.useState(
    suggestedLostCode(lead.calls.map((c) => c.outcome)) || lostCodeForCause("no_response"),
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
  assignees: { id: string; name: string }[];
  onClose: () => void;
}) {
  const done = useDone();
  const [ownerId, setOwnerId] = React.useState("");
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
      result = await assignDeskLead({ customerId: lead.id, ownerId });
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
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Assign"}
          </Button>
        </>
      }
    >
      <FieldLabel label="Give it to">
        <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Pick a telecaller…</option>
          {assignees.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FieldLabel>
      <p className="mt-2 mb-0 text-[12.5px] text-muted">
        Only people who have been given the Calling desk are listed. It lands on their desk and they are told.
      </p>
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
