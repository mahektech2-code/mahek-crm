"use client";

import { useMemo, useState } from "react";
import { FilterPills } from "@/components/ui/overlays";
import { Button, Card, checkboxClass, cx, Field, Input, Textarea } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { gridHeadClass, labelClass, LinkButton, SubTitle } from "../../_ui/look";
import { erpTransportPaymentRecord, erpTransportPaymentReverse, erpTripAddBills, erpTripRemoveBill, erpTripSave } from "@/lib/actions/erp-logistics";
import { PHASE_LABEL, shortDay } from "@/lib/erp/engines/logistics";
import { allocateByLitres, COST_STATUS_TONE, perLitreWords } from "@/lib/erp/engines/transport-cost";
import type { TripBill, TripPayment, TripView } from "@/lib/erp/trips";
import { inr, inrRate, nf } from "@/lib/erp/ui";
import { Empty, plural, ReasonDialog, useAct, useTicks } from "./common";

/**
 * TRIPS & FREIGHT (Order-to-Delivery PRD steps 10–11). One card per vehicle
 * trip: the bills it carries for every customer on it, and the transport
 * payment recorded against it, shared out by dispatched litres. The preview in
 * the payment dialog is the same function the server writes with, so what is
 * shown before saving is what is saved.
 *
 * Logistics RECORDS the confirmed payment; it does not make it — every word on
 * this tab says so.
 */
type Filter = "all" | "vehicle" | "open" | "reconcile";
type Dialog =
  | { kind: "trip"; trip: TripView | null; bills: string[] }
  | { kind: "add"; trip: TripView }
  | { kind: "pay"; trip: TripView }
  | { kind: "reverse"; payment: TripPayment; trip: TripView }
  | null;

const UNSETTLED = new Set(["Not Recorded", "Recorded", "Allocation Pending"]);

