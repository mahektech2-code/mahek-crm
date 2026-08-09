"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  EmptyState,
  Field,
  Input,
  MoneyInput,
  PageHeader,
  Radio,
  SectionLabel,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { recordReceiptAction } from "@/lib/actions/payments";
import { CustomerSearch, type Hit } from "../customer-search";
import { money, parseRupees } from "@/lib/format";
import {
  allocate,
  type AllocatableBill,
  type AllocationMode,
} from "@/lib/engines/allocation";

type OpenBill = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  daysOverdue: number;
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
    <div className="max-w-[1100px] px-6 pt-6 pb-10">
      <PageHeader
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
        <CustomerSearch title="Who has paid?" onPick={setPicked} />
      )}
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

  /*
   * The same pure function the server will run. Showing the split before it is
   * saved is the whole point of the screen — accounts are deciding where the
   * money goes, and a preview that disagrees with the save would be worse than
   * none at all.
   */
  const allocatable: AllocatableBill[] = (bills ?? []).map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    amount: b.amount,
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

  // Only binding on somebody who can confirm the money — see receipt-service.
  const referenceMissing =
    confirmsOnSave && referenceRequiredModes.includes(mode) && !reference.trim();
  const settleTotal = (bills ?? [])
    .filter((b) => selected.includes(b.id))
    .reduce((s, b) => s + Math.max(0, b.balance - b.reported), 0);

  const canSave =
    amount > 0 && !referenceMissing && !preview.errors.length && !busy;

  return (
    <>
      <Card className="mt-4">
        <CardHeader
          title={customer.customerName}
          hint={`${money(customer.outstanding)} owed${onAccountHeld ? ` · ${money(onAccountHeld)} already on account` : ""}`}
          action={
            <Button size="sm" variant="ghost" onClick={onBack}>
              Someone else
            </Button>
          }
        />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ------------------------------------------------ the bills */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Open bills"
            hint={
              allocation === "settle"
                ? "Tick what this payment clears"
                : allocation === "custom"
                  ? "Type how much goes against each"
                  : "Oldest first"
            }
          />
          {bills === null ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted">
              Loading the account…
            </p>
          ) : bills.length === 0 ? (
            <EmptyState
              title="Nothing open"
              body="This customer owes nothing. A payment recorded now sits on account and is offered against their next bill."
            />
          ) : (
            <table>
              <thead>
                <Tr>
                  {allocation === "settle" ? <Th /> : null}
                  <Th>Bill</Th>
                  <Th>Due</Th>
                  <Th align="right">Open</Th>
                  <Th align="right">
                    {allocation === "custom" ? "Against this bill" : "This payment"}
                  </Th>
                </Tr>
              </thead>
              <tbody>
                {bills.map((b) => {
                  const line = preview.lines.find((l) => l.billId === b.id);
                  const free = Math.max(0, b.balance - b.reported);
                  return (
                    <Tr key={b.id}>
                      {allocation === "settle" ? (
                        <Td>
                          <input
                            type="checkbox"
                            aria-label={`Settle ${b.billNo}`}
                            checked={selected.includes(b.id)}
                            onChange={(e) =>
                              setSelected((prev) =>
                                e.target.checked
                                  ? [...prev, b.id]
                                  : prev.filter((x) => x !== b.id),
                              )
                            }
                          />
                        </Td>
                      ) : null}
                      <Td>
                        <span className="font-medium text-ink">{b.billNo}</span>
                        <span className="mt-0.5 block text-[12px] text-muted">
                          {b.billDate}
                          {b.reported > 0
                            ? ` · ${money(b.reported)} already reported`
                            : ""}
                        </span>
                      </Td>
                      <Td>
                        {b.dueDate}
                        {b.daysOverdue > 0 ? (
                          <Badge tone="danger" className="ml-2">
                            {b.daysOverdue}d
                          </Badge>
                        ) : null}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {money(free)}
                      </Td>
                      <Td align="right">
                        {allocation === "custom" ? (
                          <MoneyInput
                            value={custom[b.id] ?? ""}
                            onChange={(e) =>
                              setCustom((prev) => ({ ...prev, [b.id]: e.target.value }))
                            }
                            placeholder="0"
                            className="w-32 text-right"
                            aria-label={`Amount against ${b.billNo}`}
                          />
                        ) : line ? (
                          <span className="font-medium tabular-nums text-ink">
                            {money(line.amount)}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* ------------------------------------------------ the money */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="The payment" />
            <div className="flex flex-col gap-3 px-4 pb-4">
              <Field label="Amount received">
                <MoneyInput
                  autoFocus
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder="0"
                />
              </Field>

              <Field label="Received on">
                <Input
                  type="date"
                  max={today}
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                />
              </Field>

              <Field label="How">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {modes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Reference"
                hint={
                  confirmsOnSave && referenceRequiredModes.includes(mode)
                    ? "The UTR or cheque number. This is how the payment is found in the bank statement again."
                    : "Optional — but give it if the customer has it"
                }
                error={referenceMissing ? "A reference is required for this mode." : null}
              >
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  invalid={referenceMissing}
                  placeholder="UTR904312"
                />
              </Field>

              <Field label="Note" hint="Optional">
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Part payment against the June bills…"
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Against which bills" />
            <div className="flex flex-col gap-1 px-4 pb-3">
              <Radio
                name="allocation"
                label="Oldest bill first"
                checked={allocation === "auto"}
                onChange={() => setAllocation("auto")}
              />
              <Radio
                name="allocation"
                label="Settle particular bills"
                checked={allocation === "settle"}
                onChange={() => setAllocation("settle")}
              />
              <Radio
                name="allocation"
                label="Split it myself"
                checked={allocation === "custom"}
                onChange={() => setAllocation("custom")}
              />
            </div>

            <div className="border-t border-line px-4 py-3">
              {allocation === "settle" && selected.length ? (
                <button
                  type="button"
                  className="mb-2 text-[13px] text-brand underline-offset-2 hover:underline"
                  onClick={() => setAmountText(String(Math.round(settleTotal / 100)))}
                >
                  Use {money(settleTotal)} — what those bills come to
                </button>
              ) : null}

              <dl className="flex flex-col gap-1 text-[13px]">
                <div className="flex justify-between">
                  <dt className="text-muted">Against bills</dt>
                  <dd className="tabular-nums text-ink">{money(preview.allocated)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">On account</dt>
                  <dd
                    className={cx(
                      "tabular-nums",
                      preview.onAccount ? "text-ink" : "text-muted",
                    )}
                  >
                    {money(preview.onAccount)}
                  </dd>
                </div>
              </dl>

              {preview.errors.length ? (
                <Callout tone="danger" className="mt-3">
                  {preview.errors[0]}
                </Callout>
              ) : null}
            </div>
          </Card>

          <Card>
            <div className="px-4 py-3">
              <SectionLabel>
                {confirmsOnSave ? "This moves the ledger" : "This waits for accounts"}
              </SectionLabel>
              <p className="mt-1.5 text-[13px] text-muted">
                {confirmsOnSave
                  ? "Recorded as confirmed — the bills are settled and the customer leaves the collections list straight away."
                  : "Recorded as reported. Nothing moves until accounts find the money, and the customer is not chased for it while they look."}
              </p>
              <Button
                variant="primary"
                className="mt-3 w-full"
                disabled={!canSave}
                title={
                  amount > 0
                    ? preview.errors[0] ||
                      (referenceMissing ? "A reference is required" : undefined)
                    : "Enter the amount received"
                }
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
              >
                {amount > 0 ? `Record ${money(amount)}` : "Record the payment"}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
