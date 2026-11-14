"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NavLink } from "@/components/shell/nav-link";
import { Button, checkboxClass, cx, Field, Input, MoneyInput, Select, Td, Textarea, Th, Tr } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog, StepBar, TabBar } from "../../_ui/dialog";
import { eyebrowClass, insetClass, linkClass, SubTitle, toggleClass } from "../../_ui/look";
import {
  erpFreightBillDelete,
  erpFreightBillPay,
  erpFreightBillResplit,
  erpFreightBillSave,
  erpFreightBillUnpay,
  erpFreightOrderLines,
  erpFreightVehicleLines,
} from "@/lib/actions/erp-logistics";
import { costPerLitrePaise, lineEligibility, paiseFromRupees, PAYMENT_MODE_LABEL, PAYMENT_MODES, splitBill, type PaymentMode } from "@/lib/erp/engines/freight-bill";
import { shortDay } from "@/lib/erp/engines/logistics";
import type { FreightBillView, FreightReport, FreightReportRow, VehicleLine, VehicleTrip } from "@/lib/erp/freight-bills";
import { fd, inr, inrRate, nf } from "@/lib/erp/ui";
import { Empty, plural, ReasonDialog, useAct } from "./common";

/* ---------------------------------------------------------------------------
 * LOGISTICS → TRANSPORT EXPENSES (the Transportation Expense PRD). Two
 * sub-tabs — Pending expense and Paid history — and the reports behind one
 * button. Only Paid freight is our expense, so To Pay never appears here.
 *
 * Pending expense is everything still owed to a transporter, in two halves:
 * the Paid-freight trips whose bill has not arrived yet, and the bills that
 * have arrived and are not paid. It used to list the second half alone, with
 * the first as a bare count on a card — so on a day nobody had typed a bill in,
 * the list said nothing was waiting while a hundred trips were, and none of
 * them could be reached from the list to enter its bill. A transporter's bill is entered against the vehicle that carried the
 * goods; the split by litres is previewed here with the same `splitBill` the
 * server writes with, so what is shown before saving is what is saved.
 * ------------------------------------------------------------------------- */

export type FreightSub = "pending" | "paid" | "reports";

type Props = {
  sub: FreightSub;
  /** The tab's own address (`?view=freight`); sub-tabs and filters add to it. */
  base: string;
  bills: FreightBillView[];
  /** A bill opened by a link that is not in the list on screen. */
  openedBill: FreightBillView | null;
  report: FreightReport | null;
  vehicles: VehicleTrip[];
  transporters: string[];
  pendingCount: number;
  pendingPaise: number;
  /** How far back the trips waiting for a bill go — the add-bill picker's reach. */
  tripDays: number;
  month: string;
  from: string;
  to: string;
  today: string;
  canWrite: boolean;
  manager: boolean;
  initialOpen: string | null;
  initialAdd: boolean;
};

type Dialog = { kind: "add"; trip?: VehicleTrip } | { kind: "edit"; bill: FreightBillView } | { kind: "view"; id: string } | { kind: "pay"; id: string } | { kind: "unpay"; id: string } | { kind: "delete"; id: string } | null;

const qs = (base: string, extra: Record<string, string>) => `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(extra).toString()}`;
const perLitre = (amount: number, litres: number) => {
  const r = costPerLitrePaise(amount, litres);
  return r == null ? "—" : inrRate(Math.round(r * 100) / 100);
};

