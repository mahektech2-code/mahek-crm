"use client";

import { useMemo, useState } from "react";
import type { OpenRequirement, PurchaseChoices, QuoteOrder } from "@/lib/erp/quotes";
import { QUOTE_STATUS_SHORT, type QuoteStatus } from "@/lib/erp/engines/quotes";
import { poLineFigures, poTotals, quoteRatePaise } from "@/lib/erp/engines/purchase-flow";
import { packNet, packsFor } from "@/lib/erp/engines/quote-panel";
import { Badge, Button, Callout, cx, Field, Input, Select } from "@/components/ui/primitives";
import { cleanWhole } from "@/lib/format";
import { fd, inr, nf } from "@/lib/erp/ui";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { Eyebrow, insetClass } from "../_ui/look";
import { QtyField } from "../_ui/units";
import { MARK_DOT } from "./menus";
import { rateText } from "./words";

/** A requirement as the dialog and the side panel name it: REQ-13 · 1,600 Litre · Mixing & Blending · by 22 Nov. */
export function requirementLine(r: OpenRequirement): string {
  return [r.reqNo ? `REQ-${r.reqNo}` : "Requirement", `${nf(r.qty)} ${r.unit}`, r.department, r.requiredBy ? `by ${fd(r.requiredBy)}` : null].filter(Boolean).join(" · ");
}

/**
 * PURCHASE IT: the drums for one rate, and the purchase order it makes — the
 * requirement it answers (picked for you where one is waiting, or raised with
 * the purchase), how much, where it is delivered and by when, and what the PO
 * comes to at this rate with the GST every Quotation manager PO line carries.
 * The PO number is the server's, new or an open PO of the same supplier's.
 * Editing a purchase already made changes only its drums.
 */
