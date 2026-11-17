"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NavLink } from "@/components/shell/nav-link";
import { Button, checkboxClass, cx, Field, Input, MoneyInput, Select, Td, Textarea, Th, Tr } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { RowMenu, type MenuItem } from "@/components/ui/overlays";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog, StepBar, TabBar } from "../../_ui/dialog";
import { eyebrowClass, insetClass, SubTitle, toggleClass } from "../../_ui/look";
import {
  erpFreightBillDelete,
  erpFreightBillResplit,
  erpFreightBillSave,
  erpFreightBillsPay,
  erpFreightBillsSave,
  erpFreightBillUnpay,
  erpFreightOrderLines,
  erpFreightVehicleLines,
} from "@/lib/actions/erp-logistics";
import { billProblems, costPerLitrePaise, freightBillNo, lineEligibility, paiseFromRupees, PAYMENT_MODE_LABEL, PAYMENT_MODES, splitBill, type BillInput, type PaymentMode } from "@/lib/erp/engines/freight-bill";
import { shortDay } from "@/lib/erp/engines/logistics";
import type { FreightBillView, FreightReport, FreightReportRow, VehicleLine, VehicleTrip, WaitingBill } from "@/lib/erp/freight-bills";
import type { ActionSpec, ListRow, ListSpec } from "@/lib/erp/ui";
import { ListScreen } from "../../_ui/list-screen";
import { fd, inr, inrRate, nf } from "@/lib/erp/ui";
import { Empty, plural, ReasonDialog, useAct } from "./common";
import { actionFailure } from "@/lib/version-skew";
import { monthLabel } from "@/lib/format";

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

export type FreightSub = "enter" | "pay" | "paid" | "reports";

type Props = {
  sub: FreightSub;
  /** The tab's own address (`?view=freight`); stages and filters add to it. */
  base: string;
  /** The bills the stage lists: pending for To pay (and Bill to enter's notices), the month's paid ones for Paid. */
  bills: FreightBillView[];
  /** A bill opened by a link that is not in the list on screen. */
  openedBill: FreightBillView | null;
  report: FreightReport | null;
  vehicles: VehicleTrip[];
  /** Sales bills whose Paid-freight lines are on no transport bill yet, newest first. */
  waiting: WaitingBill[];
  transporters: string[];
  pendingCount: number;
  pendingPaise: number;
  /** Pending bills a changed dispatch keeps from being paid. */
  staleCount: number;
  paidCount: number;
  paidPaise: number;
  /** Each transporter's usual cost per litre (paise), lower-cased name → rate — what a typed amount is checked against. */
  rates: Record<string, number>;
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

/**
 * A vehicle that left on one day — what one transporter's bill is for.
 * `orderIds` are the order lines of the sales bills that were picked to get
 * here: only they start ticked, so a bill entered from one row is split over
 * that row alone, and from three rows over those three. Null where the trip
 * was added whole from the vehicle picker — then every Paid line starts ticked.
 */
type TripPick = { vehicleNo: string; dispatchOn: string; transporter: string | null; salesBills: string[]; orderIds: Set<string> | null };

type Dialog =
  | { kind: "enter"; trips: TripPick[]; clear?: () => void }
  | { kind: "add" }
  | { kind: "edit"; bill: FreightBillView }
  | { kind: "view"; id: string }
  | { kind: "pay"; ids: string[]; clear?: () => void }
  | { kind: "unpay"; id: string }
  | { kind: "delete"; id: string }
  | null;

const qs = (base: string, extra: Record<string, string>) => `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(extra).toString()}`;
const perLitre = (amount: number, litres: number) => {
  const r = costPerLitrePaise(amount, litres);
  return r == null ? "—" : inrRate(Math.round(r * 100) / 100);
};
const NO_TRANSPORTER = "No transporter on dispatch";
const trKey = (t: string | null | undefined) => (t ?? "").trim().toLowerCase();
const daysSince = (today: string, day: string) => Math.max(0, Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000));

/* ---------------------------------------------------------------------------
 * One pipeline in three stages — Bill to enter → To pay → Paid — each one list
 * grouped by transporter, where several rows are ticked and acted on at once:
 * Enter bills for the ticked trips (one transporter's bill per vehicle per
 * day, each saved on its own), and Pay the ticked bills (one payment per
 * transporter, all or nothing). A bill whose dispatch changed cannot be
 * ticked to pay until its split is saved again.
 * ------------------------------------------------------------------------- */