export function FreightDesk(p: Props) {
  const { run, pending } = useAct();
  const [dialog, setDialog] = useState<Dialog>(p.initialAdd && p.canWrite ? { kind: "add" } : p.initialOpen ? { kind: "view", id: p.initialOpen } : null);
  const [q, setQ] = useState("");
  const close = () => setDialog(null);
  const byId = useMemo(() => new Map([...p.bills, ...(p.openedBill ? [p.openedBill] : [])].map((b) => [b.id, b])), [p.bills, p.openedBill]);
  const needle = q.trim().toLowerCase();
  const shown = p.bills.filter((b) => !needle || [b.name, b.transporter, b.vehicleNo, ...b.shares.map((s) => s.customer)].some((x) => x.toLowerCase().includes(needle)));
  const total = shown.reduce((a, b) => a + b.amountPaise, 0);
  const litres = shown.reduce((a, b) => a + b.litres, 0);
  const viewing = dialog?.kind === "view" ? byId.get(dialog.id) : null;
  /* Paid-freight trips with lines on no bill — the bill has not come in yet. Oldest first, like the bills. */
  const waiting = useMemo(() => p.vehicles.filter((v) => v.unbilledLines > 0).sort((a, b) => a.dispatchOn.localeCompare(b.dispatchOn) || a.vehicleNo.localeCompare(b.vehicleNo)), [p.vehicles]);
  const waitingShown = waiting.filter((v) => !needle || [v.vehicleNo, v.transporter ?? ""].some((x) => x.toLowerCase().includes(needle)));
  const waitingLines = waiting.reduce((a, v) => a + v.unbilledLines, 0);
  const paying = dialog?.kind === "pay" ? byId.get(dialog.id) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <NavLink href={qs(p.base, { ft: "pending" })} className={toggleClass(p.sub === "pending", "rounded-full px-3.5 py-1.5")}>
          Pending expense · {p.pendingCount + waiting.length}
        </NavLink>
        <NavLink href={qs(p.base, { ft: "paid" })} className={toggleClass(p.sub === "paid", "rounded-full px-3.5 py-1.5")}>
          Paid history
        </NavLink>
        <span className="flex-1" />
        <NavLink href={qs(p.base, { ft: "reports" })} className={toggleClass(p.sub === "reports", "rounded-full px-3.5 py-1.5")}>
          Reports
        </NavLink>
        {p.canWrite ? (
          <Button variant="primary" onClick={() => setDialog({ kind: "add" })}>
            + Add transport bill
          </Button>
        ) : null}
      </div>

      {p.sub === "reports" && p.report ? (
        <Reports report={p.report} base={p.base} />
      ) : (
        <>
          <CardGrid min="card" gap="gap-3">
            {p.sub === "pending" ? (
              <>
                <Figure label="Bill not received yet" value={plural(waiting.length, "trip")} sub={`${plural(waitingLines, "order line")} · left in the last ${p.tripDays} days`} warn={waiting.length > 0} />
                <Figure label="Bills to pay" value={inr(p.pendingPaise)} sub={plural(p.pendingCount, "bill")} />
                <Figure label="Litres on those bills" value={`${nf(litres)} L`} />
                <Figure label="Average cost per litre" value={perLitre(total, litres)} sub="On the bills to pay" />
              </>
            ) : (
              <>
                <Figure label="Paid in this month" value={inr(total)} sub={plural(shown.length, "bill")} />
                <Figure label="Litres carried" value={`${nf(litres)} L`} />
                <Figure label="Average cost per litre" value={perLitre(total, litres)} />
                <Figure
                  label="By mode"
                  value={PAYMENT_MODES.map((m) => `${PAYMENT_MODE_LABEL[m]} ${inr(shown.filter((b) => b.paymentMode === m).reduce((a, b) => a + b.amountPaise, 0))}`).join(" · ")}
                  small
                />
              </>
            )}
          </CardGrid>

          <div className="flex flex-wrap items-center gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={p.sub === "pending" ? "Search vehicle, transporter, bill, LR, customer" : "Search bill, LR, vehicle, transporter, customer"} aria-label="Search" className="w-80" />
            {p.sub === "paid" ? <MonthPicker base={p.base} month={p.month} /> : null}
            {p.sub === "paid" ? <span className="ml-auto text-meta text-muted">Newest payment first</span> : null}
          </div>

          {p.sub === "pending" ? (
            <div>
              <SubTitle aside="Oldest trip first">Bill not received yet</SubTitle>
              <div className="overflow-x-auto rounded-card border border-line bg-surface">
                {waitingShown.length ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <Th>Left on</Th>
                        <Th>Vehicle</Th>
                        <Th>Transporter</Th>
                        <Th align="right">Order lines</Th>
                        <Th align="right">Customers</Th>
                        <Th align="right">Litres</Th>
                        <Th />
                      </tr>
                    </thead>
                    <tbody>
                      {waitingShown.map((v) => (
                        <Tr key={tripKey(v)}>
                          <Td>{fd(v.dispatchOn)}</Td>
                          <Td className="font-mono text-meta">{v.vehicleNo}</Td>
                          <Td>{v.transporter ?? "—"}</Td>
                          <Td align="right">{v.unbilledLines}</Td>
                          <Td align="right">{v.unbilledCustomers}</Td>
                          <Td align="right">{nf(v.unbilledLitres)}</Td>
                          <Td align="right">
                            {p.canWrite ? (
                              <Button size="sm" onClick={() => setDialog({ kind: "add", trip: v })}>
                                Add bill
                              </Button>
                            ) : null}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty>{needle && waiting.length ? "No trip matches that search." : `Every Paid-freight trip of the last ${p.tripDays} days has its bill.`}</Empty>
                )}
              </div>
            </div>
          ) : null}

          <div>
            {p.sub === "pending" ? <SubTitle aside="Oldest bill first">Bill received, to pay</SubTitle> : null}
            <div className="overflow-x-auto rounded-card border border-line bg-surface">
              {shown.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {p.sub === "paid" ? <Th>Bill date</Th> : null}
                      <Th>Bill / LR</Th>
                      {p.sub === "pending" ? <Th>Bill date</Th> : null}
                      <Th>Transporter</Th>
                      <Th>Vehicle</Th>
                      <Th align="right">Litres</Th>
                      <Th align="right">Cost / L</Th>
                      <Th align="right">Amount</Th>
                      {p.sub === "pending" ? <Th align="right">Customers</Th> : null}
                      {p.sub === "paid" ? (
                        <>
                          <Th>Paid on</Th>
                          <Th>Mode</Th>
                        </>
                      ) : null}
                      <Th>Status</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((b) => (
                      <Tr key={b.id}>
                        {p.sub === "paid" ? <Td>{fd(b.billDate)}</Td> : null}
                        <Td>
                          <button type="button" className={linkClass("brand", "font-medium")} onClick={() => setDialog({ kind: "view", id: b.id })}>
                            {b.name}
                          </button>
                        </Td>
                        {p.sub === "pending" ? <Td>{fd(b.billDate)}</Td> : null}
                        <Td>{b.transporter}</Td>
                        <Td className="font-mono text-meta">{b.vehicleNo}</Td>
                        <Td align="right">{nf(b.litres)}</Td>
                        <Td align="right">{perLitre(b.amountPaise, b.litres)}</Td>
                        <Td align="right" className="font-medium">
                          {inr(b.amountPaise)}
                        </Td>
                        {p.sub === "pending" ? <Td align="right">{b.customers}</Td> : null}
                        {p.sub === "paid" ? (
                          <>
                            <Td>{b.paidOn ? fd(b.paidOn) : "—"}</Td>
                            <Td>{b.paymentMode ? PAYMENT_MODE_LABEL[b.paymentMode] : "—"}</Td>
                          </>
                        ) : null}
                        <Td>
                          <StatusBadge bill={b} today={p.today} />
                        </Td>
                        <Td align="right">
                          {p.canWrite && b.status === "pending" ? (
                            b.stale.length ? (
                              <Button size="sm" onClick={() => setDialog({ kind: "view", id: b.id })}>
                                Check
                              </Button>
                            ) : (
                              <Button size="sm" onClick={() => setDialog({ kind: "pay", id: b.id })}>
                                Mark as paid
                              </Button>
                            )
                          ) : p.canWrite && p.manager && b.status === "paid" ? (
                            <Button size="sm" onClick={() => setDialog({ kind: "unpay", id: b.id })}>
                              Undo payment
                            </Button>
                          ) : null}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <Tr className="bg-canvas font-medium">
                      <Td>{plural(shown.length, "bill")}</Td>
                      <Td />
                      <Td />
                      <Td />
                      <Td align="right">{nf(litres)}</Td>
                      <Td align="right">{perLitre(total, litres)}</Td>
                      <Td align="right">{inr(total)}</Td>
                      <Td />
                      <Td />
                      {p.sub === "paid" ? <Td /> : null}
                    </Tr>
                  </tfoot>
                </table>
              ) : (
                <Empty>{needle ? "No bill matches that search." : p.sub === "pending" ? "No transport bill is waiting to be paid." : "No transport bill was paid in this month."}</Empty>
              )}
            </div>
          </div>
        </>
      )}

      {dialog?.kind === "add" ? <AddBillDialog trip={dialog.trip} vehicles={p.vehicles} transporters={p.transporters} today={p.today} onClose={close} onSaved={(id, pay) => setDialog(pay ? { kind: "pay", id } : null)} /> : null}
      {dialog?.kind === "edit" ? <AddBillDialog bill={dialog.bill} vehicles={p.vehicles} transporters={p.transporters} today={p.today} onClose={close} onSaved={(id) => setDialog({ kind: "view", id })} /> : null}
      {viewing ? (
        <BillDialog
          bill={viewing}
          canWrite={p.canWrite}
          manager={p.manager}
          today={p.today}
          pending={pending}
          onClose={close}
          onEdit={() => setDialog({ kind: "edit", bill: viewing })}
          onPay={() => setDialog({ kind: "pay", id: viewing.id })}
          onUnpay={() => setDialog({ kind: "unpay", id: viewing.id })}
          onDelete={() => setDialog({ kind: "delete", id: viewing.id })}
          onResplit={() => run(() => erpFreightBillResplit(viewing.id))}
        />
      ) : null}
      {paying ? <PayDialog bill={paying} today={p.today} onClose={close} /> : null}
      <ReasonDialog
        open={dialog?.kind === "unpay"}
        title="Undo payment"
        body="The bill goes back to Pending expense. Its split on each order stays as it is, and this payment is kept in the bill's history."
        placeholder="Why is the payment undone?"
        keepLabel="Keep it paid"
        confirmLabel="Undo payment"
        tone="danger"
        pending={pending}
        onClose={close}
        onConfirm={(reason) => dialog?.kind === "unpay" && run(() => erpFreightBillUnpay(dialog.id, reason), (r) => r.ok && close())}
      />
      <ReasonDialog
        open={dialog?.kind === "delete"}
        title="Delete this bill"
        body="Its share comes off every order it was split over. The bill is kept, marked deleted, with your reason."
        placeholder="Why is it deleted?"
        keepLabel="Keep it"
        confirmLabel="Delete bill"
        tone="danger"
        pending={pending}
        onClose={close}
        onConfirm={(reason) => dialog?.kind === "delete" && run(() => erpFreightBillDelete(dialog.id, reason), (r) => r.ok && close())}
      />
    </div>
  );
}

function Figure({ label, value, sub, warn, small }: { label: string; value: string; sub?: string; warn?: boolean; small?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3">
      <span className={eyebrowClass}>{label}</span>
      <span className={cx(small ? "text-sm font-medium" : "text-lg font-semibold", warn ? "text-warn" : "text-ink")}>{value}</span>
      {sub ? <span className="text-meta text-muted">{sub}</span> : null}
    </div>
  );
}

function StatusBadge({ bill, today }: { bill: FreightBillView; today: string }) {
  if (bill.status === "paid") return <Badge label="Paid" tone="success" />;
  if (bill.stale.length) return <Badge label="Dispatch changed · split again" tone="danger" />;
  const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(bill.billDate)) / 86_400_000));
  return <Badge label={`Pending · ${plural(days, "day")}`} tone="warn" />;
}

