"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Callout, checkboxClass, cx, Input, Select, SectionLabel } from "@/components/ui/primitives";
import { ComboBox } from "@/components/ui/combo-box";
import { stamp } from "@/lib/format";
import { fd, inr, inrRate, qty } from "@/lib/erp/ui";
import { erpRunAction } from "@/lib/actions/erp";
import { erpRequirementPoLookup } from "@/lib/actions/erp-requirement-po";
import type { LinkPreview } from "@/lib/erp/screens/requirement-po";
import { registerPanel, type PanelProps } from "../panels";
import { resultError, useAct } from "../use-act";
import { DialogBody, DialogTitle, DialogFooter, DialogHeader, ErpDialog, StepBar } from "../dialog";
import { gridHeadClass, eyebrowClass, labelClass, linkClass } from "../look";
import { History, NextStep, Stepper, SumFact } from "./parts";
import { StatusBadge } from "../badge";
import { useErpUi } from "../erp-ui";
import { ErpImpactDialog } from "../impact-confirm";
import { IMPACT_FIELD } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * The purchase flow, drawn in the record of a requirement and of a PO:
 *
 *   Requirement → Purchase method → PO number → Receipt
 *
 * No count is asked for on the way (Nov 2026): a requirement's record goes
 * straight to the PO by the item's purchase rule, and it happens IN the
 * record:
 *
 * - Quotation: a PO NUMBER box. What is typed is looked up on the Quotation
 *   manager after a pause and shown; "Link PO" links it.
 * - Direct purchase: "Create PO" opens a three-page modal OVER the record,
 *   which stays open behind it. The rate is the item's price in Raw
 *   materials and is never typed; no price is ₹0.
 *
 * Neither is approved. Everything is the server's answer; the panel only
 * draws it and sends what was typed.
 * ------------------------------------------------------------------------- */

type Fact = { l: string; v: string; href?: string };
type CreateData = {
  why: string;
  item: string;
  reqNo: string | null;
  qty: string;
  unit: string;
  godown: string;
  requiredBy: string | null;
  vendor: string;
  defaultVendor: string | null;
  hasPrice: boolean;
  ratePaise: number | null;
  rate: string | null;
  amountPaise: number | null;
  gstPercent: number;
  vendors: { name: string; terms: string | null }[];
  godowns: string[];
  terms: string[];
  money: boolean;
  /** Other requirements this PO can carry — `PoCompanion` on the server. */
  others: { id: string; reqNo: string | null; item: string; qty: string; unit: string; vendor: string | null; hasPrice: boolean; ratePaise: number | null }[];
};
type Flow = {
  id: string;
  steps: string[];
  step: number;
  stage: string;
  next: string;
  /** The line under the next step: when, where, how much has come. */
  nextSub: string | null;
  summary: { qty: string; unit: string; inStock: string; requiredBy: string | null; late: string | null; team: string | null; deliverTo: string; priority: string | null; method: string; raisedBy: string; remarks: string | null };
  history: { at: string; text: string; open?: boolean }[];
  facts: Fact[];
  po: {
    name: string;
    fromQuotationManager: boolean;
    status: string;
    vendor: string;
    rate: string | null;
    gst: string;
    drums: number | null;
    received: string;
    progress: number;
    shared: string | null;
    href: string;
    canUnlink: boolean;
  } | null;
  entry: { link: boolean; create: CreateData | null } | null;
};

const count = (q: string) => (Number.isFinite(Number(q)) && q.trim() ? qty(Number(q)) : q);