export function FreightDesk(p: Props) {
  const { run, pending } = useAct();
  const [dialog, setDialog] = useState<Dialog>(p.initialAdd && p.canWrite ? { kind: "add" } : p.initialOpen ? { kind: "view", id: p.initialOpen } : null);
  const close = () => setDialog(null);
  const byId = useMemo(() => new Map([...p.bills, ...(p.openedBill ? [p.openedBill] : [])].map((b) => [b.id, b])), [p.bills, p.openedBill]);
  const viewing = dialog?.kind === "view" ? byId.get(dialog.id) : null;
  const waitingById = useMemo(() => new Map(p.waiting.map((w) => [waitingId(w), w])), [p.waiting]);
  const trips = useMemo(() => tripsOf(p.waiting), [p.waiting]);
  const lateTrips = trips.filter((t) => daysSince(p.today, t.dispatchOn) > 7).length;
  const waitingLitres = p.waiting.reduce((a, w) => a + w.litres, 0);
  const noTransporter = p.waiting.filter((w) => !w.transporter?.trim()).length;

  const enterFor = (ids: string[], clear?: () => void) => {
    const picked = tripsOf(ids.map((id) => waitingById.get(id)).filter((w): w is WaitingBill => !!w));
    if (picked.length && p.canWrite) setDialog({ kind: "enter", trips: picked, clear });
  };
  const payFor = (ids: string[], clear?: () => void) => {
    const ok = ids.filter((id) => byId.get(id)?.status === "pending" && !byId.get(id)?.stale.length);
    if (ok.length && p.canWrite) setDialog({ kind: "pay", ids: ok, clear });
  };
  const billAct = (actionId: string, id: string) => (actionId === "pay" ? payFor([id]) : actionId === "unpay" ? setDialog({ kind: "unpay", id }) : setDialog({ kind: "view", id }));
  const paying = dialog?.kind === "pay" ? dialog.ids.map((id) => byId.get(id)).filter((b): b is FreightBillView => !!b) : [];
  const monthWord = monthLabel(p.month);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-stretch gap-3">
        <nav aria-label="Stages" className="min-w-0 flex-[999_1_640px]">
          <CardGrid min={200} gap="gap-3">
          <StageCard
            n={1}
            on={p.sub === "enter"}
            href={qs(p.base, { ft: "enter" })}
            label="Bill to enter"
            big={plural(trips.length, "trip")}
            sub={`${plural(p.waiting.length, "sales bill")} · ${nf(waitingLitres)} L Paid freight`}
            alert={lateTrips ? `${lateTrips} over a week` : null}
          />
          <StageCard n={2} on={p.sub === "pay"} href={qs(p.base, { ft: "pay" })} label="To pay" big={inr(p.pendingPaise)} sub={plural(p.pendingCount, "bill")} alert={p.staleCount ? `${p.staleCount} to split again` : null} />
          <StageCard n={3} on={p.sub === "paid"} href={qs(p.base, { ft: "paid" })} label="Paid" big={inr(p.paidPaise)} sub={`${plural(p.paidCount, "bill")} paid in ${monthWord}`} alert={null} />
          </CardGrid>
        </nav>
        <div className="flex flex-[1_1_200px] flex-col justify-end gap-2">
          {p.canWrite ? (
            <Button variant="primary" onClick={() => setDialog({ kind: "add" })}>
              + Add transport bill
            </Button>
          ) : null}
          <NavLink href={qs(p.base, { ft: "reports" })} className={toggleClass(p.sub === "reports", "rounded-control px-3.5 py-2 text-center")}>
            Reports
          </NavLink>
        </div>
      </div>

      {p.sub === "pay" && p.staleCount ? (
        <Notice>
          {plural(p.staleCount, "bill")} cannot be paid: a dispatch on {p.staleCount === 1 ? "it" : "them"} changed since the split. Open {p.staleCount === 1 ? "it" : "one"} to see the old and the new split side by side, then save the new one.
        </Notice>
      ) : null}
      {p.sub === "enter" && noTransporter ? <Notice>{plural(noTransporter, "sales bill")} left with no transporter on the dispatch. Type it when you enter the bill.</Notice> : null}

      {p.sub === "reports" && p.report ? <Reports report={p.report} base={p.base} /> : null}

      {p.sub === "enter" ? (
        <ListScreen
          spec={waitingSpec(p.tripDays, p.canWrite)}
          rows={p.waiting.map((w) => waitingRow(w, p.today, p.canWrite))}
          label="Bill to enter"
          godowns={[]}
          tabs={[]}
          sections={null}
          toggle={null}
          bare
          onOpen={(id) => enterFor([id])}
          onRowAct={(_, id) => enterFor([id])}
          onBulk={(_, ids, clear) => enterFor(ids, clear)}
        />
      ) : null}

      {p.sub === "pay" || p.sub === "paid" ? (
        <div>
          {p.sub === "paid" ? (
            <div className="mb-3 flex items-center gap-2">
              <MonthPicker base={p.base} month={p.month} />
              <span className="ml-auto text-meta text-muted">Newest payment first</span>
            </div>
          ) : null}
          <ListScreen
            key={p.sub}
            spec={billsSpec(p.sub, p.canWrite)}
            rows={p.bills.map((b) => billRow(b, p.today, p.canWrite, p.manager))}
            label={p.sub === "paid" ? "Paid transport bills" : "Transport bills to pay"}
            godowns={[]}
            tabs={[]}
            sections={null}
            toggle={null}
            bare
            onOpen={(id) => setDialog({ kind: "view", id })}
            onRowAct={billAct}
            onBulk={(_, ids, clear) => payFor(ids, clear)}
          />
        </div>
      ) : null}

      {dialog?.kind === "enter" ? (
        <BatchEnterDialog
          trips={dialog.trips}
          vehicles={p.vehicles}
          transporters={p.transporters}
          rates={p.rates}
          today={p.today}
          onClose={close}
          onDone={() => {
            dialog.clear?.();
            close();
          }}
        />
      ) : null}
      {dialog?.kind === "add" ? <AddBillDialog vehicles={p.vehicles} transporters={p.transporters} today={p.today} onClose={close} onSaved={(id) => setDialog({ kind: "view", id })} /> : null}
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
          onPay={() => payFor([viewing.id])}
          onUnpay={() => setDialog({ kind: "unpay", id: viewing.id })}
          onDelete={() => setDialog({ kind: "delete", id: viewing.id })}
          onResplit={() => run(() => erpFreightBillResplit(viewing.id))}
        />
      ) : null}
      {dialog?.kind === "pay" && paying.length ? (
        <BatchPayDialog
          bills={paying}
          blocked={p.bills.filter((b) => b.status === "pending" && b.stale.length && paying.some((x) => trKey(x.transporter) === trKey(b.transporter)))}
          today={p.today}
          onClose={close}
          onOpen={(id) => setDialog({ kind: "view", id })}
          onDone={() => {
            dialog.clear?.();
            close();
          }}
        />
      ) : null}
      <ReasonDialog
        open={dialog?.kind === "unpay"}
        title="Undo payment"
        body="The bill goes back to To pay. Its split on each order stays as it is, and this payment is kept in the bill's history."
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
        body="Its share comes off every order it was split over, and its trip goes back to Bill to enter. The bill is kept, marked deleted, with your reason."
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

/** Sales bills folded into the trips they went on — one transporter's bill per vehicle per day, carrying the picked rows' order lines. */
function tripsOf(ws: WaitingBill[]): TripPick[] {
  const m = new Map<string, TripPick>();
  for (const w of ws) {
    const k = tripKey({ vehicleNo: vkey(w.vehicleNo), dispatchOn: w.dispatchOn });
    const t = m.get(k) ?? { vehicleNo: w.vehicleNo, dispatchOn: w.dispatchOn, transporter: w.transporter?.trim() || null, salesBills: [], orderIds: new Set<string>() };
    if (w.billNo) t.salesBills.push(w.billNo);
    for (const id of w.orderIds) t.orderIds?.add(id);
    if (!t.transporter && w.transporter?.trim()) t.transporter = w.transporter.trim();
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => a.dispatchOn.localeCompare(b.dispatchOn));
}