export function PurchaseDialog({
  material,
  party,
  date,
  pack,
  rate,
  status,
  cheapest,
  drums,
  poNo,
  editing,
  materialId,
  choices,
  initialReq,
  today,
  onClose,
  onSave,
}: {
  material: string;
  party: string;
  date: string;
  pack: string;
  rate: string;
  status: QuoteStatus | null;
  /** How many parties' latest rates the column holds, and whether this is the cheapest of them. */
  cheapest: { is: boolean; of: number } | null;
  drums: number | null;
  poNo: string;
  editing: boolean;
  materialId: string | null;
  choices: PurchaseChoices;
  /** The requirement to start on — the side panel's "Purchase it at ₹x" names one. */
  initialReq?: string | null;
  today: string;
  onClose: () => void;
  onSave: (drums: number, order: QuoteOrder | null) => void;
}) {
  const reqs = useMemo(() => choices.openRequirements.filter((r) => r.materialId === materialId), [choices, materialId]);
  const first = reqs.find((r) => r.id === initialReq) ?? reqs[0] ?? null;
  /* The party's open POs from here that do not already carry this material — newest first. A purchase
     defaults to the one made today, so several materials bought from one party in a sitting are one PO.
     Matched by the party's name, as the server finds the vendor; the server checks the vendor again. */
  const joinable = useMemo(() => {
    const who = party.trim().toLowerCase();
    return who ? choices.openPos.filter((p) => p.vendor.trim().toLowerCase() === who && !(materialId && p.materialIds.includes(materialId))) : [];
  }, [choices, party, materialId]);
  const [addTo, setAddTo] = useState(joinable.find((p) => p.date === today)?.poNo ?? "");
  const unit = (materialId && choices.units[materialId]) || "";
  const firstPacks = first ? packsFor(first.qty, first.unit, pack) : null;
  const [d, setD] = useState(drums ? String(drums) : firstPacks ? String(firstPacks) : "");
  const [reqId, setReqId] = useState(first?.id ?? "");
  const [qty, setQty] = useState(first ? String(first.qty) : "");
  const [godown, setGodown] = useState(first?.godown ?? choices.defaultGodown ?? choices.godowns[0] ?? "");
  const [due, setDue] = useState(first?.requiredBy && first.requiredBy > today ? first.requiredBy : today);
  const [tried, setTried] = useState(false);
  const n = Number(d);
  const drumsBad = !d.trim() || !Number.isInteger(n) || n < 1;
  const q = Number(qty);
  const ordering = !editing;
  const noMaterial = ordering && !materialId;
  const qtyBad = ordering && (!qty.trim() || !Number.isFinite(q) || q <= 0);
  const godownBad = ordering && !godown;
  const dueBad = ordering && (!due || due < today);
  const picked = reqs.find((r) => r.id === reqId) ?? null;
  const net = packNet(pack);
  const sameUnit = !!net && net.unit.toLowerCase() === unit.toLowerCase();

  function pickReq(id: string) {
    setReqId(id);
    const r = reqs.find((x) => x.id === id);
    if (r) {
      setQty(String(r.qty));
      setGodown(r.godown);
      if (r.requiredBy && r.requiredBy > today) setDue(r.requiredBy);
      const p = packsFor(r.qty, r.unit, pack);
      if (p && !d.trim()) setD(String(p));
    }
  }
  function save() {
    setTried(true);
    if (drumsBad || noMaterial || qtyBad || godownBad || dueBad) return;
    onSave(
      n,
      ordering
        ? {
            requisitionId: reqId || null,
            qty: q,
            godown,
            deliveryDate: due,
            addTo: addTo || null,
          }
        : null,
    );
  }

  /* The PO's figures, worked out by the purchase order's own engine: the line at this rate, the GST every
     Quotation manager line carries, and — on a new PO — its total rounded to the rupee. */
  const ratePaise = quoteRatePaise(rate);
  const gstBp = Math.round(choices.gstPercent * 100);
  const line = ordering && ratePaise && !qtyBad ? poLineFigures({ quantity: q, ratePaise, gstBp }) : null;
  const totals = line && !addTo ? poTotals([{ quantity: q, ratePaise: ratePaise!, gstBp }], 0) : null;

  const note = editing
    ? "Changing the drums changes the purchase order's line too."
    : `The rate turns orange${picked ? ` and ${picked.reqNo ? `REQ-${picked.reqNo}` : "the requirement"} waits for goods` : "; a requirement is raised with it"}.`;

  return (
    <ErpDialog onClose={onClose} label={editing ? "Edit purchase" : "Purchase it"} width={600} tall={false}>
      <DialogHeader onClose={onClose}>
        <Eyebrow>{editing ? "Edit purchase" : "Purchase it"}</Eyebrow>
        <DialogTitle>
          {material}
          {party ? <span className="font-medium text-muted"> from </span> : null}
          {party}
        </DialogTitle>
      </DialogHeader>
      <div className="flex flex-wrap gap-2 border-b border-divider px-6 py-3">
        <Badge tone={cheapest?.is ? "success" : "neutral"} className="h-6 text-meta">
          {rateText(rate) || "—"}
          {unit ? ` per ${unit}` : ""}
          {cheapest && cheapest.of > 1 ? (cheapest.is ? ` · cheapest of ${cheapest.of}` : ` · ${cheapest.of} parties quoted`) : ""}
        </Badge>
        <Badge className="h-6 text-meta">Quoted {date}</Badge>
        {pack ? <Badge className="h-6 text-meta">{pack}</Badge> : null}
        {status ? (
          <Badge className="h-6 gap-1.5 text-meta">
            <span aria-hidden className={cx("h-2 w-2 rounded-full", MARK_DOT[status])} />
            {QUOTE_STATUS_SHORT[status]}
          </Badge>
        ) : null}
      </div>
      <DialogBody>
        {noMaterial ? (
          <Callout tone="warn" className="mb-0 text-sm">
            This column is not linked to a raw material, so no purchase order can be made for it. Edit the column (its ⋯ menu) and pick the raw material first.
          </Callout>
        ) : null}
        <form
          className="grid grid-cols-2 gap-x-4 gap-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {ordering && !noMaterial ? (
            <div className="col-span-2">
              <Field
                label="For requirement"
                hintShown
                hint={
                  reqs.length
                    ? `${reqs.length === 1 ? "1 requirement is" : `${reqs.length} requirements are`} waiting for this material${first ? " — picked for you" : ""}. Choose "None" if it is a stock buy.`
                    : "Nothing is waiting for this material — a requirement is raised with the purchase."
                }
              >
                <Select value={reqId} onChange={(e) => pickReq(e.target.value)} className="w-full">
                  {reqs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {requirementLine(r)}
                    </option>
                  ))}
                  <option value="">None — raise one with this purchase</option>
                </Select>
              </Field>
            </div>
          ) : null}
          <Field
            label="Number of drums"
            required
            hintShown
            error={tried && drumsBad ? "Enter how many drums, a whole number." : null}
            hint={
              sameUnit && !drumsBad
                ? `≈ ${nf(n * net!.qty)} ${unit} at ${nf(net!.qty)} ${unit} net${picked && n * net!.qty >= picked.qty ? ` — covers ${picked.reqNo ? `REQ-${picked.reqNo}` : "the requirement"}` : ""}`
                : undefined
            }
          >
            <span className="relative block">
              <Input
                autoFocus
                inputMode="numeric"
                value={d}
                onChange={(e) => setD(cleanWhole(e.target.value))}
                invalid={tried && drumsBad}
                placeholder="e.g. 4"
                className="pr-14"
              />
              <span className="pointer-events-none absolute top-0 right-2.5 flex h-8.5 items-center text-meta text-muted">drums</span>
            </span>
          </Field>
          <Field label="PO number" hintShown hint={ordering && joinable.length ? `Or add this line to an open PO of ${party}.` : undefined}>
            {ordering && joinable.length ? (
              <Select value={addTo} onChange={(e) => setAddTo(e.target.value)} className="w-full">
                <option value="">New PO number</option>
                {joinable.map((p) => (
                  <option key={p.poNo} value={p.poNo}>
                    Add to {p.poNo}
                    {p.items.length ? ` · ${p.items.join(", ")}` : ""}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="flex h-8.5 items-center justify-between rounded-control border border-line bg-canvas px-2.5 text-sm text-ink">
                {poNo ? <span className="font-mono">{poNo}</span> : <span>New PO number</span>}
                {!poNo ? <span className="text-xs text-muted">made when you save</span> : null}
              </div>
            )}
          </Field>
          {ordering && !noMaterial ? (
            <>
              <Field label="Quantity" required error={tried && qtyBad ? "Enter the quantity bought." : null}>
                {/* Kept in the item's own unit; typed in any unit of that kind (drums, tonnes). */}
                <QtyField
                  base={unit ?? ""}
                  value={qty}
                  onChange={setQty}
                  error={tried && qtyBad}
                  placeholder="e.g. 800"
                  fallback={
                    <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} invalid={tried && qtyBad} placeholder="e.g. 800" />
                  }
                />
              </Field>
              <Field label="Deliver to" required error={tried && godownBad ? "Pick the godown." : null}>
                <Select value={godown} onChange={(e) => setGodown(e.target.value)} className="w-full">
                  {choices.godowns.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Delivery by" required error={tried && dueBad ? "A delivery date, today or later." : null}>
                <Input type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} invalid={tried && dueBad} />
              </Field>
              <div className={cx("col-span-2 grid gap-1.5 bg-canvas text-meta tabular-nums", insetClass)}>
                {line ? (
                  <>
                    <div className="flex justify-between gap-3 text-body">
                      <span>
                        {nf(q)} {unit} × {rateText(rate)}
                      </span>
                      <span>{inr(line.amountPaise)}</span>
                    </div>
                    <div className="flex justify-between gap-3 text-body">
                      <span>GST {nf(choices.gstPercent)}%</span>
                      <span>{inr(line.gstPaise)}</span>
                    </div>
                    {totals && totals.roundOffPaise ? (
                      <div className="flex justify-between gap-3 text-muted">
                        <span>Round off</span>
                        <span>{inr(totals.roundOffPaise)}</span>
                      </div>
                    ) : null}
                    <div className="flex justify-between gap-3 border-t border-line pt-1.5 text-sm font-semibold text-ink">
                      <span>{addTo ? `This line on ${addTo}` : "PO value"}</span>
                      <span>{inr(totals ? totals.totalPaise : line.totalPaise)}</span>
                    </div>
                  </>
                ) : (
                  <span className="text-muted">
                    {ratePaise ? "Enter the quantity to see what the PO comes to." : `The rate "${rate}" is not a number, so it cannot go on a PO.`}
                  </span>
                )}
              </div>
            </>
          ) : null}
          <button type="submit" className="hidden" />
        </form>
      </DialogBody>
      <DialogFooter left={note}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={noMaterial} title={noMaterial ? "Link the column to a raw material first." : undefined}>
          {editing ? "Save purchase" : "Purchase it"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