function MonthPicker({ base, month }: { base: string; month: string }) {
  const router = useRouter();
  return <Input type="month" value={month} aria-label="Month paid" className="w-44" onChange={(e) => e.target.value && router.push(qs(base, { ft: "paid", month: e.target.value }))} />;
}

/* ================================================================ one bill */

type View = "lines" | "customer" | "product";

function grouped(bill: Pick<FreightBillView, "shares">, by: View) {
  if (by === "lines") return bill.shares.map((s) => ({ key: s.orderId, a: s.customer, b: `Order ${s.orderNo}${s.billNo ? ` · ${s.billNo}` : ""}`, c: s.product, litres: s.litres, amount: s.amountPaise }));
  const m = new Map<string, { key: string; a: string; b: string; c: string; litres: number; amount: number; n: number }>();
  for (const s of bill.shares) {
    const k = by === "customer" ? s.customerId : s.product;
    const g = m.get(k) ?? { key: k, a: by === "customer" ? s.customer : s.product, b: "", c: "", litres: 0, amount: 0, n: 0 };
    g.litres += s.litres;
    g.amount += s.amountPaise;
    g.n += 1;
    g.b = plural(g.n, "order line");
    m.set(k, g);
  }
  return [...m.values()].sort((x, y) => y.amount - x.amount);
}

