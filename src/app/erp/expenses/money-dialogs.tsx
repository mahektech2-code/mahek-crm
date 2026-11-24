"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { addDays } from "@/lib/business-date";
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
  FileBox,
  fd,
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
import { shrinkImage } from "@/lib/shrink-image";

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
  /* ONE page, in the order a person tells it: how much, to whom, for what,
     from which account. The server checks every rule again on save. */
  const [date, setDate] = React.useState(kit.today);
  const [category, setCategory] = React.useState("");
  const [amount, setAmount] = React.useState<number | null>(null);
  const [payee, setPayee] = React.useState("");
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [description, setDescription] = React.useState("");
  const banks = kit.accounts.filter((a) => a.kind === "bank");
  const [paidFrom, setPaidFrom] = React.useState(banks[0]?.name ?? kit.accounts[0]?.name ?? "");
  const [mode, setMode] = React.useState("NEFT");
  const [reference, setReference] = React.useState("");
  const [file, setFile] = React.useState<Upload>(null);
  const [note, setNote] = React.useState("");
  const [dup, setDup] = React.useState<{ id: string; label: string; date: string; amountPaise: number } | null>(null);
  const [different, setDifferent] = React.useState(false);

  React.useEffect(() => {
    if (!invoiceNo.trim()) return;
    const t = setTimeout(async () => setDup(await erpMoneyDuplicate({ invoiceNo, payee, amountPaise: amount ?? 0 })), 350);
    return () => clearTimeout(t);
  }, [invoiceNo, payee, amount]);
  const dupNow = invoiceNo.trim() ? dup : null;

  const acc = accountByName(kit, paidFrom);
  const isCash = acc && acc.kind !== "bank";
  const e: Errors = { ...errs };
  if (dupNow && !different) e.invoiceNo = `Already entered as ${dupNow.label} (${fd(dupNow.date)}, ${inr(dupNow.amountPaise)})`;
  const needsApproval = (amount ?? 0) > kit.approvalAbove;

  const submit = () =>
    save(() =>
      erpMoneyExpense({
        petty: false,
        date,
        category,
        payee,
        invoiceNo,
        description,
        amountPaise: amount,
        paidFrom,
        source: null,
        mode: isCash ? "Cash" : mode,
        reference: isCash ? null : reference,
        note: note || null,
        files: file ? [file.id] : [],
        duplicateOverride: different,
      }),
    );

  return (
    <MoneyShell onClose={onClose} label="Add expense" width={820}>
      <MoneyHead title="Add expense" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Amount" req error={e.amount}>
              <MMoney autoFocus paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="Paid to" error={e.payee}>
              <MInput value={payee} onChange={(x) => setPayee(x.target.value)} placeholder="Shop or person" />
            </MField>
            <MField label="Category" req error={e.category}>
              <MSelect value={category} onChange={setCategory} options={kit.categories} placeholder="Choose…" invalid={!!e.category} />
            </MField>
            <MField label="What was it for?" req error={e.description}>
              <MInput value={description} onChange={(x) => setDescription(x.target.value)} invalid={!!e.description} placeholder="e.g. October electricity" />
            </MField>
            <MField label="Bill number" req error={e.invoiceNo}>
              <MInput value={invoiceNo} onChange={(x) => setInvoiceNo(x.target.value)} invalid={!!e.invoiceNo} />
            </MField>
            <MField label="Date paid" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} invalid={!!e.date} />
            </MField>
          </div>
          {dupNow ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-danger">
              <input type="checkbox" className={checkboxClass} checked={different} onChange={(x) => setDifferent(x.target.checked)} />
              This is a different bill — save it anyway
            </label>
          ) : null}
          <MField label="Paid from" req>
            <PaidFromCards choices={accountChoices(kit.accounts, amount ?? 0, "out", undefined, kit.seesBalances)} value={paidFrom} onChange={setPaidFrom} error={e.paidFrom} />
          </MField>
          {!isCash ? (
            <div className="grid grid-cols-3 gap-x-4 gap-y-4">
              <MField label="Paid by" req error={e.mode}>
                <MSelect value={mode} onChange={setMode} options={PAY_MODES.filter((m) => m !== "Cash")} />
              </MField>
              <MField label="UTR / cheque no." error={e.reference} className="col-span-2">
                <MInput value={reference} onChange={(x) => setReference(x.target.value)} placeholder="Optional" />
              </MField>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <MField label="Bill photo">
              <FileBox value={file} onChange={setFile} empty="Add a photo or PDF" />
            </MField>
            <MField label="Note">
              <MInput value={note} onChange={(x) => setNote(x.target.value)} placeholder="Optional" />
            </MField>
          </div>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left={needsApproval ? "Above " + inr(kit.approvalAbove) + " — the accountant approves it" : ""}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || (!!dupNow && !different)} onClick={submit}>
          {busy ? "Saving…" : "Save expense"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* ================================================== production petty cash */

/** The Paid-from cards petty cash offers: GPay from a bank, the petty cash float, a withdrawal's cash, or a customer's cash. */
function pettyChoices(kit: MoneyKit, amount: number): CardChoice[] {
  const bank = kit.accounts.find((a) => a.kind === "bank");
  const petty = kit.accounts.find((a) => a.kind === "petty");
  const out: CardChoice[] = [];
  if (bank) out.push({ key: bank.name, name: `${bank.name.split(" ")[0]} GPay`, kind: "bank", mark: 0, sub: "paid by GPay / UPI" });
  const show = kit.seesBalances;
  if (petty) out.push({ key: petty.name, name: petty.name, kind: "petty", sub: show ? inr(petty.balance) : "petty cash box", after: show && amount > 0 ? `${inr(petty.balance)} → ${inr(petty.balance - amount)}` : undefined });
  out.push({ key: FROM_WITHDRAWAL, name: `Cash withdrawn from ${bank ? bank.name.split(" ")[0] : "a bank"}`, kind: "cash", sub: "choose the withdrawal" });
  out.push({ key: FROM_CUSTOMER_CASH, name: "Cash from a customer", kind: "customer", sub: "choose whose cash" });
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
  return (
    <MoneyShell onClose={onClose} label="Add petty cash spend" width={820}>
      <MoneyHead title="Add petty cash spend" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Amount" req error={e.amount}>
              <MMoney autoFocus paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="Paid to" error={e.payee}>
              <MInput value={payee} onChange={(x) => setPayee(x.target.value)} placeholder="Shop or person" />
            </MField>
            <MField label="Category" req error={e.category}>
              <MSelect value={category} onChange={setCategory} options={kit.categories} placeholder="Choose…" invalid={!!e.category} />
            </MField>
            <MField label="What was it for?" error={e.description}>
              <MInput value={purpose} onChange={(x) => setPurpose(x.target.value)} placeholder="Optional" />
            </MField>
            <MField label="Bill number" req error={e.invoiceNo}>
              <MInput value={invoiceNo} onChange={(x) => setInvoiceNo(x.target.value)} invalid={!!e.invoiceNo} />
            </MField>
            <MField label="Date" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} invalid={!!e.date} />
            </MField>
          </div>
          <MField label="Paid from" req>
            <PaidFromCards choices={pettyChoices(kit, amount ?? 0)} value={from} onChange={setFrom} error={e.paidFrom} />
          </MField>
          {isSource ? (
            <MField label={from === FROM_CUSTOMER_CASH ? "Which customer's cash?" : "Which withdrawal?"} req error={e.source} hint={sources.length ? undefined : "Nothing has cash left. Enter the money received first."}>
              <MSelect
                value={source}
                onChange={setSource}
                placeholder={sources.length ? "Choose…" : "Nothing with cash left"}
                options={sources.map((s) => ({ v: s.label.split(" · ")[0], l: `${s.label} · ${inr(s.left)} left` }))}
                invalid={!!e.source}
              />
            </MField>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <MField label="Bill photo" req error={e.files}>
              <FileBox value={file} onChange={setFile} empty="Add a photo of the bill" />
            </MField>
            <MField label="Note">
              <MInput value={note} onChange={(x) => setNote(x.target.value)} placeholder="Optional" />
            </MField>
          </div>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left="The accountant checks it after you save">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
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
  return (
    <MoneyShell onClose={onClose} label="Add money received" width={880}>
      <MoneyHead title="Add money received" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Amount" req error={e.amount}>
              <MMoney autoFocus paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="From" req>
              <Segments options={["Customer", "Other party"]} value={fromKind} onChange={setFromKind} />
            </MField>
            {fromKind === "Customer" ? (
              <MField label="Which customer?" req error={e.customer} hint={open ? `They owe ${inr(open.outstanding)}` : undefined}>
                <input list="money-customers" value={customer} onChange={(x) => setCustomer(x.target.value)} className={boxClass(!!e.customer)} placeholder="Type to search" />
                <datalist id="money-customers">
                  {kit.customers.map((c) => (
                    <option key={c.id} value={c.label} />
                  ))}
                </datalist>
              </MField>
            ) : (
              <MField label="Who paid?" req error={e.customer}>
                <MInput value={payer} onChange={(x) => setPayer(x.target.value)} invalid={!!e.customer} />
              </MField>
            )}
            <MField label="Received into" req error={e.into}>
              <AccSelect kit={kit} value={into} onChange={setInto} options={kit.accounts} invalid={!!e.into} />
            </MField>
            <MField label="Date" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} invalid={!!e.date} />
            </MField>
            <MField label="What is it for?">
              <MSelect value={purpose} onChange={setPurpose} options={["Invoice payment", "Advance from customer", "Other"]} />
            </MField>
            {isBank ? (
              <>
                <MField label="Paid by" req error={e.mode}>
                  <MSelect value={mode} onChange={setMode} options={PAY_MODES.filter((m) => m !== "Cash")} />
                </MField>
                <MField label="UTR / cheque no." req error={e.reference} className="col-span-2">
                  <MInput value={reference} onChange={(x) => setReference(x.target.value)} />
                </MField>
              </>
            ) : null}
          </div>

          {fromKind === "Customer" && cust ? (
            <div>
              <div className="mb-1.5 text-sm font-semibold text-body">Which bills does it pay? Oldest are ticked first.</div>
              {list.length ? (
                <LineTable
                  head={[{ l: "", w: "w-12" }, { l: "Invoice" }, { l: "Bill date" }, { l: "Due" }, { l: "Balance", align: "right" }, { l: "Apply", align: "right" }]}
                  foot={
                    <Tr>
                      <Td />
                      <Td className="text-sm text-muted">Not against a bill: {inr(onAccount)}</Td>
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
                <div className="rounded-card border border-line px-4 py-3 text-sm text-muted">No unpaid bills — the whole amount is kept on their account.</div>
              )}
            </div>
          ) : null}

          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left={kit.seesBalances && acc && amount ? `${acc.name}: ${inr(acc.balance)} → ${inr(acc.balance + amount)}` : ""}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* =============================================================== transfer */

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
  /* Two boxes, From and To, over every account. How it moved follows from
     the two kinds exactly as the old four "types" did. */
  const bank = kit.accounts.find((a) => a.kind === "bank");
  const cashLike = kit.accounts.find((a) => a.kind !== "bank");
  const [from, setFrom] = React.useState(bank?.name ?? kit.accounts[0]?.name ?? "");
  const [to, setTo] = React.useState(cashLike?.name ?? kit.accounts.find((a) => a.name !== (bank?.name ?? kit.accounts[0]?.name))?.name ?? "");
  const [date, setDate] = React.useState(kit.today);
  const [amount, setAmount] = React.useState<number | null>(null);
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [file, setFile] = React.useState<Upload>(null);
  const fa = accountByName(kit, from);
  const ta = accountByName(kit, to);
  const fromBank = fa?.kind === "bank";
  const toBank = ta?.kind === "bank";
  const amt = amount ?? 0;
  const e = errs;
  const mode = fromBank && toBank ? "NEFT" : fromBank ? "Cheque" : "Cash";
  const submit = () => save(() => erpMoneyTransfer({ date, from, to, amountPaise: amount, mode, reference, source: null, note: description, files: file ? [file.id] : [] }));
  const line = (a: KitAccount | undefined, sign: 1 | -1) => (a ? `${a.name}: ${inr(a.balance)} → ${inr(a.balance + sign * amt)}` : "");
  return (
    <MoneyShell onClose={onClose} label="Move money" width={760}>
      <MoneyHead title="Move money" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-5">
            <MField label="From" req error={e.from} hint={!kit.seesBalances ? undefined : amt ? line(fa, -1) : fa ? `Has ${inr(fa.balance)}` : undefined}>
              <AccSelect kit={kit} value={from} onChange={setFrom} options={kit.accounts} invalid={!!e.from} />
            </MField>
            <span className={cx("text-2xl text-brand", kit.seesBalances && (amt || fa) ? "pb-8" : "pb-2.5")}>→</span>
            <MField label="To" req error={e.to ?? (from && from === to ? "Choose a different account." : undefined)} hint={!kit.seesBalances ? undefined : amt ? line(ta, 1) : ta ? `Has ${inr(ta.balance)}` : undefined}>
              <AccSelect kit={kit} value={to} onChange={setTo} options={kit.accounts} invalid={!!e.to || (!!from && from === to)} />
            </MField>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="Amount" req error={e.amount}>
              <MMoney autoFocus paise={amount} onPaise={setAmount} invalid={!!e.amount} />
            </MField>
            <MField label="Date" req error={e.date}>
              <MInput type="date" value={date} max={kit.today} onChange={(x) => setDate(x.target.value)} />
            </MField>
            <MField label={fromBank ? "Cheque / slip no." : "Deposit slip no."} error={e.reference}>
              <MInput value={reference} onChange={(x) => setReference(x.target.value)} placeholder="Optional" />
            </MField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <MField label="Note">
              <MInput value={description} onChange={(x) => setDescription(x.target.value)} placeholder="Optional — e.g. weekly petty cash top-up" />
            </MField>
            <MField label="Slip photo">
              <FileBox value={file} onChange={setFile} empty="Add a photo or PDF" />
            </MField>
          </div>
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left="Moving money is not an expense — nothing is spent">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !from || !to || from === to || !amt} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </MoneyFoot>
    </MoneyShell>
  );
}

/* ================================================================ advance */

export function AdvanceDialog({ kit, onClose }: { kit: MoneyKit; onClose: () => void }) {
  const { busy, errs, save } = useSave(onClose);
  /* The person, by account id: the name is only what the list shows. */
  const [personId, setPersonId] = React.useState("");
  const [amount, setAmount] = React.useState<number | null>(null);
  const [date, setDate] = React.useState(kit.today);
  const [purpose, setPurpose] = React.useState("");
  const due = (d: string) => addDays(d, kit.billsDays);
  const [billsDue, setBillsDue] = React.useState(due(kit.today));
  const [handed, setHanded] = React.useState("Cash");
  const petty = kit.accounts.find((a) => a.kind === "petty");
  const cash = kit.accounts.find((a) => a.kind === "cash");
  const bank = kit.accounts.find((a) => a.kind === "bank");
  const [from, setFrom] = React.useState(petty?.name ?? cash?.name ?? "");
  const [source, setSource] = React.useState("");
  const amt = amount ?? 0;
  const choices: CardChoice[] = [];
  const show = kit.seesBalances;
  if (petty) choices.push({ key: petty.name, name: petty.name, kind: "petty", sub: show ? inr(petty.balance) : "petty cash box", after: show && amt ? `${inr(petty.balance)} → ${inr(petty.balance - amt)}` : undefined });
  if (cash) choices.push({ key: cash.name, name: cash.name, kind: "cash", sub: show ? inr(cash.balance) : "office cash", after: show && amt ? `${inr(cash.balance)} → ${inr(cash.balance - amt)}` : undefined });
  if (bank) choices.push({ key: bank.name, name: `${bank.name.split(" ")[0]} GPay`, kind: "bank", sub: "sent by GPay / UPI" });
  choices.push({ key: FROM_CUSTOMER_CASH, name: "Cash from a customer", kind: "customer", sub: "choose whose cash" });
  const isCustomer = from === FROM_CUSTOMER_CASH;
  const accName = isCustomer ? (cash?.name ?? "") : from;
  const fromAcc = accountByName(kit, accName);
  const mode = fromAcc?.kind === "bank" ? (handed === "Cash" ? "UPI" : handed) : "Cash";
  const emp = kit.employees.find((x) => x.id === personId);
  const employee = emp?.name ?? "";
  const first = employee.split(" ")[0] || "They";
  const e = errs;
  const submit = () =>
    save(() =>
      erpMoneyAdvance({
        userId: personId || null,
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
    <MoneyShell onClose={onClose} label="Give advance" width={780}>
      <MoneyHead title="Give advance" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-x-4 gap-y-4">
            <MField label="To whom?" req error={e.employee}>
              <MSelect
                value={personId}
                onChange={setPersonId}
                placeholder="Choose…"
                options={kit.employees.map((x) => ({ v: x.id, l: `${x.name}${x.dept ? ` · ${x.dept}` : ""}${x.open ? " — has an advance open" : ""}` }))}
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
            <MField label="What is it for?" error={e.purpose}>
              <MInput value={purpose} onChange={(x) => setPurpose(x.target.value)} placeholder="What the money is for" />
            </MField>
            <MField label="Bills due by" error={e.billsDueOn} hint="A reminder goes out on this day">
              <MInput type="date" value={billsDue} onChange={(x) => setBillsDue(x.target.value)} />
            </MField>
            {fromAcc?.kind === "bank" ? (
              <MField label="Sent by" error={e.mode}>
                <MSelect value={handed === "Cash" ? "UPI" : handed} onChange={setHanded} options={["UPI", "NEFT", "IMPS"]} />
              </MField>
            ) : null}
          </div>
          <MField label="Paid from" req>
            <PaidFromCards choices={choices} value={from} onChange={setFrom} error={e.from} />
          </MField>
          {isCustomer ? (
            <MField label="Which customer's cash?" req>
              <MSelect value={source} onChange={setSource} placeholder={kit.customerCash.length ? "Choose…" : "Nothing with cash left"} options={kit.customerCash.map((s) => ({ v: s.label.split(" · ")[0], l: `${s.label} · ${inr(s.left)} left` }))} />
            </MField>
          ) : null}
          {emp?.open ? (
            <Note tone="warn">
              {first} already has an advance that is not settled. Settle that one first.
            </Note>
          ) : null}
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left="Not an expense yet — their bills are, once checked">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Give advance"}
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
      body.set("file", await shrinkImage(f));
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
        title={`Bills for ${target.employee}'s advance`}
        code={
          <span className="font-sans text-sm text-muted">
            {target.label} · {inr(target.withThem)} still to show bills for
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
                      <MMoney paise={l.amount} onPaise={(p) => set(i, { amount: p })} />
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
              — each photo becomes a line
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
          {e._ ? <Note tone="danger">{e._}</Note> : null}
        </div>
      </div>
      <MoneyFoot left="No bill? Tick “No bill?” on the line and say why">
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
