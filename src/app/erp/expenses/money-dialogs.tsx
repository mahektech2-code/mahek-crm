"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import type { Result } from "@/lib/result";
import {
  erpMoneyAdvance,
  erpMoneyBills,
  erpMoneyCustomerBills,
  erpMoneyDuplicate,
  erpMoneyExpense,
  erpMoneyReceipt,
  erpMoneyTransfer,
  type OpenBill,
} from "@/lib/actions/erp-money";
import {
  AccountMark,
  accountChoices,
  bankIndex,
  Button,
  checkboxClass,
  FigureBoxes,
  FileBox,
  fd,
  fdLong,
  FROM_CUSTOMER_CASH,
  FROM_WITHDRAWAL,
  inr,
  LineTable,
  linkClass,
  MField,
  MInput,
  MMoney,
  MoneyFoot,
  MoneyHead,
  MoneyShell,
  MoneySteps,
  MSelect,
  Note,
  PaidFromCards,
  Segments,
  SumStrip,
  Td,
  Tr,
  boxClass,
  type CardChoice,
  type KitAccount,
  type MoneyKit,
  type Upload,
} from "./money-ui";

const PAY_MODES = ["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash", "Card"];

/* --------------------------------------------------------------- plumbing */

type Errors = Record<string, string>;

function errorsOf(r: Result<unknown>): Errors {
  if (r.ok) return {};
  const out: Errors = {};
  for (const f of r.fieldErrors ?? []) out[f.field] = f.message;
  if (!r.fieldErrors?.length) out._ = r.error;
  return out;
}

/** Saves, then refreshes the page and closes — or keeps the dialog open with the server's errors. */
function useSave(onClose: () => void) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errs, setErrs] = React.useState<Errors>({});
  const save = async (fn: () => Promise<Result<unknown>>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) {
        push(r.message ?? "Saved");
        onClose();
        router.refresh();
      } else setErrs(errorsOf(r));
    } finally {
      setBusy(false);
    }
  };
  return { busy, errs, setErrs, save };
}

const accountByName = (kit: MoneyKit, name: string): KitAccount | undefined => kit.accounts.find((a) => a.name === name);

/* ================================================================ expense */

