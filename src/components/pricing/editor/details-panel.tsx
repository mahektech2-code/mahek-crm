"use client";

/* ---------------------------------------------------------------------------
 * THE HEADER OF THE PAPER — everything printed above the grid, and the two
 * lines printed under the signature.
 *
 * Each field says where it lands on the document, because this is a form for
 * making a document, and "GST basis" means nothing until it says "prints as
 * GST 18% Inclusive in the header line".
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import type { PriceDeliveryBasis, PriceFreightTerm } from "@/db/schema";
import { DELIVERY_BASIS_LABEL, FREIGHT_TERM_HINT, FREIGHT_TERM_LABEL } from "@/lib/price-list-labels";
import { headerLine, type PriceSheet } from "@/lib/price-sheet";
import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import type { PricingOptions } from "@/lib/price-list-views";

const DELIVERY: PriceDeliveryBasis[] = ["for_godown", "for_mumbai", "door_delivery", "ex_factory"];
const FREIGHT: PriceFreightTerm[] = ["paid", "to_pay", "not_stated"];

export function DetailsPanel({
  sheet,
  onChange,
  notes,
  onNotes,
  mode,
  supersedesId,
  onSupersedes,
  lists,
  sourceName,
  errors,
}: {
  sheet: PriceSheet;
  onChange: (next: PriceSheet, label: string) => void;
  notes: string;
  onNotes: (v: string) => void;
  mode: "create" | "update" | "version";
  supersedesId: string;
  onSupersedes: (id: string) => void;
  lists: PricingOptions["lists"];
  sourceName: string | null;
  errors: Record<string, string>;
}) {
  const set = <K extends keyof PriceSheet>(key: K, value: PriceSheet[K], label: string) => onChange({ ...sheet, [key]: value }, label);
  const priced = sheet.rows.some((r) => Object.values(r.cells).some((c) => c.printedPaise != null));

  /** Switching what the paper prints keeps what the shop is CHARGED ex-GST, and reprints every figure. */
  function switchBasis(next: "inclusive" | "exclusive") {
    if (next === sheet.taxBasis) return;
    const rows = sheet.rows.map((r) => ({
      ...r,
      cells: Object.fromEntries(
        Object.entries(r.cells).map(([k, c]) => {
          if (c.printedPaise == null) return [k, c];
          const printed =
            next === "exclusive" ? exFromIncl(c.printedPaise, sheet.gstBp) : inclFromEx(c.printedPaise, sheet.gstBp);
          return [k, { ...c, printedPaise: printed }];
        }),
      ),
    }));
    onChange({ ...sheet, taxBasis: next, rows }, "Changed how GST is printed");
  }

  const published = lists.filter((l) => l.status === "published");

  return (
    <div className="mx-auto grid max-w-[980px] gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-5">
        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink">What it is called</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.name} hint="How the list is found on every screen. Not printed.">
              <Input
                value={sheet.name}
                autoFocus
                placeholder="Odisha To Pay — October 2026"
                invalid={!!errors.name}
                onChange={(e) => set("name", e.target.value, "Renamed")}
              />
            </Field>
            <Field label="Reference number" hint="Printed first in the header line, e.g. PL0105.">
              <Input value={sheet.refNo ?? ""} placeholder="PL0105" onChange={(e) => set("refNo", e.target.value || null, "Changed the reference")} />
            </Field>
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink">When it applies</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Effective from" error={errors.effectiveFrom} hint="Printed as the Effective date, and the day it starts pricing orders.">
              <Input
                type="date"
                value={sheet.effectiveFrom}
                invalid={!!errors.effectiveFrom}
                onChange={(e) => set("effectiveFrom", e.target.value, "Changed the effective date")}
              />
            </Field>
            <Field label="Valid for (days)" hint="Blank uses the configured default. Printed in the terms.">
              <Input
                type="number"
                min={0}
                value={sheet.validityDays ?? ""}
                onChange={(e) => set("validityDays", e.target.value === "" ? null : Math.max(0, Number(e.target.value)), "Changed the validity")}
              />
            </Field>
          </div>
          {mode === "create" ? (
            <div className="mt-4">
              <Field
                label="Replaces a list in force"
                hint="Optional. On publish, that list is dated out the day before this one starts and its customers carry over if this one names none."
              >
                <Select value={supersedesId} onChange={(e) => onSupersedes(e.target.value)} className="w-full">
                  <option value="">Nothing — this is a new list</option>
                  {published.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} (v{l.version})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : mode === "version" ? (
            <p className="mt-3 text-[13px] text-muted">
              This becomes a new version of <span className="font-medium text-body">{sourceName}</span>. Publishing it dates
              that one out the day before this takes effect; until then, nothing changes for anybody.
            </p>
          ) : null}
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink">Tax, delivery and freight</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prices print" hint={priced ? "Switching converts every price, so what the shop is charged ex-GST stays the same." : undefined}>
              <Select value={sheet.taxBasis} onChange={(e) => switchBasis(e.target.value as "inclusive" | "exclusive")} className="w-full">
                <option value="inclusive">GST inclusive — as every list so far</option>
                <option value="exclusive">GST extra</option>
              </Select>
            </Field>
            <Field label="GST rate (%)">
              <Input
                type="number"
                min={0}
                max={50}
                step={0.5}
                value={sheet.gstBp / 100}
                onChange={(e) => set("gstBp", Math.round(Number(e.target.value || 0) * 100), "Changed the GST rate")}
              />
            </Field>
            <Field label="Delivered to">
              <Select
                value={sheet.deliveryBasis ?? ""}
                onChange={(e) => set("deliveryBasis", (e.target.value || null) as PriceDeliveryBasis | null, "Changed the delivery basis")}
                className="w-full"
              >
                <option value="">Not stated</option>
                {DELIVERY.map((d) => (
                  <option key={d} value={d}>
                    {DELIVERY_BASIS_LABEL[d]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Transport" hint={FREIGHT_TERM_HINT[sheet.freightTerm]}>
              <Select value={sheet.freightTerm} onChange={(e) => set("freightTerm", e.target.value as PriceFreightTerm, "Changed who pays transport")} className="w-full">
                {FREIGHT.map((f) => (
                  <option key={f} value={f}>
                    {FREIGHT_TERM_LABEL[f]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink">Who signs it</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Signed by" hint="Printed under “For Mahek Marketing India”.">
              <Input value={sheet.signatory ?? ""} placeholder="Heena Doshi" onChange={(e) => set("signatory", e.target.value || null, "Changed the signatory")} />
            </Field>
            <Field label="Their title">
              <Input value={sheet.signatoryTitle ?? ""} placeholder="Account Team Head" onChange={(e) => set("signatoryTitle", e.target.value || null, "Changed the title")} />
            </Field>
          </div>
        </section>

        <section>
          <Field label="Internal notes" hint="For the office. Never printed.">
            <Textarea rows={3} value={notes} onChange={(e) => onNotes(e.target.value)} placeholder="Why this list exists, who asked for it, what to check next month." />
          </Field>
        </section>
      </div>

      <aside className="space-y-3">
        <div className="rounded-[6px] border border-line bg-canvas p-4">
          <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">The header line will read</div>
          <div className="mt-2 font-mono text-[12px] leading-[18px] break-words text-ink">{headerLine(sheet)}</div>
        </div>
        {sheet.effectiveFrom && sheet.gstBp === 0 ? (
          <Callout tone="warn">GST is set to 0%. Every list Mahek has sent so far charges 18%.</Callout>
        ) : null}
      </aside>
    </div>
  );
}
