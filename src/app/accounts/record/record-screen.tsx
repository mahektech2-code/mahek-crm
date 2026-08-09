"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { recordReceiptAction } from "@/lib/actions/payments";
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
  allowOnAccount,
}: {
  confirmsOnSave: boolean;
  today: string;
  modes: string[];
  referenceRequiredModes: string[];
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
  allowOnAccount,
  onBack,
}: {
  customer: Hit;
  confirmsOnSave: boolean;
  today: string;
  modes: string[];
  referenceRequiredModes: string[];
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
  const [note, setNote] = React.useState("");
  const [allocation, setAllocation] = React.useState<AllocationMode>("auto");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  // Minted once per form. A retried save is the same payment, not a second one.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());

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

            <div className="mt-3">
              <Label>Note</Label>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Part payment against the June bills…"
                className="w-full resize-y rounded-[4px] border border-line px-2.5 py-2 text-sm focus:border-brand focus:outline-none"
              />
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
    </>
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