export function Trips({ trips, unassigned, today, transporters, canWrite }: { trips: TripView[]; unassigned: TripBill[]; today: string; transporters: string[]; canWrite: boolean }) {
  const { run, pending } = useAct();
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const { ticked, toggle, setMany, clear } = useTicks();

  const counts = {
    all: trips.length,
    vehicle: unassigned.length + trips.filter((t) => !t.vehicleNo).length,
    open: trips.filter((t) => UNSETTLED.has(t.costStatus) && t.bills.length).length,
    reconcile: trips.filter((t) => t.costStatus === "Reconciliation Required").length,
  };
  const shown = trips.filter((t) => (filter === "vehicle" ? !t.vehicleNo : filter === "open" ? UNSETTLED.has(t.costStatus) && t.bills.length > 0 : filter === "reconcile" ? t.costStatus === "Reconciliation Required" : true));
  const sel = [...ticked].filter((id) => unassigned.some((b) => b.id === id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterPills<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "Every trip", count: counts.all },
            { key: "vehicle", label: "Vehicle missing", count: counts.vehicle },
            { key: "open", label: "Cost not shared out", count: counts.open },
            { key: "reconcile", label: "Reconciliation required", count: counts.reconcile },
          ]}
        />
        {canWrite ? (
          <Button size="sm" variant="primary" className="ml-auto" disabled={pending} onClick={() => setDialog({ kind: "trip", trip: null, bills: [] })}>
            New trip
          </Button>
        ) : null}
      </div>
      <p className="text-meta text-muted">
        A trip is one tempo or truck, carrying bills for any number of customers. Logistics records the confirmed transport payment against the trip and shares it out over its bills by dispatched litres only — never boxes, weight or the number of bills. Logistics records the payment; it does not make it.
      </p>

      {filter === "all" || filter === "vehicle" ? (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-canvas px-4 py-2.5">
            <div className="min-w-0">
              <SubTitle className="mb-0">Bills on no trip</SubTitle>
              <div className="text-meta text-muted">Dispatched in the last 30 days with no vehicle recorded, or not yet put on a trip.</div>
            </div>
            {canWrite && unassigned.length ? (
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" disabled={!sel.length || pending} onClick={() => setDialog({ kind: "trip", trip: null, bills: sel })}>
                  New trip with {sel.length ? plural(sel.length, "bill") : "the ticked bills"}
                </Button>
              </div>
            ) : null}
          </div>
          {unassigned.length ? (
            <>
              <BillHead tick={canWrite} />
              {unassigned.map((b) => (
                <BillRow key={b.id} b={b} tick={canWrite ? { on: ticked.has(b.id), toggle: () => toggle(b.id) } : null} />
              ))}
              {canWrite ? (
                <div className="flex gap-3 px-4 py-2 text-meta">
                  <LinkButton tone="muted" onClick={() => setMany(unassigned.map((b) => b.id), true)}>
                    Tick all
                  </LinkButton>
                  {sel.length ? (
                    <LinkButton tone="muted" onClick={clear}>
                      Clear
                    </LinkButton>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <Empty>Every recent bill is on a trip with its vehicle.</Empty>
          )}
        </Card>
      ) : null}

      {!shown.length ? (
        <Card>
          <Empty>{trips.length ? "No trip matches." : "No trips yet. Dispatch opens one when it records a vehicle number, or start one with New trip."}</Empty>
        </Card>
      ) : null}

      {shown.map((t) => {
        const live = t.payments.filter((p) => p.status !== "reversed");
        const free = t.bills.filter((b) => b.sharePaise == null);
        return (
          <Card key={t.id} className={cx("overflow-clip", t.costStatus === "Reconciliation Required" && "border-danger/50")}>
            <div className="flex flex-wrap items-start gap-3 border-b border-divider bg-canvas px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SubTitle className="mb-0">Trip {t.tripNo}</SubTitle>
                  <span className="font-mono text-meta text-ink">{t.vehicleNo ?? "No vehicle"}</span>
                  <Badge label={t.costStatus} tone={COST_STATUS_TONE[t.costStatus]} />
                  {!t.vehicleNo ? <Badge label="Vehicle missing" tone="warn" /> : null}
                  {t.litresMissing ? <Badge label="Litres missing" tone="warn" /> : null}
                </div>
                <div className="text-meta text-muted">
                  {shortDay(t.tripDate)} · {t.driver ? `Driver ${t.driver}` : "No driver named"} · {t.transporter ?? "No transporter named"} · {plural(t.bills.length, "bill")} for {plural(new Set(t.bills.map((b) => b.deliveryParty)).size, "party", "parties")} · {nf(t.totalLitres)} L
                </div>
                {t.note ? <div className="mt-0.5 text-meta text-body">{t.note}</div> : null}
              </div>
              {canWrite ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={pending} onClick={() => setDialog({ kind: "trip", trip: t, bills: [] })}>
                    Edit trip
                  </Button>
                  <Button size="sm" disabled={pending} onClick={() => setDialog({ kind: "add", trip: t })}>
                    Add bills
                  </Button>
                  <Button size="sm" variant="primary" disabled={pending || !free.length} title={free.length ? undefined : "Every bill on this trip already carries a share of a payment"} onClick={() => setDialog({ kind: "pay", trip: t })}>
                    Record transport payment
                  </Button>
                </div>
              ) : null}
            </div>
            {t.bills.length ? (
              <>
                <BillHead share />
                {t.bills.map((b) => (
                  <BillRow
                    key={b.id}
                    b={b}
                    share
                    onRemove={canWrite && b.sharePaise == null ? () => run(() => erpTripRemoveBill(b.id)) : undefined}
                  />
                ))}
              </>
            ) : (
              <Empty>No bills on this trip yet.</Empty>
            )}
            {t.payments.length ? (
              <div className="border-t border-divider">
                <div className={cx("px-4 pt-2", labelClass)}>Transport payments recorded</div>
                {t.payments.map((p) => (
                  <div key={p.id} className={cx("flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm", p.status === "reversed" && "text-muted line-through decoration-muted/50")}>
                    <span className="font-medium tabular-nums text-ink">{inrRate(p.amountPaise)}</span>
                    <span className="text-meta">{p.costPerLitrePaise != null ? `${perLitreWords(p.costPerLitrePaise)} over ${nf(p.totalLitres)} L` : "not shared out"}</span>
                    <span className="text-meta">{p.paidOn ? `Paid ${shortDay(p.paidOn)}` : "Payment date not given"}{p.paidTo ? ` · to ${p.paidTo}` : ""}{p.reference ? ` · ref ${p.reference}` : ""}</span>
                    {p.scope ? <span className="text-meta">Covers: {p.scope}</span> : null}
                    <span className="text-2xs text-muted">Recorded by {p.recordedBy ?? "—"}</span>
                    {p.reconcile ? <Badge label="Reconciliation required" tone="danger" /> : null}
                    {p.status === "reversed" ? (
                      <span className="text-2xs no-underline">Reversed{p.reversedBy ? ` by ${p.reversedBy}` : ""}: {p.reverseReason}</span>
                    ) : canWrite ? (
                      <LinkButton tone="muted" className="ml-auto text-meta" onClick={() => setDialog({ kind: "reverse", payment: p, trip: t })}>
                        Reverse
                      </LinkButton>
                    ) : null}
                  </div>
                ))}
                {live.length ? (
                  <div className="px-4 pb-2 text-2xs text-muted">The shares add up to the amount to the paisa; a rounding paisa goes to the bills that lost most to rounding.</div>
                ) : null}
              </div>
            ) : null}
          </Card>
        );
      })}

      {dialog?.kind === "trip" ? (
        <TripDialog key={`trip${dialog.trip?.id ?? "new"}`} trip={dialog.trip} bills={dialog.bills} today={today} transporters={transporters} onClose={() => setDialog(null)} onSaved={clear} />
      ) : null}
      {dialog?.kind === "add" ? <AddBillsDialog key={`add${dialog.trip.id}`} trip={dialog.trip} trips={trips} unassigned={unassigned} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "pay" ? <PaymentDialog key={`pay${dialog.trip.id}`} trip={dialog.trip} today={today} onClose={() => setDialog(null)} /> : null}
      <ReasonDialog
        key={dialog?.kind === "reverse" ? dialog.payment.id : "none"}
        open={dialog?.kind === "reverse"}
        title={dialog?.kind === "reverse" ? `Reverse the ${inrRate(dialog.payment.amountPaise)} payment on trip ${dialog.trip.tripNo}?` : ""}
        body="The payment and its shares stay on the record, marked reversed, and the bills are free to be shared again."
        placeholder="Why — e.g. wrong amount, wrong trip, payment cancelled"
        keepLabel="Keep it"
        confirmLabel="Reverse payment"
        tone="danger"
        pending={pending}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => dialog?.kind === "reverse" && run(() => erpTransportPaymentReverse(dialog.payment.id, reason), (r) => r.ok && setDialog(null))}
      />
    </div>
  );
}

