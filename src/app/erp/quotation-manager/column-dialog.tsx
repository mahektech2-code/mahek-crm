"use client";

import { useState } from "react";
import type { QuoteColumnKind } from "@/lib/erp/engines/quotes";
import type { SheetColumn } from "@/lib/erp/engines/quote-sheet";
import { Button, cx, Field, Input, Select } from "@/components/ui/primitives";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { Eyebrow, fieldLabelClass } from "../_ui/look";
import { columnName } from "./words";

export type ColumnValues = {
  pack: string;
  name: string;
  brand: string;
  kind: QuoteColumnKind;
  rawMaterialId: string | null;
  at: number;
};

/**
 * ADD OR EDIT A MATERIAL COLUMN: the raw material it is for (what Purchase it
 * puts on the PO line), its three heading lines, whether it holds rates or
 * text, and where it sits — with the heading drawn as it will look. What a
 * rate is per is the raw material's own purchase unit, so it is not asked.
 */
export function ColumnDialog({
  column,
  at,
  columns,
  materials,
  onClose,
  onSave,
  onRemove,
}: {
  column: SheetColumn | null;
  /** Where a new column goes, or where the edited one is now — an index among the shown columns. */
  at: number;
  /** The shown columns, in order — what "Place it" offers. */
  columns: SheetColumn[];
  materials: { id: string; name: string }[];
  onClose: () => void;
  onSave: (v: ColumnValues) => void;
  /** Only with Delete on the Quotation manager. */
  onRemove?: () => void;
}) {
  const [pack, setPack] = useState(column?.pack ?? "");
  const [name, setName] = useState(column?.name ?? "");
  const [brand, setBrand] = useState(column?.brand ?? "");
  const [kind, setKind] = useState<QuoteColumnKind>(column?.kind ?? "rate");
  const [rm, setRm] = useState(column?.rawMaterialId ?? "");
  /* "Place it" names the column it follows; -1 is first. The edited column is not one it can follow. */
  const others = columns.filter((c) => c.id !== column?.id);
  const [after, setAfter] = useState(() => {
    const before = column ? columns.slice(0, at).filter((c) => c.id !== column.id) : columns.slice(0, at);
    return before.length ? before[before.length - 1].id : "";
  });
  const placeAt = after ? others.findIndex((c) => c.id === after) + 1 : 0;
  const save = () => onSave({ pack, name, brand, kind, rawMaterialId: rm || null, at: placeAt });
  const pickMaterial = (id: string) => {
    setRm(id);
    const m = materials.find((x) => x.id === id);
    if (m && !name.trim()) setName(m.name);
  };
  const title = column ? "Edit material" : "Add a material";
  return (
    <ErpDialog onClose={onClose} label={title} width={720} tall={false}>
      <DialogHeader onClose={onClose}>
        <Eyebrow>{column ? "Column" : "New column"}</Eyebrow>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-6">
          <form
            className="grid grid-cols-2 gap-x-4 gap-y-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="col-span-2">
              <Field label="Raw material" optional hintShown hint="Which item in the master this column is for — Purchase it uses it to raise the PO line.">
                <Select value={rm} onChange={(e) => pickMaterial(e.target.value)} className="w-full">
                  <option value="">Not linked</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Pack (top line)" hint="Like 185/180 KGS NET or 200 LITER">
              <Input value={pack} onChange={(e) => setPack(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Material (middle line)" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label="Brand (bottom line)" hint="Mahek">
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Holds">
              <Select value={kind} onChange={(e) => setKind(e.target.value === "text" ? "text" : "rate")} className="w-full">
                <option value="rate">Rates (numbers)</option>
                <option value="text">Text (a broker, a note)</option>
              </Select>
            </Field>
            <div className="col-span-2">
              <Field label="Place it">
                <Select value={after} onChange={(e) => setAfter(e.target.value)} className="w-full">
                  <option value="">First, before {others[0] ? columnName(others[0]) : "every other"}</option>
                  {others.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      After {columnName(c)}
                      {i === others.length - 1 ? " (last)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <button type="submit" className="hidden" />
          </form>
          <div>
            <div className={cx("mb-1", fieldLabelClass)}>Preview</div>
            <div className={cx("rounded-t-control bg-ink px-2.5 pt-2 pb-1.5", kind === "rate" ? "text-right" : "text-left")}>
              <div className={cx("h-4 truncate text-2xs leading-4 font-medium tracking-label text-white/70", "uppercase")}>{pack}</div>
              <div className="text-meta leading-tight font-semibold text-white">{name || <span className="font-normal text-white/60">Untitled</span>}</div>
              <div className="h-4 truncate text-2xs leading-4 text-white/70">{brand}</div>
            </div>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={cx("flex h-8.5 items-center border-x border-b border-divider px-2.5 text-sm text-line-strong", kind === "rate" ? "justify-end" : "justify-start")}
              >
                —
              </div>
            ))}
            <p className="mt-2 text-xs text-muted">Every party row gets an empty cell to type the {kind === "rate" ? "rate" : "text"} into.</p>
          </div>
        </div>
      </DialogBody>
      <DialogFooter
        left={
          onRemove ? (
            <Button variant="danger" onClick={onRemove}>
              Remove column
            </Button>
          ) : column ? undefined : (
            "Edit, move or remove it later from the column's ⋯ menu."
          )
        }
      >
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save}>
          {column ? "Save" : "Add material"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