export function ExpenseDialog({ kit, onClose }: { kit: MoneyKit; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  const [page, setPage] = React.useState<0 | 1>(0);
  const [date, setDate] = React.useState(kit.today);
  const [category, setCategory] = React.useState("");
  const [amount, setAmount] = React.useState<number | null>(null);
  const [payee, setPayee] = React.useState("");
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [description, setDescription] = React.useState("");
  const banks = kit.accounts.filter((a) => a.kind === "bank");
  const [paidFrom, setPaidFrom] = React.useState(banks[0]?.name ?? kit.accounts[0]?.name ?? "");
  const [paidOn, setPaidOn] = React.useState(kit.today);
  const [mode, setMode] = React.useState("NEFT");
  const [reference, setReference] = React.useState("");
  const [file, setFile] = React.useState<Upload>(null);
  const [note, setNote] = React.useState("");
  const [dup, setDup] = React.useState<{ id: string; label: string; date: string; amountPaise: number } | null>(null);
  const [different, setDifferent] = React.useState(false);
  const [tried, setTried] = React.useState(false);

  React.useEffect(() => {
    if (!invoiceNo.trim()) return;
    const t = setTimeout(async () => setDup(await erpMoneyDuplicate({ invoiceNo, payee, amountPaise: amount ?? 0 })), 350);
    return () => clearTimeout(t);
  }, [invoiceNo, payee, amount]);
  const dupNow = invoiceNo.trim() ? dup : null;

  const acc = accountByName(kit, paidFrom);
  const isCash = acc && acc.kind !== "bank";
  const whatDone = !!(category && amount && invoiceNo.trim() && description.trim());
  const payDone = !!(paidFrom && paidOn && (isCash || mode));
  const local: Errors = {};
  if (tried) {
    if (!category) local.category = "Choose the category.";
    if (!amount) local.amount = "Enter the amount paid.";
    if (!invoiceNo.trim()) local.invoiceNo = "The invoice or bill number is required.";
    if (!description.trim()) local.description = "Say what it was for.";
  }
  if (dupNow && !different) local.invoiceNo = `Already on ${dupNow.label} (${fd(dupNow.date)}, ${inr(dupNow.amountPaise)})`;
  const e = { ...errs, ...local };

  const submit = () =>
    save(() =>
      erpMoneyExpense({
        petty: false,
        date: paidOn,
        category,
        payee,
        invoiceNo,
        description,
        amountPaise: amount,
        paidFrom,
        source: null,
        mode: isCash ? "Cash" : mode,
        reference,
        note: [date !== paidOn ? `Expense dated ${fdLong(date)}.` : "", note].filter(Boolean).join(" ") || null,
        files: file ? [file.id] : [],
        duplicateOverride: different,
      }),
    );

  return (
    <MoneyShell onClose={onClose} label="New expense" width={900}>
      <MoneyHead title="New expense" code={`${kit.nextTxn} · assigned on save`} onClose={onClose} />
      <MoneySteps steps={["What & who", "Payment", "Review"]} at={page === 1 ? 2 : whatDone ? 1 : 0} done={[whatDone, page === 1 && payDone, false]} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {page === 0 ? (
          <div className="grid gap-4">
            <div className="grid grid-cols-3 gap-x-4 gap-y-4">
              <MField label="Expense date" req error={e.date}>
                <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} invalid={!!e.date} />
              </MField>
              <MField label="Category" req error={e.category}>
                <MSelect value={category} onChange={setCategory} options={kit.categories} placeholder="Choose…" invalid={!!e.category} />
              </MField>
              <MField label="Amount" req error={e.amount}>
                <MMoney paise={amount} onPaise={setAmount} invalid={!!e.amount} />
              </MField>
              <MField label="Vendor / payee" error={e.payee}>
                <MInput value={payee} onChange={(x) => setPayee(x.target.value)} placeholder="Who was paid" />
              </MField>
              <MField label="Invoice number" req error={e.invoiceNo}>
                <MInput value={invoiceNo} onChange={(x) => setInvoiceNo(x.target.value)} invalid={!!e.invoiceNo} />
              </MField>
              <MField label="Description / purpose" req error={e.description}>
                <MInput value={description} onChange={(x) => setDescription(x.target.value)} invalid={!!e.description} />
              </MField>
            </div>
            {dupNow ? (
              <Note tone="danger">
                <b>Looks like a duplicate.</b> Same invoice number{payee ? ", vendor" : ""} and amount as {dupNow.label}.{" "}
                <a href={`?view=expenses&open=${dupNow.id}`} target="_blank" rel="noreferrer" className={linkClass("brand", "font-semibold")}>
                  Open it
                </a>{" "}
                · or tick{" "}
                <label className="inline-flex cursor-pointer items-center gap-1.5 font-bold">
                  <input type="checkbox" className={checkboxClass} checked={different} onChange={(x) => setDifferent(x.target.checked)} />
                  &quot;This is a different invoice&quot;
                </label>{" "}
                to save anyway.
              </Note>
            ) : null}
            <MField label="Paid from" req>
              <PaidFromCards choices={accountChoices(kit.accounts, amount ?? 0, "out")} value={paidFrom} onChange={setPaidFrom} error={e.paidFrom} />
            </MField>
            <div className="grid grid-cols-3 gap-x-4 gap-y-4">
              <MField label="Paid on" req error={e.date}>
                <MInput type="date" value={paidOn} max={kit.today} onChange={(x) => setPaidOn(x.target.value)} />
              </MField>
              <MField label="Mode" req error={e.mode}>
                <MSelect value={isCash ? "Cash" : mode} onChange={setMode} options={isCash ? ["Cash"] : PAY_MODES.filter((m) => m !== "Cash")} />
              </MField>
              <MField label="UTR / cheque / reference" error={e.reference} hint={acc?.kind === "bank" ? `Used to match the ${acc.name.split(" ")[0]} statement line` : undefined}>
                <MInput value={reference} onChange={(x) => setReference(x.target.value)} disabled={!!isCash} placeholder={isCash ? "Cash — none" : ""} />
              </MField>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <MField label="Invoice / supporting document">
                <FileBox value={file} onChange={setFile} empty="Attach the invoice — photo or PDF" />
              </MField>
              <MField label="Notes">
                <MInput value={note} onChange={(x) => setNote(x.target.value)} placeholder="Optional" />
              </MField>
            </div>
            {e._ ? <Note tone="danger">{e._}</Note> : null}
          </div>
        ) : (
          <Review
            rows={[
              ["Expense date", fdLong(date)],
              ["Category", category],
              ["Amount", inr(amount ?? 0)],
              ["Vendor / payee", payee || "—"],
              ["Invoice number", invoiceNo],
              ["Description", description],
              ["Paid from", acc ? `${acc.name} · ${inr(acc.balance)} → ${inr(acc.balance - (amount ?? 0))}` : paidFrom],
              ["Paid on", fdLong(paidOn)],
              ["Mode", isCash ? "Cash" : mode],
              ["Reference", reference || "—"],
              ["Document", file?.name ?? "None attached"],
              ["Approval", (amount ?? 0) > kit.approvalAbove ? `Goes to the Accountant — above ${inr(kit.approvalAbove)}` : "Paid — no approval needed"],
            ]}
            errors={e}
            onChange={() => setPage(0)}
          />
        )}
      </div>
      <MoneyFoot left={`Created by ${kit.me} · needs approval above ${inr(kit.approvalAbove)}`}>
        <Button onClick={() => (page === 1 ? setPage(0) : onClose())}>{page === 1 ? "Back" : "Cancel"}</Button>
        {page === 0 ? (
          <Button variant="primary" disabled={!!dupNow && !different} onClick={() => (whatDone && paidFrom ? setPage(1) : setTried(true))}>
            Next: Review
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save expense"}
          </Button>
        )}
      </MoneyFoot>
    </MoneyShell>
  );
}

function Review({ rows, errors, onChange }: { rows: [string, string][]; errors: Errors; onChange: () => void }) {
  const any = Object.values(errors).filter(Boolean);
  return (
    <div className="grid gap-4">
      {any.length ? <Note tone="danger">{any[0]}</Note> : null}
      <div className="overflow-hidden rounded-card border border-line">
        {rows.map(([l, v]) => (
          <div key={l} className="flex gap-4 border-b border-divider px-4 py-2.5 text-sm last:border-b-0">
            <span className="w-48 flex-none text-muted">{l}</span>
            <span className="min-w-0 flex-1 font-medium text-ink">{v}</span>
          </div>
        ))}
      </div>
      <button type="button" onClick={onChange} className={linkClass("brand", "justify-self-start text-sm font-semibold")}>
        Change something
      </button>
    </div>
  );
}

/* ================================================== production petty cash */