const GRID = "grid grid-cols-[28px_minmax(110px,1fr)_minmax(160px,1.8fr)_80px_minmax(120px,1fr)_100px_64px] gap-3";

function BillHead({ tick = false, share = false }: { tick?: boolean; share?: boolean }) {
  return (
    <div className={cx(GRID, "px-4 py-1.5", gridHeadClass)}>
      <span />
      <span>Bill</span>
      <span>Goes to</span>
      <span>Litres</span>
      <span>LR · where</span>
      <span>{share ? "Transport cost" : tick ? "" : ""}</span>
      <span />
    </div>
  );
}

function BillRow({ b, tick, share = false, onRemove }: { b: TripBill; tick?: { on: boolean; toggle: () => void } | null; share?: boolean; onRemove?: () => void }) {
  return (
    <div className={cx(GRID, "items-center border-b border-divider px-4 py-2 text-sm last:border-0", tick?.on && "bg-brand-soft/40")}>
      {tick ? <input type="checkbox" checked={tick.on} onChange={tick.toggle} className={checkboxClass} aria-label={`Tick ${b.billNo ?? b.orderNo}`} /> : <span />}
      <span className="min-w-0">
        <span className="block truncate font-mono text-meta text-ink">{b.billNo ?? `Order ${b.orderNo}`}</span>
        <span className="block truncate text-meta text-muted">
          Order {b.orderNo}
          {b.billDate ? ` · ${shortDay(b.billDate)}` : ""}
          {b.vehicleNo ? ` · ${b.vehicleNo}` : ""}
        </span>
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink">{b.deliveryParty}</span>
        {b.deliveryParty !== b.party ? <span className="block truncate text-meta text-muted">billed to {b.party}</span> : null}
      </span>
      <span className={cx("tabular-nums text-meta", !b.litres && "text-warn")}>{b.litres ? nf(b.litres) : "none"}</span>
      <span className="min-w-0 truncate text-meta">
        {b.lrNo ? `LR ${b.lrNo}` : "No LR"} · {PHASE_LABEL[b.phase]}
      </span>
      <span className="tabular-nums text-meta">{share ? (b.sharePaise != null ? inrRate(b.sharePaise) : <span className="text-muted">not shared</span>) : null}</span>
      <span className="text-right">
        {onRemove ? (
          <LinkButton tone="muted" className="text-meta" onClick={onRemove}>
            Remove
          </LinkButton>
        ) : null}
      </span>
    </div>
  );
}