function SplitTable({ bill, by, staleIds }: { bill: Pick<FreightBillView, "shares" | "amountPaise" | "litres">; by: View; staleIds?: Set<string> }) {
  const rows = grouped(bill, by);
  return (
    <div className="overflow-x-auto rounded-control border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>{by === "product" ? "Product" : "Customer"}</Th>
            <Th>{by === "lines" ? "Order" : "Lines"}</Th>
            {by === "lines" ? <Th>Product</Th> : null}
            <Th align="right">Litres</Th>
            <Th align="right">Rate / L</Th>
            <Th align="right">Transport expense</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.key} className={cx(staleIds?.has(r.key) && "bg-danger-soft")}>
              <Td className="font-medium">{r.a}</Td>
              <Td>{r.b}</Td>
              {by === "lines" ? <Td>{r.c}</Td> : null}
              <Td align="right">{nf(r.litres)}</Td>
              <Td align="right">{perLitre(r.amount, r.litres)}</Td>
              <Td align="right" className="font-medium">
                {inr(r.amount)}
              </Td>
            </Tr>
          ))}
        </tbody>
        <tfoot>
          <Tr className="bg-canvas font-medium">
            <Td>{by === "lines" ? plural(rows.length, "order line") : plural(rows.length, by === "customer" ? "customer" : "product")}</Td>
            <Td />
            {by === "lines" ? <Td /> : null}
            <Td align="right">{nf(bill.litres)}</Td>
            <Td align="right">{perLitre(bill.amountPaise, bill.litres)}</Td>
            <Td align="right">{inr(bill.shares.reduce((a, s) => a + s.amountPaise, 0))}</Td>
          </Tr>
        </tfoot>
      </table>
    </div>
  );
}

