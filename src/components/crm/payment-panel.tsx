"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Field,
  Input,
  MoneyInput,
  SlowPayerBadge,
  cx,
} from "@/components/ui/primitives";
import { useEscape } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { NextStepDialog } from "@/components/crm/next-step-dialog";
import type { NextStep } from "@/lib/engines/next-step";
import {
  holdOtherReasonsUntilReminder,
  logPaymentFollowUpAction,
  queueMessage,
  confirmMessageSent,
  sendWhatsAppNow,
  recordPayment,
} from "@/lib/actions/crm";
import { ageLabel, money, shortDate, stamp, today as todayISO } from "@/lib/format";
import { PaymentModeFields } from "@/components/crm/payment-mode-fields";
import type { FollowUpPanelData } from "@/lib/services/payment-followup-service";
import type { ReminderPreview } from "@/lib/services/whatsapp-service";
import type { RuleOutlook, TrackerRow } from "@/lib/services/whatsapp-tracker-service";
import { MessageTimeline, RuleOutlookList } from "@/components/whatsapp/message-timeline";
import type { PayOutcomeDefinition } from "@/lib/services/payment-followup-service";
import { BodyPortal } from "@/components/ui/body-portal";

/* ---------------------------------------------------------------------------
 * The payment follow-up panel.
 *
 * Everything a collections call needs in one place: the account, the log and
 * the message. Nothing here navigates away from the worklist — a telecaller
 * working a list of twelve should not lose their place to look at a bill.
 *
 * The outcome definitions come from the server, so what the form demands and
 * what the action demands cannot drift apart.
 * ------------------------------------------------------------------------- */

export type PanelTarget = {
  customerId: string;
  /** Position in the worked list, for "Customer 3 of 12" and prev/next. */
  index: number;
  total: number;
};

/** The two things a follow-up can be: a call logged, or a reminder sent. */
type Tab = "log" | "msg";

export function PaymentPanel(props: {
  /** `payments.modes` — the list is configuration, never a literal on a screen. */
  modes: string[];
  /** `payments.datedModes` — modes whose instrument carries a date of its own. */
  datedModes: string[];
  /** The business date, read on the server: the clock is not read during render. */
  today: string;
  target: PanelTarget | null;
  outcomes: PayOutcomeDefinition[];
  onClose: () => void;
  onMove: (delta: number) => void;
  /** Advance to the next customer after a save, for Save & next. */
  onSavedNext: () => void;
  onSaved: () => void;
  /** Refresh the list behind without closing — used after a per-bill payment. */
  onRefresh: () => void;
}) {
  /*
   * The confirmation lives HERE, above the body, for the reason the call
   * drawer's does: saving revalidates the worklist, the customer just worked
   * drops off it, and `target` goes with them — a dialog rendered inside the
   * body would be unmounted in the frame it opened, and the answer never seen.
   * Everything it needs is captured at the moment of saving.
   */
  const [logged, setLogged] = React.useState<LoggedFollowUp | null>(null);
  const [stepOpen, setStepOpen] = React.useState(false);
  // Bumped on every save — see the same field on CallPanel. NextStepDialog
  // is one long-lived instance here too, so its "holding..." state needs a
  // key that changes with each save rather than surviving into the next.
  const [logSeq, setLogSeq] = React.useState(0);

  function dismiss(advance: boolean) {
    setStepOpen(false);
    if (advance) props.onSavedNext();
    else props.onSaved();
  }

  return (
    <>
      {props.target ? (
        // Remounted per customer: every field starts clean rather than being
        // reset in an effect. See AGENTS.md on the React Compiler rules.
        <PanelBody
          key={props.target.customerId}
          {...props}
          target={props.target}
          onLogged={(entry) => {
            setLogged(entry);
            setStepOpen(true);
            setLogSeq((n) => n + 1);
          }}
        />
      ) : null}

      {logged ? (
        <NextStepDialog
          key={logSeq}
          open={stepOpen}
          savedLabel={logged.label}
          step={logged.step}
          customerName={logged.customerName}
          defaultNext={logged.wantsNext}
          onNext={() => dismiss(true)}
          onStay={() => dismiss(false)}
          onHold={async (reminderId) => {
            await holdOtherReasonsUntilReminder(reminderId);
          }}
        />
      ) : null}
    </>
  );
}

/** Captured at the moment of saving, so it outlives the row it came from. */
type LoggedFollowUp = {
  label: string;
  customerName: string;
  step: NextStep | null;
  wantsNext: boolean;
};