function StageCard({ n, on, href, label, big, sub, alert }: { n: number; on: boolean; href: string; label: string; big: string; sub: string; alert: string | null }) {
  return (
    <NavLink
      href={href}
      aria-current={on ? "page" : undefined}
      className={cx("flex flex-col gap-1 rounded-card bg-surface px-4 py-3 no-underline", on ? "border-2 border-brand shadow-pop" : "border border-line hover:border-line-strong")}
    >
      <span className="flex items-center gap-2">
        <span className={cx("inline-flex size-5 items-center justify-center rounded-full text-2xs font-semibold", on ? "bg-brand text-white" : "bg-brand-soft text-brand")}>{n}</span>
        <span className="text-sm font-semibold text-ink">{label}</span>
        <span className="flex-1" />
        {alert ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-2xs font-medium text-warn-ink">{alert}</span> : null}
      </span>
      <span className="text-lg font-semibold text-ink">{big}</span>
      <span className="text-meta text-muted">{sub}</span>
    </NavLink>
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

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-control border border-warn-line bg-warn-soft px-3.5 py-2.5 text-sm text-warn-ink">{children}</div>;
}

function StatusBadge({ bill, today }: { bill: FreightBillView; today: string }) {
  if (bill.status === "paid") return <Badge label="Paid" tone="success" />;
  if (bill.stale.length) return <Badge label="Dispatch changed · split again" tone="danger" />;
  return <Badge label={`To pay · ${plural(daysSince(today, bill.billDate), "day")}`} tone="warn" />;
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

function SplitTable({ bill, by }: { bill: Pick<FreightBillView, "shares" | "amountPaise" | "litres">; by: View }) {
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
            <Tr key={r.key}>
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

/** What splitting a stale bill again gives, worked out here with the server's own `splitBill`, before anything is saved. */
function resplitPreview(bill: FreightBillView) {
  const change = new Map(bill.stale.map((s) => [s.orderId, s]));
  const keep = bill.shares
    .map((s) => {
      const c = change.get(s.orderId);
      if (!c) return { share: s, litres: s.litres, why: null as string | null };
      if (c.why === "gone") return { share: s, litres: null, why: "No longer dispatched — drops out" };
      if (c.why === "not_paid") return { share: s, litres: null, why: "No longer Paid freight — drops out" };
      return { share: s, litres: c.now, why: c.now == null ? "No litres — drops out" : `${nf(c.now)} L, was ${nf(c.was)} L` };
    });
  const live = keep.filter((k) => k.litres != null && k.litres > 0);
  const split = live.length ? splitBill(bill.amountPaise, live.map((k) => ({ orderId: k.share.orderId, litres: k.litres }))) : null;
  const now = new Map(split?.ok ? split.rows.map((r) => [r.id, r.amountPaise]) : []);
  return {
    rows: keep.map((k) => ({ ...k, now: now.get(k.share.orderId) ?? 0 })),
    ok: !!split?.ok,
    litres: split?.ok ? split.totalLitres : 0,
    reason: split && !split.ok ? split.reason : live.length ? null : "None of this bill's dispatches is Paid freight any more. Delete the bill, or edit its dispatches.",
  };
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
  const stale = bill.status === "pending" && bill.stale.length > 0;
  const [tab, setTab] = useState<"lines" | "customer" | "product" | "bill" | "history">("lines");
  const preview = stale ? resplitPreview(bill) : null;
  const menu: MenuItem[] = [];
  if (canWrite && bill.status === "pending") {
    menu.push({ label: "Edit bill", onSelect: onEdit });
    menu.push({ label: "Delete bill…", onSelect: onDelete, destructive: true });
  }
  if (canWrite && bill.status === "paid" && manager) menu.push({ label: "Undo payment…", onSelect: onUnpay, destructive: true });
  return (
    <ErpDialog onClose={onClose} label={bill.name} size="lg">
      <DialogHeader onClose={onClose} aside={<StatusBadge bill={bill} today={today} />}>
        <DialogTitle>{bill.name}</DialogTitle>
      </DialogHeader>
      <ol aria-label="Where this bill stands" className="grid grid-cols-3 gap-3 px-6 pt-1 pb-3">
        <Milestone tone="done" label="✓ Entered" sub={`${fd(bill.createdAt.slice(0, 10))} · ${bill.createdBy ?? "—"}`} />
        <Milestone tone={stale ? "bad" : "done"} label={stale ? "Split · out of date" : "✓ Split"} sub={stale ? "A dispatch changed since" : `${plural(bill.shares.length, "order line")} · ${nf(bill.litres)} L`} />
        <Milestone
          tone={bill.status === "paid" ? "done" : "todo"}
          label={bill.status === "paid" ? "✓ Paid" : "Paid"}
          sub={bill.status === "paid" ? `${bill.paidOn ? fd(bill.paidOn) : "—"} · ${bill.paymentMode ? PAYMENT_MODE_LABEL[bill.paymentMode] : "—"}` : `Waiting ${plural(daysSince(today, bill.billDate), "day")}`}
        />
      </ol>
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-y border-divider bg-canvas px-6 py-3 text-sm">
        <Fact label="Transporter" value={bill.transporter} />
        <Fact label="Vehicle" value={`${bill.vehicleNo} · left ${shortDay(bill.dispatchOn)}`} />
        <Fact label="Bill date" value={fd(bill.billDate)} />
        <Fact label="Amount" value={inr(bill.amountPaise)} />
        <Fact label="Litres" value={preview?.ok ? `${nf(preview.litres)} L (was ${nf(bill.litres)})` : `${nf(bill.litres)} L`} />
        <Fact label="Cost / L" value={preview?.ok ? `${perLitre(bill.amountPaise, preview.litres)} (was ${perLitre(bill.amountPaise, bill.litres)})` : perLitre(bill.amountPaise, bill.litres)} />
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
        {preview && tab === "lines" ? (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-control border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              <span className="min-w-0 flex-[1_1_320px]">
                {preview.reason ?? "A dispatch on this bill changed since it was split. Here is the bill split again over the dispatches as they are now — check it, then save the new split."}
              </span>
              {canWrite && preview.ok ? (
                <Button size="sm" variant="danger" disabled={pending} onClick={onResplit}>
                  Save new split
                </Button>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-control border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th>Order</Th>
                    <Th>Product</Th>
                    <Th align="right">Litres now</Th>
                    <Th align="right">Was</Th>
                    <Th align="right">Now</Th>
                    <Th align="right">Change</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const d = r.now - r.share.amountPaise;
                    return (
                      <Tr key={r.share.orderId} className={cx(r.why && "bg-danger-soft")}>
                        <Td className="font-medium">{r.share.customer}</Td>
                        <Td>Order {r.share.orderNo}</Td>
                        <Td>{r.share.product}</Td>
                        <Td align="right">{r.why ?? nf(r.litres ?? 0)}</Td>
                        <Td align="right" className="text-muted">
                          {inr(r.share.amountPaise)}
                        </Td>
                        <Td align="right" className="font-medium">
                          {inr(r.now)}
                        </Td>
                        <Td align="right" className={cx(d > 0 ? "text-warn-ink" : d < 0 ? "text-success" : "text-muted")}>
                          {d === 0 ? "—" : `${d > 0 ? "+" : "−"}${inr(Math.abs(d))}`}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-meta text-muted">The bill amount does not change, only how it is shared over the orders.</p>
          </>
        ) : null}
        {!preview && tab === "lines" ? <SplitTable bill={bill} by="lines" /> : null}
        {tab === "customer" || tab === "product" ? <SplitTable bill={bill} by={tab} /> : null}
        {tab === "bill" ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Fact label="Bill / LR number" value={bill.lrNo} />
            <Fact label="Entered" value={`${bill.createdBy ?? "—"} · ${fd(bill.createdAt.slice(0, 10))}`} />
            <Fact label="Remarks" value={bill.remarks ?? "—"} />
            <Fact label="Payment status" value={bill.status === "paid" ? "Paid" : "To pay"} />
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
      <DialogFooter left={menu.length ? <RowMenu items={menu} /> : undefined}>
        {stale ? <span className="text-meta text-muted">Save the new split to pay it</span> : null}
        <Button onClick={onClose}>Close</Button>
        {canWrite && bill.status === "pending" ? (
          <Button variant="primary" disabled={stale} title={stale ? "A dispatch changed since it was split" : undefined} onClick={onPay}>
            Mark as paid
          </Button>
        ) : null}
      </DialogFooter>
    </ErpDialog>
  );
}

function Milestone({ tone, label, sub }: { tone: "done" | "bad" | "todo"; label: string; sub: string }) {
  return (
    <li className={cx("border-t-[3px] pt-2", tone === "done" ? "border-success" : tone === "bad" ? "border-danger" : "border-line")}>
      <span className={cx("block text-sm font-semibold", tone === "done" ? "text-success" : tone === "bad" ? "text-danger" : "text-muted")}>{label}</span>
      <span className="block truncate text-meta text-muted">{sub}</span>
    </li>
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

/* ================================================================ pay several bills */

type PayGroup = { key: string; name: string; bills: FreightBillView[] };

function BatchPayDialog({
  bills,
  blocked,
  today,
  onClose,
  onOpen,
  onDone,
}: {
  bills: FreightBillView[];
  /** Pending bills of the same transporters a changed dispatch keeps out of this payment. */
  blocked: FreightBillView[];
  today: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDone: () => void;
}) {
  const { run, pending } = useAct();
  const [ids, setIds] = useState<string[]>(bills.map((b) => b.id));
  const [same, setSame] = useState(true);
  const [paidOn, setPaidOn] = useState(today);
  const [mode, setMode] = useState<PaymentMode>("bank");
  const [per, setPer] = useState<Record<string, { paidOn: string; mode: PaymentMode; ref: string; remarks: string }>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const shown = bills.filter((b) => ids.includes(b.id));
  const groups: PayGroup[] = [];
  for (const b of shown) {
    const k = trKey(b.transporter);
    const g = groups.find((x) => x.key === k);
    if (g) g.bills.push(b);
    else groups.push({ key: k, name: b.transporter, bills: [b] });
  }
  const valOf = (k: string) => per[k] ?? { paidOn: today, mode: "bank" as PaymentMode, ref: "", remarks: "" };
  const setVal = (k: string, v: Partial<{ paidOn: string; mode: PaymentMode; ref: string; remarks: string }>) => setPer((cur) => ({ ...cur, [k]: { ...valOf(k), ...v } }));
  const total = shown.reduce((a, b) => a + b.amountPaise, 0);
  const litres = shown.reduce((a, b) => a + b.litres, 0);
  const title = shown.length === 1 ? `Pay ${shown[0].name}` : `Pay ${shown.length} bills · ${inr(total)}`;

  const pay = () => {
    const payments = groups.map((g) => {
      const v = valOf(g.key);
      return { billIds: g.bills.map((b) => b.id), paidOn: same ? paidOn : v.paidOn, mode: same ? mode : v.mode, reference: v.ref, remarks: v.remarks };
    });
    if (payments.some((x) => !x.paidOn)) return setProblem("Pick the payment date.");
    setProblem(null);
    run(() => erpFreightBillsPay(payments), (r) => (r.ok ? onDone() : setProblem(r.fieldErrors?.[0]?.message ?? r.error)));
  };

  return (
    <ErpDialog onClose={onClose} label={title} size="lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-4">
        <p className="text-sm text-muted">
          {groups.length === 1 ? `One payment to ${groups[0].name}.` : `${groups.length} transporters, so ${groups.length} payments — one each.`} Every bill moves to Paid; its split on each order stays as it is.
        </p>
        <div className={cx(insetClass, "flex flex-wrap items-center gap-3 bg-canvas")}>
          <label className="flex items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" className={checkboxClass} checked={same} onChange={(e) => setSame(e.target.checked)} />
            Same date and mode for every payment
          </label>
          <span className="flex-1" />
          {same ? <ModeAndDate mode={mode} paidOn={paidOn} today={today} onMode={setMode} onDate={setPaidOn} /> : null}
        </div>
        {groups.map((g, gi) => {
          const v = valOf(g.key);
          const sub = g.bills.reduce((a, b) => a + b.amountPaise, 0);
          return (
            <section key={g.key} className="overflow-hidden rounded-card border border-line">
              <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-canvas px-4 py-2.5">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand-soft text-2xs font-semibold text-brand">{gi + 1}</span>
                <span className="text-sm font-semibold text-ink">{g.name}</span>
                <span className="text-meta text-muted">
                  {plural(g.bills.length, "bill")} · {nf(g.bills.reduce((a, b) => a + b.litres, 0))} L
                </span>
                <span className="flex-1" />
                <span className="font-semibold text-ink">{inr(sub)}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {g.bills.map((b) => (
                    <Tr key={b.id}>
                      <Td>
                        <span className="block font-medium text-ink">{b.name}</span>
                        <span className="block text-meta text-muted">Bill {fd(b.billDate)}</span>
                      </Td>
                      <Td>{b.vehicleNo}</Td>
                      <Td align="right">{nf(b.litres)} L</Td>
                      <Td align="right" className="text-muted">
                        {perLitre(b.amountPaise, b.litres)} / L
                      </Td>
                      <Td align="right" className="font-medium">
                        {inr(b.amountPaise)}
                      </Td>
                      <Td align="right">
                        {shown.length > 1 ? (
                          <Button size="sm" aria-label={`Take ${b.name} out of this payment`} onClick={() => setIds((cur) => cur.filter((x) => x !== b.id))}>
                            ×
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
              <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
                {!same ? (
                  <div className="sm:col-span-2">
                    <ModeAndDate mode={v.mode} paidOn={v.paidOn} today={today} onMode={(m) => setVal(g.key, { mode: m })} onDate={(d) => setVal(g.key, { paidOn: d })} />
                  </div>
                ) : null}
                <Field label="Transaction reference" optional>
                  <Input value={v.ref} onChange={(e) => setVal(g.key, { ref: e.target.value })} placeholder="UTR / UPI ref" />
                </Field>
                <Field label="Payment remarks" optional>
                  <Input value={v.remarks} onChange={(e) => setVal(g.key, { remarks: e.target.value })} />
                </Field>
              </div>
            </section>
          );
        })}
        {blocked.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-control border border-dashed border-danger/40 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            <span className="min-w-0 flex-[1_1_320px]">
              Also owed to {b.transporter}: {b.name} · {inr(b.amountPaise)} — not in this payment. A dispatch on it changed; save its new split first.
            </span>
            <Button size="sm" onClick={() => onOpen(b.id)}>
              Open it
            </Button>
          </div>
        ))}
        {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      </DialogBody>
      <DialogFooter left={`${plural(groups.length, "payment")} · ${plural(shown.length, "bill")} · ${inr(total)} · ${nf(litres)} L`}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !shown.length} onClick={pay}>
          {shown.length === 1 ? "Mark as paid" : `Mark ${shown.length} bills paid`}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function ModeAndDate({ mode, paidOn, today, onMode, onDate }: { mode: PaymentMode; paidOn: string; today: string; onMode: (m: PaymentMode) => void; onDate: (d: string) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="inline-flex gap-1" role="radiogroup" aria-label="Payment mode">
        {PAYMENT_MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => onMode(m)} className={toggleClass(mode === m, "h-9 rounded-control px-3")}>
            {PAYMENT_MODE_LABEL[m]}
          </button>
        ))}
      </span>
      <Input type="date" value={paidOn} max={today} onChange={(e) => onDate(e.target.value)} aria-label="Payment date" className="w-40" />
    </span>
  );
}

/* ================================================================ enter several bills */

type EnterRow = {
  key: string;
  trip: TripPick;
  lrNo: string;
  billDate: string;
  transporter: string;
  amount: string;
  lines: VehicleLine[] | null;
  loadError: string | null;
  ticked: Set<string>;
  open: boolean;
  extraNo: string;
  saved: string | null;
  error: string | null;
};

const rowOf = (t: TripPick, today: string): EnterRow => ({
  key: tripKey({ vehicleNo: vkey(t.vehicleNo), dispatchOn: t.dispatchOn }),
  trip: t,
  lrNo: "",
  billDate: today,
  transporter: t.transporter ?? "",
  amount: "",
  lines: null,
  loadError: null,
  ticked: new Set(),
  open: false,
  extraNo: "",
  saved: null,
  error: null,
});

/** What a row would save as, and whether it may. */
function rowState(r: EnterRow, rows: EnterRow[], rates: Record<string, number>, today: string) {
  const paise = paiseFromRupees(r.amount);
  const picked = (r.lines ?? []).filter((l) => r.ticked.has(l.orderId) && lineEligibility(l).ok);
  const litres = picked.reduce((a, l) => a + (l.litres ?? 0), 0);
  const input: BillInput = { lrNo: r.lrNo, billDate: r.billDate, transporter: r.transporter, vehicleNo: r.trip.vehicleNo, dispatchOn: r.trip.dispatchOn, amountPaise: paise, orderIds: picked.map((l) => l.orderId) };
  const split = paise != null && picked.length ? splitBill(paise, picked) : null;
  const twin = r.lrNo.trim() ? rows.find((x) => x.key !== r.key && !x.saved && vkey(x.lrNo) === vkey(r.lrNo) && trKey(x.transporter) === trKey(r.transporter)) : null;
  const blank = !r.lrNo.trim() && !r.amount.trim();
  const problems = billProblems(input, today);
  const problem = r.saved
    ? null
    : r.lines == null
      ? r.loadError ?? "Reading the dispatches…"
      : blank
        ? "Type the LR number and the amount"
        : twin
          ? "Same LR as another row — one bill is entered once"
          : (Object.values(problems)[0] ?? (split && !split.ok ? split.reason : null));
  const usual = rates[trKey(r.transporter)];
  const rate = paise != null && litres > 0 ? paise / litres : null;
  const odd = rate != null && usual ? rate / usual : null;
  const warn = odd != null && (odd >= 2 || odd <= 0.5) ? `${odd >= 2 ? `${Math.round(odd * 10) / 10}×` : `${Math.round(odd * 100)}% of`} ${r.transporter.trim()}'s usual ${inrRate(Math.round(usual))} / L — check the amount` : null;
  return { paise, picked, litres, input, split, blank, problem, warn, ready: !r.saved && !problem && !!split?.ok };
}

function BatchEnterDialog({
  trips,
  vehicles,
  transporters,
  rates,
  today,
  onClose,
  onDone,
}: {
  trips: TripPick[];
  vehicles: VehicleTrip[];
  transporters: string[];
  rates: Record<string, number>;
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { run, pending } = useAct();
  const [rows, setRows] = useState<EnterRow[]>(() => trips.map((t) => rowOf(t, today)));
  const [allDate, setAllDate] = useState(today);
  const [allTr, setAllTr] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const patch = (key: string, v: Partial<EnterRow> | ((r: EnterRow) => Partial<EnterRow>)) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...(typeof v === "function" ? v(r) : v) } : r)));

  /*
   * Each trip's dispatches, read once. The whole vehicle is listed, but only
   * the picked rows' Paid-freight lines start ticked — the rest of the lorry
   * is there to tick by hand, never split over unasked.
   */
  const loaded = (key: string, trip: TripPick, r: Awaited<ReturnType<typeof erpFreightVehicleLines>> | null, e?: unknown) =>
    patch(
      key,
      !r ? { loadError: actionFailure(e) } : !r.ok ? { loadError: r.error } : { lines: r.data, ticked: new Set(r.data.filter((l) => lineEligibility(l).ok && (!trip.orderIds || trip.orderIds.has(l.orderId))).map((l) => l.orderId)) },
    );
  const load = (key: string, trip: TripPick) =>
    erpFreightVehicleLines(trip.vehicleNo, trip.dispatchOn, null).then(
      (r) => loaded(key, trip, r),
      (e) => loaded(key, trip, null, e),
    );
  useEffect(() => {
    let gone = false;
    for (const t of trips) {
      const key = tripKey({ vehicleNo: vkey(t.vehicleNo), dispatchOn: t.dispatchOn });
      erpFreightVehicleLines(t.vehicleNo, t.dispatchOn, null).then(
        (r) => !gone && loaded(key, t, r),
        (e) => !gone && loaded(key, t, null, e),
      );
    }
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, for the trips the dialog opened on
  }, [trips]);

  const addTrip = (k: string) => {
    const v = vehicles.find((x) => tripKey({ vehicleNo: vkey(x.vehicleNo), dispatchOn: x.dispatchOn }) === k);
    if (!v || rows.some((r) => r.key === k)) return;
    const t: TripPick = { vehicleNo: v.vehicleNo, dispatchOn: v.dispatchOn, transporter: v.transporter, salesBills: [], orderIds: null };
    setRows((rs) => [...rs, { ...rowOf(t, today), billDate: allDate }]);
    void load(k, t);
  };
  const addOrder = async (r: EnterRow) => {
    const no = Number(r.extraNo.trim());
    if (!Number.isInteger(no) || no <= 0) return patch(r.key, { error: "Type an order number." });
    try {
      const res = await erpFreightOrderLines([no], null);
      if (!res.ok) return patch(r.key, { error: res.error });
      if (!res.data.length) return patch(r.key, { error: `Order ${no} has no dispatched line.` });
      patch(r.key, (cur) => ({
        lines: [...(cur.lines ?? []), ...res.data.filter((l) => !(cur.lines ?? []).some((c) => c.orderId === l.orderId))],
        ticked: new Set([...cur.ticked, ...res.data.filter((l) => lineEligibility(l).ok).map((l) => l.orderId)]),
        extraNo: "",
        error: null,
      }));
    } catch (e) {
      patch(r.key, { error: actionFailure(e) });
    }
  };

  const states = new Map(rows.map((r) => [r.key, rowState(r, rows, rates, today)]));
  const ready = rows.filter((r) => states.get(r.key)!.ready);
  const open = rows.filter((r) => !r.saved);
  const readyPaise = ready.reduce((a, r) => a + (states.get(r.key)!.paise ?? 0), 0);
  const readyLitres = ready.reduce((a, r) => a + states.get(r.key)!.litres, 0);
  const notReady = open.length - ready.length;
  const offered = vehicles.filter((v) => v.unbilledLines > 0 && !rows.some((r) => r.key === tripKey({ vehicleNo: vkey(v.vehicleNo), dispatchOn: v.dispatchOn })));
  const savedAny = rows.some((r) => r.saved);

  const save = () => {
    if (!ready.length) return setProblem("No row is ready yet — each needs its LR number, date, transporter and amount.");
    setProblem(null);
    run(
      () => erpFreightBillsSave(ready.map((r) => ({ ...states.get(r.key)!.input, remarks: null }))),
      (res) => {
        if (!res.ok) return setProblem(res.error);
        const by = new Map(ready.map((r, i) => [r.key, res.data[i]]));
        setRows((rs) => rs.map((r) => {
          const a = by.get(r.key);
          if (!a) return r;
          return a.ok ? { ...r, saved: freightBillNo(a.billNo), error: null, open: false } : { ...r, error: a.error };
        }));
        if (res.data.every((a) => a.ok) && ready.length === open.length) onDone();
      },
    );
  };

  const title = trips.length === 1 && rows.length === 1 ? `Enter the bill for ${rows[0].trip.vehicleNo}` : `Enter ${plural(open.length || rows.length, "transport bill")}`;
  return (
    <ErpDialog onClose={savedAny ? onDone : onClose} label={title} size="xl">
      <DialogHeader onClose={savedAny ? onDone : onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-4">
        <p className="text-sm text-muted">One row per trip. Each saves as its own bill, split over that vehicle&apos;s Paid-freight lines by litres, and goes to To pay. Open a row to check its split.</p>
        {rows.length > 1 ? (
          <div className={cx(insetClass, "flex flex-wrap items-end gap-3 bg-canvas")}>
            <span className="self-center text-sm font-medium text-ink">Same for every row</span>
            <Field label="Bill date">
              <Input type="date" value={allDate} max={today} onChange={(e) => setAllDate(e.target.value)} className="w-40" />
            </Field>
            <Field label="Transporter">
              <Input value={allTr} onChange={(e) => setAllTr(e.target.value)} list="freight-transporters-all" placeholder="Leave as each trip says" className="w-56" />
              <datalist id="freight-transporters-all">
                {transporters.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <Button onClick={() => setRows((rs) => rs.map((r) => (r.saved ? r : { ...r, billDate: allDate || r.billDate, transporter: allTr.trim() || r.transporter })))}>Apply to every row</Button>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr>
                <Th>Trip</Th>
                <Th>Transporter</Th>
                <Th>Bill / LR number</Th>
                <Th>Bill date</Th>
                <Th align="right">Amount on bill</Th>
                <Th align="right">Cost / L</Th>
                <Th>Check</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const st = states.get(r.key)!;
                const locked = !!r.saved;
                return (
                  <Fragment key={r.key}>
                    <Tr className={cx(r.open && "bg-brand-soft/30")}>
                      <Td>
                        <span className="block font-medium text-ink">{r.trip.vehicleNo}</span>
                        <span className="block text-meta text-muted">
                          Left {shortDay(r.trip.dispatchOn)}
                          {r.lines ? ` · ${plural(st.picked.length, "Paid line")} · ${nf(st.litres)} L` : ""}
                          {r.trip.salesBills.length ? ` · ${r.trip.salesBills.slice(0, 2).join(", ")}${r.trip.salesBills.length > 2 ? ` +${r.trip.salesBills.length - 2}` : ""}` : ""}
                        </span>
                      </Td>
                      <Td>
                        <Input value={r.transporter} disabled={locked} onChange={(e) => patch(r.key, { transporter: e.target.value })} list="freight-transporters-all" placeholder="Pick or type" aria-label={`Transporter for row ${i + 1}`} className="w-44" />
                      </Td>
                      <Td>
                        <Input value={r.lrNo} disabled={locked} onChange={(e) => patch(r.key, { lrNo: e.target.value })} placeholder="LR 88213" aria-label={`Bill or LR number for row ${i + 1}`} className="w-32" />
                      </Td>
                      <Td>
                        <Input type="date" value={r.billDate} max={today} disabled={locked} onChange={(e) => patch(r.key, { billDate: e.target.value })} aria-label={`Bill date for row ${i + 1}`} className="w-40" />
                      </Td>
                      <Td align="right">
                        <MoneyInput value={r.amount} disabled={locked} onChange={(e) => patch(r.key, { amount: e.target.value })} inputMode="decimal" placeholder="0" aria-label={`Amount for row ${i + 1}`} className="w-32" />
                      </Td>
                      <Td align="right" className={cx("font-medium", st.warn ? "text-warn-ink" : "text-ink")}>
                        {st.paise != null && st.litres > 0 ? perLitre(st.paise, st.litres) : "—"}
                      </Td>
                      <Td>
                        <RowCheck r={r} st={st} />
                      </Td>
                      <Td align="right">
                        {!locked && r.lines ? (
                          <Button size="sm" aria-expanded={r.open} onClick={() => patch(r.key, { open: !r.open })}>
                            {r.open ? "Hide split" : "Split"}
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                    {r.open && r.lines ? (
                      <Tr>
                        <Td colSpan={8} className="bg-canvas">
                          <RowSplit
                            r={r}
                            st={st}
                            onTick={(id) =>
                              patch(r.key, (cur) => {
                                const n = new Set(cur.ticked);
                                if (n.has(id)) n.delete(id);
                                else n.add(id);
                                return { ticked: n };
                              })
                            }
                            onExtra={(v) => patch(r.key, { extraNo: v })}
                            onAdd={() => addOrder(r)}
                          />
                        </Td>
                      </Tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {offered.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value="" onChange={(e) => e.target.value && addTrip(e.target.value)} aria-label="Add another trip" className="w-96">
              <option value="">+ Add another trip…</option>
              {offered.map((v) => {
                const k = tripKey({ vehicleNo: vkey(v.vehicleNo), dispatchOn: v.dispatchOn });
                return (
                  <option key={k} value={k}>
                    {v.vehicleNo} · left {shortDay(v.dispatchOn)} · {v.transporter ?? NO_TRANSPORTER} · {nf(v.unbilledLitres)} L
                  </option>
                );
              })}
            </Select>
          </div>
        ) : null}
        {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      </DialogBody>
      <DialogFooter
        left={
          <span className="flex flex-col">
            <span className="font-semibold text-ink">
              {ready.length} of {plural(open.length, "bill")} ready{ready.length ? ` · ${inr(readyPaise)} · ${nf(readyLitres)} L` : ""}
            </span>
            {notReady > 0 && ready.length ? <span className="text-meta text-muted">The {notReady === 1 ? "other stays" : `other ${notReady} stay`} on Bill to enter until typed in.</span> : null}
          </span>
        }
      >
        <Button onClick={savedAny ? onDone : onClose}>{savedAny ? "Done" : "Cancel"}</Button>
        <Button variant="primary" disabled={pending || !ready.length} onClick={save}>
          {ready.length === 1 ? "Save 1 bill" : `Save ${ready.length || ""} bills`.replace("  ", " ")}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function RowCheck({ r, st }: { r: EnterRow; st: ReturnType<typeof rowState> }) {
  if (r.saved) return <Badge label={`Saved as ${r.saved}`} tone="success" />;
  if (r.error) return <span className="text-meta text-danger">{r.error}</span>;
  if (st.ready) return st.warn ? <span className="text-meta text-warn-ink">{st.warn}</span> : <Badge label="Ready" tone="success" />;
  return <span className={cx("text-meta", st.blank || r.lines == null ? "text-muted" : "text-danger")}>{st.problem}</span>;
}

function RowSplit({ r, st, onTick, onExtra, onAdd }: { r: EnterRow; st: ReturnType<typeof rowState>; onTick: (id: string) => void; onExtra: (v: string) => void; onAdd: () => void }) {
  const share = new Map(st.split?.ok ? st.split.rows.map((x) => [x.id, x.amountPaise]) : []);
  return (
    <div className="flex flex-col gap-2 py-1">
      {r.lines!.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th className="w-9" />
              <Th>Customer</Th>
              <Th>Order</Th>
              <Th>Product</Th>
              <Th align="right">Litres</Th>
              <Th align="right">Share</Th>
              <Th>Freight</Th>
            </tr>
          </thead>
          <tbody>
            {r.lines!.map((l) => {
              const e = lineEligibility(l);
              const on = e.ok && r.ticked.has(l.orderId);
              return (
                <Tr key={l.orderId} className={cx(!e.ok && "text-muted")}>
                  <Td>
                    <input type="checkbox" className={checkboxClass} disabled={!e.ok} checked={on} aria-label={`Order ${l.orderNo}`} onChange={() => onTick(l.orderId)} />
                  </Td>
                  <Td className={cx(e.ok && "font-medium text-ink")}>{l.customer}</Td>
                  <Td>
                    Order {l.orderNo}
                    {l.billNo ? <span className="text-muted"> · {l.billNo}</span> : null}
                  </Td>
                  <Td>{l.product}</Td>
                  <Td align="right">{l.litres == null ? "—" : nf(l.litres)}</Td>
                  <Td align="right" className="font-medium">
                    {on && share.has(l.orderId) ? inr(share.get(l.orderId)!) : "—"}
                  </Td>
                  <Td>{e.ok ? <Badge label="Paid" tone="success" /> : <Badge label={e.why} tone={e.kind === "taken" ? "danger" : "neutral"} />}</Td>
                </Tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty>Nothing left on this vehicle that day. Add a dispatch by its order number.</Empty>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={r.extraNo} onChange={(e) => onExtra(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Order number" aria-label="Order number" className="w-40" />
        <Button size="sm" onClick={onAdd}>
          + Add a dispatch that left on another vehicle
        </Button>
        <span className="flex-1" />
        {st.split?.ok && st.paise != null ? (
          <span className="text-sm font-medium text-ink">
            {inr(st.paise)} over {nf(st.split.totalLitres)} L · {perLitre(st.paise, st.split.totalLitres)} / L · adds up to the paisa
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ================================================================ add or edit a bill */


const STEPS = ["Bill", "What was on the vehicle", "Check the split"];
const tripKey = (v: { vehicleNo: string; dispatchOn: string }) => `${v.vehicleNo}|${v.dispatchOn}`;
/** A vehicle number however it was spaced — "MH04 KL 2231" and "mh04kl2231" are one lorry. */
const vkey = (v: string) => v.replace(/\s/g, "").toUpperCase();
const waitingId = (w: WaitingBill) => `${w.billNo ?? "-"}|${vkey(w.vehicleNo)}|${w.dispatchOn}`;

/* ---------------------------------------------------------------------------
 * The three lists are the ERP's ordinary list (ListScreen), so they search,
 * filter by column, sort, hide columns, group, tick rows with totals and
 * export exactly as every other ERP list does. Each is grouped by transporter
 * and a whole transporter can be ticked at once; the selection bar's button
 * opens this screen's own dialog — Enter bills, or Pay — over the ticks.
 * ------------------------------------------------------------------------- */

const ADD: ActionSpec = { id: "add", l: "Enter bill", primary: true };

function waitingSpec(days: number, canWrite: boolean): ListSpec {
  return {
    screen: "freightWaiting",
    cols: [
      { k: "transporter", l: "Transporter", t: "t" },
      { k: "trip", l: "Trip", t: "b" },
      { k: "billNo", l: "Sales bill", t: "mono" },
      { k: "party", l: "Billing party", t: "t" },
      { k: "goods", l: "Description of goods", t: "t" },
      { k: "qty", l: "Order qty (cans)", t: "n" },
      { k: "boxes", l: "Boxes", t: "n" },
      { k: "lines", l: "Order lines", t: "n" },
      { k: "litres", l: "Paid-freight litres", t: "n" },
      { k: "days", l: "Waiting (days)", t: "n" },
    ],
    hidden: [],
    groups: ["transporter"],
    groupHead: ["transporter"],
    groupSel: true,
    agg: { k: "litres", l: "L" },
    colFilters: true,
    filters: ["transporter", "party", "trip", "days"],
    sortDefault: ["days", -1],
    selectSum: [
      { k: "litres", l: "L" },
      { k: "boxes", l: "boxes" },
      { k: "trip", l: "trips", one: "trip", kind: "distinct" },
    ],
    bulk: canWrite ? [{ id: "add", l: "Enter bills" }] : [],
    rowMenu: canWrite ? ["add"] : [],
    readOnly: true,
    noDataLine: `Every Paid-freight sales bill of the last ${days} days is on a transport bill.`,
  };
}

function waitingRow(w: WaitingBill, today: string, canWrite: boolean): ListRow {
  return {
    id: waitingId(w),
    v: {
      transporter: w.transporter?.trim() || NO_TRANSPORTER,
      trip: `${w.vehicleNo} · left ${shortDay(w.dispatchOn)}`,
      billNo: w.billNo,
      party: w.party,
      goods: w.goods,
      qty: w.qty,
      boxes: w.boxes,
      lines: w.lines,
      litres: w.litres,
      days: daysSince(today, w.dispatchOn),
    },
    flags: [],
    actions: canWrite ? [ADD] : [],
  };
}

function billsSpec(sub: "pay" | "paid", canWrite: boolean): ListSpec {
  const paid = sub === "paid";
  return {
    screen: paid ? "freightPaid" : "freightPending",
    cols: [
      { k: "transporter", l: "Transporter", t: "t" },
      { k: "name", l: "Bill / LR", t: "b" },
      { k: "billDate", l: "Bill date", t: "d" },
      { k: "vehicle", l: "Vehicle", t: "mono" },
      { k: "litres", l: "Litres", t: "n" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "perLitre", l: "Cost / L", t: "m" },
      ...(paid
        ? [
            { k: "paidOn", l: "Paid on", t: "d" as const },
            { k: "mode", l: "Mode", t: "s" as const },
          ]
        : [{ k: "days", l: "Waiting (days)", t: "n" as const }]),
      { k: "parties", l: "Billing parties", t: "t" },
      { k: "status", l: "Status", t: "s" },
    ],
    hidden: [],
    groups: ["transporter"],
    groupHead: ["transporter"],
    groupSel: true,
    agg: { k: "amount", l: "amount" },
    colFilters: true,
    filters: paid ? ["transporter", "mode", "vehicle", "amount"] : ["transporter", "status", "vehicle", "amount", "days"],
    sortDefault: paid ? ["paidOn", -1] : ["billDate", 1],
    selectSum: [
      { k: "amount", l: "amount" },
      { k: "litres", l: "L" },
    ],
    bulk: !paid && canWrite ? [{ id: "pay", l: "Pay" }] : [],
    rowMenu: ["pay", "unpay", "open"],
    readOnly: true,
    noDataLine: paid ? "No transport bill was paid in this month." : "No transport bill is waiting to be paid.",
  };
}

function billRow(b: FreightBillView, today: string, canWrite: boolean, manager: boolean): ListRow {
  const perL = costPerLitrePaise(b.amountPaise, b.litres);
  const actions: ActionSpec[] = [];
  if (canWrite && b.status === "pending" && !b.stale.length) actions.push({ id: "pay", l: "Pay", primary: true });
  if (canWrite && manager && b.status === "paid") actions.push({ id: "unpay", l: "Undo payment" });
  actions.push({ id: "open", l: b.stale.length && b.status === "pending" ? "Split again" : "Open bill" });
  return {
    id: b.id,
    v: {
      transporter: b.transporter,
      name: b.name,
      billDate: b.billDate,
      vehicle: b.vehicleNo,
      litres: b.litres,
      amount: b.amountPaise,
      perLitre: perL == null ? null : Math.round(perL),
      paidOn: b.paidOn,
      mode: b.paymentMode ? `${PAYMENT_MODE_LABEL[b.paymentMode]}${b.paymentRef ? ` · ${b.paymentRef}` : ""}` : null,
      days: b.status === "pending" ? daysSince(today, b.billDate) : null,
      parties: [...new Set(b.shares.map((x) => x.customer))].join(", "),
      status: b.status === "paid" ? "Paid" : b.stale.length ? "Dispatch changed · split again" : "To pay",
    },
    flags: [],
    actions,
  };
}


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
  onSaved: (id: string) => void;
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
    /* Loading always clears, and a call that throws says so rather than spinning for ever. */
    try {
      const r = await erpFreightVehicleLines(chosen.vehicleNo, chosen.dispatchOn, bill?.id ?? null);
      if (!r.ok) return setProblem(r.error);
      /* Lines of the bill being edited that left on another vehicle stay on it. */
      const extra = bill ? bill.shares.filter((s) => !r.data.some((l) => l.orderId === s.orderId)).map((s) => s.orderNo) : [];
      const more = extra.length ? await erpFreightOrderLines(extra, bill?.id ?? null) : null;
      const all = [...r.data, ...(more?.ok ? more.data : [])];
      setLines(all);
      setTicked((cur) => (bill ? cur : new Set(all.filter((l) => lineEligibility(l).ok).map((l) => l.orderId))));
    } catch (e) {
      setProblem(actionFailure(e));
    } finally {
      setLoading(false);
    }
  };

  const addOrder = async () => {
    const no = Number(extraNo.trim());
    if (!Number.isInteger(no) || no <= 0) return setProblem("Type an order number.");
    setProblem(null);
    let r: Awaited<ReturnType<typeof erpFreightOrderLines>>;
    try {
      r = await erpFreightOrderLines([no], bill?.id ?? null);
    } catch (e) {
      return setProblem(actionFailure(e));
    }
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

  const save = () =>
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
        if (r.ok) onSaved(r.data.id);
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
        ) : (
          <Button variant="primary" disabled={pending} onClick={save}>
            {bill ? "Save changes" : "Save — it goes to To pay"}
          </Button>
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