function BillDialog({
  bill,
  canWrite,
  manager,
  today,
  pending,
  onClose,
  onEdit,
  onPay,
  onUnpay,
  onDelete,
  onResplit,
}: {
  bill: FreightBillView;
  canWrite: boolean;
  manager: boolean;
  today: string;
  pending: boolean;
  onClose: () => void;
  onEdit: () => void;
  onPay: () => void;
  onUnpay: () => void;
  onDelete: () => void;
  onResplit: () => void;
}) {
  const [tab, setTab] = useState<"lines" | "customer" | "product" | "bill" | "history">("lines");
  const staleIds = new Set(bill.stale.map((s) => s.orderId));
  const nameOf = new Map(bill.shares.map((s) => [s.orderId, `Order ${s.orderNo} (${s.customer})`]));
  return (
    <ErpDialog onClose={onClose} label={bill.name} size="lg">
      <DialogHeader onClose={onClose} aside={<StatusBadge bill={bill} today={today} />}>
        <DialogTitle>{bill.name}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-divider px-6 py-3 text-sm">
        <Fact label="Transporter" value={bill.transporter} />
        <Fact label="Vehicle" value={`${bill.vehicleNo} · left ${shortDay(bill.dispatchOn)}`} />
        <Fact label="Bill date" value={fd(bill.billDate)} />
        <Fact label="Amount" value={inr(bill.amountPaise)} />
        <Fact label="Litres" value={`${nf(bill.litres)} L`} />
        <Fact label="Cost / L" value={perLitre(bill.amountPaise, bill.litres)} />
      </div>
      <TabBar
        tabs={[
          { key: "lines", label: "Split", count: bill.shares.length },
          { key: "customer", label: "By customer" },
          { key: "product", label: "By product" },
          { key: "bill", label: bill.status === "paid" ? "Bill & payment" : "Bill" },
          { key: "history", label: "History", count: bill.events.length },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />
      <DialogBody className="gap-3">
        {bill.stale.length ? (
          <div className="flex flex-wrap items-center gap-3 rounded-control border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            <span className="min-w-0 flex-1">
              {bill.stale
                .map((s) => `${nameOf.get(s.orderId) ?? "A dispatch"} ${s.why === "gone" ? "is no longer dispatched" : s.why === "not_paid" ? "is no longer Paid freight" : `now carries ${nf(s.now)} L, not ${nf(s.was)} L`}`)
                .join(". ")}
              . Split the bill again before paying it.
            </span>
            {canWrite ? (
              <Button size="sm" disabled={pending} onClick={onResplit}>
                Split again
              </Button>
            ) : null}
          </div>
        ) : null}
        {tab === "lines" || tab === "customer" || tab === "product" ? <SplitTable bill={bill} by={tab} staleIds={tab === "lines" ? staleIds : undefined} /> : null}
        {tab === "bill" ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Fact label="Bill / LR number" value={bill.lrNo} />
            <Fact label="Entered" value={`${bill.createdBy ?? "—"} · ${fd(bill.createdAt.slice(0, 10))}`} />
            <Fact label="Remarks" value={bill.remarks ?? "—"} />
            <Fact label="Payment status" value={bill.status === "paid" ? "Paid" : "Pending"} />
            {bill.status === "paid" ? (
              <>
                <Fact label="Payment date" value={bill.paidOn ? fd(bill.paidOn) : "—"} />
                <Fact label="Payment mode" value={bill.paymentMode ? PAYMENT_MODE_LABEL[bill.paymentMode] : "—"} />
                <Fact label="Transaction reference" value={bill.paymentRef ?? "—"} />
                <Fact label="Payment remarks" value={bill.paymentRemarks ?? "—"} />
                <Fact label="Marked paid by" value={bill.paidBy ?? "—"} />
              </>
            ) : null}
          </div>
        ) : null}
        {tab === "history" ? (
          <ol className="space-y-2 text-sm">
            {bill.events.map((e, i) => (
              <li key={`${e.at}${i}`} className={insetClass}>
                <span className="font-medium text-ink">{EVENT_WORD[e.kind] ?? e.kind}</span>
                <span className="text-muted">
                  {" "}
                  · {e.by ?? "—"} · {fd(e.at.slice(0, 10))}
                </span>
                {e.note ? <p className="mt-1 text-body">{e.note}</p> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </DialogBody>
      <DialogFooter left={bill.status === "pending" && bill.stale.length ? "Split again before paying" : undefined}>
        {canWrite && bill.status === "pending" ? (
          <>
            <Button variant="danger" onClick={onDelete}>
              Delete bill
            </Button>
            <Button onClick={onEdit}>Edit bill</Button>
            <Button variant="primary" disabled={bill.stale.length > 0} title={bill.stale.length ? "A dispatch changed since it was split" : undefined} onClick={onPay}>
              Mark as paid
            </Button>
          </>
        ) : null}
        {canWrite && bill.status === "paid" && manager ? <Button onClick={onUnpay}>Undo payment</Button> : null}
        {!canWrite || bill.status !== "pending" ? <Button onClick={onClose}>Close</Button> : null}
      </DialogFooter>
    </ErpDialog>
  );
}

const EVENT_WORD: Record<string, string> = { created: "Entered", edited: "Edited", split: "Split again", paid: "Marked paid", unpaid: "Payment undone", deleted: "Deleted" };

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-meta text-muted">{label}</span>
      <span className="truncate font-medium text-ink">{value}</span>
    </div>
  );
}

/* ================================================================ mark as paid */

function PayDialog({ bill, today, onClose }: { bill: FreightBillView; today: string; onClose: () => void }) {
  const { run, pending } = useAct();
  const [paidOn, setPaidOn] = useState(today);
  const [mode, setMode] = useState<PaymentMode>("bank");
  const [ref, setRef] = useState("");
  const [remarks, setRemarks] = useState("");
  return (
    <ErpDialog onClose={onClose} label="Mark as paid" size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Mark as paid</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-4">
        <div className={cx(insetClass, "flex items-center justify-between gap-3 bg-canvas")}>
          <span className="min-w-0">
            <span className="block font-medium text-ink">{bill.name}</span>
            <span className="block truncate text-meta text-muted">
              {bill.transporter} · {bill.vehicleNo} · {fd(bill.billDate)}
            </span>
          </span>
          <span className="text-lg font-semibold text-ink">{inr(bill.amountPaise)}</span>
        </div>
        <Field label="Payment mode" required>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Payment mode">
            {PAYMENT_MODES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={toggleClass(mode === m, "h-10 rounded-control")}>
                {PAYMENT_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment date" required>
            <Input type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
          <Field label="Transaction reference" optional>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="UTR / UPI ref" />
          </Field>
        </div>
        <Field label="Payment remarks" optional>
          <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
        </Field>
      </DialogBody>
      <DialogFooter left="It moves to Paid history; the split on each order stays as it is.">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !paidOn} onClick={() => run(() => erpFreightBillPay(bill.id, { paidOn, mode, reference: ref, remarks }), (r) => r.ok && onClose())}>
          Mark as paid
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

/* ================================================================ add or edit a bill */

const STEPS = ["Bill", "What was on the vehicle", "Check the split"];
const tripKey = (v: { vehicleNo: string; dispatchOn: string }) => `${v.vehicleNo}|${v.dispatchOn}`;

function AddBillDialog({
  bill,
  trip: startTrip,
  vehicles,
  transporters,
  today,
  onClose,
  onSaved,
}: {
  bill?: FreightBillView;
  /** Opened from a trip waiting for its bill: the vehicle and transporter come filled in. */
  trip?: VehicleTrip;
  vehicles: VehicleTrip[];
  transporters: string[];
  today: string;
  onClose: () => void;
  onSaved: (id: string, pay: boolean) => void;
}) {
  const { run, pending } = useAct();
  const [step, setStep] = useState(0);
  const [lrNo, setLrNo] = useState(bill?.lrNo ?? "");
  const [billDate, setBillDate] = useState(bill?.billDate ?? today);
  const [transporter, setTransporter] = useState(bill?.transporter ?? startTrip?.transporter ?? "");
  const [trip, setTrip] = useState(bill ? tripKey(bill) : startTrip ? tripKey(startTrip) : "");
  const [amount, setAmount] = useState(bill ? String(bill.amountPaise / 100) : "");
  const [remarks, setRemarks] = useState(bill?.remarks ?? "");
  const [lines, setLines] = useState<VehicleLine[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set(bill?.shares.map((s) => s.orderId) ?? []));
  const [extraNo, setExtraNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [view, setView] = useState<View>("lines");

  /* The vehicles of the chosen transporter first; the bill being edited's own vehicle always offered. */
  const options = useMemo(() => {
    const t = transporter.trim().toLowerCase();
    const list = [...vehicles];
    if (bill && !list.some((v) => tripKey(v) === tripKey(bill))) list.unshift({ vehicleNo: bill.vehicleNo, dispatchOn: bill.dispatchOn, transporter: bill.transporter, lines: bill.shares.length, customers: bill.customers, paidLitres: bill.litres, otherLines: 0, unbilledLines: 0, unbilledLitres: 0, unbilledCustomers: 0 });
    return t ? [...list.filter((v) => (v.transporter ?? "").toLowerCase() === t), ...list.filter((v) => (v.transporter ?? "").toLowerCase() !== t)] : list;
  }, [vehicles, transporter, bill]);
  const chosen = options.find((v) => tripKey(v) === trip) ?? null;
  const paise = paiseFromRupees(amount);

  const step0Problem = !lrNo.trim()
    ? "Write the bill or LR number."
    : !billDate
      ? "Pick the bill date."
      : billDate > today
        ? "The bill date cannot be in the future."
        : !transporter.trim()
          ? "Pick the transporter."
          : !chosen
            ? "Pick the vehicle."
            : paise == null
              ? "Enter the total amount on the bill."
              : null;

  const loadLines = async () => {
    if (!chosen) return;
    setLoading(true);
    setProblem(null);
    const r = await erpFreightVehicleLines(chosen.vehicleNo, chosen.dispatchOn, bill?.id ?? null);
    setLoading(false);
    if (!r.ok) return setProblem(r.error);
    /* Lines of the bill being edited that left on another vehicle stay on it. */
    const extra = bill ? bill.shares.filter((s) => !r.data.some((l) => l.orderId === s.orderId)).map((s) => s.orderNo) : [];
    const more = extra.length ? await erpFreightOrderLines(extra, bill?.id ?? null) : null;
    const all = [...r.data, ...(more?.ok ? more.data : [])];
    setLines(all);
    setTicked((cur) => (bill ? cur : new Set(all.filter((l) => lineEligibility(l).ok).map((l) => l.orderId))));
  };

  const addOrder = async () => {
    const no = Number(extraNo.trim());
    if (!Number.isInteger(no) || no <= 0) return setProblem("Type an order number.");
    setProblem(null);
    const r = await erpFreightOrderLines([no], bill?.id ?? null);
    if (!r.ok) return setProblem(r.error);
    if (!r.data.length) return setProblem(`Order ${no} has no dispatched line.`);
    setLines((cur) => [...(cur ?? []), ...r.data.filter((l) => !(cur ?? []).some((c) => c.orderId === l.orderId))]);
    setTicked((cur) => new Set([...cur, ...r.data.filter((l) => lineEligibility(l).ok).map((l) => l.orderId)]));
    setExtraNo("");
  };

  const picked = (lines ?? []).filter((l) => ticked.has(l.orderId) && lineEligibility(l).ok);
  const preview = paise == null ? null : splitBill(paise, picked);
  const pickedLitres = picked.reduce((a, l) => a + (l.litres ?? 0), 0);
  const draft = {
    shares: preview?.ok
      ? preview.rows.map((r) => {
          const l = picked.find((x) => x.orderId === r.id)!;
          return { orderId: l.orderId, orderNo: l.orderNo, billNo: l.billNo, customer: l.customer, customerId: l.customerId, product: l.product, litres: r.litres, amountPaise: r.amountPaise };
        })
      : [],
    amountPaise: paise ?? 0,
    litres: preview?.ok ? preview.totalLitres : 0,
  };
  const left = lines?.filter((l) => !lineEligibility(l).ok) ?? [];

  const next = async () => {
    if (step === 0) {
      if (step0Problem) return setProblem(step0Problem);
      setProblem(null);
      setStep(1);
      await loadLines();
    } else if (step === 1) {
      if (!picked.length) return setProblem("Tick at least one Paid-freight dispatch.");
      if (preview && !preview.ok) return setProblem(preview.reason);
      setProblem(null);
      setStep(2);
    }
  };

  const save = (pay: boolean) =>
    run(
      () =>
        erpFreightBillSave({
          id: bill?.id ?? null,
          lrNo,
          billDate,
          transporter,
          vehicleNo: chosen?.vehicleNo ?? "",
          dispatchOn: chosen?.dispatchOn ?? "",
          amountPaise: paise,
          remarks,
          orderIds: picked.map((l) => l.orderId),
        }),
      (r) => {
        if (r.ok) onSaved(r.data.id, pay);
        else setProblem(r.fieldErrors?.[0]?.message ?? r.error);
      },
    );

  const title = bill ? `Edit ${bill.name}` : lrNo.trim() && step ? `Add transport bill · LR ${lrNo.trim()}` : "Add transport bill";
  return (
    <ErpDialog onClose={onClose} label={title} size="lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <StepBar steps={STEPS} active={step} reached={step} onChange={(i) => i < step && setStep(i)} />
      <DialogBody className="gap-4">
        {step === 0 ? (
          <>
            <div className="grid grid-cols-2 gap-x-5 gap-y-4">
              <Field label="Bill / LR number" required>
                <Input value={lrNo} onChange={(e) => setLrNo(e.target.value)} placeholder="LR 88213" autoFocus />
              </Field>
              <Field label="Bill date" required>
                <Input type="date" value={billDate} max={today} onChange={(e) => setBillDate(e.target.value)} />
              </Field>
              <Field label="Transporter" required>
                <Input value={transporter} onChange={(e) => setTransporter(e.target.value)} list="freight-transporters" placeholder="Pick or type" />
                <datalist id="freight-transporters">
                  {transporters.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
              <Field label="Vehicle number" required hint="Vehicles that left in the last 45 days, the chosen transporter's first">
                <Select
                  value={trip}
                  onChange={(e) => {
                    setTrip(e.target.value);
                    const v = options.find((x) => tripKey(x) === e.target.value);
                    if (v?.transporter && !transporter.trim()) setTransporter(v.transporter);
                    setLines(null);
                    if (!bill) setTicked(new Set());
                  }}
                  className="w-full"
                >
                  <option value="">Choose the vehicle…</option>
                  {options.map((v) => (
                    <option key={tripKey(v)} value={tripKey(v)}>
                      {v.vehicleNo} · left {shortDay(v.dispatchOn)} · {plural(v.customers, "customer")} · {nf(v.paidLitres)} L paid
                      {v.unbilledLines ? "" : " · billed"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Total transportation amount" required>
                <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1000" />
              </Field>
              <Field label="Payment status">
                <Input value={bill?.status === "paid" ? "Paid" : "Pending — set when it is paid"} readOnly disabled />
              </Field>
            </div>
            {chosen ? (
              <div className={cx(insetClass, "flex flex-wrap items-center gap-4 bg-brand-soft/40")}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">
                    {chosen.vehicleNo} left on {shortDay(chosen.dispatchOn)} with {plural(chosen.lines, "order line")}
                  </span>
                  <span className="block text-meta text-muted">
                    {nf(chosen.paidLitres)} L Paid freight{chosen.otherLines ? ` · ${plural(chosen.otherLines, "line")} To Pay or not set, left out` : ""}
                  </span>
                </span>
                {paise != null && chosen.paidLitres > 0 ? (
                  <span className="text-right">
                    <span className="block text-meta text-muted">Works out to about</span>
                    <span className="font-semibold text-ink">{perLitre(paise, chosen.paidLitres)} / L</span>
                  </span>
                ) : null}
              </div>
            ) : null}
            <Field label="Remarks" optional>
              <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} placeholder="e.g. includes ₹100 hamali" />
            </Field>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Summary chosen={chosen} paise={paise} litres={pickedLitres} />
            <p className="text-meta text-muted">Every order line that left on this vehicle that day. Untick one that was not on it; add one that left on another vehicle by its order number.</p>
            {loading ? (
              <Empty>Reading the dispatches…</Empty>
            ) : lines && lines.length ? (
              <div className="overflow-x-auto rounded-control border border-line">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th className="w-9" />
                      <Th>Customer</Th>
                      <Th>Order</Th>
                      <Th>Product</Th>
                      <Th align="right">Litres</Th>
                      <Th>Freight</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const e = lineEligibility(l);
                      return (
                        <Tr key={l.orderId} className={cx(!e.ok && "text-muted", e.ok && ticked.has(l.orderId) && "bg-brand-soft/30")}>
                          <Td>
                            <input
                              type="checkbox"
                              className={checkboxClass}
                              disabled={!e.ok}
                              checked={e.ok && ticked.has(l.orderId)}
                              aria-label={`Order ${l.orderNo}`}
                              onChange={() =>
                                setTicked((s) => {
                                  const n = new Set(s);
                                  if (n.has(l.orderId)) n.delete(l.orderId);
                                  else n.add(l.orderId);
                                  return n;
                                })
                              }
                            />
                          </Td>
                          <Td className={cx(e.ok && "font-medium text-ink")}>{l.customer}</Td>
                          <Td>
                            Order {l.orderNo}
                            {l.billNo ? <span className="text-muted"> · {l.billNo}</span> : null}
                          </Td>
                          <Td>{l.product}</Td>
                          <Td align="right">{l.litres == null ? "—" : nf(l.litres)}</Td>
                          <Td>{e.ok ? <Badge label="Paid" tone="success" /> : <Badge label={e.why} tone={e.kind === "taken" ? "danger" : "neutral"} />}</Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Nothing left on this vehicle that day. Add a dispatch by its order number.</Empty>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input value={extraNo} onChange={(e) => setExtraNo(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Order number" aria-label="Order number" className="w-40" />
              <Button size="sm" onClick={addOrder}>
                + Add a dispatch that left on another vehicle
              </Button>
              {left.length ? <span className="ml-auto text-meta text-muted">{plural(left.length, "line")} left out — not a company expense, or already billed</span> : null}
            </div>
          </>
        ) : null}

        {step === 2 && preview?.ok ? (
          <>
            <div className="flex flex-wrap items-center gap-4 rounded-card bg-brand-soft px-5 py-3.5">
              <Stat label="Bill" value={inr(paise)} />
              <span className="text-muted">÷</span>
              <Stat label="Paid-freight litres" value={`${nf(preview.totalLitres)} L`} />
              <span className="text-muted">=</span>
              <Stat label="Cost per litre" value={`${perLitre(paise ?? 0, preview.totalLitres)} / L`} />
              <span className="flex-1" />
              <div className="flex gap-1" role="tablist" aria-label="View the split">
                {(["lines", "customer", "product"] as const).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={toggleClass(view === v, "rounded-control px-3 py-1.5")}>
                    {v === "lines" ? "By order line" : v === "customer" ? "By customer" : "By product"}
                  </button>
                ))}
              </div>
            </div>
            <SplitTable bill={draft} by={view} />
            <SubTitle>
              <span className="text-success">✓ Shares add up to the bill exactly</span>
            </SubTitle>
            <p className="-mt-2 text-meta text-muted">Where the rate does not divide evenly, the leftover paise go to the lines that lost most to rounding.</p>
          </>
        ) : null}

        {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      </DialogBody>
      <DialogFooter>
        {step ? <Button onClick={() => setStep(step - 1)}>Back</Button> : <Button onClick={onClose}>Cancel</Button>}
        {step < 2 ? (
          <Button variant="primary" disabled={loading} onClick={next}>
            Next
          </Button>
        ) : bill ? (
          <Button variant="primary" disabled={pending} onClick={() => save(false)}>
            Save changes
          </Button>
        ) : (
          <>
            <Button disabled={pending} onClick={() => save(false)}>
              Save as pending
            </Button>
            <Button variant="primary" disabled={pending} onClick={() => save(true)}>
              Save and mark as paid
            </Button>
          </>
        )}
      </DialogFooter>
    </ErpDialog>
  );
}

function Summary({ chosen, paise, litres }: { chosen: VehicleTrip | null; paise: number | null; litres: number }) {
  return (
    <div className="flex flex-wrap gap-x-7 gap-y-2 rounded-control border border-line bg-canvas px-4 py-3 text-sm">
      <Fact label="Vehicle" value={chosen ? `${chosen.vehicleNo} · ${shortDay(chosen.dispatchOn)}` : "—"} />
      <Fact label="Bill amount" value={inr(paise)} />
      <Fact label="Paid-freight litres ticked" value={`${nf(litres)} L`} />
      <Fact label="Cost per litre" value={paise != null && litres > 0 ? perLitre(paise, litres) : "—"} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-meta text-muted">{label}</span>
      <span className="text-lg font-semibold text-ink">{value}</span>
    </span>
  );
}

/* ================================================================ reports */

function Reports({ report, base }: { report: FreightReport; base: string }) {
  const router = useRouter();
  const [by, setBy] = useState<"customer" | "product" | "order" | "transporter">("transporter");
  const rows: FreightReportRow[] = by === "customer" ? report.byCustomer : by === "product" ? report.byProduct : by === "order" ? report.byOrder : report.byTransporter;
  const go = (from: string, to: string) => router.push(qs(base, { ft: "reports", from, to }));
  const max = Math.max(1, ...report.monthly.map((m) => (m.litres ? m.amountPaise / m.litres : 0)));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta text-muted">Bills dated</span>
        <Input type="date" value={report.from} onChange={(e) => e.target.value && go(e.target.value, report.to)} className="w-40" aria-label="From" />
        <span className="text-meta text-muted">to</span>
        <Input type="date" value={report.to} onChange={(e) => e.target.value && go(report.from, e.target.value)} className="w-40" aria-label="To" />
      </div>
      <CardGrid min="card" gap="gap-3">
        <Figure label="Pending (not paid yet)" value={inr(report.pendingPaise)} warn={report.pendingPaise > 0} />
        <Figure label="Paid" value={inr(report.paidPaise)} />
        <Figure label="Litres carried on Paid freight" value={`${nf(report.litres)} L`} sub={plural(report.bills, "bill")} />
        <Figure label="Average cost per litre" value={perLitre(report.pendingPaise + report.paidPaise, report.litres)} sub="Pending and paid together" />
      </CardGrid>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex gap-1 border-b border-line px-3 py-2" role="tablist">
            {(["customer", "product", "order", "transporter"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={by === k} onClick={() => setBy(k)} className={toggleClass(by === k, "rounded-control px-3 py-1.5")}>
                By {k}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-auto">
            {rows.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>{by === "order" ? "Order" : by[0].toUpperCase() + by.slice(1)}</Th>
                    <Th align="right">Bills</Th>
                    <Th align="right">Litres</Th>
                    <Th align="right">Cost / L</Th>
                    <Th align="right">Pending</Th>
                    <Th align="right">Paid</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.key}>
                      <Td className="font-medium">
                        {r.label}
                        {r.sub ? <span className="block text-meta font-normal text-muted">{r.sub}</span> : null}
                      </Td>
                      <Td align="right">{r.bills}</Td>
                      <Td align="right">{nf(r.litres)}</Td>
                      <Td align="right">{perLitre(r.pendingPaise + r.paidPaise, r.litres)}</Td>
                      <Td align="right">{r.pendingPaise ? inr(r.pendingPaise) : "—"}</Td>
                      <Td align="right" className="font-medium">
                        {r.paidPaise ? inr(r.paidPaise) : "—"}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No transport bill is dated in this period.</Empty>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <span className={eyebrowClass}>Cost per litre, by month</span>
          {report.monthly.length ? (
            <div className="flex h-44 items-end gap-3">
              {report.monthly.slice(-8).map((m) => {
                const rate = m.litres ? m.amountPaise / m.litres : 0;
                return (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-1 text-meta text-muted">
                    <span className="font-medium text-ink">{inrRate(Math.round(rate))}</span>
                    <span className="block w-full rounded-t-control bg-brand" style={{ height: `${Math.max(4, (rate / max) * 120)}px` }} />
                    {m.month.slice(2)}
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty>Nothing yet.</Empty>
          )}
          <span className="text-meta text-muted">Each bar is the month&apos;s bills ÷ the litres they carried, not an average of rates.</span>
        </div>
      </div>
    </div>
  );
}
