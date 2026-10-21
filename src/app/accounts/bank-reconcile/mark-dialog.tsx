"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { bankCustomerBills, bankEditLine, bankLineDetail, bankMark, bankMarkKit } from "@/lib/actions/bank-statements";
import { MARK_IN, MARK_OUT, type MarkKind } from "@/lib/engines/bank-statements";
import type { LineView, MarkKit } from "@/lib/services/bank-statement-service";
import { Btn, dayLabel, Dialog, FieldLabel, figure, inputCls, inr, labelCls, Note, Pill } from "../bank-statements/bank-ui";

/* ---------------------------------------------------------------------------
 * MARKING A LINE BY HAND — what a line nothing explains actually is. Money in
 * is a customer payment (applied to their open bills, oldest first), a
 * transfer from one of our accounts, or other money in. Money out is a vendor
 * payment, an expense, salary, GST / TDS, bank charges, a transfer or other
 * money out. Saving creates the record that was missing and matches it.
 * ------------------------------------------------------------------------- */

type Bill = { id: string; no: string; billDate: string; dueDate: string | null; balance: number };

export function MarkDialog({ lineId, preset, onClose, onDone }: { lineId: string; preset?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [line, setLine] = React.useState<LineView | null>(null);
  const [kit, setKit] = React.useState<MarkKit | null>(null);
  const [as, setAs] = React.useState<MarkKind | null>((preset as MarkKind) ?? null);
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [custQuery, setCustQuery] = React.useState("");
  const [bills, setBills] = React.useState<Bill[]>([]);
  const [alloc, setAlloc] = React.useState<"auto" | "custom">("auto");
  const [order, setOrder] = React.useState<"oldest" | "newest">("oldest");
  const [custom, setCustom] = React.useState<Record<string, number>>({});
  const [ticked, setTicked] = React.useState<Set<string> | null>(null);
  const [mode, setMode] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [payoutId, setPayoutId] = React.useState<string | null>(null);
  const [counter, setCounter] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState("");
  const [party, setParty] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const [d, k] = await Promise.all([bankLineDetail(lineId), bankMarkKit(lineId)]);
      if (!d || !k) return;
      setLine(d.line);
      setKit(k);
      const credit = d.line.creditPaise > 0;
      setAs((cur) => cur ?? (credit ? "customer_payment" : "expense"));
      setReference(d.line.reference ?? (/\b(\d{6})\b/.exec(d.line.description)?.[1] ?? ""));
      const g = /\b(CHQ|CHEQUE|CLG)\b/i.test(d.line.description) ? "Cheque" : /\bUPI\b/i.test(d.line.description) ? "UPI" : "Bank transfer";
      setMode(k.modes.includes(g) ? g : k.modes[0]);
      if (k.guessCustomerId) setCustomerId(k.guessCustomerId);
      const amount = d.line.debitPaise || d.line.creditPaise;
      const eq = k.payouts.find((p) => p.amountPaise === amount);
      if (eq) setPayoutId(eq.id);
      setCategory(k.categories.includes("Freight") ? "" : "");
    })();
  }, [lineId]);

  React.useEffect(() => {
    if (!customerId) return;
    let stop = false;
    void bankCustomerBills(customerId).then((b) => {
      if (stop) return;
      setBills(b as Bill[]);
      setCustom({});
      setTicked(null);
    });
    return () => {
      stop = true;
    };
  }, [customerId]);

  if (!line || !kit)
    return (
      <Dialog open onClose={onClose} title="Mark this line" width={880} top={70}>
        <div className="px-5 py-10 text-center text-[12.5px] text-muted">Loading…</div>
      </Dialog>
    );

  const credit = line.creditPaise > 0;
  const amount = line.debitPaise || line.creditPaise;
  const choices = credit ? MARK_IN : MARK_OUT;
  const customer = kit.customers.find((c) => c.id === customerId) ?? null;
  const outstanding = bills.reduce((s, b) => s + b.balance, 0);

  /* What the payment would settle — the same oldest-first spread the server runs. */
  const spread: Record<string, number> = {};
  if (alloc === "custom") Object.assign(spread, custom);
  else {
    let left = amount;
    const list = (ticked ? bills.filter((b) => ticked.has(b.id)) : bills).slice();
    if (order === "newest") list.reverse();
    for (const b of list) {
      if (left <= 0) break;
      const take = Math.min(left, b.balance);
      spread[b.id] = take;
      left -= take;
    }
  }
  const applied = Object.values(spread).reduce((s, x) => s + x, 0);
  const onAccount = amount - applied;
  const moved = bills.filter((b) => (spread[b.id] ?? 0) > 0);

  const matches = custQuery.trim().length >= 2 ? kit.customers.filter((c) => `${c.name} ${c.city ?? ""}`.toLowerCase().includes(custQuery.trim().toLowerCase())).slice(0, 8) : [];

  async function save() {
    if (!as) return;
    setBusy(true);
    try {
      const r = await toast.run(
        bankMark(lineId, {
          as,
          customerId,
          mode,
          reference: reference || null,
          allocation: alloc === "custom" ? "custom" : ticked ? "settle" : "auto",
          order,
          billIds: ticked ? [...ticked] : [],
          custom: alloc === "custom" ? custom : {},
          payoutId,
          counterAccountId: counter,
          category: category || null,
          party: party || null,
          description: description || null,
        }),
      );
      if (r.ok) {
        onDone();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  const ready =
    as === "customer_payment"
      ? !!customerId && (alloc !== "custom" || applied <= amount)
      : as === "vendor_payment"
        ? !!payoutId
        : as === "transfer"
          ? !!counter
          : as === "expense"
            ? !!category
            : true;

  return (
    <Dialog
      open
      onClose={onClose}
      width={880}
      top={70}
      title="Mark this line"
      aside={
        <Pill tone={credit ? "ok" : "danger"}>
          {credit ? "+" : "−"}
          {inr(amount, { paise: true })} · {dayLabel(line.date)} · {line.account}
          {line.last4 ? ` ··${line.last4}` : ""}
        </Pill>
      }
      foot={
        <>
          <span className="text-[11.5px] text-muted">
            {credit ? "Credit lines offer: Customer payment · Transfer from our account · Other money in" : "Debit lines offer: Vendor payment · Expense · Salary · GST / TDS · Bank charges · Transfer to our account · Other"}
          </span>
          <Btn className="ml-auto" onClick={onClose}>
            Cancel
          </Btn>
          <Btn tone="primary" disabled={busy || !ready} onClick={save}>
            {busy ? "Saving…" : "Save and match"}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 px-5 py-4">
        <div className="rounded-[8px] border border-divider bg-[#fafbfc] px-2.5 py-2 font-mono text-[11.5px] break-all text-ink">
          {line.description}
          {line.reference ? ` · Ref ${line.reference}` : ""}
        </div>
        <div>
          <FieldLabel>{credit ? "What is this money in?" : "What is this money out?"}</FieldLabel>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${credit ? 3 : 4}, minmax(0, 1fr))` }}>
            {choices.map((c) => (
              <button
                key={c.v}
                type="button"
                onClick={() => setAs(c.v)}
                className={cx(
                  "flex cursor-pointer items-start gap-[9px] rounded-[10px] border bg-surface px-[11px] py-[9px] text-left text-[12px] text-muted",
                  as === c.v ? "border-brand bg-[#fbfaff] shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line hover:border-line-strong",
                )}
              >
                <span className={cx("mt-0.5 h-[15px] w-[15px] flex-none rounded-full", as === c.v ? "border-[5px] border-brand" : "border-[1.6px] border-line-strong")} />
                <span>
                  <b className="block text-[12.8px] text-ink">{c.l}</b>
                  {c.v === "transfer" ? kit.accounts.filter((a) => a.id !== line.accountId).map((a) => a.name.replace(/\s*bank$/i, "")).join(", ") : c.s}
                </span>
              </button>
            ))}
          </div>
        </div>

        {as === "customer_payment" ? (
          <>
            <div className="grid grid-cols-3 gap-x-3.5 gap-y-3">
              <div className="relative">
                <FieldLabel required>Customer</FieldLabel>
                {customer ? (
                  <button type="button" onClick={() => setCustomerId(null)} className={cx(inputCls, "flex cursor-pointer items-center text-left")}>
                    <span className="truncate">
                      {customer.name}
                      {customer.city ? ` · ${customer.city}` : ""}
                    </span>
                    <span className="ml-auto text-faint">▾</span>
                  </button>
                ) : (
                  <>
                    <input autoFocus className={inputCls} value={custQuery} onChange={(e) => setCustQuery(e.target.value)} placeholder="Type a name or a town…" />
                    {matches.length ? (
                      <div className="absolute inset-x-0 top-[62px] z-10 max-h-[260px] overflow-auto rounded-[9px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
                        {matches.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setCustomerId(c.id);
                              setCustQuery("");
                            }}
                            className="block w-full cursor-pointer border-none bg-transparent px-3 py-2 text-left text-[12.5px] text-ink hover:bg-brand-soft"
                          >
                            {c.name}
                            {c.city ? <span className="text-muted"> · {c.city}</span> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
                {kit.guessCustomerId && customerId === kit.guessCustomerId ? <div className="mt-1 text-[11.5px] text-muted">Name found in the narration</div> : null}
              </div>
              <div>
                <FieldLabel>Mode</FieldLabel>
                <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                  {kit.modes.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel>{mode === "Cheque" ? "Cheque no." : "Reference / UTR"}</FieldLabel>
                <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
            </div>
            {customer ? (
              <div>
                <div className={cx(labelCls, "mb-1.5")}>Apply to open bills · outstanding {inr(outstanding)}</div>
                {bills.length ? (
                  <div className="overflow-hidden rounded-[12px] border border-line">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          {["", "Bill", "Billed", "Due", "Balance", "Applied"].map((h, i) => (
                            <th key={i} className={cx("border-b border-line bg-[#fafbfc] px-2.5 py-2 text-left text-[11px] font-bold tracking-[0.06em] text-muted uppercase", i >= 4 && "text-right")}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bills.map((b) => {
                          const on = (spread[b.id] ?? 0) > 0;
                          const late = b.dueDate && b.dueDate < line.date ? Math.round((Date.parse(line.date) - Date.parse(b.dueDate)) / 86_400_000) : 0;
                          return (
                            <tr key={b.id}>
                              <td className="border-b border-divider px-2.5 py-[7px] text-[12px]">
                                <input
                                  type="checkbox"
                                  className="h-[15px] w-[15px] cursor-pointer accent-brand"
                                  checked={alloc === "custom" ? (custom[b.id] ?? 0) > 0 : ticked ? ticked.has(b.id) : on}
                                  onChange={(e) => {
                                    if (alloc === "custom") {
                                      const n = { ...custom };
                                      if (e.target.checked) n[b.id] = Math.min(b.balance, Math.max(0, amount - Object.values(custom).reduce((s, x) => s + x, 0)));
                                      else delete n[b.id];
                                      setCustom(n);
                                    } else {
                                      const t = new Set(ticked ?? bills.filter((x) => (spread[x.id] ?? 0) > 0).map((x) => x.id));
                                      if (e.target.checked) t.add(b.id);
                                      else t.delete(b.id);
                                      setTicked(t);
                                    }
                                  }}
                                />
                              </td>
                              <td className="border-b border-divider px-2.5 py-[7px] text-[12px]">{on ? <b className="text-ink">{b.no}</b> : b.no}</td>
                              <td className="border-b border-divider px-2.5 py-[7px] text-[12px]">{dayLabel(b.billDate)}</td>
                              <td className="border-b border-divider px-2.5 py-[7px] text-[12px]">{late ? <Pill tone="danger">{late} days late</Pill> : b.dueDate ? dayLabel(b.dueDate) : "—"}</td>
                              <td className="border-b border-divider px-2.5 py-[7px] text-right text-[12px] tabular-nums">{inr(b.balance)}</td>
                              <td className="border-b border-divider px-2.5 py-[7px] text-right text-[12px] tabular-nums">
                                {alloc === "custom" ? (
                                  <input
                                    inputMode="decimal"
                                    className="h-7 w-[100px] rounded-[6px] border border-line px-1.5 text-right text-[12px] outline-none focus:border-brand"
                                    value={custom[b.id] ? String(custom[b.id] / 100) : ""}
                                    onChange={(e) => {
                                      const v = Math.round(Number(e.target.value.replace(/[^\d.]/g, "")) * 100) || 0;
                                      setCustom({ ...custom, [b.id]: Math.min(v, b.balance) });
                                    }}
                                  />
                                ) : on ? (
                                  <b className="text-ink">{inr(spread[b.id])}</b>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Note tone="i">{customer.name} has no open bills. The whole amount goes on account.</Note>
                )}
                <div className="mt-1.5 text-[11.5px] text-muted">
                  <SpreadLink on={alloc === "auto" && order === "oldest"} onClick={() => (setAlloc("auto"), setOrder("oldest"), setTicked(null))}>
                    Oldest first
                  </SpreadLink>
                  {" · "}
                  <SpreadLink on={alloc === "auto" && order === "newest"} onClick={() => (setAlloc("auto"), setOrder("newest"), setTicked(null))}>
                    newest first
                  </SpreadLink>
                  {" · "}
                  <SpreadLink on={alloc === "custom"} onClick={() => (setAlloc("custom"), setCustom({ ...spread }))}>
                    split it myself
                  </SpreadLink>
                  {" · "}
                  {onAccount > 0 ? `${inr(onAccount)} left over goes on account` : onAccount < 0 ? <span className="text-danger">{inr(-onAccount)} more than the line — take some off</span> : "nothing left over for on account"}
                </div>
              </div>
            ) : null}
            {customer ? (
              <Note tone="i">
                Saving records a <b>confirmed</b> receipt dated {dayLabel(line.date)}, linked to this bank line.
                {moved.length ? ` ${moved.length === 1 ? "Bill" : "Bills"} ${moved.map((b) => b.no.split("/").pop()).join(" and ")} move, and` : ""} {customer.name}&apos;s outstanding becomes {inr(Math.max(0, outstanding - applied))}.
              </Note>
            ) : null}
          </>
        ) : null}

        {as === "vendor_payment" ? (
          <div>
            <FieldLabel required>Which payout does this pay?</FieldLabel>
            {kit.payouts.length ? (
              <div className="max-h-[300px] overflow-auto rounded-[12px] border border-line">
                {kit.payouts
                  .slice()
                  .sort((a, b) => Math.abs(a.amountPaise - amount) - Math.abs(b.amountPaise - amount))
                  .map((p) => (
                    <label key={p.id} className={cx("flex cursor-pointer items-center gap-2.5 border-b border-divider px-3 py-2 text-[12.5px]", payoutId === p.id && "bg-brand-soft")}>
                      <input type="radio" name="payout" className="accent-brand" checked={payoutId === p.id} onChange={() => setPayoutId(p.id)} />
                      <span className="min-w-0 flex-1">
                        <b className="text-ink">{p.payee}</b> <span className="text-muted">· {p.label} · planned {dayLabel(p.payOn)}</span>
                      </span>
                      {p.amountPaise === amount ? <Pill tone="ok">Amount equal</Pill> : null}
                      <b className="text-ink tabular-nums">{inr(p.amountPaise)}</b>
                    </label>
                  ))}
              </div>
            ) : (
              <Note tone="i">No payout is open. Mark it as an expense instead, or add the payout on Cash flow → Payables first.</Note>
            )}
            <Note tone="i" className="mt-2">
              Saving marks the payout paid on {dayLabel(line.date)} for {inr(amount)} and links it to this bank line.
            </Note>
          </div>
        ) : null}

        {as === "transfer" ? (
          <div className="grid grid-cols-2 gap-x-3.5">
            <div>
              <FieldLabel required>{credit ? "From which of our accounts?" : "To which of our accounts?"}</FieldLabel>
              <select className={inputCls} value={counter ?? ""} onChange={(e) => setCounter(e.target.value || null)}>
                <option value="">Choose…</option>
                {kit.accounts
                  .filter((a) => a.id !== line.accountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </div>
            <Note tone="i" className="self-end">
              Saving enters the transfer on Petty Cash and matches it. It is never income or expense.
            </Note>
          </div>
        ) : null}

        {as && !["customer_payment", "vendor_payment", "transfer"].includes(as) ? (
          <div className="grid grid-cols-3 gap-x-3.5 gap-y-3">
            {as === "expense" ? (
              <div>
                <FieldLabel required>Category</FieldLabel>
                <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">Choose…</option>
                  {kit.categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <FieldLabel>{credit ? "Received from" : "Paid to"}</FieldLabel>
              <input className={inputCls} value={party} onChange={(e) => setParty(e.target.value)} placeholder={credit ? "e.g. Kotak Bank (interest)" : "e.g. MSEDCL"} />
            </div>
            <div className={as === "expense" ? "" : "col-span-2"}>
              <FieldLabel>What it was</FieldLabel>
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={credit ? "Interest, refund, scrap sale, loan…" : "What it was for"} />
            </div>
            <Note tone="i" className="col-span-3">
              Saving enters it on Petty Cash{as === "salary" ? " under Salary" : as === "tax" ? " under GST / TDS" : as === "charges" ? " under Bank charges" : ""}, paid {credit ? "into" : "from"} {line.account}, and matches it to this line.
            </Note>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function SpreadLink({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return on ? (
    <span className="font-[650] text-body">{children}</span>
  ) : (
    <button type="button" onClick={onClick} className="cursor-pointer border-none bg-transparent p-0 font-semibold text-brand hover:underline">
      {children}
    </button>
  );
}

/* ---------------------------------------------------------- fix a figure */

export function EditLineDialog({ line, onClose, onDone }: { line: LineView; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const credit = line.creditPaise > 0;
  const [date, setDate] = React.useState(line.date);
  const [description, setDescription] = React.useState(line.description);
  const [reference, setReference] = React.useState(line.reference ?? "");
  const [side, setSide] = React.useState<"in" | "out">(credit ? "in" : "out");
  const [amount, setAmount] = React.useState(figure(line.debitPaise || line.creditPaise).replace(/,/g, ""));
  const [balance, setBalance] = React.useState(line.balancePaise == null ? "" : figure(line.balancePaise).replace(/,/g, "").replace("−", "-"));
  const [busy, setBusy] = React.useState(false);
  const paise = (s: string) => Math.round(Number(s.replace(/[^\d.-]/g, "")) * 100);

  async function save() {
    setBusy(true);
    const a = paise(amount);
    const r = await toast.run(
      bankEditLine(line.id, {
        date,
        description,
        reference: reference || null,
        debitPaise: side === "out" ? a : 0,
        creditPaise: side === "in" ? a : 0,
        balancePaise: balance.trim() === "" ? null : paise(balance),
      }),
    );
    setBusy(false);
    if (r.ok) {
      onDone();
      onClose();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Fix a figure the reading got wrong"
      width={640}
      top={120}
      foot={
        <>
          {line.uploadId ? (
            <a href={`/api/accounts/bank-statements/${line.uploadId}/pdf${line.page ? `#page=${line.page}` : ""}`} target="_blank" rel="noreferrer" className="text-[12.5px] font-semibold text-brand hover:underline">
              Open the PDF{line.page ? ` at page ${line.page}` : ""} ↗
            </a>
          ) : null}
          <Btn className="ml-auto" onClick={onClose}>
            Cancel
          </Btn>
          <Btn tone="primary" disabled={busy || !(paise(amount) > 0)} onClick={save}>
            Save the line
          </Btn>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3.5 gap-y-3 px-5 py-4">
        <div>
          <FieldLabel required>Date</FieldLabel>
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Ref / UTR</FieldLabel>
          <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="col-span-2">
          <FieldLabel required>Narration</FieldLabel>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <FieldLabel required>Amount</FieldLabel>
          <div className="flex gap-2">
            <select className={cx(inputCls, "w-[120px]")} value={side} onChange={(e) => setSide(e.target.value as "in" | "out")}>
              <option value="in">Credit</option>
              <option value="out">Debit</option>
            </select>
            <input inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          </div>
        </div>
        <div>
          <FieldLabel>Balance after</FieldLabel>
          <input inputMode="decimal" className={inputCls} value={balance} onChange={(e) => setBalance(e.target.value.replace(/[^\d.-]/g, ""))} />
        </div>
        <Note tone="i" className="col-span-2">
          Correcting a line clears its flag and works out its matches again. The change is in the audit log with what it was before.
        </Note>
      </div>
    </Dialog>
  );
}
