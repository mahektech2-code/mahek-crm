"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Field,
  Input,
  MoneyInput,
  Select,
  SlowPayerBadge,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { useEscape } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  logPaymentFollowUpAction,
  queueMessage,
  confirmMessageSent,
  recordPayment,
} from "@/lib/actions/crm";
import { ageLabel, money, shortDate, stamp, today as todayISO } from "@/lib/format";
import type { FollowUpPanelData } from "@/lib/services/payment-followup-service";
import type { ReminderPreview } from "@/lib/services/whatsapp-service";
import type { PayOutcomeDefinition } from "@/lib/services/payment-followup-service";

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

type Tab = "account" | "log" | "msg";

export function PaymentPanel(props: {
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
  if (!props.target) return null;
  // Remounted per customer: every field starts clean rather than being reset
  // in an effect. See AGENTS.md on the React Compiler rules.
  return <PanelBody key={props.target.customerId} {...props} target={props.target} />;
}

function PanelBody({
  target,
  outcomes,
  onClose,
  onMove,
  onSavedNext,
  onSaved,
  onRefresh,
}: {
  target: PanelTarget;
  outcomes: PayOutcomeDefinition[];
  onClose: () => void;
  onMove: (delta: number) => void;
  onSavedNext: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const { run, push } = useToast();

  const [tab, setTab] = React.useState<Tab>("account");
  const [panel, setPanel] = React.useState<FollowUpPanelData | null>(null);
  const [message, setMessage] = React.useState<ReminderPreview | null>(null);
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
    setBusy(true);
    try {
      const result = await run(
        logPaymentFollowUpAction({
          customerId: panel.customerId,
          outcome: def.key,
          amount: amount.trim() ? Number(amount.replace(/[^0-9]/g, "")) : undefined,
          date: date || undefined,
          notes: notes.trim() || undefined,
          chips,
          idempotencyKey: idempotencyKey.current,
        }),
      );
      if (result.ok) {
        setErrors({});
        if (next) onSavedNext();
        else onSaved();
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

  return (
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
        <div className="flex-none">
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[22px] leading-7 font-semibold text-ink">
                  {panel?.name ?? "Loading…"}
                </span>
                {panel ? (
                  <>
                    <Badge
                      tone={
                        panel.stage === 3 ? "danger" : panel.stage === 2 ? "warn" : "neutral"
                      }
                    >
                      Stage {panel.stage}
                    </Badge>
                    {panel.slowPayer ? <SlowPayerBadge /> : null}
                    {panel.floorReason ? (
                      <span title={panel.floorReason}>
                        <Badge tone="warn">Held at this stage</Badge>
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
              {panel ? (
                <div className="mt-1 flex items-center gap-2 text-sm text-muted">
                  <span>{panel.contactPerson}</span>
                  <span>·</span>
                  <span className="font-medium text-ink">{panel.phone}</span>
                  <button
                    type="button"
                    title="Copy number"
                    onClick={() => {
                      void navigator.clipboard.writeText(panel.phone);
                      push("Phone number copied");
                    }}
                    className="inline-flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-muted hover:bg-canvas hover:text-body"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="12" height="12" rx="2" />
                      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
                    </svg>
                  </button>
                  <span>·</span>
                  <span>{panel.city}</span>
                  <span>·</span>
                  <span>{panel.ownerName ?? "Unassigned"}</span>
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

          {/* ------------------------------------------------ context bar */}
          <div className="flex items-center gap-5 border-y border-line bg-canvas px-6 py-2.5">
            <Stat label="Outstanding" tone={panel?.stage === 3 ? "danger" : undefined}>
              {money(panel?.totalOverdue ?? 0)}
            </Stat>
            <Rule />
            <Stat
              label="Oldest bill"
              tone={
                (panel?.oldestOverdueDays ?? 0) > 45
                  ? "danger"
                  : (panel?.oldestOverdueDays ?? 0) > 15
                    ? "warn"
                    : undefined
              }
            >
              {panel ? (panel.oldestOverdueDays ? ageLabel(panel.oldestOverdueDays) : "Not due") : "—"}
            </Stat>
            <Rule />
            <Stat label="Bills overdue">{panel?.overdueBillCount ?? 0}</Stat>
            <Rule />
            <Stat label="Last follow-up">
              {panel?.lastFollowUpAt ? stamp(panel.lastFollowUpAt) : "Never"}
            </Stat>
            <span className="flex-1" />
            <div className="text-right">
              <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Prescribed now
              </div>
              <div className="text-sm font-semibold text-brand-hover">
                {panel?.nextAction ?? "—"}
              </div>
            </div>
          </div>

          {/* ----------------------------------------------------- tabs */}
          <div className="flex items-center border-b border-line px-6">
            {(
              [
                ["account", "Account"],
                ["log", "Log follow-up"],
                ["msg", message?.mode === "automatic" ? "Send message" : "Prepare message"],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cx(
                  "mr-5 h-9 cursor-pointer border-none bg-transparent px-1 text-sm",
                  tab === key
                    ? "border-b-2 border-brand font-medium text-brand-hover"
                    : "border-b-2 border-transparent text-muted",
                )}
              >
                {label}
                {key === "log" && dirty ? (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" />
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* --------------------------------------------------------- body */}
        {loading ? (
          <div className="flex-1 px-6 py-10 text-sm text-muted">Loading the account…</div>
        ) : !panel ? (
          <div className="flex-1 px-6 py-10 text-sm text-muted">
            This customer is no longer on the follow-up list — their bills may have been
            paid, or they are outside your book.
          </div>
        ) : tab === "account" ? (
          <AccountTab panel={panel} onRecordPayment={setPayingBill} />
        ) : tab === "log" ? (
          <LogTab
            outcomes={outcomes}
            def={def}
            onPick={(key) => {
              setOutcome(key);
              setAmount("");
              setDate("");
              setChips([]);
              setTyped("");
              setErrors({});
            }}
            onBack={() => guard(() => { setOutcome(null); setChips([]); setTyped(""); setAmount(""); setDate(""); })}
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
            name={panel.name}
          />
        ) : (
          <MessageTab
            message={message}
            copied={Boolean(copiedId)}
            onCopy={copyMessage}
            phone={panel.phone}
          />
        )}

        {/* ------------------------------------------------------- footer */}
        <div className="flex flex-none items-center gap-2.5 border-t border-line bg-surface px-6 py-3">
          {target.total > 1 ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[13px] text-muted">
                Customer {target.index + 1} of {target.total}
              </span>
              <button
                type="button"
                disabled={target.index <= 0}
                onClick={() => guard(() => onMove(-1))}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 border-none bg-transparent px-2.5 text-[13px] text-muted disabled:cursor-not-allowed disabled:text-line-strong"
              >
                ◀ Previous
              </button>
              <span className="text-line">|</span>
              <button
                type="button"
                disabled={target.index >= target.total - 1}
                onClick={() => guard(() => onMove(1))}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 border-none bg-transparent px-2.5 text-[13px] text-muted disabled:cursor-not-allowed disabled:text-line-strong"
              >
                Next ▶
              </button>
            </span>
          ) : null}
          <span className="flex-1" />
          <Button variant="secondary" onClick={close}>
            {tab === "log" && def ? "Cancel" : "Close"}
          </Button>
          {tab === "account" ? (
            <Button onClick={() => setTab("log")}>Log the follow-up ▸</Button>
          ) : null}
          {tab === "log" && def ? (
            <>
              <Button
                variant="secondary"
                disabled={blocked || busy}
                title={blocked ? blockedTitle(def) : undefined}
                onClick={() => save(false)}
              >
                Save log
              </Button>
              <Button
                disabled={blocked || busy}
                title={blocked ? blockedTitle(def) : undefined}
                onClick={() => save(true)}
              >
                Save &amp; next ▸
              </Button>
            </>
          ) : null}
          {tab === "msg" ? (
            <Button
              disabled={Boolean(message?.blocked) || confirming}
              title={message?.blocked ? "Fill the missing merge fields first" : undefined}
              onClick={() =>
                message?.mode === "automatic" || copiedId ? markSent() : copyMessage()
              }
            >
              {message?.mode === "automatic"
                ? "Send message"
                : copiedId
                  ? "Mark as sent"
                  : "Copy message first"}
            </Button>
          ) : null}
        </div>
      </div>

      {bill ? (
        <RecordPaymentForm
          key={bill.id}
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
  );
}

/** A payment against one named bill. Oldest-first allocation is the "Already
 *  paid" outcome on the log tab; this is for "they paid bill MM/4210". */
function RecordPaymentForm({
  bill,
  customerName,
  onClose,
  onDone,
}: {
  bill: FollowUpPanelData["bills"][number];
  customerName: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { run } = useToast();
  const [amount, setAmount] = React.useState(String(Math.round(bill.balance / 100)));
  const [mode, setMode] = React.useState("Bank transfer");
  const [reference, setReference] = React.useState("");
  const [receivedOn, setReceivedOn] = React.useState(todayISO());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  useEscape(onClose);

  // What the bill will read after this is saved, shown while it is typed —
  // the same "here is what happens next" the panel's context bar gives.
  const entered = Number(amount.replace(/[^0-9]/g, "")) * 100;
  const leftOpen = bill.balance - entered;

  return (
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
              error={error}
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
            <Field label="Mode">
              <Select
                className="w-full"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                {["Bank transfer", "Cheque", "Cash", "UPI"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" hint="UTR, cheque number — optional">
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR or cheque number"
              />
            </Field>
          </div>

          {leftOpen < 0 ? (
            <div className="mt-3 rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
              That is {money(-leftOpen)} more than {bill.billNo} has open. Record what
              landed against this bill, and the rest against the next one.
            </div>
          ) : null}
        </div>

        {/* ------------------------------------------------------- footer */}
        <div className="flex items-center gap-2.5 border-t border-line bg-surface px-6 py-3">
          <span className="text-[13px] text-muted">
            Outstanding is rebuilt from the bills after this.
          </span>
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
                    receivedOn,
                  }),
                );
                if (result.ok) await onDone();
                else setError(result.fieldErrors?.[0]?.message ?? result.error);
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

/* ------------------------------------------------------------ account tab */

function AccountTab({
  panel,
  onRecordPayment,
}: {
  panel: FollowUpPanelData;
  onRecordPayment: (billId: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="border-b border-divider bg-brand-soft px-6 py-3.5">
        <div className="text-sm text-ink">
          Stage {panel.stage} says: {panel.nextAction.toLowerCase()}. Last follow-up{" "}
          {panel.lastFollowUpAt ? stamp(panel.lastFollowUpAt) : "never"}.
        </div>
        <div className="mt-0.5 text-[13px] text-muted">
          Stage {panel.stage} — {panel.stageName} · Credit terms {panel.creditDays} days ·{" "}
          {panel.slowPayer ? "flagged as a slow payer" : "no slow-payer flag"}
          {panel.floorReason ? ` · ${panel.floorReason}` : ""}
        </div>
      </div>

      <div className="border-b border-divider px-6 py-4">
        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Bills outstanding
        </div>
        {panel.bills.length ? (
          <div className="overflow-hidden rounded-[4px] border border-line">
            <div className="flex items-center gap-3 bg-canvas px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              <span className="w-[132px] flex-none">Bill</span>
              <span className="w-[76px] flex-none">Due</span>
              <span className="flex-1">Amount</span>
              <span className="w-24 flex-none text-right">Balance</span>
              <span className="w-[76px] flex-none text-right">Overdue</span>
              <span className="w-[132px] flex-none" />
            </div>
            {panel.bills.map((b, i) => (
              <div
                key={b.id}
                className={cx(
                  "flex items-center gap-3 px-3 py-2",
                  i ? "border-t border-canvas" : "",
                  b.overdueDays > 45 ? "bg-danger-soft" : "bg-surface",
                )}
              >
                <span
                  title={b.billNo}
                  className="w-[132px] flex-none truncate text-sm font-medium text-ink"
                >
                  {b.billNo}
                </span>
                <span className="w-[76px] flex-none whitespace-nowrap text-[13px] text-muted">
                  {shortDate(b.dueDate)}
                </span>
                <span className="flex-1 text-sm text-body">
                  {money(b.amount)} · paid {money(b.paid)}
                  {b.disputed ? " · disputed" : ""}
                </span>
                <span className="w-24 flex-none text-right text-sm font-medium text-ink">
                  {money(b.balance)}
                </span>
                <span
                  className={cx(
                    "w-[76px] flex-none text-right text-[13px] font-medium",
                    b.overdueDays > 45
                      ? "text-danger"
                      : b.overdueDays > 15
                        ? "text-warn-ink"
                        : "text-muted",
                  )}
                >
                  {b.overdueDays > 0 ? ageLabel(b.overdueDays) : "Not due"}
                </span>
                <span className="w-[132px] flex-none text-right">
                  <Button size="sm" variant="secondary" onClick={() => onRecordPayment(b.id)}>
                    Record payment
                  </Button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[4px] border border-dashed border-line px-3 py-5 text-center text-sm text-muted">
            No open bills on this account.
          </div>
        )}
        <div className="mt-2 text-[13px] text-muted">
          Record against a named bill here. For &ldquo;they paid ₹50,000&rdquo; with no
          bill named, log <span className="font-medium text-ink">Already paid</span> on the
          next tab — that spreads it over the oldest bills first.
        </div>
      </div>

      {panel.promises.length ? (
        <div className="border-b border-divider px-6 py-4">
          <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Promises on record
          </div>
          {panel.promises.map((p, i) => (
            <div key={i} className="border-t border-canvas py-1.5 first:border-0">
              <div className="text-sm font-medium text-ink">
                {money(p.amount)} promised by {shortDate(p.date)}
                {p.broken ? (
                  <span className="ml-2 text-[13px] font-normal text-danger">
                    that date has passed
                  </span>
                ) : null}
              </div>
              <div className="text-[13px] text-muted">{p.note ?? "No note"}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Last three interactions
        </div>
        {panel.recent.length ? (
          panel.recent.map((h, i) => (
            <div key={i} className="flex gap-3 border-t border-canvas py-2 first:border-0">
              <span className="w-[110px] flex-none whitespace-nowrap text-[13px] text-muted">
                {stamp(h.at)}
              </span>
              <span className="min-w-0 flex-1">
                <Badge tone={h.channel === "Collections" ? "warn" : "brand"}>
                  {h.outcome ?? h.channel}
                </Badge>
                <span className="mt-0.5 block text-[13px] text-muted">{h.note ?? "—"}</span>
              </span>
            </div>
          ))
        ) : (
          <div className="text-sm text-muted">Nothing logged against this customer yet.</div>
        )}
        <Link
          href={`/crm/customers/${panel.customerId}`}
          className="mt-3 inline-block text-[13px] text-brand"
        >
          Open the full customer record ▸
        </Link>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- log tab */

function LogTab(props: {
  outcomes: PayOutcomeDefinition[];
  def: PayOutcomeDefinition | null;
  onPick: (key: string) => void;
  onBack: () => void;
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
  name: string;
}) {
  const { def } = props;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-[720px]">
        {!def ? (
          <div>
            <div className="mb-1 text-[15px] font-semibold text-ink">What did they say?</div>
            <div className="mb-3.5 text-[13px] text-muted">
              Pick the outcome — it decides what gets created and whether the stage moves.
            </div>
            {props.outcomes.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => props.onPick(o.key)}
                className="mb-2 flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[4px] border border-line bg-surface px-3 text-left text-sm text-ink hover:border-brand hover:bg-canvas"
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={props.onBack}
              className="mb-2.5 inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-[13px] text-muted"
            >
              ◀ All outcomes
            </button>
            <div className="mb-3 text-[15px] font-semibold text-ink">{def.label}</div>

            {def.amount ? (
              <Field
                label={`${def.amount} · required`}
                hint={`Outstanding is ${money(props.outstanding)}.`}
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
              <Field
                label={`${def.date} · required`}
                error={props.errors.date ?? null}
                hint="It becomes the reminder that chases this."
              >
                <Input
                  type="date"
                  value={props.date}
                  onChange={(e) => props.setDate(e.target.value)}
                  className="w-[200px]"
                />
              </Field>
            ) : null}

            <div className="mb-3.5">
              <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                Quick notes
              </span>
              <div className="flex flex-wrap gap-2">
                {def.chips.map((c) => {
                  const on = props.chips.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => props.toggleChip(c)}
                      className={cx(
                        "h-7 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
                        on
                          ? "border-brand bg-brand-soft font-medium text-brand-hover"
                          : "border-line bg-surface text-body hover:bg-canvas",
                      )}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>

            <Field
              label="Notes"
              hint="Quick notes add to this — you can still edit or type your own."
            >
              <Textarea
                rows={4}
                placeholder="Who you spoke to and exactly what they said"
                value={props.notes}
                onChange={(e) => props.setTyped(e.target.value)}
              />
            </Field>

            {def.consequence ? (
              <div className="mt-3 rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
                {def.consequence}
              </div>
            ) : null}
            {def.escalates ? (
              <div className="mt-2 rounded-[4px] border border-danger-soft bg-danger-soft px-2.5 py-2 text-[13px] text-danger">
                Saving this holds {props.name} at stage {Math.min(3, props.stage + 1)} until
                they pay, which prescribes a firmer follow-up. Their stage still rises with
                the age of the debt.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ message tab */

function MessageTab({
  message,
  copied,
  onCopy,
  phone,
}: {
  message: ReminderPreview | null;
  copied: boolean;
  onCopy: () => void;
  phone: string;
}) {
  if (!message) {
    return (
      <div className="flex-1 px-6 py-10 text-sm text-muted">
        No active payment reminder template. A manager can write one on the WhatsApp
        screen — until then, log a call instead.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-[720px]">
        <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
          {message.templateName} · going to {message.destination} (
          {message.destKind === "group" ? "group" : "personal number"})
        </div>

        {message.blocked ? (
          <div className="mb-3 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-3 py-2.5 text-sm leading-[21px] text-warn-ink">
            {message.blockedReason}
          </div>
        ) : null}

        <div className="mb-3 overflow-hidden rounded-[4px] border border-line">
          <div className="bg-canvas px-2.5 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Merge fields
          </div>
          {message.fields.map((f) => (
            <div
              key={f.label}
              className={cx(
                "flex items-center justify-between gap-3 border-b border-canvas px-2.5 py-1.5 last:border-0",
                f.ok ? "bg-surface" : "bg-warn-soft",
              )}
            >
              <span className="text-[13px] text-muted">{f.label}</span>
              <span
                className={cx(
                  "text-[13px] font-medium",
                  f.ok ? "text-ink" : "text-warn-ink",
                )}
              >
                {f.value || "Missing"}
              </span>
            </div>
          ))}
        </div>

        <div className="flex justify-end rounded-[6px] border border-line bg-canvas p-5">
          <div className="max-w-[340px] rounded-[6px_6px_2px_6px] border border-brand-softer bg-brand-soft px-3 py-2.5">
            {message.body.split("\n").map((line, i) => (
              <span
                key={i}
                className="block min-h-[11px] text-[15px] leading-[22px] whitespace-pre-wrap text-ink"
              >
                {line}
              </span>
            ))}
          </div>
        </div>

        {message.mode === "automatic" ? (
          <div className="mt-4 rounded-[6px] border border-line p-4 text-[13px] text-muted">
            Sends from the connected business number and updates the last follow-up date.
            Delivery and read status come back automatically.
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-[6px] border border-line">
            <div className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
              Send it in three steps
            </div>
            <Step n={1} title="Copy the message">
              <Button
                variant={copied ? "secondary" : "primary"}
                disabled={message.blocked}
                onClick={onCopy}
                className="w-full"
              >
                {copied ? "Copied" : "Copy message"}
              </Button>
            </Step>
            <Step n={2} title="Send it from WhatsApp" dim={!copied}>
              <a
                href={`https://wa.me/${phone.replace(/[^0-9]/g, "")}`}
                target="_blank"
                rel="noreferrer"
                className="flex h-9 w-full items-center justify-center rounded-[4px] border border-line-strong bg-surface text-sm font-medium text-body no-underline hover:bg-canvas"
              >
                Open WhatsApp Web ↗
              </a>
              <span className="mt-1.5 block text-[13px] text-muted">
                Paste into: <span className="font-medium text-ink">{message.destination}</span>
              </span>
            </Step>
            <Step n={3} title="Confirm" dim={!copied} last>
              <span className="block text-[13px] text-muted">
                Once it has gone, press <span className="font-medium text-ink">Mark as sent</span>{" "}
                below. Only a confirmed send counts as contact.
              </span>
            </Step>
            <div className="bg-canvas px-4 py-2.5 text-[13px] text-muted">
              Confirming updates the last follow-up date and holds this customer back in the
              call log.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
  dim,
  last,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  dim?: boolean;
  last?: boolean;
}) {
  return (
    <div className={cx("flex gap-3 px-4 py-3.5", last ? "" : "border-b border-divider")}>
      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-divider text-[11px] font-medium text-body">
        {n}
      </span>
      <span className="flex-1">
        <span className="mb-2 block text-sm font-medium text-ink">{title}</span>
        <span className={cx("block", dim ? "pointer-events-none opacity-40" : "")}>
          {children}
        </span>
      </span>
    </div>
  );
}
