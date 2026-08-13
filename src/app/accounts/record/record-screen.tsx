"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { DictateButton, joinDictation } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import {
  confirmAsMatchAction,
  matchesForEntryAction,
  recordReceiptAction,
} from "@/lib/actions/payments";
import type { ReceiptMatchView } from "@/lib/services/receipt-service";
import { longDate, money, parseRupees } from "@/lib/format";
import {
  allocate,
  type AllocatableBill,
  type AllocationMode,
} from "@/lib/engines/allocation";
import { CustomerSearch, type Hit } from "../customer-search";
import { Banner, Pill, ScreenHeader } from "../parts";

/* ---------------------------------------------------------------------------
 * Record a payment.
 *
 * Money is in front of somebody — against what?
 *
 * The preview on this screen runs the SAME pure function the server runs. That
 * is the whole point of it: accounts are deciding where the money goes, and a
 * preview that disagreed with the save would be worse than no preview at all.
 * ------------------------------------------------------------------------- */

type OpenBill = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  daysOverdue: number;
  /** Paise already claimed against this bill by a reported, unconfirmed receipt. */
  reported: number;
};

export function RecordScreen({
  confirmsOnSave,
  today,
  modes,
  referenceRequiredModes,
  datedModes,
  allowOnAccount,
}: {
  confirmsOnSave: boolean;
  today: string;
  modes: string[];
  referenceRequiredModes: string[];
  /** Modes whose instrument carries a date of its own — see payments.datedModes. */
  datedModes: string[];
  allowOnAccount: boolean;
}) {
  const [picked, setPicked] = React.useState<Hit | null>(null);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="Record a payment"
          subtitle={
            confirmsOnSave
              ? "Money you can see. What is entered here is confirmed as it is written — it moves the bills immediately."
              : "What you record here waits for accounts to confirm it. The customer stops being chased for it in the meantime."
          }
        />

        {picked ? (
          <PaymentForm
            // A different customer remounts the form rather than being reset by
            // an effect — no amount or split survives the switch.
            key={picked.customerId}
            customer={picked}
            confirmsOnSave={confirmsOnSave}
            today={today}
            modes={modes}
            referenceRequiredModes={referenceRequiredModes}
            datedModes={datedModes}
            allowOnAccount={allowOnAccount}
            onBack={() => setPicked(null)}
          />
        ) : (
          <CustomerSearch
            title="Who has paid?"
            hint="Customer name, phone, bill number, order number, or the reference on the transfer."
            placeholder="Shree Paints, MMI/26-27/1119, UTR904312…"
            onPick={setPicked}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- form */

function PaymentForm({
  customer,
  confirmsOnSave,
  today,
  modes,
  referenceRequiredModes,
  datedModes,
  allowOnAccount,
  onBack,
}: {
  customer: Hit;
  confirmsOnSave: boolean;
  today: string;
  modes: string[];
  referenceRequiredModes: string[];
  /** Modes whose instrument carries a date of its own — see payments.datedModes. */
  datedModes: string[];
  allowOnAccount: boolean;
  onBack: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();

  const [bills, setBills] = React.useState<OpenBill[] | null>(null);
  const [onAccountHeld, setOnAccountHeld] = React.useState(0);
  const [amountText, setAmountText] = React.useState("");
  const [receivedAt, setReceivedAt] = React.useState(today);
  const [mode, setMode] = React.useState(modes[0] ?? "Bank transfer");
  const [reference, setReference] = React.useState("");
  /** The date written on the cheque — see `payments.datedModes`. */
  const [instrumentDate, setInstrumentDate] = React.useState("");
  const [note, setNote] = React.useState("");
  const [allocation, setAllocation] = React.useState<AllocationMode>("auto");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  // Minted once per form. A retried save is the same payment, not a second one.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());

  /*
   * MONEY SOMEBODY HAS ALREADY WRITTEN DOWN.
   *
   * A telecaller hears about a payment on the phone days before the transfer
   * shows up on a statement. Both records are honest and both describe one
   * payment; entered separately, the customer is credited twice, one bill is
   * settled and the other sits on account, and somebody untangles it months
   * later against a customer who is certain they paid once.
   */
  const [matches, setMatches] = React.useState<ReceiptMatchView[]>([]);
  const [merging, setMerging] = React.useState<ReceiptMatchView | null>(null);
  /** Typed back before a merge. See `confirmAsMatch` — it is checked there too. */
  const [typed, setTyped] = React.useState("");
  const [mergeError, setMergeError] = React.useState<string | null>(null);
  /** "I have looked, and this is a different payment." */
  const [separate, setSeparate] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/payments/open-bills?customerId=${customer.customerId}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d: { bills: OpenBill[]; onAccount: number }) => {
        setBills(d.bills ?? []);
        setOnAccountHeld(d.onAccount ?? 0);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [customer.customerId]);

  const amount = parseRupees(amountText) ?? 0;

  /*
   * Asked as the amount is typed, debounced, and re-asked when the reference
   * or the date changes — a reference typed off the statement is often what
   * turns a maybe into a certainty, and it usually gets typed last.
   */
  React.useEffect(() => {
    let live = true;
    // Everything runs off the timer, including clearing. Setting state
    // synchronously in an effect body cascades a render, and the React
    // Compiler rules refuse it — the debounce this already needed is also
    // what keeps that honest.
    const timer = setTimeout(() => {
      if (!live) return;
      if (amount <= 0) {
        setMatches([]);
        return;
      }
      matchesForEntryAction(customer.customerId, {
        amount,
        receivedAt,
        mode,
        reference: reference.trim() || null,
      }).then((r) => {
        if (!live) return;
        setMatches(r.ok ? r.data : []);
        // A changed entry is a changed question, so an acknowledgement made
        // about the old one no longer applies.
        setSeparate(false);
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [customer.customerId, amount, receivedAt, mode, reference]);

  // Only the near-certain ones stand in the way. A close match is a question,
  // and making somebody dismiss a question before they can do their job is how
  // a warning becomes something people click through without reading.
  const blockingMatch = matches.find((m) => m.blocking) ?? null;

  const allocatable: AllocatableBill[] = (bills ?? []).map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: b.amount,
    // Money already claimed against a bill is not offered to a second receipt.
    // Two people writing down one transfer is the ordinary failure here.
    paid: b.paid + b.reported,
  }));

  const preview = allocate(allocatable, {
    mode: allocation,
    amount,
    selectedBillIds: selected,
    custom: Object.fromEntries(
      Object.entries(custom).map(([k, v]) => [k, parseRupees(v) ?? 0]),
    ),
    allowOnAccount,
  });

  // Only binding on somebody who can confirm the money — a telecaller relaying
  // what a customer said usually has no UTR, and refusing the save would lose
  // the claim rather than improve it.
  const referenceMissing =
    confirmsOnSave && referenceRequiredModes.includes(mode) && !reference.trim();

  // Asked of everybody, unlike the reference: a cheque without its date is a
  // cheque nobody can act on, and the customer telling us about it is holding
  // it while they speak.
  const instrumentDateMissing = datedModes.includes(mode) && !instrumentDate;
  const postDated = Boolean(instrumentDate && instrumentDate > today);
  const settleTotal = (bills ?? [])
    .filter((b) => selected.includes(b.id))
    .reduce((s, b) => s + Math.max(0, b.balance - b.reported), 0);

  const blocked =
    amount <= 0
      ? "Enter the amount received"
      : preview.errors[0]
        ? preview.errors[0]
        : referenceMissing
          ? "A reference is required"
          : instrumentDateMissing
            ? `Enter the date on the ${mode.toLowerCase()}`
            : blockingMatch && !separate
            ? // Not refused — made deliberate. A genuine second payment of the
              // same amount is ordinary, and blocking it outright would teach
              // people to work around this screen.
              "Say whether this is the same money as the payment already recorded"
            : busy
              ? "Saving…"
              : undefined;

  const hint =
    allocation === "settle"
      ? "Tick what this payment clears"
      : allocation === "custom"
        ? "Type how much goes against each"
        : "Oldest first";

  return (
    <>
      <div className="mb-4 flex items-center gap-4 rounded-[6px] border border-line bg-surface px-5 py-3.5">
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-semibold text-ink">
            {customer.customerName}
          </span>
          <span className="mt-px block text-[13px] text-muted">
            {money(customer.outstanding)} owed
            {onAccountHeld ? ` · ${money(onAccountHeld)} already on account` : ""}
          </span>
        </span>
        <button
          onClick={onBack}
          className="h-8 flex-none cursor-pointer border-none bg-transparent px-3 text-sm font-medium text-brand hover:underline"
        >
          Someone else
        </button>
      </div>

      <div className="grid items-start gap-4 [grid-template-columns:minmax(0,1fr)_360px]">
        {/* ---------------------------------------------------- the bills */}
        <section className="min-w-0 overflow-hidden rounded-[6px] border border-line bg-surface">
          <div className="flex items-baseline justify-between gap-3 border-b border-divider px-5 py-3.5">
            <h2 className="text-lg font-semibold text-ink">Open bills</h2>
            <span className="text-[13px] text-muted">{hint}</span>
          </div>

          {bills === null ? (
            <p className="px-5 py-10 text-center text-[13px] text-muted">
              Loading the account…
            </p>
          ) : bills.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <div className="text-[15px] font-semibold text-ink">Nothing open</div>
              <p className="mt-1 text-sm text-pretty text-muted">
                This customer owes nothing. A payment recorded now sits on account and is
                offered against their next bill.
              </p>
            </div>
          ) : (
            bills.map((b, i) => {
              const line = preview.lines.find((l) => l.billId === b.id);
              const free = Math.max(0, b.balance - b.reported);
              const ticked = selected.includes(b.id);
              return (
                <div
                  key={b.id}
                  className={cx(
                    "flex items-center gap-3 px-3.5 py-2.5",
                    i ? "border-t border-canvas" : "",
                    line ? "bg-brand-soft" : "bg-surface",
                  )}
                >
                  {allocation === "settle" ? (
                    <input
                      type="checkbox"
                      aria-label={`Settle ${b.billNo}`}
                      checked={ticked}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id),
                        )
                      }
                      className="h-[15px] w-[15px] flex-none accent-brand"
                    />
                  ) : null}

                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{b.billNo}</span>
                    <span className="mt-px block text-[13px] text-muted">
                      {longDate(b.billDate)}
                      {b.reported > 0 ? ` · ${money(b.reported)} already reported` : ""}
                    </span>
                  </span>

                  <span className="flex flex-none items-center gap-2">
                    <span className="text-[13px] text-muted">{longDate(b.dueDate)}</span>
                    {b.daysOverdue > 0 ? <Pill tone="danger">{b.daysOverdue}d</Pill> : null}
                  </span>

                  <span className="w-[110px] flex-none text-right text-sm font-medium tabular-nums text-ink">
                    {money(free)}
                  </span>

                  {allocation === "custom" ? (
                    <input
                      value={custom[b.id] ?? ""}
                      onChange={(e) =>
                        setCustom((prev) => ({
                          ...prev,
                          [b.id]: e.target.value.replace(/[^0-9]/g, ""),
                        }))
                      }
                      placeholder="0"
                      aria-label={`Amount against ${b.billNo}`}
                      className={cx(
                        "h-7.5 w-[110px] flex-none rounded-[4px] border px-2 text-right text-sm tabular-nums focus:outline-none",
                        line ? "border-brand" : "border-line",
                      )}
                    />
                  ) : (
                    <span className="w-[110px] flex-none text-right text-sm font-medium tabular-nums text-[#5223E0]">
                      {line ? money(line.amount) : "—"}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </section>

        {/* ---------------------------------------------------- the money */}
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
            <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              The payment
            </div>

            <Label>Amount received</Label>
            <span className="flex h-9.5 items-center rounded-[4px] border border-line bg-surface px-2.5 focus-within:border-brand">
              <span className="mr-1 text-muted">₹</span>
              <input
                autoFocus
                value={amountText}
                onChange={(e) => setAmountText(e.target.value.replace(/[^0-9,]/g, ""))}
                placeholder="50,000"
                aria-label="Amount received in rupees"
                className="w-full flex-1 border-none bg-transparent text-[15px] tabular-nums outline-none"
              />
            </span>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <Label>Received on</Label>
                <input
                  type="date"
                  max={today}
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                  className={FIELD}
                />
              </div>
              <div>
                <Label>How</Label>
                <select
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value);
                    setReference("");
                    // A cheque date belongs to a cheque. Left behind on a
                    // switch to Cash it would be saved against a mode that
                    // carries no date, which the service refuses anyway.
                    setInstrumentDate("");
                  }}
                  className={FIELD}
                >
                  {modes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3">
              <Label>Reference</Label>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR904312"
                className={cx(FIELD, amount > 0 && referenceMissing ? "border-danger" : "")}
              />
              <p
                className={cx(
                  "mt-1 text-[13px] text-pretty",
                  amount > 0 && referenceMissing ? "text-danger" : "text-muted",
                )}
              >
                {amount > 0 && referenceMissing
                  ? "A reference is required for this mode."
                  : confirmsOnSave && referenceRequiredModes.includes(mode)
                    ? "The UTR or cheque number. This is how the payment is found in the bank statement again."
                    : "Optional — but give it if the customer has it"}
              </p>
            </div>

            {/*
              The date written ON the cheque, which is not the day we received
              it. A cheque handed over today and dated the 20th cannot be
              banked until the 20th, and the two dates answer different
              questions — when did we get it, and when can it be banked.

              Asked of everybody, unlike the reference. The reasoning that
              spares a telecaller a UTR does not carry across: a customer who
              says they have paid by cheque is holding the cheque, and "what
              date is on it" is a question that can be asked on the same call.
            */}
            {datedModes.includes(mode) ? (
              <div className="mt-3">
                <Label>{mode} date</Label>
                <input
                  type="date"
                  value={instrumentDate}
                  onChange={(e) => setInstrumentDate(e.target.value)}
                  className={cx(
                    FIELD,
                    amount > 0 && instrumentDateMissing ? "border-danger" : "",
                  )}
                />
                <p
                  className={cx(
                    "mt-1 text-[13px] text-pretty",
                    amount > 0 && instrumentDateMissing ? "text-danger" : "text-muted",
                  )}
                >
                  {amount > 0 && instrumentDateMissing
                    ? `Enter the date written on the ${mode.toLowerCase()}.`
                    : postDated
                      ? `Post-dated — it cannot be banked until ${longDate(instrumentDate)}, and ${customer.customerName} is not chased for it until then.`
                      : `The date on the ${mode.toLowerCase()} itself, not the day it was handed over. Past or future are both fine.`}
                </p>
              </div>
            ) : null}

            <div className="mt-3">
              <Label>Note</Label>
              <span className="relative block">
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Part payment against the June bills…"
                  className="w-full resize-y rounded-[4px] border border-line px-2.5 py-2 pr-9 text-sm focus:border-brand focus:outline-none"
                />
                <DictateButton
                  hasExistingText={note.trim().length > 0}
                  onImport={(text, replace) =>
                    setNote(replace ? text : joinDictation(note, text))
                  }
                  className="absolute right-2 bottom-3"
                />
              </span>
            </div>
          </section>

          <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
            <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Against which bills
            </div>

            {(
              [
                ["auto", "Oldest bill first"],
                ["settle", "Settle particular bills"],
                ["custom", "Split it myself"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setAllocation(key)}
                className={cx(
                  "mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-[4px] border px-3 py-2.25 text-left text-sm",
                  allocation === key
                    ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                    : "border-line bg-surface text-body hover:bg-canvas",
                )}
              >
                <span
                  className={cx(
                    "h-3.5 w-3.5 flex-none rounded-full border",
                    allocation === key
                      ? "border-brand bg-brand shadow-[inset_0_0_0_3px_#FFFFFF]"
                      : "border-line-strong bg-surface",
                  )}
                />
                {label}
              </button>
            ))}

            {allocation === "settle" && selected.length && settleTotal !== amount ? (
              <button
                onClick={() => setAmountText(String(Math.round(settleTotal / 100)))}
                className="mt-1 cursor-pointer border-none bg-transparent p-0 text-[13px] font-medium text-brand hover:underline"
              >
                Use {money(settleTotal)} — what those bills come to
              </button>
            ) : null}

            <dl className="mt-3 border-t border-divider pt-3">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-sm text-muted">Against bills</dt>
                <dd className="text-sm font-medium tabular-nums text-ink">
                  {money(preview.allocated)}
                </dd>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <dt className="text-sm text-muted">On account</dt>
                <dd
                  className={cx(
                    "text-sm tabular-nums",
                    preview.onAccount ? "font-medium text-warn-ink" : "text-muted",
                  )}
                >
                  {money(preview.onAccount)}
                </dd>
              </div>
            </dl>

            {preview.errors.length ? (
              <Banner tone="danger">{preview.errors[0]}</Banner>
            ) : null}
          </section>

          <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {confirmsOnSave ? "This moves the ledger" : "This waits for accounts"}
            </div>
            <p className="mt-1 text-sm text-pretty text-body">
              {confirmsOnSave
                ? "Recorded as confirmed — the bills are settled and the customer leaves the collections list straight away."
                : "Recorded as reported. Nothing moves until accounts find the money, and the customer is not chased for it while they look."}
            </p>

            {matches.length ? (
              <MatchPanel
                matches={matches}
                separate={separate}
                onSeparate={setSeparate}
                onMerge={(m) => {
                  setMerging(m);
                  setTyped("");
                  setMergeError(null);
                }}
              />
            ) : null}
            <button
              disabled={Boolean(blocked)}
              title={blocked}
              onClick={async () => {
                setBusy(true);
                const r = await run(
                  recordReceiptAction({
                    customerId: customer.customerId,
                    amount,
                    receivedAt,
                    mode,
                    reference: reference.trim() || undefined,
                    instrumentDate: instrumentDate || undefined,
                    note: note.trim() || undefined,
                    allocation,
                    selectedBillIds: selected,
                    custom: Object.fromEntries(
                      Object.entries(custom)
                        .map(([k, v]) => [k, parseRupees(v) ?? 0] as const)
                        .filter(([, v]) => v > 0),
                    ),
                    source: "accounts",
                    idempotencyKey,
                  }),
                );
                setBusy(false);
                if (r.ok) {
                  onBack();
                  router.refresh();
                }
              }}
              className={cx(
                "mt-3.5 h-10 w-full rounded-[4px] border text-[15px] font-medium",
                blocked
                  ? "cursor-not-allowed border-divider bg-divider text-line-strong"
                  : "cursor-pointer border-brand bg-brand text-white hover:bg-brand-hover",
              )}
            >
              {amount > 0 ? `Record ${money(amount)}` : "Record the payment"}
            </button>
            {amount > 0 && blocked && !busy ? (
              <p className="mt-2 text-[13px] text-pretty text-danger">{blocked}</p>
            ) : null}
          </section>
        </div>
      </div>

      {/* Keyed on the receipt: opening it for a different match starts with an
          empty box rather than the last one's typing. */}
      {merging ? (
        <MergeDialog
          key={merging.candidate.receiptId}
          match={merging}
          customerName={customer.customerName}
          entryAmount={amount}
          typed={typed}
          onTyped={setTyped}
          error={mergeError}
          busy={busy}
          onClose={() => setMerging(null)}
          onConfirm={async () => {
            setBusy(true);
            setMergeError(null);
            const r = await run(
              confirmAsMatchAction({
                receiptId: merging.candidate.receiptId,
                confirmAmount: parseRupees(typed) ?? 0,
                // What accounts hold that the telecaller did not: the string
                // off the bank statement, and the day it actually landed.
                reference: reference.trim() || undefined,
                receivedAt,
                mode,
                // Where they have just decided the money should go. They are
                // looking at the bills; asking again on a second screen would
                // be asking the same question twice.
                allocation: {
                  mode: allocation,
                  selectedBillIds: selected,
                  custom: Object.fromEntries(
                    Object.entries(custom)
                      .map(([k, v]) => [k, parseRupees(v) ?? 0] as const)
                      .filter(([, v]) => v > 0),
                  ),
                },
              }),
            );
            setBusy(false);
            if (r.ok) {
              setMerging(null);
              onBack();
              router.refresh();
            } else {
              // It stays in the dialog rather than vanishing as a toast: a
              // refused merge changes what to do next.
              setMergeError(r.error);
            }
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------ money already written down */

/**
 * What somebody has already recorded that looks like this money.
 *
 * Shown as a question rather than a warning. The great majority of these are
 * genuine — a telecaller wrote down what the customer told them, and this is
 * that payment arriving on the statement — so the primary action is "yes, same
 * money", not "dismiss".
 */
function MatchPanel({
  matches,
  separate,
  onSeparate,
  onMerge,
}: {
  matches: ReceiptMatchView[];
  separate: boolean;
  onSeparate: (v: boolean) => void;
  onMerge: (m: ReceiptMatchView) => void;
}) {
  const blocking = matches.some((m) => m.blocking);

  return (
    <div
      className={cx(
        "mt-3.5 rounded-[4px] border px-3 py-3",
        blocking ? "border-warn-line bg-warn-soft" : "border-line bg-canvas",
      )}
    >
      <div
        className={cx(
          "text-sm font-medium",
          blocking ? "text-warn-ink" : "text-ink",
        )}
      >
        {matches.length === 1
          ? "This may already be recorded"
          : `${matches.length} payments already recorded look like this one`}
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {matches.map((m) => (
          <div
            key={m.candidate.receiptId}
            className="rounded-[4px] border border-line bg-surface px-3 py-2.5"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium tabular-nums text-ink">
                {money(m.candidate.amount)}
              </span>
              <span className="text-[11px] text-muted">
                {m.candidate.status === "held" ? "On hold" : "Reported"}
              </span>
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              {m.candidate.reportedByName ?? "Somebody"} · {m.candidate.mode} ·{" "}
              {m.candidate.reference ?? "no reference"} · received{" "}
              {longDate(m.candidate.receivedAt)}
            </div>
            {m.candidate.note ? (
              <div className="mt-1 text-[13px] text-pretty text-body">{m.candidate.note}</div>
            ) : null}
            <div className="mt-1.5 text-[13px] text-pretty text-ink">{m.why}</div>

            <button
              type="button"
              onClick={() => onMerge(m)}
              className="mt-2 h-8 cursor-pointer rounded-[4px] border border-brand bg-brand px-3 text-[13px] font-medium text-white hover:bg-brand-hover"
            >
              This is the same money
            </button>
          </div>
        ))}
      </div>

      {blocking ? (
        <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[13px] text-pretty text-body">
          <input
            type="checkbox"
            checked={separate}
            onChange={(e) => onSeparate(e.target.checked)}
            className="mt-0.5 size-4 flex-none cursor-pointer"
          />
          <span>
            I have looked — this is a different payment, and the customer has paid twice.
          </span>
        </label>
      ) : null}
    </div>
  );
}

/**
 * The typed confirmation before two records of money become one.
 *
 * A single click is too cheap for this. It confirms a payment somebody else
 * asserted, on a customer's ledger, and quietly decides that a second entry
 * should not exist — and the amount typed is the one on the RECEIPT being
 * confirmed, not the one on the form, so getting it right means having read
 * which of the two figures is about to count.
 *
 * The check is repeated in `confirmAsMatch`. A check that lives only in a
 * dialog is not a check.
 */
function MergeDialog({
  match,
  customerName,
  entryAmount,
  typed,
  onTyped,
  error,
  busy,
  onClose,
  onConfirm,
}: {
  match: ReceiptMatchView;
  customerName: string;
  entryAmount: number;
  typed: string;
  onTyped: (v: string) => void;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const target = match.candidate.amount;
  const matchesTyped = (parseRupees(typed) ?? 0) === target;
  const differs = target !== entryAmount;

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="This looks like the same money"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!matchesTyped || busy}
            title={matchesTyped ? undefined : `Type ${money(target)} to confirm it`}
            onClick={onConfirm}
          >
            Confirm {money(target)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <div className="rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-pretty text-danger">
            {error}
          </div>
        ) : null}

        <p className="text-sm text-pretty text-body">
          {match.candidate.reportedByName ?? "Somebody"} recorded{" "}
          <span className="font-medium text-ink">{money(target)}</span> for {customerName} on{" "}
          {longDate(match.candidate.receivedAt)}. {match.why}.
        </p>

        <p className="text-sm text-pretty text-body">
          Confirming it settles that payment and records nothing new, so the customer is
          credited once. Your reference and date are written onto it.
        </p>

        {/* The amounts disagreeing is the most important thing on this screen
            when it happens: one of the two figures is wrong, and it is usually
            the one taken down a phone. */}
        {differs ? (
          <div className="rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-pretty text-warn-ink">
            You entered {money(entryAmount)} and the recorded payment is {money(target)}. It
            is the recorded {money(target)} that will count. If the bank says otherwise,
            reject that payment and record yours instead.
          </div>
        ) : null}

        <div>
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Type {money(target)} to confirm
          </span>
          <span className="flex h-10 items-center rounded-[4px] border border-line bg-surface px-2.5">
            <span className="mr-1 text-muted">₹</span>
            <input
              autoFocus
              inputMode="numeric"
              value={typed}
              onChange={(e) => onTyped(e.target.value)}
              placeholder={String(Math.round(target / 100))}
              aria-label="Type the amount to confirm"
              className="w-full flex-1 border-none bg-transparent text-[17px] font-semibold tabular-nums outline-none"
            />
          </span>
        </div>
      </div>
    </Modal>
  );
}

const FIELD =
  "h-9.5 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm focus:border-brand focus:outline-none";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
      {children}
    </span>
  );
}