function TripDialog({ trip, bills, today, transporters, onClose, onSaved }: { trip: TripView | null; bills: string[]; today: string; transporters: string[]; onClose: () => void; onSaved: () => void }) {
  const { run, pending } = useAct();
  const [date, setDate] = useState(trip?.tripDate ?? today);
  const [vehicle, setVehicle] = useState(trip?.vehicleNo ?? "");
  const [driver, setDriver] = useState(trip?.driver ?? "");
  const [transporter, setTransporter] = useState(trip?.transporter ?? "");
  const [note, setNote] = useState(trip?.note ?? "");
  const title = trip ? `Edit trip ${trip.tripNo}` : bills.length ? `New trip with ${plural(bills.length, "bill")}` : "New trip";
  const save = () =>
    run(
      () => erpTripSave({ id: trip?.id ?? null, tripDate: date, vehicleNo: vehicle, driver, transporter, note, transportIds: bills }),
      (r) => {
        if (r.ok) {
          onSaved();
          onClose();
        }
      },
    );
  return (
    <ErpDialog onClose={onClose} label={title} size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Trip date">
            <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Vehicle / tempo / truck no">
            <Input value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} placeholder="MH04 AB 1234" />
          </Field>
          <Field label="Driver">
            <Input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="Name and phone — optional" />
          </Field>
          <Field label="Transporter">
            <Input value={transporter} onChange={(e) => setTransporter(e.target.value)} list="trip-transporters" placeholder="Optional" />
            <datalist id="trip-transporters">
              {transporters.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        {trip && vehicle.trim() && vehicle.trim() !== (trip.vehicleNo ?? "") ? <p className="text-meta text-muted">Every bill on the trip takes the new vehicle number.</p> : null}
        {!vehicle.trim() ? <p className="text-meta text-warn">With no vehicle number the trip is listed under Vehicle missing.</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !date} onClick={save}>
          {trip ? "Save trip" : "Create trip"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

/** Bills that can join this trip: on no trip, or on another trip and carrying no share of its payment. */
function AddBillsDialog({ trip, trips, unassigned, onClose }: { trip: TripView; trips: TripView[]; unassigned: TripBill[]; onClose: () => void }) {
  const { run, pending } = useAct();
  const { ticked, toggle } = useTicks();
  const [q, setQ] = useState("");
  const candidates = useMemo(() => {
    const others = trips.filter((t) => t.id !== trip.id).flatMap((t) => t.bills.filter((b) => b.sharePaise == null).map((b) => ({ b, from: `on trip ${t.tripNo}` })));
    return [...unassigned.map((b) => ({ b, from: "on no trip" })), ...others];
  }, [trip.id, trips, unassigned]);
  const needle = q.trim().toLowerCase();
  const shown = candidates.filter(({ b }) => !needle || [b.billNo, b.party, b.deliveryParty, String(b.orderNo), b.vehicleNo].some((x) => x?.toLowerCase().includes(needle)));
  const title = `Add bills to trip ${trip.tripNo}`;
  return (
    <ErpDialog onClose={onClose} label={title} size="md">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bill, order, party, vehicle" aria-label="Search bills" />
        <p className="text-meta text-muted">A bill already carrying a share of another trip&apos;s payment is not listed — reverse that payment first.</p>
        <div className="max-h-[50vh] overflow-y-auto rounded-control border border-line">
          {shown.length ? (
            shown.map(({ b, from }) => (
              <label key={b.id} className={cx("flex cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-0", ticked.has(b.id) && "bg-brand-soft/40")}>
                <input type="checkbox" checked={ticked.has(b.id)} onChange={() => toggle(b.id)} className={checkboxClass} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{b.deliveryParty}</span>
                  <span className="block truncate text-meta text-muted">
                    {b.billNo ?? `Order ${b.orderNo}`} · order {b.orderNo} · {b.litres ? `${nf(b.litres)} L` : "no litres"} · {from}
                  </span>
                </span>
              </label>
            ))
          ) : (
            <Empty>No bill to add.</Empty>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !ticked.size} onClick={() => run(() => erpTripAddBills(trip.id, [...ticked]), (r) => r.ok && onClose())}>
          Add {ticked.size ? plural(ticked.size, "bill") : "bills"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function PaymentDialog({ trip, today, onClose }: { trip: TripView; today: string; onClose: () => void }) {
  const { run, pending } = useAct();
  const free = trip.bills.filter((b) => b.sharePaise == null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(free.filter((b) => b.litres && b.litres > 0).map((b) => b.id)));
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [paidTo, setPaidTo] = useState(trip.transporter ?? "");
  const [reference, setReference] = useState("");
  const [scope, setScope] = useState("");
  const [note, setNote] = useState("");
  const paise = Math.round(Number(amount.replace(/[,₹\s]/g, "")) * 100);
  const chosen = free.filter((b) => picked.has(b.id));
  /* The same function the server shares it out with. */
  const preview = allocateByLitres(
    Number.isFinite(paise) ? paise : 0,
    chosen.map((b) => ({ id: b.id, litres: b.litres })),
  );
  const shareOf = new Map(preview.ok ? preview.rows.map((r) => [r.id, r.amountPaise]) : []);
  const partOnly = chosen.length < trip.bills.length;
  const flip = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const title = `Record transport payment · trip ${trip.tripNo}`;
  const save = () =>
    run(
      () => erpTransportPaymentRecord({ tripId: trip.id, amountPaise: paise, paidOn: paidOn || null, paidTo, reference, scope, note, transportIds: chosen.map((b) => b.id) }),
      (r) => r.ok && onClose(),
    );
  return (
    <ErpDialog onClose={onClose} label={title} size="md">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <p className="text-meta text-muted">
          Record the confirmed amount once. It is shared out over the ticked bills by dispatched litres only. Recording it says the payment is confirmed — Logistics does not make the payment.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Total transport amount (₹)">
            <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder="1000" />
          </Field>
          <Field label="Paid on">
            <Input type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
          <Field label="Paid to">
            <Input value={paidTo} onChange={(e) => setPaidTo(e.target.value)} placeholder="Transporter" />
          </Field>
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR, cheque or voucher no — optional" />
          </Field>
        </div>
        <div className="rounded-control border border-line">
          <div className={cx("grid grid-cols-[28px_minmax(0,1.6fr)_80px_110px] gap-3 px-3 py-1.5", gridHeadClass)}>
            <span />
            <span>Bill</span>
            <span>Litres</span>
            <span>Share</span>
          </div>
          {free.map((b) => {
            const bad = !b.litres || b.litres <= 0;
            return (
              <label key={b.id} className={cx("grid cursor-pointer grid-cols-[28px_minmax(0,1.6fr)_80px_110px] items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-0", picked.has(b.id) && "bg-brand-soft/40")}>
                <input type="checkbox" checked={picked.has(b.id)} onChange={() => flip(b.id)} className={checkboxClass} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{b.deliveryParty}</span>
                  <span className="block truncate text-meta text-muted">{b.billNo ?? `Order ${b.orderNo}`} · order {b.orderNo}</span>
                </span>
                <span className={cx("tabular-nums text-meta", bad && "text-danger")}>{bad ? "none" : nf(b.litres)}</span>
                <span className="tabular-nums text-meta">{shareOf.has(b.id) ? inrRate(shareOf.get(b.id)) : "—"}</span>
              </label>
            );
          })}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-canvas px-3 py-2 text-meta">
            {preview.ok ? (
              <>
                <span>
                  <b className="text-ink">{nf(preview.totalLitres)} L</b> eligible
                </span>
                <span>
                  <b className="text-ink">{perLitreWords(preview.costPerLitrePaise)}</b>
                </span>
                <span>
                  Shares total <b className="text-ink">{inrRate(preview.rows.reduce((a, r) => a + r.amountPaise, 0))}</b> = {inr(paise)}
                </span>
              </>
            ) : (
              <span className={amount.trim() ? "text-danger" : "text-muted"}>{amount.trim() ? preview.reason : "Enter the amount to see each bill's share."}</span>
            )}
          </div>
        </div>
        {partOnly ? (
          <Field label="Which part of the trip this covers" hint="Not every bill on the trip is ticked — say what the payment covers, so the rest is not paid for twice.">
            <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. Pune drop only" />
          </Field>
        ) : null}
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !preview.ok || (partOnly && !scope.trim())} onClick={save}>
          Record and share out
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