/** The PO number box: typed, looked up after a pause, linked with one press. Never a pop-up. */
function LinkPo({ id, inputRef, focus }: { id: string; inputRef?: React.Ref<HTMLInputElement>; focus?: boolean }) {
  const [poNo, setPoNo] = useState("");
  const [found, setFound] = useState<{ q: string; data: LinkPreview } | null>(null);
  const [error, setError] = useState<{ q: string; text: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const seq = useRef(0);
  const { run, pending } = useAct();
  const q = poNo.trim();
  useEffect(() => {
    if (!q) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setLooking(true);
      const r = await erpRequirementPoLookup(id, q);
      if (n !== seq.current) return;
      setLooking(false);
      if (r.ok) {
        setFound({ q, data: r.data });
        setError(null);
      } else {
        setFound(null);
        setError({ q, text: resultError(r) });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [id, q]);
  const hit = found && found.q === q ? found.data : null;
  const miss = error && error.q === q ? error.text : null;
  return (
    <div className="overflow-hidden rounded-control border border-line">
      <div className="border-b border-divider bg-canvas px-3 py-2 text-meta font-medium text-ink">Purchase order · Link PO</div>
      <div className="grid gap-2.5 p-3">
        <label className="grid gap-1">
          <span className={labelClass}>PO number</span>
          <Input
            ref={inputRef}
            autoFocus={focus}
            value={poNo}
            onChange={(e) => setPoNo(e.target.value)}
            placeholder="The PO number the Quotation manager made"
            className="font-mono"
            maxLength={60}
            invalid={!!miss}
          />
          <span className={cx("text-meta", miss ? "text-danger" : "text-muted")}>
            {miss ?? (q && (looking || !hit) ? "Looking it up on the Quotation manager…" : "The supplier, rate and drums are fetched from it — nothing else to fill.")}
          </span>
        </label>
        {hit ? (
          <div className="overflow-hidden rounded-control border border-success-soft">
            <div className="bg-success-soft px-3 py-1.5 text-meta font-medium text-success">✓ Found in the Quotation manager</div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 px-3 py-2.5 text-meta">
              {[
                ["Supplier", hit.vendor],
                ["Material", hit.material],
                ...(hit.rate ? [["Rate", `${hit.rate} · GST ${hit.gst}`]] : [["GST", hit.gst]]),
                ["Drums", hit.drums == null ? "—" : String(hit.drums)],
                ["Quantity", hit.quantity],
                ...(hit.amount ? [["Amount", hit.amount]] : []),
                ["Quoted", hit.quotedOn],
                ["Bought", [hit.boughtBy, hit.boughtAt ? stamp(hit.boughtAt) : null].filter(Boolean).join(" · ") || "—"],
              ].map(([l, v]) => (
                <div key={l} className="min-w-0">
                  <dt className={eyebrowClass}>{l}</dt>
                  <dd className="break-words text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            {hit.shared ? <div className="px-3 pb-2 text-meta text-muted">This PO number already carries {hit.shared} other item{hit.shared > 1 ? "s" : ""}; this one is added to it.</div> : null}
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!hit || pending}
            onClick={() => run(() => erpRunAction("requisitions", "linkPo", id, { poNo: q }))}
          >
            {pending ? "Linking…" : "Link PO to requirement"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const PAGES = ["Supplier", "Delivery", "Review"] as const;

/** Create PO: three pages over the record. The rate is the item's price and is shown, never asked. */
function CreatePoModal({ id, d, preselect, onClose }: { id: string; d: CreateData; preselect?: string[]; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const termsOf = (name: string) => d.vendors.find((x) => x.name === name)?.terms ?? null;
  const [v, setV] = useState({
    vendor: d.vendor,
    qty: d.qty,
    deliverTo: d.godown,
    deliveryDate: d.requiredBy ?? "",
    terms: termsOf(d.vendor) ?? "",
    freight: "",
    remarks: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  /* The other items on this PO: offered where they have no vendor yet or the one picked, the vendor's own ticked. */
  const [also, setAlso] = useState<Record<string, { on: boolean; qty: string }>>(() =>
    /* Create one PO names exactly the requirements ticked on the list; otherwise the vendor's own are ticked. */
    Object.fromEntries(d.others.map((o) => [o.id, { on: preselect ? preselect.includes(o.id) : !!d.vendor && o.vendor === d.vendor, qty: o.qty }])),
  );
  const { run, pending } = useAct();
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));
  const qty = Number(v.qty);
  const rate = d.ratePaise ?? 0;
  const eligible = d.others.filter((o) => !o.vendor || o.vendor === v.vendor);
  const ticked = eligible.filter((o) => also[o.id]?.on);
  const lineAmount = (q: number, r: number) => (Number.isFinite(q) ? Math.round(r * q) : 0);
  const amount = lineAmount(qty, rate) + ticked.reduce((a, o) => a + lineAmount(Number(also[o.id].qty), o.ratePaise ?? 0), 0);
  const gst = Math.round((amount * d.gstPercent) / 100);
  const freight = Math.round((Number(v.freight) || 0) * 100);
  const vendorOk = d.vendors.some((x) => x.name === v.vendor);
  function pickVendor(name: string) {
    setV((x) => ({ ...x, vendor: name, terms: termsOf(name) ?? x.terms }));
    setAlso((a) => ({ ...a, ...Object.fromEntries(d.others.filter((o) => o.vendor === name).map((o) => [o.id, { on: true, qty: a[o.id]?.qty ?? o.qty }])) }));
  }
  function check(p: number): boolean {
    const e: Record<string, string> = {};
    if (p === 0) {
      if (!vendorOk) e.vendor = "Pick a supplier from the list.";
      if (!(qty > 0)) e.qty = "Quantity is required";
      const short = ticked.find((o) => !(Number(also[o.id].qty) > 0));
      if (short) e.also = `${short.item}: quantity is required`;
    }
    if (p === 1) {
      if (!v.deliverTo) e.deliverTo = "Where is it delivered?";
      if (!v.deliveryDate) e.deliveryDate = "Delivery date is required";
      if (!v.terms) e.terms = "Payment terms are required";
      if (v.freight && !(Number(v.freight) >= 0)) e.freight = "Freight must be a number";
    }
    setErrors(e);
    return !Object.keys(e).length;
  }
  function submit() {
    run(
      () => erpRunAction("requisitions", "createPo", id, { ...v, also: JSON.stringify(ticked.map((o) => ({ id: o.id, qty: also[o.id].qty }))) }),
      (r) => {
        if (r.ok) onClose();
        else {
          const f = r.fieldErrors ?? [];
          if (f.length) {
            setErrors(Object.fromEntries(f.map((x) => [x.field, x.message])));
            setPage(f.some((x) => x.field === "vendor" || x.field === "qty" || x.field === "also") ? 0 : 1);
          }
        }
      },
    );
  }
  const err = (k: string) => (errors[k] ? <span className="text-meta text-danger">{errors[k]}</span> : null);
  return (
    <ErpDialog onClose={onClose} label={`Create PO · ${d.item}`} width={680} tall={false} over>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Create PO · {d.item}</DialogTitle>
        <div className="mt-0.5 text-meta text-muted">
          {[d.reqNo, `${count(d.qty)} ${d.unit}`, d.godown, "Direct purchase — no quotation needed"].filter(Boolean).join(" · ")}
        </div>
      </DialogHeader>
      <StepBar steps={[...PAGES]} active={page} reached={page} onChange={setPage} />
      <DialogBody>
        {page === 0 ? (
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className={labelClass}>Supplier</span>
              <ComboBox
                label="Supplier"
                value={v.vendor}
                options={d.vendors.map((x) => x.name)}
                onChange={pickVendor}
                placeholder="Search the suppliers"
                emptyHint="No supplier by that name"
              />
              {err("vendor") ?? <span className="text-meta text-muted">{d.defaultVendor ? (v.vendor === d.defaultVendor ? "The item's default supplier." : `The item's default supplier is ${d.defaultVendor}.`) : "The item has no default supplier."}</span>}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className={labelClass}>Item</span>
                <div className="flex h-8.5 items-center rounded-control border border-dashed border-line bg-canvas px-2.5 text-sm text-ink">{d.item}</div>
              </label>
              <label className="grid gap-1">
                <span className={labelClass}>Quantity ({d.unit})</span>
                <Input inputMode="decimal" value={v.qty} onChange={(e) => set("qty", e.target.value)} invalid={!!errors.qty} />
                {err("qty") ?? <span className="text-meta text-muted">From the requirement; change it if the supplier packs differently.</span>}
              </label>
            </div>
            {eligible.length ? (
              <div className="grid gap-1.5">
                <span className={labelClass}>Also on this PO</span>
                <div className="overflow-hidden rounded-control border border-line">
                  {eligible.map((o) => (
                    <div key={o.id} className="flex items-center gap-3 border-b border-divider px-3 py-2 last:border-b-0">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input
                          type="checkbox"
                          className={checkboxClass}
                          checked={!!also[o.id]?.on}
                          onChange={(e) => setAlso((a) => ({ ...a, [o.id]: { on: e.target.checked, qty: a[o.id]?.qty ?? o.qty } }))}
                        />
                        <span className="min-w-0 text-sm text-ink">
                          {o.item}
                          <span className="block text-meta text-muted">{[o.reqNo, o.vendor ? `supplier ${o.vendor}` : "no supplier yet"].filter(Boolean).join(" · ")}</span>
                        </span>
                      </label>
                      <Input
                        inputMode="decimal"
                        aria-label={`Quantity of ${o.item}`}
                        className="w-24"
                        value={also[o.id]?.qty ?? o.qty}
                        disabled={!also[o.id]?.on}
                        onChange={(e) => setAlso((a) => ({ ...a, [o.id]: { on: true, qty: e.target.value } }))}
                      />
                      <span className="w-10 text-meta text-muted">{o.unit}</span>
                    </div>
                  ))}
                </div>
                {err("also") ?? (
                  <span className="text-meta text-muted">
                    Other requirements ready for a PO, with no supplier yet or with {v.vendor || "the supplier picked"}. Each is ordered at its own price in Raw materials.
                  </span>
                )}
              </div>
            ) : null}
          </div>
        ) : page === 1 ? (
          <div className="grid gap-3">
            <div className="overflow-hidden rounded-control border border-line text-meta">
              <div className="flex justify-between border-b border-divider bg-canvas px-3 py-2">
                <span className="font-medium text-ink">Price · from Raw materials</span>
                <span className="text-xs text-muted">not typed here</span>
              </div>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-2 px-3 py-2.5">
                {d.money ? (
                  <>
                    <div>
                      <dt className={eyebrowClass}>Rate per {d.unit.toLowerCase()}</dt>
                      <dd className="text-md font-semibold text-ink">{d.hasPrice ? inrRate(rate) : "₹0 — no price on the item"}</dd>
                    </div>
                    <div>
                      <dt className={eyebrowClass}>Amount</dt>
                      <dd className="text-ink">
                        {inr(amount)} + GST {inr(gst)}
                      </dd>
                    </div>
                  </>
                ) : (
                  <div className="col-span-2 text-muted">The item&apos;s price is used; purchase money is not shown on your account.</div>
                )}
                <div>
                  <dt className={eyebrowClass}>GST</dt>
                  <dd className="text-ink">{d.gstPercent}%</dd>
                </div>
                <div>
                  <dt className={eyebrowClass}>Quantity</dt>
                  <dd className="text-ink">
                    {count(v.qty)} {d.unit}
                  </dd>
                </div>
              </dl>
              <div className="px-3 pb-2.5 text-meta text-muted">
                The rate is the price on the item in Masters → Raw materials. An item with no price there is ordered at ₹0.
                {ticked.length ? ` The ${ticked.length === 1 ? "other item is" : `${ticked.length} other items are`} each ordered at ${ticked.length === 1 ? "its" : "their"} own price — the review shows every line.` : ""}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className={labelClass}>Deliver to</span>
                <Select value={v.deliverTo} onChange={(e) => set("deliverTo", e.target.value)} className="w-full">
                  <option value="">Choose…</option>
                  {d.godowns.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </Select>
                {err("deliverTo")}
              </label>
              <label className="grid gap-1">
                <span className={labelClass}>Delivery date</span>
                <Input type="date" value={v.deliveryDate} onChange={(e) => set("deliveryDate", e.target.value)} invalid={!!errors.deliveryDate} />
                {err("deliveryDate") ?? (d.requiredBy ? <span className="text-meta text-muted">The requirement is needed by this date.</span> : null)}
              </label>
              <label className="grid gap-1">
                <span className={labelClass}>Payment terms</span>
                <Select value={v.terms} onChange={(e) => set("terms", e.target.value)} className="w-full">
                  <option value="">Choose…</option>
                  {[...new Set([...(v.terms && !d.terms.includes(v.terms) ? [v.terms] : []), ...d.terms])].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                {err("terms")}
              </label>
              <label className="grid gap-1">
                <span className={labelClass}>Freight (₹)</span>
                <Input inputMode="decimal" value={v.freight} onChange={(e) => set("freight", e.target.value)} placeholder="Blank when delivery is free" invalid={!!errors.freight} />
                {err("freight")}
              </label>
            </div>
            <label className="grid gap-1">
              <span className={labelClass}>Remarks for the supplier</span>
              <Input value={v.remarks} onChange={(e) => set("remarks", e.target.value)} placeholder="Optional" />
            </label>
          </div>
        ) : (
          <div className="grid gap-3 text-meta">
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-control border border-line px-3 py-2.5">
              {[
                ["Supplier", v.vendor],
                ["Deliver to", `${v.deliverTo}${v.deliveryDate ? ` · by ${fd(v.deliveryDate)}` : ""}`],
                ["Payment terms", v.terms],
                ["For", d.reqNo ?? d.item],
              ].map(([l, x]) => (
                <div key={l}>
                  <dt className={eyebrowClass}>{l}</dt>
                  <dd className="text-ink">{x}</dd>
                </div>
              ))}
            </dl>
            <div className="overflow-clip rounded-control border border-line">
              <div className={cx("grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 py-2", gridHeadClass)}>
                <span>Item</span>
                <span className="text-right">Quantity</span>
                <span className="text-right">Rate</span>
                <span className="text-right">Total</span>
              </div>
              {[
                { key: id, item: d.item, q: v.qty, unit: d.unit, hasPrice: d.hasPrice, r: rate },
                ...ticked.map((o) => ({ key: o.id, item: o.item, q: also[o.id].qty, unit: o.unit, hasPrice: o.hasPrice, r: o.ratePaise ?? 0 })),
              ].map((l) => {
                const a = lineAmount(Number(l.q), l.r);
                return (
                  <div key={l.key} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-b border-divider px-3 py-2 last:border-b-0">
                    <span className="text-ink">{l.item}</span>
                    <span className="text-right tabular-nums">
                      {count(l.q)} {l.unit}
                    </span>
                    <span className="text-right tabular-nums">{d.money ? (l.hasPrice ? inrRate(l.r) : "₹0") : "—"}</span>
                    <span className="text-right font-semibold tabular-nums">{d.money ? inr(a + Math.round((a * d.gstPercent) / 100)) : "—"}</span>
                  </div>
                );
              })}
              {d.money ? (
                <div className="border-t border-divider bg-canvas px-3 py-2 text-right text-body">
                  Amount {inr(amount)} · GST {d.gstPercent}% {inr(gst)}
                  {freight ? ` · freight ${inr(freight)}` : ""} · <span className="font-semibold text-ink">total {inr(amount + gst + freight)}</span>
                </div>
              ) : null}
            </div>
            {(() => {
              const unpriced = [...(d.hasPrice ? [] : [d.item]), ...ticked.filter((o) => !o.hasPrice).map((o) => o.item)];
              return unpriced.length ? (
                <Callout tone="warn" className="mb-0 block">
                  <div className="font-semibold text-warn-ink">No price in Raw materials for {unpriced.length === 1 ? unpriced[0] : `${unpriced.length} items`}</div>
                  <div className="text-meta text-body">
                    {unpriced.length === 1 ? "It is" : `${unpriced.join(", ")} are`} ordered at ₹0. Add the price on the item to order it at a rate next time.
                  </div>
                </Callout>
              ) : null;
            })()}
            <Callout tone="brand" className="mb-0 block text-brand-hover">
              On save the PO number is made from the PO series. No approval — it is ready to share with the supplier and receive against.
            </Callout>
          </div>
        )}
      </DialogBody>
      <DialogFooter left={`Step ${page + 1} of ${PAGES.length}`}>
        {page === 0 ? <Button onClick={onClose}>Cancel</Button> : <Button onClick={() => setPage(page - 1)}>← Back</Button>}
        {page < 2 ? (
          <Button variant="primary" onClick={() => check(page) && setPage(page + 1)}>
            Next · {PAGES[page + 1]}
          </Button>
        ) : (
          <Button variant="primary" disabled={pending} onClick={submit}>
            {pending ? "Creating…" : "Create PO"}
          </Button>
        )}
      </DialogFooter>
    </ErpDialog>
  );
}

/** One fact down the record's left side: a small label over the value. */
/**
 * A REQUIREMENT'S RECORD, whole (Nov 2026 design): every fact down the left,
 * so there is no Details tab; on the right the four steps, a Next step card
 * with the one button the requirement is waiting on, its PO, and its history
 * read from what happened. The button is the row's own primary action, so its
 * tick and its reason are the list's; Create PO and the PO number box are
 * started here (`ActionSpec.opens`), from the row, the foot or this card.
 */
function PurchaseFlow({ data, row, screen, start }: PanelProps) {
  const f = data as Flow;
  const ui = useErpUi();
  const [creating, setCreating] = useState(start?.act === "createPo" && !!f.entry?.create && !f.entry.create.why);
  /* Unlinking takes the line off the PO, and the PO with it where it was the only one: the modal says so first. */
  const [unlinking, setUnlinking] = useState(false);
  const poBox = useRef<HTMLInputElement>(null);
  const { pending } = useAct();
  const s = f.summary;
  const next = row.actions?.find((a) => a.primary);
  const press = () => {
    if (!next || next.why) return;
    if (next.id === "createPo" && f.entry?.create) setCreating(true);
    else if (next.id === "linkPo") poBox.current?.focus();
    else ui.act(screen, next, row.id);
  };
  return (
    <div className="grid min-h-full flex-1 grid-cols-[280px_minmax(0,1fr)]">
      <dl className="grid content-start gap-3.5 border-r border-divider bg-canvas px-5 py-5" aria-label="Summary">
        <SumFact l="Quantity">
          <span className="text-lg font-semibold tabular-nums">{s.qty}</span> {s.unit}
        </SumFact>
        <SumFact l="In stock now">{s.inStock}</SumFact>
        <SumFact l="Required by">
          {s.requiredBy ? <span className={cx(s.late && "font-semibold text-danger")}>{s.late ? `${s.requiredBy} · ${s.late}` : s.requiredBy}</span> : <span className="text-muted">—</span>}
        </SumFact>
        <SumFact l="Team">{s.team ?? "—"}</SumFact>
        <SumFact l="Deliver to">{s.deliverTo}</SumFact>
        <SumFact l="Priority">{s.priority ? <StatusBadge value={s.priority} /> : "—"}</SumFact>
        <SumFact l="Purchase method">{s.method}</SumFact>
        <SumFact l="Raised by">{s.raisedBy}</SumFact>
        {s.remarks ? <SumFact l="Remarks"><span className="text-body">{s.remarks}</span></SumFact> : null}
      </dl>
      <div className="grid min-w-0 content-start gap-4 px-6 py-5">
        <Stepper steps={f.steps} step={f.step} label="Purchase flow" />
        {f.step >= 0 && f.step < f.steps.length ? (
          <NextStep title={f.next} sub={f.nextSub} act={next ? { l: next.l, why: next.why || undefined, onPress: press } : null} />
        ) : null}
        {f.facts.length ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
            {f.facts.map((x) => (
              <div key={x.l} className="min-w-0">
                <dt className={labelClass}>{x.l}</dt>
                <dd className="mt-0.5 text-sm break-words text-ink">{x.v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {f.po ? (
          <div className="overflow-hidden rounded-card border border-line">
            <div className="flex items-center justify-between gap-3 border-b border-divider bg-canvas px-4 py-2.5 text-sm">
              <span className="font-medium text-ink">
                Purchase order · <span className="font-mono">{f.po.name}</span>
              </span>
              <a href={f.po.href} className={linkClass("brand", "text-meta")}>
                Open the PO
              </a>
            </div>
            {/* One row of the PO's facts — as many columns as it has, in a panel of known width. */}
            <dl className="grid gap-3 px-4 py-3.5" style={{ gridTemplateColumns: `repeat(${3 + (f.po.rate ? 1 : 0) + (f.po.drums != null ? 1 : 0)}, minmax(0, 1fr))` }}>
              <SumFact l="Supplier">{f.po.vendor}</SumFact>
              {f.po.rate ? <SumFact l="Rate">{`${f.po.rate} · GST ${f.po.gst}`}</SumFact> : null}
              {f.po.drums != null ? <SumFact l="Drums">{String(f.po.drums)}</SumFact> : null}
              <SumFact l="Shared">{f.po.shared ?? <span className="text-muted">Not yet</span>}</SumFact>
              <SumFact l="Received">
                {f.po.received}
                <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-divider">
                  <span className="block h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(2, Math.round(f.po.progress * 100))}%` }} />
                </span>
              </SumFact>
            </dl>
            {f.po.canUnlink ? (
              <div className="flex justify-end border-t border-divider px-4 py-2">
                <Button size="sm" disabled={pending} onClick={() => setUnlinking(true)}>
                  Unlink PO
                </Button>
                {unlinking ? (
                  <ErpImpactDialog
                    kind="erp-requirement-unlink"
                    id={f.id}
                    confirmLabel="Unlink PO"
                    onClose={() => setUnlinking(false)}
                    act={(confirmation) => erpRunAction("requisitions", "unlinkPo", f.id, { [IMPACT_FIELD]: JSON.stringify(confirmation) })}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {f.entry?.link ? <LinkPo key={f.id} id={f.id} inputRef={poBox} focus={start?.act === "linkPo"} /> : null}
        {creating && f.entry?.create ? <CreatePoModal key={f.id} id={f.id} d={f.entry.create} preselect={start?.with} onClose={() => setCreating(false)} /> : null}
        <History items={f.history} />
      </div>
    </div>
  );
}

type PoData = {
  steps: string[];
  step: number;
  status: string;
  money: boolean;
  revision?: number;
  lines: {
    item: string;
    ordered: string;
    expected?: string | null;
    received: string;
    pending: string;
    done: boolean;
    rate: string | null;
    gst: string;
    total: string | null;
    requirement: string;
    flag?: string | null;
    corrections?: { label: string; quantity: string; kind: string; note: string; rate: string | null; total: string | null; rateNote: string | null; cancelled: string | null }[];
  }[];
  totals: { amount: string; gst: string; freight: string; total: string } | null;
  history: { l: string; v: string }[];
  print: string | null;
};

function PurchaseOrder({ data }: PanelProps) {
  const p = data as PoData;
  return (
    /* The record's flow, Next step and history are the record dialog's Purchase layout; this is the PO's lines. */
    <section className="grid min-w-0 gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Lines{p.revision ? ` · Rev ${p.revision}` : ""}</SectionLabel>
        {p.print ? (
          <a href={p.print} className={linkClass("brand", "text-xs")}>
            Print PO
          </a>
        ) : null}
      </div>
      {/* A row per line rather than a seven-column table: the item and what it
          costs on top, the quantities beneath — readable at a panel's width. */}
      <div className="overflow-hidden rounded-control border border-divider text-meta">
        {p.lines.map((l, i) => (
          <div key={i} className={cx("px-3 py-2", i > 0 && "border-t border-divider")}>
            <div className="flex items-baseline justify-between gap-3">
              <a href={l.requirement} className="min-w-0 font-medium break-words text-ink hover:text-brand-hover hover:underline" title="Open its requirement">
                {l.item}
              </a>
              {p.money ? <span className="flex-none font-semibold text-ink tabular-nums">{l.total}</span> : null}
            </div>
            <dl className={cx("mt-1 grid gap-x-3 text-xs", p.money ? "grid-cols-5" : "grid-cols-4")}>
              {[
                ["Ordered", l.expected ? `${l.ordered} → ${l.expected}` : l.ordered, ""],
                ["Received", l.received, l.done ? "text-success" : ""],
                ["Pending", l.done ? "—" : l.pending, ""],
                ...(p.money ? [["Rate", l.rate ?? "—", ""]] : []),
                ["GST", l.gst, ""],
              ].map(([k, v, tone]) => (
                <div key={k} className="min-w-0">
                  <dt className={eyebrowClass}>{k}</dt>
                  <dd className={cx("truncate text-body tabular-nums", tone)} title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            {/* Correction lines made at the gate, under the line they correct; a cancelled one stays, struck through. */}
            {(l.corrections ?? []).map((c) => (
              <div key={c.label} className={cx("mt-2 rounded-control bg-brand-soft px-2 py-1.5 text-xs", c.cancelled && "opacity-70")}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cx("min-w-0 break-words text-ink", c.cancelled && "line-through")}>
                    <span className="font-semibold">{c.label}</span> · Correction: {c.kind} {c.quantity}
                  </span>
                  {p.money && c.total ? <span className={cx("flex-none tabular-nums text-ink", c.cancelled && "line-through")}>{c.total}</span> : null}
                </div>
                <div className="text-muted">
                  {c.note}
                  {p.money && c.rate ? ` · ${c.rate}` : ""}
                </div>
                {c.rateNote ? <div className="text-muted">{c.rateNote}</div> : null}
                {c.cancelled ? <div className="text-muted">{c.cancelled}</div> : null}
              </div>
            ))}
            {l.flag ? <div className="mt-1.5 text-xs font-medium text-warn-ink">Quantity differs from PO · {l.flag}</div> : null}
          </div>
        ))}
        {p.totals ? (
          <div className="border-t border-line bg-canvas px-3 py-2 text-right text-body">
            Amount {p.totals.amount} · GST {p.totals.gst}
            {p.totals.freight !== "₹0" ? ` · freight ${p.totals.freight}` : ""} · <span className="font-semibold text-ink">Total {p.totals.total}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

registerPanel("purchaseFlow", (p) => <PurchaseFlow {...p} />);
registerPanel("purchaseOrder", (p) => <PurchaseOrder {...p} />);