/** The Paid-from cards petty cash offers: GPay from a bank, the petty cash float, a withdrawal's cash, or a customer's cash. */
function pettyChoices(kit: MoneyKit, amount: number): CardChoice[] {
  const bank = kit.accounts.find((a) => a.kind === "bank");
  const petty = kit.accounts.find((a) => a.kind === "petty");
  const out: CardChoice[] = [];
  if (bank) out.push({ key: bank.name, name: `${bank.name.split(" ")[0]} GPay`, kind: "bank", mark: 0, sub: `matched on ${bank.name.split(" ")[0]} statement` });
  if (petty) out.push({ key: petty.name, name: petty.name, kind: "petty", sub: inr(petty.balance), after: amount > 0 ? `${inr(petty.balance)} → ${inr(petty.balance - amount)}` : undefined });
  out.push({ key: FROM_WITHDRAWAL, name: `Cash withdrawn from ${bank ? bank.name.split(" ")[0] : "a bank"}`, kind: "cash", sub: "pick the withdrawal TXN" });
  out.push({ key: FROM_CUSTOMER_CASH, name: "Cash from a customer", kind: "customer", sub: "pick the cash receipt" });
  return out;
}

export function PettyDialog({ kit, onClose }: { kit: MoneyKit; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  const [date, setDate] = React.useState(kit.today);
  const [category, setCategory] = React.useState("");
  const [amount, setAmount] = React.useState<number | null>(null);
  const [payee, setPayee] = React.useState("");
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const petty = kit.accounts.find((a) => a.kind === "petty");
  const [from, setFrom] = React.useState(petty?.name ?? "");
  const [source, setSource] = React.useState("");
  const [file, setFile] = React.useState<Upload>(null);
  const [note, setNote] = React.useState("");
  const isSource = from === FROM_CUSTOMER_CASH || from === FROM_WITHDRAWAL;
  const sources = from === FROM_CUSTOMER_CASH ? kit.customerCash : kit.withdrawals;
  const fromAcc = accountByName(kit, from);
  const e = errs;
  const submit = () =>
    save(() =>
      erpMoneyExpense({
        petty: true,
        date,
        category,
        payee,
        invoiceNo,
        description: purpose,
        amountPaise: amount,
        paidFrom: from,
        source: isSource ? source : null,
        mode: fromAcc?.kind === "bank" ? "UPI" : "Cash",
        reference: null,
        note,
        files: file ? [file.id] : [],
        duplicateOverride: false,
      }),
    );
  const example = kit.customerCash[0];
  return (
    <MoneyShell onClose={onClose} label="New petty cash expense" width={880}>
      <MoneyHead title="New petty cash expense" code={kit.nextTxn} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Date" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} invalid={!!e.date} />
            </MField>
            <MField label="Category" req error={e.category}>
              <MSelect value={category} onChange={setCategory} options={kit.categories} placeholder="Choose…" invalid={!!e.category} />
            </MField>
            <MField label="Amount" req error={e.amount}>
              <MMoney paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="Paid to" error={e.payee}>
              <MInput value={payee} onChange={(x) => setPayee(x.target.value)} />
            </MField>
            <MField label="Invoice / bill no." req error={e.invoiceNo}>
              <MInput value={invoiceNo} onChange={(x) => setInvoiceNo(x.target.value)} invalid={!!e.invoiceNo} />
            </MField>
            <MField label="Purpose" error={e.description}>
              <MInput value={purpose} onChange={(x) => setPurpose(x.target.value)} />
            </MField>
          </div>
          <MField label="Paid from" req>
            <PaidFromCards choices={pettyChoices(kit, amount ?? 0)} value={from} onChange={setFrom} error={e.paidFrom} />
          </MField>
          {from === FROM_CUSTOMER_CASH ? (
            <Note tone="warn">
              Paying from <b>customer cash</b>? The receipt must already be in <b>Receipts</b>. You pick it here
              {example ? (
                <>
                  {" "}— e.g.{" "}
                  <i>
                    {example.label} · {inr(example.left)} still unused
                  </i>
                </>
              ) : null}{" "}
              — and the two are linked.
            </Note>
          ) : null}
          {isSource ? (
            <MField label={from === FROM_CUSTOMER_CASH ? "Cash receipt it came from" : "Withdrawal it came from"} req error={e.source}>
              <MSelect
                value={source}
                onChange={setSource}
                placeholder={sources.length ? "Choose…" : "Nothing with cash left"}
                options={sources.map((s) => ({ v: s.label.split(" · ")[0], l: `${s.label} · ${inr(s.left)} unused` }))}
                invalid={!!e.source}
              />
            </MField>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <MField label="Bill photo" req error={e.files}>
              <FileBox value={file} onChange={setFile} empty="Photo of the bill" />
            </MField>
            <MField label="Notes">
              <MInput value={note} onChange={(x) => setNote(x.target.value)} placeholder="Optional" />
            </MField>
          </div>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left={`Submitted by ${kit.me} → the Accountant reviews it`}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Submit for review"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* ================================================================ receipt */

/** Spreads an amount over the ticked bills, oldest first. */
function spread(bills: OpenBill[], ticked: Set<string>, amount: number): Map<string, number> {
  const out = new Map<string, number>();
  let left = amount;
  for (const b of bills) {
    if (!ticked.has(b.id) || left <= 0) continue;
    const a = Math.min(left, b.balancePaise);
    out.set(b.id, a);
    left -= a;
  }
  return out;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function ReceiptDialog({ kit, onClose }: { kit: MoneyKit; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  const [date, setDate] = React.useState(kit.today);
  const [fromKind, setFromKind] = React.useState("Customer");
  const [customer, setCustomer] = React.useState("");
  const [payer, setPayer] = React.useState("");
  const [amount, setAmount] = React.useState<number | null>(null);
  const cash = kit.accounts.find((a) => a.kind === "cash");
  const [into, setInto] = React.useState(cash?.name ?? kit.accounts[0]?.name ?? "");
  const [purpose, setPurpose] = React.useState("Invoice payment");
  const [mode, setMode] = React.useState("NEFT");
  const [reference, setReference] = React.useState("");
  const [bills, setBills] = React.useState<{ key: string; outstanding: number; list: OpenBill[] } | null>(null);
  const [ticked, setTicked] = React.useState<Set<string> | null>(null);
  const acc = accountByName(kit, into);
  const isBank = acc?.kind === "bank";
  const cust = kit.customers.find((c) => c.label === customer);

  React.useEffect(() => {
    if (!cust) return;
    let live = true;
    erpMoneyCustomerBills(cust.id).then((r) => {
      if (live && r.ok) {
        setBills({ key: cust.id, outstanding: r.data.outstanding, list: r.data.bills });
        setTicked(null);
      }
    });
    return () => {
      live = false;
    };
  }, [cust]);
  const open = fromKind === "Customer" && cust && bills?.key === cust.id ? bills : null;
  const list = open?.list ?? [];
  // Ticked by default: as many of the oldest as the amount reaches.
  const tick = ticked ?? (() => {
    const s = new Set<string>();
    let left = amount ?? 0;
    for (const b of list) {
      if (left <= 0) break;
      s.add(b.id);
      left -= b.balancePaise;
    }
    return s;
  })();
  const applied = spread(list, tick, amount ?? 0);
  const appliedTotal = [...applied.values()].reduce((t, v) => t + v, 0);
  const onAccount = Math.max(0, (amount ?? 0) - appliedTotal);
  const billsText = list
    .filter((b) => applied.get(b.id))
    .map((b) => `${b.billNo} ${inr(applied.get(b.id))}`)
    .join(" · ");
  const e = errs;
  const submit = () =>
    save(() =>
      erpMoneyReceipt({
        date,
        into,
        amountPaise: amount,
        customer: fromKind === "Customer" ? customer : null,
        payer: fromKind === "Customer" ? null : payer,
        mode: isBank ? mode : "Cash",
        reference: isBank ? reference : null,
        billsText: [purpose !== "Invoice payment" ? purpose : "", billsText, onAccount && list.length ? `${inr(onAccount)} on account` : ""].filter(Boolean).join(" · ") || null,
        note: null,
        files: [],
      }),
    );
  const who = fromKind === "Customer" ? (customer ? customer.split(",")[0] : "") : payer;
  return (
    <MoneyShell onClose={onClose} label="New receipt" width={960}>
      <MoneyHead title="New receipt" code={`${kit.nextTxn} · assigned on save`} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Receipt date" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} invalid={!!e.date} />
            </MField>
            <MField label="Received from" req>
              <Segments options={["Customer", "Other party"]} value={fromKind} onChange={setFromKind} />
            </MField>
            {fromKind === "Customer" ? (
              <MField label="Customer" req error={e.customer} hint={open ? `Outstanding ${inr(open.outstanding)} · ${open.list.length} open bill${open.list.length === 1 ? "" : "s"}` : undefined}>
                <input list="money-customers" value={customer} onChange={(x) => setCustomer(x.target.value)} className={boxClass(!!e.customer)} placeholder="Search a customer" />
                <datalist id="money-customers">
                  {kit.customers.map((c) => (
                    <option key={c.id} value={c.label} />
                  ))}
                </datalist>
              </MField>
            ) : (
              <MField label="Paid by" req error={e.customer}>
                <MInput value={payer} onChange={(x) => setPayer(x.target.value)} invalid={!!e.customer} />
              </MField>
            )}
            <MField label="Amount received" req error={e.amount}>
              <MMoney paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="Received into" req error={e.into}>
              <span className={cx("flex h-9 items-center gap-2 rounded-control border bg-surface pl-3", e.into ? "border-danger" : "border-brand ring-2 ring-brand-soft")}>
                {acc ? <AccountMark kind={acc.kind} name={acc.name} size="sm" index={bankIndex(kit.accounts, acc.id)} /> : null}
                <select value={into} onChange={(x) => setInto(x.target.value)} className="h-full min-w-0 flex-1 cursor-pointer border-none bg-transparent pr-2 text-sm font-semibold text-ink outline-none">
                  {kit.accounts.map((a) => (
                    <option key={a.id} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </span>
            </MField>
            <MField label="Purpose" req>
              <MSelect value={purpose} onChange={setPurpose} options={["Invoice payment", "Advance from customer", "Other"]} />
            </MField>
            {isBank ? (
              <>
                <MField label="Mode" req error={e.mode}>
                  <MSelect value={mode} onChange={setMode} options={PAY_MODES.filter((m) => m !== "Cash")} />
                </MField>
                <MField label="UTR / cheque / reference" req error={e.reference} hint={`Matched later on the ${acc!.name.split(" ")[0]} statement`}>
                  <MInput value={reference} onChange={(x) => setReference(x.target.value)} />
                </MField>
              </>
            ) : null}
          </div>

          {fromKind === "Customer" && cust ? (
            <div>
              <div className="mb-1.5 text-sm font-semibold text-body">Apply to open invoices — oldest first</div>
              {list.length ? (
                <LineTable
                  head={[{ l: "", w: "w-12" }, { l: "Invoice" }, { l: "Bill date" }, { l: "Due" }, { l: "Balance", align: "right" }, { l: "Apply", align: "right" }]}
                  foot={
                    <Tr>
                      <Td />
                      <Td className="text-sm text-muted">Left on account: {inr(onAccount)}</Td>
                      <Td />
                      <Td />
                      <Td />
                      <Td align="right" className="font-bold text-ink">
                        {inr(amount ?? 0)}
                      </Td>
                    </Tr>
                  }
                >
                  {list.map((b) => {
                    const on = tick.has(b.id);
                    const late = b.dueDate && b.dueDate < kit.today ? daysBetween(b.dueDate, kit.today) : 0;
                    return (
                      <Tr key={b.id} className={on ? "bg-brand-soft/60" : undefined}>
                        <Td>
                          <input
                            type="checkbox"
                            className={checkboxClass}
                            checked={on}
                            onChange={() => {
                              const s = new Set(tick);
                              if (on) s.delete(b.id);
                              else s.add(b.id);
                              setTicked(s);
                            }}
                          />
                        </Td>
                        <Td className="font-semibold text-ink">{b.billNo}</Td>
                        <Td>{fd(b.billDate)}</Td>
                        <Td className={late ? "text-danger" : undefined}>{late ? `${late} days late` : b.dueDate ? fd(b.dueDate) : "—"}</Td>
                        <Td align="right">{inr(b.balancePaise)}</Td>
                        <Td align="right" className="font-semibold text-ink">
                          {applied.get(b.id) ? inr(applied.get(b.id)) : "—"}
                        </Td>
                      </Tr>
                    );
                  })}
                </LineTable>
              ) : (
                <div className="rounded-card border border-line px-4 py-3 text-sm text-muted">No open invoices — the whole amount stays on account.</div>
              )}
            </div>
          ) : null}

          {acc ? (
            <FigureBoxes
              items={[
                { l: `${acc.name} now`, v: inr(acc.balance) },
                { l: "This receipt", v: `+ ${inr(amount ?? 0)}`, tone: "success" },
                { l: `${acc.name} after`, v: inr(acc.balance + (amount ?? 0)), sub: who ? `from ${who}, ${fd(date)}` : undefined },
              ]}
            />
          ) : null}
          <Note tone="info">
            {isBank ? (
              <>
                Bank receipt: the UTR is how it is <b>matched</b> later on the {acc!.name.split(" ")[0]} statement — never entered again there.
              </>
            ) : (
              <>
                Cash receipt: no UTR needed. A <b>bank</b> receipt asks for the UTR and is <b>matched</b> later on that bank&apos;s statement — never entered again there.
              </>
            )}
          </Note>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left={`Receipt ${kit.nextTxn} · created by ${kit.me}`}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save receipt"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* =============================================================== transfer */

const TYPES = ["Bank → Cash", "Cash → Bank", "Bank → Bank", "Cash → Cash"] as const;
const sideKinds = (side: string): KitAccount["kind"][] => (side === "Bank" ? ["bank"] : ["cash", "petty"]);

function AccSelect({ kit, value, onChange, options, invalid }: { kit: MoneyKit; value: string; onChange: (v: string) => void; options: KitAccount[]; invalid?: boolean }) {
  const a = accountByName(kit, value);
  return (
    <span className={cx("flex h-9 items-center gap-2 rounded-control border bg-surface pl-3", invalid ? "border-danger" : "border-line")}>
      {a ? <AccountMark kind={a.kind} name={a.name} size="sm" index={bankIndex(kit.accounts, a.id)} /> : null}
      <select value={value} onChange={(x) => onChange(x.target.value)} className="h-full min-w-0 flex-1 cursor-pointer border-none bg-transparent pr-2 text-sm font-medium text-ink outline-none">
        {options.map((o) => (
          <option key={o.id} value={o.name}>
            {o.name}
            {o.last4 ? ` ••${o.last4}` : ""}
          </option>
        ))}
      </select>
    </span>
  );
}

export function TransferDialog({ kit, onClose }: { kit: MoneyKit; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  const [type, setType] = React.useState<string>(TYPES[0]);
  const [fromSide, toSide] = type.split(" → ");
  const fromList = kit.accounts.filter((a) => sideKinds(fromSide).includes(a.kind));
  const toList = kit.accounts.filter((a) => sideKinds(toSide).includes(a.kind));
  const [from, setFrom] = React.useState(fromList[0]?.name ?? "");
  const [to, setTo] = React.useState(toList.find((a) => a.name !== fromList[0]?.name)?.name ?? "");
  const [date, setDate] = React.useState(kit.today);
  const [amount, setAmount] = React.useState<number | null>(null);
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [file, setFile] = React.useState<Upload>(null);
  const pickType = (t: string) => {
    setType(t);
    const [f, tt] = t.split(" → ");
    const fl = kit.accounts.filter((a) => sideKinds(f).includes(a.kind));
    const tl = kit.accounts.filter((a) => sideKinds(tt).includes(a.kind));
    setFrom(fl[0]?.name ?? "");
    setTo(tl.find((a) => a.name !== fl[0]?.name)?.name ?? "");
  };
  const fa = accountByName(kit, from);
  const ta = accountByName(kit, to);
  const amt = amount ?? 0;
  const e = errs;
  const mode = fromSide === "Cash" && toSide === "Cash" ? "Cash" : fromSide === "Bank" && toSide === "Bank" ? "NEFT" : fromSide === "Bank" ? "Cheque" : "Cash";
  const submit = () => save(() => erpMoneyTransfer({ date, from, to, amountPaise: amount, mode, reference, source: null, note: description, files: file ? [file.id] : [] }));
  return (
    <MoneyShell onClose={onClose} label="New transfer" width={840}>
      <MoneyHead title="New transfer" code={`${kit.nextTxn} · one ID, two legs`} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <MField label="Transaction type" req>
            <Segments options={[...TYPES]} value={type} onChange={pickType} />
          </MField>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-5">
            <MField label="From account" req error={e.from}>
              <AccSelect kit={kit} value={from} onChange={setFrom} options={fromList} invalid={!!e.from} />
            </MField>
            <span className="pb-2.5 text-2xl text-brand">→</span>
            <MField label="To account" req error={e.to}>
              <AccSelect kit={kit} value={to} onChange={setTo} options={toList} invalid={!!e.to} />
            </MField>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Date" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} />
            </MField>
            <MField label="Amount" req error={e.amount}>
              <MMoney paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label={fromSide === "Bank" ? "Withdrawal slip / cheque / ref" : "Deposit slip / ref"} error={e.reference}>
              <MInput value={reference} onChange={(x) => setReference(x.target.value)} />
            </MField>
          </div>
          <FigureBoxes
            items={[
              ...(fa ? [{ l: fa.name, v: inr(fa.balance), sub: `→ ${inr(fa.balance - amt)}`, subTone: "danger" as const }] : []),
              ...(ta ? [{ l: ta.name, v: inr(ta.balance), sub: `→ ${inr(ta.balance + amt)}`, subTone: "success" as const }] : []),
              { l: "Income / Expense", v: "₹0", sub: "a transfer is neither", subTone: "muted" as const },
            ]}
          />
          <div className="grid grid-cols-2 gap-4">
            <MField label="Description">
              <MInput value={description} onChange={(x) => setDescription(x.target.value)} />
            </MField>
            <MField label="Attachment">
              <FileBox value={file} onChange={setFile} empty="Drop slip photo or PDF" dashed />
            </MField>
          </div>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left="From and To can't be the same · amount must be above ₹0">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !from || !to || from === to || !amt} onClick={submit}>
          {busy ? "Posting…" : "Post transfer"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* ================================================================ advance */

export function AdvanceDialog({ kit, onClose }: { kit: MoneyKit; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  const [employee, setEmployee] = React.useState("");
  const [amount, setAmount] = React.useState<number | null>(null);
  const [date, setDate] = React.useState(kit.today);
  const [purpose, setPurpose] = React.useState("");
  const due = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + kit.billsDays);
    return t.toISOString().slice(0, 10);
  };
  const [billsDue, setBillsDue] = React.useState(due(kit.today));
  const [handed, setHanded] = React.useState("Cash");
  const petty = kit.accounts.find((a) => a.kind === "petty");
  const cash = kit.accounts.find((a) => a.kind === "cash");
  const bank = kit.accounts.find((a) => a.kind === "bank");
  const [from, setFrom] = React.useState(petty?.name ?? cash?.name ?? "");
  const [source, setSource] = React.useState("");
  const amt = amount ?? 0;
  const choices: CardChoice[] = [];
  if (petty) choices.push({ key: petty.name, name: petty.name, kind: "petty", sub: inr(petty.balance), after: amt ? `${inr(petty.balance)} → ${inr(petty.balance - amt)}` : undefined });
  if (cash) choices.push({ key: cash.name, name: cash.name, kind: "cash", sub: inr(cash.balance), after: amt ? `${inr(cash.balance)} → ${inr(cash.balance - amt)}` : undefined });
  if (bank) choices.push({ key: bank.name, name: `${bank.name.split(" ")[0]} GPay`, kind: "bank", sub: `matched on ${bank.name.split(" ")[0]} statement` });
  choices.push({ key: FROM_CUSTOMER_CASH, name: "Cash from a customer", kind: "customer", sub: "pick the cash receipt" });
  const isCustomer = from === FROM_CUSTOMER_CASH;
  const accName = isCustomer ? (cash?.name ?? "") : from;
  const fromAcc = accountByName(kit, accName);
  const mode = fromAcc?.kind === "bank" ? (handed === "Cash" ? "UPI" : handed) : "Cash";
  const emp = kit.employees.find((x) => x.name === employee);
  const first = employee.split(" ")[0] || "They";
  const e = errs;
  const submit = () =>
    save(() =>
      erpMoneyAdvance({
        employee,
        amountPaise: amount,
        date,
        purpose,
        billsDueOn: billsDue || null,
        from: accName,
        mode,
        reference: isCustomer ? source || null : null,
        note: isCustomer && source ? `From customer cash ${source}` : null,
      }),
    );
  return (
    <MoneyShell onClose={onClose} label="Give an advance" width={780}>
      <MoneyHead title="Give an advance" code={`${kit.nextTxn} · ${kit.nextAdv}`} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Given to" req error={e.employee}>
              <MSelect
                value={employee}
                onChange={setEmployee}
                placeholder="Choose…"
                options={kit.employees.map((x) => ({ v: x.name, l: `${x.name}${x.dept ? ` · ${x.dept}` : ""}${x.open ? " — holds an open advance" : ""}` }))}
                invalid={!!e.employee}
              />
            </MField>
            <MField label="Amount" req error={e.amount}>
              <MMoney paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="Date" req error={e.date}>
              <MInput
                type="date"
                value={date}
                max={kit.today}
                onChange={(x) => {
                  setDate(x.target.value);
                  setBillsDue(due(x.target.value));
                }}
              />
            </MField>
            <MField label="For" error={e.purpose}>
              <MInput value={purpose} onChange={(x) => setPurpose(x.target.value)} placeholder="What the money is for" />
            </MField>
            <MField label="Bills due by" error={e.billsDueOn} hint={`${kit.billsDays} days, then ${employee ? first : "they are"} ${employee ? "is " : ""}reminded`}>
              <MInput type="date" value={billsDue} onChange={(x) => setBillsDue(x.target.value)} />
            </MField>
            <MField label="Handed over as" error={e.mode}>
              <MSelect value={fromAcc?.kind === "bank" ? (handed === "Cash" ? "UPI" : handed) : "Cash"} onChange={setHanded} options={fromAcc?.kind === "bank" ? ["UPI", "NEFT", "IMPS"] : ["Cash"]} />
            </MField>
          </div>
          <MField label="Paid from" req>
            <PaidFromCards choices={choices} value={from} onChange={setFrom} error={e.from} />
          </MField>
          {isCustomer ? (
            <MField label="Cash receipt it came from" req>
              <MSelect value={source} onChange={setSource} placeholder={kit.customerCash.length ? "Choose…" : "Nothing with cash left"} options={kit.customerCash.map((s) => ({ v: s.label.split(" · ")[0], l: `${s.label} · ${inr(s.left)} unused` }))} />
            </MField>
          ) : null}
          <Note tone="info">
            This is a <b>transfer</b>, not an expense: {fromAcc?.name ?? "the account"} goes down {inr(amt)} and{" "}
            <b>Advance · {employee || "the employee"}</b> goes up {inr(amt)}. Nothing reaches the expense books until {employee ? "their" : "the"} bills are approved.{" "}
            {employee ? (
              emp?.open ? (
                <>
                  {first} <b>already holds an open advance</b> — settle it first.
                </>
              ) : (
                <>
                  {first} already holds <b>no other open advance</b>.
                </>
              )
            ) : null}
          </Note>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left={`Given by ${kit.me}${employee ? ` · ${first} is told on his phone` : ""}`}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "Giving…" : "Give advance"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* ================================================== submit bills (advance) */

export type BillsTarget = { id: string; label: string; employee: string; withThem: number; issuedOn: string };
type BillLine = { key: string; date: string; category: string; payee: string; invoiceNo: string; amount: number | null; noBill: boolean; reason: string; photo: Upload };

let seq = 0;
const blank = (day: string): BillLine => ({ key: `b${++seq}`, date: day, category: "", payee: "", invoiceNo: "", amount: null, noBill: false, reason: "", photo: null });

export function BillsDialog({ kit, target, onClose }: { kit: MoneyKit; target: BillsTarget; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  const draftKey = `erp-money-bills-${target.id}`;
  const [lines, setLines] = React.useState<BillLine[]>(() => {
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) return (JSON.parse(raw) as BillLine[]).map((l) => ({ ...l, key: `b${++seq}` }));
    } catch {
      /* no storage: start empty */
    }
    return [blank(kit.today)];
  });
  const { push } = useToast();
  const many = React.useRef<HTMLInputElement>(null);
  const set = (i: number, p: Partial<BillLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const total = lines.reduce((t, l) => t + (l.amount ?? 0), 0);
  const counted = lines.filter((l) => l.amount).length;
  const left = target.withThem - total;
  const e = errs;
  const uploadMany = async (files: FileList | null) => {
    if (!files?.length) return;
    const added: BillLine[] = [];
    for (const f of [...files].slice(0, 20)) {
      const body = new FormData();
      body.set("file", f);
      body.set("kind", "photo");
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string };
      if (j.id) added.push({ ...blank(kit.today), photo: { id: j.id, name: f.name, size: f.size } });
    }
    setLines((ls) => [...ls.filter((l) => l.amount || l.payee || l.invoiceNo || l.photo), ...added]);
  };
  const submit = () =>
    save(async () => {
      const r = await erpMoneyBills(
        target.id,
        lines.map((l) => ({ date: l.date, category: l.category, payee: l.payee, invoiceNo: l.noBill ? null : l.invoiceNo, amountPaise: l.amount, noBillReason: l.noBill ? l.reason : null, description: null, photo: l.noBill ? null : (l.photo?.id ?? null) })),
      );
      if (r.ok) {
        try {
          window.localStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
      }
      return r;
    });
  const draft = () => {
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(lines));
      push("Draft kept on this browser");
      onClose();
    } catch {
      push("This browser cannot keep a draft", "error");
    }
  };
  const lineErr = (i: number) => Object.entries(e).find(([k]) => k.startsWith(`l${i}.`))?.[1];
  return (
    <MoneyShell onClose={onClose} label="Submit bills" width={980}>
      <MoneyHead
        title={`Submit bills against ${target.label}`}
        code={
          <span className="font-sans text-sm text-muted">
            {target.employee} · {inr(target.withThem)} not yet accounted for
          </span>
        }
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div>
            <LineTable fixed head={[{ l: "Date", w: "w-40" }, { l: "Category", w: "w-36" }, { l: "Paid to" }, { l: "Bill no.", w: "w-28" }, { l: "Amount", align: "right", w: "w-28" }, { l: "Bill photo", w: "w-48" }, { l: "", w: "w-10" }]}>
              {lines.map((l, i) => (
                <React.Fragment key={l.key}>
                  <Tr>
                    <Td>
                      <input type="date" value={l.date} min={target.issuedOn} max={kit.today} onChange={(x) => set(i, { date: x.target.value })} className={boxClass(false, "h-9 text-sm")} />
                    </Td>
                    <Td>
                      <select value={l.category} onChange={(x) => set(i, { category: x.target.value })} className={boxClass(false, "h-9 cursor-pointer text-sm")}>
                        <option value="">Choose…</option>
                        {kit.categories.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </Td>
                    <Td>
                      <input value={l.payee} onChange={(x) => set(i, { payee: x.target.value })} className={boxClass(false, "h-9 text-sm font-semibold")} placeholder="Who was paid" />
                    </Td>
                    <Td>
                      {l.noBill ? (
                        <span className="text-sm text-muted">no bill</span>
                      ) : (
                        <input value={l.invoiceNo} onChange={(x) => set(i, { invoiceNo: x.target.value })} className={boxClass(false, "h-9 text-sm")} />
                      )}
                    </Td>
                    <Td align="right">
                      <span className="flex h-9 items-center rounded-control border border-line bg-surface px-2 focus-within:border-brand">
                        <span className="mr-1 text-sm text-muted">₹</span>
                        <input
                          inputMode="decimal"
                          value={l.amount == null ? "" : String(l.amount / 100)}
                          onChange={(x) => {
                            const v = Number(x.target.value.replace(/[^0-9.]/g, ""));
                            set(i, { amount: x.target.value.trim() && Number.isFinite(v) ? Math.round(v * 100) : null });
                          }}
                          className="min-w-0 flex-1 border-none bg-transparent text-right text-sm font-bold text-ink outline-none"
                        />
                      </span>
                    </Td>
                    <Td>
                      {l.noBill ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2.5 py-0.5 text-meta font-semibold text-danger">
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          Note instead
                        </span>
                      ) : (
                        <div className="[&_button]:h-10">
                          <FileBox value={l.photo} onChange={(p) => set(i, { photo: p })} empty="Photo" />
                        </div>
                      )}
                      <button type="button" onClick={() => set(i, { noBill: !l.noBill })} className={linkClass("brand", "mt-1 text-meta")}>
                        {l.noBill ? "There is a bill" : "No bill?"}
                      </button>
                    </Td>
                    <Td>
                      <button type="button" aria-label="Remove" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [blank(kit.today)]))} className="cursor-pointer text-md text-muted hover:text-danger">
                        ×
                      </button>
                    </Td>
                  </Tr>
                  {l.noBill || lineErr(i) ? (
                    <Tr>
                      <Td />
                      <Td colSpan={6}>
                        {l.noBill ? <input value={l.reason} onChange={(x) => set(i, { reason: x.target.value })} className={boxClass(false, "h-9 text-sm")} placeholder="Why there is no bill — e.g. loading labour, paid in cash" /> : null}
                        {lineErr(i) ? <div className="mt-1 text-meta text-danger">{lineErr(i)}</div> : null}
                      </Td>
                    </Tr>
                  ) : null}
                </React.Fragment>
              ))}
            </LineTable>
            <div className="mt-3 text-sm text-muted">
              <button type="button" onClick={() => setLines((ls) => [...ls, blank(kit.today)])} className={linkClass("brand", "font-semibold")}>
                + Add another bill
              </button>{" "}
              ·{" "}
              <button type="button" onClick={() => many.current?.click()} className={linkClass("brand", "font-semibold")}>
                Upload several photos at once
              </button>{" "}
              — each photo becomes a line for you to fill in
              <input ref={many} type="file" multiple accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={(x) => uploadMany(x.target.files)} />
            </div>
          </div>
          <SumStrip
            items={[
              { l: "Still with you", v: inr(target.withThem) },
              "−",
              { l: "These bills", v: inr(total) },
              "=",
              left >= 0 ? { l: "Left after this", v: inr(left), tone: "success" } : { l: "Owed back to you", v: inr(-left), tone: "danger" },
            ]}
          />
          <Note tone="warn">
            A line with <b>no bill</b> needs a sentence saying why, and is flagged for the Accountant. Spent more than you were given? Add the bills anyway — the extra is <b>owed back to you</b> once approved.
          </Note>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left="Goes to the Accountant for review · the Production Head sees it too">
        <Button onClick={draft}>Save draft</Button>
        <Button variant="primary" disabled={busy || !counted} onClick={submit}>
          {busy ? "Submitting…" : `Submit ${counted} bill${counted === 1 ? "" : "s"} · ${inr(total)}`}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* ================================================================== host */

export type DialogKind = "expense" | "petty" | "receipt" | "transfer" | "advance" | "bills";

/** Opens the dialog the URL names (`?dlg=`), and takes it off the URL when it closes. */
export function MoneyDialogHost({ kit, dlg, bills }: { kit: MoneyKit; dlg: string | null; bills?: BillsTarget | null }) {
  const router = useRouter();
  const close = () => {
    const u = new URL(window.location.href);
    u.searchParams.delete("dlg");
    u.searchParams.delete("adv");
    router.replace(`${u.pathname}${u.search}`, { scroll: false });
  };
  if (dlg === "expense") return <ExpenseDialog kit={kit} onClose={close} />;
  if (dlg === "petty") return <PettyDialog kit={kit} onClose={close} />;
  if (dlg === "receipt") return <ReceiptDialog kit={kit} onClose={close} />;
  if (dlg === "transfer") return <TransferDialog kit={kit} onClose={close} />;
  if (dlg === "advance") return <AdvanceDialog kit={kit} onClose={close} />;
  if (dlg === "bills" && bills) return <BillsDialog kit={kit} target={bills} onClose={close} />;
  return null;
}