function PanelBody({
  modes,
  datedModes,
  today: businessDay,
  target,
  outcomes,
  onClose,
  onMove,
  onSaved,
  onRefresh,
  onLogged,
}: {
  /** `payments.modes` — the list is configuration, never a literal on a screen. */
  modes: string[];
  /** `payments.datedModes` — modes whose instrument carries a date of its own. */
  datedModes: string[];
  /** The business date, read on the server: the clock is not read during render. */
  today: string;
  target: PanelTarget;
  outcomes: PayOutcomeDefinition[];
  onClose: () => void;
  onMove: (delta: number) => void;
  /*
   * Advancing is the WRAPPER's, because the confirmation stands between the
   * save and the next customer now. `onSaved` stays: a per-bill payment
   * refreshes without logging a call, so it has no next step to confirm.
   */
  onSaved: () => void;
  onRefresh: () => void;
  /** Handed up rather than advancing here — the confirmation is shown first. */
  onLogged: (entry: LoggedFollowUp) => void;
}) {
  const { run, push } = useToast();

  /*
   * Null until somebody picks: the panel opens on whatever the stage asks
   * for — the reminder at stage 1, the call log otherwise — so the commonest
   * case is zero clicks from the row.
   */
  const [picked, setPicked] = React.useState<Tab | null>(null);
  const [panel, setPanel] = React.useState<FollowUpPanelData | null>(null);
  const [message, setMessage] = React.useState<ReminderPreview | null>(null);
  const [wa, setWa] = React.useState<{ messages: TrackerRow[]; rules: RuleOutlook[] }>({ messages: [], rules: [] });
  const [loading, setLoading] = React.useState(true);

  const [outcome, setOutcome] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState("");
  const [chips, setChips] = React.useState<string[]>([]);
  const [typed, setTyped] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  /** The bill a payment is being recorded against, from the Account tab. */
  const [payingBill, setPayingBill] = React.useState<string | null>(null);

  // One key per opening, so a double-click logs one follow-up, not two.
  const idempotencyKey = React.useRef(crypto.randomUUID());

  const load = React.useCallback(
    (signal?: AbortSignal) =>
      fetch(`/api/payment-panel?customerId=${target.customerId}`, { signal })
        .then((r) => (r.ok ? r.json() : { panel: null }))
        .then((d) => {
          setPanel(d.panel);
          setMessage(d.message ?? null);
          setWa(d.whatsapp ?? { messages: [], rules: [] });
        })
        .catch(() => {})
        .finally(() => setLoading(false)),
    [target.customerId],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const def = outcomes.find((o) => o.key === outcome) ?? null;
  const dirty = Boolean(typed.trim() || chips.length || amount || date);

  // Notes are the chips plus whatever was typed, kept in one string so the
  // telecaller can still edit it.
  const notes = chips.length
    ? [typed.trim(), chips.join(". ")].filter(Boolean).join(". ")
    : typed;

  const guard = React.useCallback(
    (go: () => void) => {
      if (!dirty) return go();
      if (
        window.confirm(
          `You have entered details for ${panel?.name ?? "this customer"} that have not been saved. Discard them?`,
        )
      ) {
        go();
      }
    },
    [dirty, panel?.name],
  );

  const close = () => guard(onClose);
  useEscape(close);

  function toggleChip(label: string) {
    setChips((c) => (c.includes(label) ? c.filter((x) => x !== label) : [...c, label]));
  }

  async function save(next: boolean) {
    if (!def || !panel) return;
    // A retired outcome is readable but never writable, so it cannot be the
    // thing being saved — the screen never offers one.
    if (def.retired) return;
    setBusy(true);
    try {
      const result = await run(
        logPaymentFollowUpAction({
          customerId: panel.customerId,
          outcome: def.key as Exclude<typeof def.key, "part">,
          amount: amount.trim() ? Number(amount.replace(/[^0-9]/g, "")) : undefined,
          date: date || undefined,
          notes: notes.trim() || undefined,
          chips,
          idempotencyKey: idempotencyKey.current,
        }),
      );
      if (result.ok) {
        setErrors({});
        /*
         * Handed UP rather than advancing here, and the advance goes with it.
         *
         * Moving straight to the next overdue account was what made the answer
         * invisible on this screen: the telecaller had just agreed a promise
         * date with the customer and had nowhere to be told when that customer
         * comes back. Pressing Enter still advances in one keystroke.
         */
        onLogged({
          label: def.label,
          customerName: panel.name,
          step: result.data.nextStep,
          wantsNext: next,
        });
      } else if (result.fieldErrors?.length) {
        setErrors(
          Object.fromEntries(result.fieldErrors.map((f) => [f.field, f.message])),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyMessage() {
    if (!panel || !message || message.blocked) return;
    await navigator.clipboard.writeText(message.body).catch(() => {});
    const result = await run(
      queueMessage({
        customerId: panel.customerId,
        templateId: message.templateId,
        body: message.body,
        edited: false,
        destKind: message.destKind,
      }),
    );
    if (result.ok) setCopiedId(result.data.id);
  }

  /**
   * The API route: one press sends the reminder from the business number and
   * stamps it, exactly as confirming a pasted one does. Refused — with the
   * reason in the toast — whenever it cannot go that way, and the copy route
   * is still on the screen beneath the refusal.
   */
  async function sendNow() {
    if (!panel || !message || message.blocked) return;
    setConfirming(true);
    try {
      const result = await run(
        sendWhatsAppNow({ customerId: panel.customerId, templateId: message.templateId }),
      );
      if (result.ok) onSaved();
    } finally {
      setConfirming(false);
    }
  }

  async function markSent() {
    if (!copiedId) return;
    setConfirming(true);
    try {
      const result = await run(confirmMessageSent(copiedId));
      if (result.ok) onSaved();
    } finally {
      setConfirming(false);
    }
  }

  const blocked = Boolean(
    def && ((def.amount && !amount.trim()) || (def.date && !date)),
  );

  const bill = panel?.bills.find((b) => b.id === payingBill) ?? null;
  const tab: Tab = picked ?? (panel?.nextChannel === "whatsapp" ? "msg" : "log");

  return (
    <BodyPortal>
      <div
        onClick={close}
        className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(26,30,40,0.45)] p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Payment follow-up"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex h-[760px] max-h-[calc(100vh-48px)] w-[1160px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[6px] bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
        >
          {/* ------------------------------------------------------- header */}
          <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-6 pt-4 pb-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[20px] leading-7 font-semibold text-ink">
                  {panel?.name ?? "Loading…"}
                </span>
                {panel ? (
                  <>
                    <Badge
                      tone={panel.stage === 3 ? "danger" : panel.stage === 2 ? "warn" : "brand"}
                      title={panel.stageName}
                    >
                      Stage {panel.stage}
                    </Badge>
                    {panel.slowPayer ? <SlowPayerBadge /> : null}
                    {panel.floorReason ? (
                      <Badge tone="warn" title={panel.floorReason}>
                        Held at this stage
                      </Badge>
                    ) : null}
                  </>
                ) : null}
              </div>
              {panel ? (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                  {panel.contactPerson ? <span>{panel.contactPerson}</span> : null}
                  <span className="inline-flex items-center gap-1.5">
                    <a
                      href={`tel:${panel.phone}`}
                      className="font-medium text-ink no-underline hover:underline"
                    >
                      {panel.phone}
                    </a>
                    <button
                      type="button"
                      title="Copy number"
                      onClick={() => {
                        void navigator.clipboard.writeText(panel.phone);
                        push("Phone number copied");
                      }}
                      className="inline-flex h-[20px] w-[20px] flex-none cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-muted hover:bg-canvas hover:text-body"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="12" height="12" rx="2" />
                        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
                      </svg>
                    </button>
                  </span>
                  <span>· {panel.city}</span>
                  <span>· {panel.ownerName ?? "Unassigned"}</span>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="h-7 w-7 flex-none cursor-pointer rounded-[4px] border-none bg-transparent text-muted hover:bg-canvas hover:text-body"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          {/* --------------------------------------------------------- body */}
          {loading ? (
            <div className="flex-1 px-6 py-10 text-sm text-muted">Loading…</div>
          ) : !panel ? (
            <div className="flex-1 px-6 py-10 text-sm text-muted">
              Not on the follow-up list any more — paid, or outside your book.
            </div>
          ) : (
            /*
             * ONE SCREEN, TWO SIDES. The account on the left is what you READ
             * before and during the call; the right is what you DO. They were
             * three tabs, so the bills were out of sight at the exact moment
             * the customer was asking about one.
             */
            <div className="flex min-h-0 flex-1">
              <AccountPane panel={panel} onRecordPayment={setPayingBill} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-none items-center gap-3 border-b border-line px-6 py-3">
                  <Segmented
                    value={tab}
                    onChange={setPicked}
                    options={[
                      { key: "log", label: "Log a call", dot: dirty },
                      { key: "msg", label: "WhatsApp reminder" },
                    ]}
                  />
                  <span className="flex-1" />
                  <span className="text-[12px] text-muted">
                    Next step:{" "}
                    <span className="font-medium text-brand-hover">{panel.nextAction}</span>
                  </span>
                </div>
                {tab === "log" ? (
                  <LogPane
                    outcomes={outcomes}
                    def={def}
                    onPick={(key) => {
                      if (key === outcome) return;
                      setOutcome(key);
                      setAmount("");
                      setDate("");
                      // Quick notes belong to an outcome; what was typed
                      // belongs to the call, so a change of mind keeps it.
                      setChips([]);
                      setErrors({});
                    }}
                    amount={amount}
                    setAmount={setAmount}
                    date={date}
                    setDate={setDate}
                    chips={chips}
                    toggleChip={toggleChip}
                    notes={notes}
                    setTyped={setTyped}
                    errors={errors}
                    outstanding={panel.totalOverdue}
                    stage={panel.stage}
                  />
                ) : (
                  <MessagePane
                    wa={wa}
                    message={message}
                    copied={Boolean(copiedId)}
                    confirming={confirming}
                    onCopy={copyMessage}
                    onMarkSent={markSent}
                    phone={panel.phone}
                  />
                )}
              </div>
            </div>
          )}

          {/* ------------------------------------------------------- footer */}
          <div className="flex flex-none items-center gap-2.5 border-t border-line bg-surface px-6 py-3">
            {target.total > 1 ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={target.index <= 0}
                  onClick={() => guard(() => onMove(-1))}
                  title="Previous customer"
                  className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] text-body hover:bg-canvas disabled:cursor-not-allowed disabled:text-line-strong"
                >
                  ◀
                </button>
                <span className="px-1.5 text-[13px] text-muted">
                  {target.index + 1} / {target.total}
                </span>
                <button
                  type="button"
                  disabled={target.index >= target.total - 1}
                  onClick={() => guard(() => onMove(1))}
                  title="Next customer"
                  className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] text-body hover:bg-canvas disabled:cursor-not-allowed disabled:text-line-strong"
                >
                  ▶
                </button>
              </span>
            ) : null}
            <span className="flex-1" />
            <Button variant="secondary" onClick={close}>
              {tab === "log" && def ? "Cancel" : "Close"}
            </Button>
            {panel && tab === "log" ? (
              <>
                <Button
                  variant="secondary"
                  disabled={!def || blocked || busy}
                  title={!def ? "Pick what they said first" : blocked ? blockedTitle(def) : undefined}
                  onClick={() => save(false)}
                >
                  Save
                </Button>
                <Button
                  variant="primary"
                  disabled={!def || blocked || busy}
                  title={!def ? "Pick what they said first" : blocked ? blockedTitle(def) : undefined}
                  onClick={() => save(true)}
                >
                  Save &amp; next ▸
                </Button>
              </>
            ) : null}
            {panel && tab === "msg" && message?.mode === "automatic" ? (
              <Button
                variant="primary"
                disabled={Boolean(message.blocked) || confirming}
                title={message.blocked ? "Some details are missing — see above" : undefined}
                onClick={sendNow}
              >
                {confirming ? "Sending…" : "Send on WhatsApp"}
              </Button>
            ) : null}
          </div>
        </div>

        {bill ? (
          <RecordPaymentForm
            key={bill.id}
            modes={modes}
            datedModes={datedModes}
            today={businessDay}
            bill={bill}
            customerName={panel?.name ?? ""}
            onClose={() => setPayingBill(null)}
            onDone={async () => {
              setPayingBill(null);
              // The bills are the truth, so the panel re-reads them rather than
              // adjusting a number it is holding.
              await load();
              onRefresh();
            }}
          />
        ) : null}
      </div>
    </BodyPortal>
  );
}

/** A payment against one named bill. Oldest-first allocation is the "Already
 *  paid" outcome on the log tab; this is for "they paid bill MM/4210". */
function RecordPaymentForm({
  modes,
  datedModes,
  today: businessDay,
  bill,
  customerName,
  onClose,
  onDone,
}: {
  modes: string[];
  datedModes: string[];
  today: string;
  bill: FollowUpPanelData["bills"][number];
  customerName: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { run } = useToast();
  const [amount, setAmount] = React.useState(String(Math.round(bill.balance / 100)));
  const [mode, setMode] = React.useState("Bank transfer");
  const [reference, setReference] = React.useState("");
  /** The date written on the cheque — see `payments.datedModes`. */
  const [instrumentDate, setInstrumentDate] = React.useState("");
  const [receivedOn, setReceivedOn] = React.useState(todayISO());
  const [busy, setBusy] = React.useState(false);
  /*
   * The message AND the field it belongs to.
   *
   * It used to be a bare string pinned to the amount box, so "a cheque needs
   * the date written on it" appeared under "Amount received" — pointing at the
   * one field that was correct. A validation message under the wrong field is
   * worse than no message: it sends somebody to fix what is not broken.
   */
  const [error, setError] = React.useState<{ field: string | null; message: string } | null>(
    null,
  );

  useEscape(onClose);

  // What the bill will read after this is saved, shown while it is typed —
  // the same "here is what happens next" the panel's context bar gives.
  const entered = Number(amount.replace(/[^0-9]/g, "")) * 100;
  const leftOpen = bill.balance - entered;

  return (
    <BodyPortal>
      <div
        onClick={onClose}
        className="animate-fade-in fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(22,22,22,0.35)] p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Record payment"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-[620px] max-w-[calc(100vw-48px)] overflow-hidden rounded-[6px] bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
        >
          {/* ------------------------------------------------------- header */}
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[22px] leading-7 font-semibold text-ink">
                  Record payment
                </span>
                <Badge tone="neutral">{bill.billNo}</Badge>
                {bill.disputed ? <Badge tone="warn">Disputed</Badge> : null}
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm text-muted">
                <span className="font-medium text-ink">{customerName}</span>
                <span>·</span>
                <span>due {shortDate(bill.dueDate)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="h-7 w-7 flex-none cursor-pointer rounded-[4px] border-none bg-transparent text-muted hover:bg-canvas hover:text-body"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          {/* -------------------------------------------------- context bar */}
          <div className="flex items-center gap-5 border-y border-line bg-canvas px-6 py-2.5">
            <Stat label="Bill amount">{money(bill.amount)}</Stat>
            <Rule />
            <Stat label="Already paid">{money(bill.paid)}</Stat>
            <Rule />
            <Stat label="Open now" tone={bill.overdueDays > 45 ? "danger" : undefined}>
              {money(bill.balance)}
            </Stat>
            <Rule />
            <Stat
              label="Overdue"
              tone={
                bill.overdueDays > 45 ? "danger" : bill.overdueDays > 15 ? "warn" : undefined
              }
            >
              {bill.overdueDays > 0 ? ageLabel(bill.overdueDays) : "Not due"}
            </Stat>
            <span className="flex-1" />
            <div className="text-right">
              <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Leaves open
              </div>
              <div
                className={cx(
                  "text-sm font-semibold",
                  leftOpen < 0 ? "text-danger" : "text-brand-hover",
                )}
              >
                {leftOpen < 0 ? `${money(-leftOpen)} over` : money(leftOpen)}
              </div>
            </div>
          </div>

          {/* --------------------------------------------------------- body */}
          <div className="px-6 py-4">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Amount received"
                error={
                  error && error.field !== "instrumentDate" && error.field !== "reference"
                    ? error.message
                    : undefined
                }
                hint={error ? undefined : `Up to ${money(bill.balance)} on this bill`}
              >
                <MoneyInput
                  invalid={Boolean(error) || leftOpen < 0}
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value.replace(/[^0-9]/g, ""));
                    setError(null);
                  }}
                />
              </Field>
              <Field label="Received on">
                <Input
                  type="date"
                  value={receivedOn}
                  onChange={(e) => setReceivedOn(e.target.value)}
                />
              </Field>
              <PaymentModeFields
                modes={modes}
                datedModes={datedModes}
                today={businessDay}
                mode={mode}
                onMode={setMode}
                reference={reference}
                onReference={setReference}
                instrumentDate={instrumentDate}
                onInstrumentDate={setInstrumentDate}
                error={error?.field === "instrumentDate" ? error.message : undefined}
                referenceError={error?.field === "reference" ? error.message : undefined}
              />
            </div>

            {leftOpen < 0 ? (
              <div className="mt-3 rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
                {money(-leftOpen)} more than this bill has open — put the rest on the next bill.
              </div>
            ) : null}
          </div>

          {/* ------------------------------------------------------- footer */}
          <div className="flex items-center gap-2.5 border-t border-line bg-surface px-6 py-3">
            <span className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await run(
                    recordPayment({
                      billId: bill.id,
                      amount,
                      mode,
                      reference: reference || undefined,
                      instrumentDate: instrumentDate || undefined,
                      receivedOn,
                    }),
                  );
                  if (result.ok) await onDone();
                  else
                    setError({
                      field: result.fieldErrors?.[0]?.field ?? null,
                      message: result.fieldErrors?.[0]?.message ?? result.error,
                    });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Record payment
            </Button>
          </div>
        </div>
      </div>
    </BodyPortal>
  );
}

function blockedTitle(def: PayOutcomeDefinition): string {
  if (def.amount) return `Enter the ${def.amount.toLowerCase()}`;
  return `Choose the ${String(def.date).toLowerCase()} date`;
}

function Rule() {
  return <span className="h-7 w-px bg-line" />;
}

function Stat({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "danger" | "warn";
  children: React.ReactNode;
}) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span
        className={cx(
          "text-sm font-medium",
          tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {children}
      </span>
    </span>
  );
}

/** "payment_promised" → "Payment promised": a stored code is not a label. */
function readable(code: string): string {
  if (!/_/.test(code) && code !== code.toLowerCase()) return code;
  const words = code.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ageTone(days: number): "danger" | "warn" | undefined {
  return days > 45 ? "danger" : days > 15 ? "warn" : undefined;
}

function PaneLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="text-[12px] font-medium text-muted">{children}</span>
      {right ? (
        <>
          <span className="flex-1" />
          {right}
        </>
      ) : null}
    </div>
  );
}

/** Two buttons that behave as one control — which of two things you are doing. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (key: T) => void;
  options: Array<{ key: T; label: string; dot?: boolean }>;
}) {
  return (
    <div className="inline-flex rounded-[6px] border border-line bg-canvas p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cx(
            "h-8 cursor-pointer rounded-[4px] border-none px-3.5 text-[13px]",
            value === o.key
              ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(22,22,22,0.08)]"
              : "bg-transparent text-muted hover:text-body",
          )}
        >
          {o.label}
          {o.dot ? (
            <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ account pane */

/**
 * EVERYTHING ABOUT THE ACCOUNT, IN READING ORDER: how much and how late, the
 * bills it is made of, what was promised, and what happened last. No
 * sentences restating the figures — the figures are the sentence.
 */
function AccountPane({
  panel,
  onRecordPayment,
}: {
  panel: FollowUpPanelData;
  onRecordPayment: (billId: string) => void;
}) {
  return (
    <div className="w-[440px] flex-none overflow-y-auto border-r border-line bg-canvas">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line px-5 py-4">
        <Stat label="Outstanding" tone={panel.stage === 3 ? "danger" : undefined}>
          <span className="text-[18px] font-semibold">{money(panel.totalOverdue)}</span>
        </Stat>
        <Stat label="Oldest bill" tone={ageTone(panel.oldestOverdueDays)}>
          <span className="text-[18px] font-semibold">
            {panel.oldestOverdueDays ? ageLabel(panel.oldestOverdueDays) : "Not due"}
          </span>
        </Stat>
        <Stat label="Last chased">
          {panel.lastFollowUpAt ? stamp(panel.lastFollowUpAt) : "Never"}
        </Stat>
        <Stat label="Credit terms">{panel.creditDays} days</Stat>
      </div>

      <div className="border-b border-line px-5 py-4">
        <PaneLabel>Open bills · {panel.bills.length}</PaneLabel>
        {panel.bills.length ? (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            {panel.bills.map((b, i) => (
              <div
                key={b.id}
                className={cx(
                  "flex items-center gap-3 px-3 py-2",
                  i ? "border-t border-divider" : "",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span
                    title={b.billNo}
                    className="block truncate text-[13px] font-medium text-ink"
                  >
                    {b.billNo}
                    {b.disputed ? (
                      <Badge tone="warn" className="ml-1.5">
                        Disputed
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block text-[12px] text-muted">
                    Due {shortDate(b.dueDate)}
                    {b.paid ? ` · ${money(b.paid)} paid` : ""}
                  </span>
                </span>
                <span className="flex-none text-right">
                  <span className="block text-[13px] font-semibold text-ink">
                    {money(b.balance)}
                  </span>
                  <span
                    className={cx(
                      "block text-[12px]",
                      ageTone(b.overdueDays) === "danger"
                        ? "text-danger"
                        : ageTone(b.overdueDays) === "warn"
                          ? "text-warn-ink"
                          : "text-muted",
                    )}
                  >
                    {b.overdueDays > 0 ? ageLabel(b.overdueDays) : "Not due"}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onRecordPayment(b.id)}
                  title={`Record a payment against ${b.billNo}`}
                >
                  Paid
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[6px] border border-dashed border-line bg-surface px-3 py-4 text-center text-[13px] text-muted">
            No open bills
          </div>
        )}
        {panel.bills.length ? (
          <div className="mt-1.5 text-[12px] text-muted">
            No bill named? Log <span className="font-medium text-body">Already paid</span> —
            it clears the oldest first.
          </div>
        ) : null}
      </div>

      {panel.promises.length ? (
        <div className="border-b border-line px-5 py-4">
          <PaneLabel>Promises</PaneLabel>
          {panel.promises.map((p, i) => (
            <div key={i} className="py-1" title={p.note ?? undefined}>
              <div className="flex items-center gap-2 text-[13px] text-ink">
                <span className="font-medium">{money(p.amount)}</span>
                <span className="text-muted">by {shortDate(p.date)}</span>
                {p.broken ? <Badge tone="danger">Missed</Badge> : null}
              </div>
              {p.note ? <div className="truncate text-[12px] text-muted">{p.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="px-5 py-4">
        <PaneLabel
          right={
            <Link
              href={`/crm/customers/${panel.customerId}`}
              className="text-[12px] text-brand no-underline"
            >
              Full record →
            </Link>
          }
        >
          Recent
        </PaneLabel>
        {panel.recent.length ? (
          panel.recent.map((h, i) => (
            <div key={i} className="border-t border-divider py-2 first:border-0">
              <div className="flex items-center gap-2">
                <Badge tone={h.channel === "Collections" ? "warn" : "brand"}>
                  {readable(h.outcome ?? h.channel)}
                </Badge>
                <span className="text-[12px] text-muted">{stamp(h.at)}</span>
              </div>
              {h.note ? (
                <div className="mt-0.5 line-clamp-2 text-[12px] text-body" title={h.note}>
                  {h.note}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <div className="text-[13px] text-muted">Nothing logged yet</div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- log pane */

/**
 * WHAT DID THEY SAY — every answer on the screen at once, as a grid of
 * buttons, and the fields it needs appear under it. The old flow was a list
 * to pick from, then a second page with a back link, so changing your mind
 * mid-call cost two clicks and the list disappeared.
 */
function LogPane(props: {
  outcomes: PayOutcomeDefinition[];
  def: PayOutcomeDefinition | null;
  onPick: (key: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  chips: string[];
  toggleChip: (label: string) => void;
  notes: string;
  setTyped: (v: string) => void;
  errors: Record<string, string>;
  outstanding: number;
  stage: number;
}) {
  const { def } = props;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <PaneLabel>What did they say?</PaneLabel>
      <div className="grid grid-cols-2 gap-2">
        {props.outcomes.map((o) => {
          const on = def?.key === o.key;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => props.onPick(o.key)}
              aria-pressed={on}
              className={cx(
                "flex h-10 cursor-pointer items-center gap-2 rounded-[6px] border px-3 text-left text-[13px]",
                on
                  ? "border-brand bg-brand-soft font-medium text-brand-hover"
                  : "border-line bg-surface text-ink hover:border-brand hover:bg-canvas",
              )}
            >
              <span
                className={cx(
                  "h-3.5 w-3.5 flex-none rounded-full border",
                  on ? "border-[4px] border-brand bg-surface" : "border-line-strong",
                )}
                aria-hidden
              />
              {o.label}
            </button>
          );
        })}
      </div>

      {def ? (
        <div className="mt-5 border-t border-divider pt-4">
          {def.amount || def.date ? (
            <div className="mb-3 grid grid-cols-2 gap-3">
              {def.amount ? (
                <Field
                  label={def.amount}
                  hint={`Outstanding ${money(props.outstanding)}`}
                  error={props.errors.amount ?? null}
                >
                  <Input
                    inputMode="numeric"
                    placeholder="1,00,000"
                    value={props.amount}
                    onChange={(e) => props.setAmount(e.target.value.replace(/[^0-9,]/g, ""))}
                  />
                </Field>
              ) : null}
              {def.date ? (
                <Field label={def.date} error={props.errors.date ?? null}>
                  <Input
                    type="date"
                    value={props.date}
                    onChange={(e) => props.setDate(e.target.value)}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          {def.chips.length ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {def.chips.map((c) => {
                const on = props.chips.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => props.toggleChip(c)}
                    className={cx(
                      "h-7 cursor-pointer rounded-full border px-3 text-[12px]",
                      on
                        ? "border-brand bg-brand-soft font-medium text-brand-hover"
                        : "border-line bg-surface text-body hover:bg-canvas",
                    )}
                  >
                    {on ? "✓ " : ""}
                    {c}
                  </button>
                );
              })}
            </div>
          ) : null}

          <Field label="Note">
            <VoiceTextarea
              rows={3}
              placeholder="Who you spoke to and what they said"
              value={props.notes}
              onChange={(e) => props.setTyped(e.target.value)}
              onDictate={props.setTyped}
            />
          </Field>

          {def.consequence || def.escalates ? (
            <div className="mt-3 space-y-1 text-[12px]">
              {def.consequence ? <div className="text-muted">→ {def.consequence}</div> : null}
              {def.escalates ? (
                <div className="text-danger">
                  → Moves them to stage {Math.min(3, props.stage + 1)} until they pay.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- message pane */

/**
 * THE MESSAGE AS THE CUSTOMER WILL SEE IT, and the buttons to send it. The
 * merge-field table is shown only when something is missing — when every
 * field is filled, the preview already shows each value in place.
 */
function MessagePane({
  wa,
  message,
  copied,
  confirming,
  onCopy,
  onMarkSent,
  phone,
}: {
  wa: { messages: TrackerRow[]; rules: RuleOutlook[] };
  message: ReminderPreview | null;
  copied: boolean;
  confirming: boolean;
  onCopy: () => void;
  onMarkSent: () => void;
  phone: string;
}) {
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const missing = message?.fields.filter((f) => !f.ok) ?? [];

  const history = (
    <div className="mt-5 border-t border-divider pt-3">
      <button
        type="button"
        onClick={() => setHistoryOpen((o) => !o)}
        className="cursor-pointer border-none bg-transparent p-0 text-[13px] text-brand"
        aria-expanded={historyOpen}
      >
        {historyOpen ? "Hide" : "Show"} earlier messages ({wa.messages.length}) {historyOpen ? "▴" : "▾"}
      </button>
      {historyOpen ? (
        <div className="mt-3 space-y-4">
          <MessageTimeline messages={wa.messages} />
          <div>
            <PaneLabel>Automatic reminders</PaneLabel>
            <RuleOutlookList rules={wa.rules} />
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!message) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="rounded-[6px] border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
          No payment reminder template yet — log a call instead.
        </div>
        {history}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium text-ink">{message.templateName}</span>
        <span className="text-muted">
          → {message.destination} ({message.destKind === "group" ? "group" : "personal"})
        </span>
      </div>

      {message.blocked ? (
        <div className="mb-3 rounded-[6px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
          {message.blockedReason}
          {missing.length ? (
            <div className="mt-1">
              Missing: <span className="font-medium">{missing.map((f) => f.label).join(", ")}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end rounded-[6px] border border-line bg-canvas p-4">
        <div className="max-w-[420px] rounded-[6px_6px_2px_6px] border border-brand-softer bg-brand-soft px-3 py-2.5">
          {message.body.split("\n").map((line, i) => (
            <span
              key={i}
              className="block min-h-[11px] text-[14px] leading-[21px] whitespace-pre-wrap text-ink"
            >
              {line}
            </span>
          ))}
        </div>
      </div>

      {message.mode === "automatic" ? (
        <div className="mt-3 text-[12px] text-muted">
          Goes from the business number. Ticks come back on their own.
        </div>
      ) : (
        /*
         * Copy, open, confirm — three buttons in a row, numbered. Only a
         * CONFIRMED send counts as contact (AGENTS.md), so the third step
         * stays, and it cannot be pressed before the first.
         */
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StepButton n={1} done={copied}>
            <Button
              size="sm"
              variant={copied ? "secondary" : "primary"}
              disabled={message.blocked}
              onClick={onCopy}
            >
              {copied ? "Copied ✓" : "Copy message"}
            </Button>
          </StepButton>
          <span className="text-line-strong">→</span>
          <StepButton n={2}>
            <a
              href={`https://wa.me/${phone.replace(/[^0-9]/g, "")}`}
              target="_blank"
              rel="noreferrer"
              title={`Paste into ${message.destination}`}
              className={cx(
                "inline-flex h-8 items-center rounded-[4px] border px-2.5 text-[13px] font-medium no-underline",
                copied
                  ? "border-brand bg-brand text-white hover:bg-brand-hover"
                  : "border-line-strong bg-surface text-body hover:bg-canvas",
              )}
            >
              Open WhatsApp ↗
            </a>
          </StepButton>
          <span className="text-line-strong">→</span>
          <StepButton n={3}>
            <Button
              size="sm"
              variant="primary"
              disabled={!copied || confirming}
              title={copied ? "Press once it has gone" : "Copy and send it first"}
              onClick={onMarkSent}
            >
              {confirming ? "Saving…" : "Mark as sent"}
            </Button>
          </StepButton>
        </div>
      )}

      {history}
    </div>
  );
}

function StepButton({
  n,
  done,
  children,
}: {
  n: number;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cx(
          "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium",
          done ? "bg-success-soft text-success" : "bg-divider text-body",
        )}
      >
        {done ? "✓" : n}
      </span>
      {children}
    </span>
  );
}
