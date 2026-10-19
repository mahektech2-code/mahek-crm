"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Callout, cx, Input, Select, SectionLabel } from "@/components/ui/primitives";
import { ComboBox } from "@/components/ui/combo-box";
import { stamp } from "@/lib/format";
import { inr, inrRate, qty } from "@/lib/erp/ui";
import { erpRunAction } from "@/lib/actions/erp";
import { erpRequirementPoLookup } from "@/lib/actions/erp-requirement-po";
import type { LinkPreview } from "@/lib/erp/screens/requirement-po";
import { registerPanel, type PanelProps } from "../panels";
import { resultError, useAct } from "../use-act";
import { DialogBody, DialogTitle, DialogFooter, DialogHeader, ErpDialog, StepBar } from "../dialog";
import { eyebrowClass, insetClass, labelClass, linkClass } from "../look";
import { Stepper } from "./parts";

/* ---------------------------------------------------------------------------
 * The purchase flow, drawn in the record of a requirement and of a PO:
 *
 *   Requirement → Blind count → Book comparison → Verification →
 *   Purchase method → PO number → Receipt
 *
 * A requirement's record shows its book comparison and verdict, then the PO
 * by the item's purchase rule — and both happen IN the record:
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
};
type Flow = {
  id: string;
  steps: string[];
  step: number;
  stage: string;
  next: string;
  facts: Fact[];
  comparison: { count: string | null; counted: string; book: string; pendingIn: string; pendingOut: string | null; reconciled: string; difference: string; tolerance: string } | null;
  verdict: "passed" | "red" | "waiting" | null;
  po: {
    name: string;
    fromQuotationManager: boolean;
    status: string;
    vendor: string;
    rate: string | null;
    gst: string;
    drums: number | null;
    received: string;
    href: string;
    canUnlink: boolean;
  } | null;
  entry: { held: boolean; link: boolean; create: CreateData | null } | null;
};

const count = (q: string) => (Number.isFinite(Number(q)) && q.trim() ? qty(Number(q)) : q);

function Comparison({ c, verdict }: { c: NonNullable<Flow["comparison"]>; verdict: Flow["verdict"] }) {
  const rows: [string, string, string?][] = [
    ["Physical count", c.counted, "font-semibold text-ink"],
    ["Book — stock ledger", c.book],
    ["+ At the gate, under test or awaiting rate", c.pendingIn],
    ...(c.pendingOut ? ([["− Going out, not yet booked", c.pendingOut]] as [string, string][]) : []),
  ];
  return (
    <div className="grid gap-2">
      <div className="overflow-hidden rounded-control border border-line text-meta">
        <div className="border-b border-divider bg-canvas px-3 py-2 font-medium text-ink">Book comparison{c.count ? ` · ${c.count}` : ""}</div>
        {rows.map(([l, v, tone]) => (
          <div key={l} className="flex justify-between gap-3 border-b border-divider px-3 py-1.5">
            <span className="text-muted">{l}</span>
            <span className={cx("tabular-nums", tone)}>{v}</span>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-b border-divider px-3 py-1.5 font-semibold text-ink">
          <span>Reconciled system quantity</span>
          <span className="tabular-nums">{c.reconciled}</span>
        </div>
        <div className="flex justify-between gap-3 border-b border-divider px-3 py-1.5">
          <span>Difference</span>
          <span className={cx("font-semibold tabular-nums", verdict === "red" ? "text-danger" : "text-success")}>{c.difference}</span>
        </div>
        <div className="flex justify-between gap-3 px-3 py-1.5">
          <span className="text-muted">Allowed difference</span>
          <span className="tabular-nums">{c.tolerance}</span>
        </div>
      </div>
      {verdict === "passed" ? (
        <Callout tone="success" className="mb-0 block">
          <div className="font-semibold text-success">✓ Stock verification passed</div>
          <div className="text-meta text-body">The physical count agrees with the reconciled book within the allowed difference.</div>
        </Callout>
      ) : verdict === "red" ? (
        <Callout tone="danger" className="mb-0 block">
          <div className="font-semibold text-danger">⚑ Red flag — stock differs from the book</div>
          <div className="text-meta text-body">Beyond the allowed difference. Stock control is told and a recount is opened. The purchase carries on.</div>
        </Callout>
      ) : null}
    </div>
  );
}

/** The PO number box: typed, looked up after a pause, linked with one press. Never a pop-up. */
function LinkPo({ id }: { id: string }) {
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
            value={poNo}
            onChange={(e) => setPoNo(e.target.value)}
            placeholder="The PO number the Quotation manager made"
            className="font-mono"
            maxLength={60}
            invalid={!!miss}
          />
          <span className={cx("text-meta", miss ? "text-danger" : "text-muted")}>
            {miss ?? (q && (looking || !hit) ? "Looking it up on the Quotation manager…" : "The vendor, rate and drums are fetched from it — nothing else to fill.")}
          </span>
        </label>
        {hit ? (
          <div className="overflow-hidden rounded-control border border-success-soft">
            <div className="bg-success-soft px-3 py-1.5 text-meta font-medium text-success">✓ Found in the Quotation manager</div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 px-3 py-2.5 text-meta">
              {[
                ["Vendor", hit.vendor],
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

const PAGES = ["Vendor", "Delivery", "Review"] as const;

/** Create PO: three pages over the record. The rate is the item's price and is shown, never asked. */
function CreatePoModal({ id, d, onClose }: { id: string; d: CreateData; onClose: () => void }) {
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
  const { run, pending } = useAct();
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));
  const qty = Number(v.qty);
  const rate = d.ratePaise ?? 0;
  const amount = Number.isFinite(qty) ? Math.round(rate * qty) : 0;
  const gst = Math.round((amount * d.gstPercent) / 100);
  const freight = Math.round((Number(v.freight) || 0) * 100);
  const vendorOk = d.vendors.some((x) => x.name === v.vendor);
  function check(p: number): boolean {
    const e: Record<string, string> = {};
    if (p === 0) {
      if (!vendorOk) e.vendor = "Pick a vendor from the list";
      if (!(qty > 0)) e.qty = "Quantity is required";
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
      () => erpRunAction("requisitions", "createPo", id, v),
      (r) => {
        if (r.ok) onClose();
        else {
          const f = r.fieldErrors ?? [];
          if (f.length) {
            setErrors(Object.fromEntries(f.map((x) => [x.field, x.message])));
            setPage(f.some((x) => x.field === "vendor" || x.field === "qty") ? 0 : 1);
          }
        }
      },
    );
  }
  const err = (k: string) => (errors[k] ? <span className="text-meta text-danger">{errors[k]}</span> : null);
  return (
    <ErpDialog onClose={onClose} label={`Create PO · ${d.item}`} width={680} tall={false}>
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
              <span className={labelClass}>Vendor</span>
              <ComboBox
                label="Vendor"
                value={v.vendor}
                options={d.vendors.map((x) => x.name)}
                onChange={(name) => setV((x) => ({ ...x, vendor: name, terms: termsOf(name) ?? x.terms }))}
                placeholder="Search the vendors"
                emptyHint="No vendor by that name"
              />
              {err("vendor") ?? <span className="text-meta text-muted">{d.defaultVendor ? (v.vendor === d.defaultVendor ? "The item's default vendor." : `The item's default vendor is ${d.defaultVendor}.`) : "The item has no default vendor."}</span>}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className={labelClass}>Item</span>
                <div className="flex h-8.5 items-center rounded-control border border-dashed border-line bg-canvas px-2.5 text-sm text-ink">{d.item}</div>
              </label>
              <label className="grid gap-1">
                <span className={labelClass}>Quantity ({d.unit})</span>
                <Input inputMode="decimal" value={v.qty} onChange={(e) => set("qty", e.target.value)} invalid={!!errors.qty} />
                {err("qty") ?? <span className="text-meta text-muted">From the requirement; change it if the vendor packs differently.</span>}
              </label>
            </div>
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
              <div className="px-3 pb-2.5 text-meta text-muted">The rate is the price on the item in Masters → Raw materials. An item with no price there is ordered at ₹0.</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className={labelClass}>Deliver to</span>
                <Select value={v.deliverTo} onChange={(e) => set("deliverTo", e.target.value)} className="w-full">
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
              <span className={labelClass}>Remarks for the vendor</span>
              <Input value={v.remarks} onChange={(e) => set("remarks", e.target.value)} placeholder="Optional" />
            </label>
          </div>
        ) : (
          <div className="grid gap-3 text-meta">
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-control border border-line px-3 py-2.5">
              {[
                ["Vendor", v.vendor],
                ["Deliver to", `${v.deliverTo}${v.deliveryDate ? ` · by ${v.deliveryDate}` : ""}`],
                ["Payment terms", v.terms],
                ["For", d.reqNo ?? d.item],
              ].map(([l, x]) => (
                <div key={l}>
                  <dt className={eyebrowClass}>{l}</dt>
                  <dd className="text-ink">{x}</dd>
                </div>
              ))}
            </dl>
            <div className="overflow-hidden rounded-control border border-line">
              <div className={cx("grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-b border-divider bg-canvas px-3 py-2", eyebrowClass)}>
                <span>Item</span>
                <span className="text-right">Quantity</span>
                <span className="text-right">Rate</span>
                <span className="text-right">Total</span>
              </div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 py-2">
                <span className="text-ink">{d.item}</span>
                <span className="text-right tabular-nums">
                  {count(v.qty)} {d.unit}
                </span>
                <span className="text-right tabular-nums">{d.money ? (d.hasPrice ? inrRate(rate) : "₹0") : "—"}</span>
                <span className="text-right font-semibold tabular-nums">{d.money ? inr(amount + gst + freight) : "—"}</span>
              </div>
              {d.money ? (
                <div className="border-t border-divider bg-canvas px-3 py-2 text-right text-body">
                  Amount {inr(amount)} · GST {d.gstPercent}% {inr(gst)}
                  {freight ? ` · freight ${inr(freight)}` : ""}
                </div>
              ) : null}
            </div>
            {!d.hasPrice ? (
              <Callout tone="warn" className="mb-0 block">
                <div className="font-semibold text-warn-ink">No price on this item in Raw materials</div>
                <div className="text-meta text-body">The PO is created at ₹0. Add the price on the item to order it at a rate next time.</div>
              </Callout>
            ) : null}
            <Callout tone="brand" className="mb-0 block text-brand-hover">
              On save the PO number is made from the PO series. No approval — it is ready to send to the vendor and receive against.
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

function PurchaseFlow({ data }: PanelProps) {
  const f = data as Flow;
  const [creating, setCreating] = useState(false);
  const { run, pending } = useAct();
  return (
    <section className={cx("grid gap-3", insetClass)}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Purchase flow</SectionLabel>
        <span className="text-xs text-muted">{f.stage}</span>
      </div>
      <Stepper steps={f.steps} step={f.step} label="Purchase flow" />
      {/* Once every step is done there is no next one; the stage above says so. */}
      {f.step < f.steps.length ? (
        <div className={cx("rounded-control px-3 py-2 text-meta", f.step < 0 ? "bg-canvas text-muted" : "bg-brand-soft text-brand-hover")}>
          <span className="font-semibold">Next · </span>
          {f.next}
        </div>
      ) : null}
      {f.comparison ? <Comparison c={f.comparison} verdict={f.verdict} /> : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
        {f.facts.map((x) => (
          <div key={x.l} className="min-w-0">
            <dt className={labelClass}>{x.l}</dt>
            <dd className="mt-0.5 text-sm break-words text-ink">
              {x.href ? (
                <a href={x.href} className={linkClass("brand")}>
                  {x.v}
                </a>
              ) : (
                x.v
              )}
            </dd>
          </div>
        ))}
      </dl>
      {f.po ? (
        <div className="overflow-hidden rounded-control border border-line">
          <div className="flex items-center justify-between gap-3 border-b border-divider bg-canvas px-3 py-2 text-meta">
            <span className="font-medium text-ink">
              Purchase order · <span className="font-mono">{f.po.name}</span>
            </span>
            <a href={f.po.href} className={linkClass("brand", "text-xs")}>
              Open the PO
            </a>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 px-3 py-2.5 text-meta">
            {[
              ["Vendor", f.po.vendor],
              ["Status", f.po.status],
              ...(f.po.rate ? [["Rate", `${f.po.rate} · GST ${f.po.gst}`]] : []),
              ...(f.po.drums != null ? [["Drums", String(f.po.drums)]] : []),
              ["Received", f.po.received],
              ["From", f.po.fromQuotationManager ? "Quotation manager · no approval needed" : "Created on the requirement · no approval needed"],
            ].map(([l, v]) => (
              <div key={l} className="min-w-0">
                <dt className={eyebrowClass}>{l}</dt>
                <dd className="break-words text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          {f.po.canUnlink ? (
            <div className="flex justify-end border-t border-divider px-3 py-2">
              <Button size="sm" disabled={pending} onClick={() => run(() => erpRunAction("requisitions", "unlinkPo", f.id))}>
                Unlink PO
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {f.entry && f.entry.held ? (
        <div className="rounded-control bg-canvas px-3 py-2 text-meta text-muted">The PO comes after the blind count — enter the count first.</div>
      ) : f.entry ? (
        <>
          {f.entry.link ? <LinkPo key={f.id} id={f.id} /> : null}
          {f.entry.create ? (
            <div className="overflow-hidden rounded-control border border-line">
              <div className="border-b border-divider bg-canvas px-3 py-2 text-meta font-medium text-ink">Purchase order · Create PO</div>
              <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-meta">
                <span className="text-body">
                  Direct purchase — <b>no quotation needed</b>.{" "}
                  {f.entry.create.defaultVendor ? <>Default vendor <b>{f.entry.create.defaultVendor}</b>, </> : null}
                  {f.entry.create.money ? (f.entry.create.hasPrice ? <>at the item&apos;s price <b>{f.entry.create.rate}</b>.</> : <><b>no price</b> on the item — ordered at ₹0.</>) : "at the item's price."}
                </span>
                <Button variant="primary" className="shrink-0" disabled={!!f.entry.create.why} title={f.entry.create.why || undefined} onClick={() => setCreating(true)}>
                  Create PO
                </Button>
              </div>
            </div>
          ) : null}
          {creating && f.entry.create ? <CreatePoModal key={f.id} id={f.id} d={f.entry.create} onClose={() => setCreating(false)} /> : null}
        </>
      ) : null}
    </section>
  );
}

type PoData = {
  steps: string[];
  step: number;
  status: string;
  money: boolean;
  lines: { item: string; ordered: string; received: string; pending: string; done: boolean; rate: string | null; gst: string; total: string | null; requirement: string }[];
  totals: { amount: string; gst: string; freight: string; total: string } | null;
  history: { l: string; v: string }[];
  print: string | null;
};

function PurchaseOrder({ data }: PanelProps) {
  const p = data as PoData;
  return (
    <section className={cx("grid gap-3", insetClass)}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Purchase flow</SectionLabel>
        {p.print ? (
          <a href={p.print} className={linkClass("brand", "text-xs")}>
            Open the printable PO
          </a>
        ) : null}
      </div>
      <Stepper steps={p.steps} step={p.step} label="Purchase flow" />
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
            <dl className="mt-1 grid grid-cols-5 gap-x-3 text-xs">
              {[
                ["Ordered", l.ordered, ""],
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
          </div>
        ))}
        {p.totals ? (
          <div className="border-t border-line bg-canvas px-3 py-2 text-right text-body">
            Amount {p.totals.amount} · GST {p.totals.gst}
            {p.totals.freight !== "₹0" ? ` · freight ${p.totals.freight}` : ""} · <span className="font-semibold text-ink">Total {p.totals.total}</span>
          </div>
        ) : null}
      </div>
      <dl className="grid gap-1.5">
        {p.history.map((h) => (
          <div key={h.l} className="flex gap-2 text-meta">
            <dt className="w-28 flex-none text-muted">{h.l}</dt>
            <dd className="min-w-0 text-ink">{h.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

registerPanel("purchaseFlow", (p) => <PurchaseFlow {...p} />);
registerPanel("purchaseOrder", (p) => <PurchaseOrder {...p} />);
