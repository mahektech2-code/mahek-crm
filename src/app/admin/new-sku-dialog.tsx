"use client";

import * as React from "react";
import { Button, Callout, Checkbox, Field, Input, Radio, Select, Textarea, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  canonicalName,
  describeQuantity,
  finishedGoodNameFor,
  newSkuProblems,
  packingLabelFor,
  sizeLabel,
  skuNameFor,
  type NewSkuDraft,
  type PackingKind,
} from "@/lib/catalogue";
import { createSku, type NewSkuInput } from "@/lib/actions/catalogue";
import type { CatalogueData } from "./catalogue-data";

/* ---------------------------------------------------------------------------
 * ADD A SKU, IN FOUR PAGES.
 *
 * A SKU hangs from three levels, and a new product often needs one of them new
 * too — a new pack size is a new finished good, a new label is a new brand
 * line. So the first page is where it sits, each level picked from the list or
 * named fresh; the second how it is packed; the third what it costs and what
 * else it is called; the fourth says all of it back before anything is written.
 *
 * The rules are `newSkuProblems` in `lib/catalogue.ts`, run here on every
 * keystroke and again by `createSku` before it writes — the name and the
 * legacy ID are the two things only the database can check, and the action
 * says so in words.
 * ------------------------------------------------------------------------- */

const NEW = "__new";
const STEPS = ["Where it sits", "Packing", "Costs & codes", "Review"] as const;

/** Which page each field is asked on, so an error lands the person on it. */
const STEP_OF: Partial<Record<keyof NewSkuDraft, number>> = {
  name: 1,
  cansPerBox: 1,
  millilitresPerCan: 1,
  packingCostPaise: 2,
  weightGrams: 2,
  sellingPricePaise: 2,
  externalCode: 2,
  aliases: 2,
};

/** "" → null; anything else → a number, NaN where it is not one. */
function num(v: string): number | null {
  const t = v.trim();
  return t === "" ? null : Number(t);
}
/** Rupees or kilograms typed as decimals → integer hundredths or thousandths. */
function scaled(v: string, by: number): number | null {
  const n = num(v);
  return n == null ? null : Number.isFinite(n) ? Math.round(n * by) : NaN;
}

/** ["brand line", "finished good"] → "The new brand line and finished good". */
function listInWords(items: string[]): string {
  const joined = items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `The new ${joined}`;
}

export function NewSkuDialog({
  open,
  hierarchy,
  onClose,
  onCreated,
}: {
  open: boolean;
  hierarchy: CatalogueData["hierarchy"];
  onClose: () => void;
  onCreated: (sku: { productId: string; name: string }) => void;
}) {
  if (!open) return null;
  return <NewSkuBody hierarchy={hierarchy} onClose={onClose} onCreated={onCreated} />;
}

function NewSkuBody({
  hierarchy,
  onClose,
  onCreated,
}: {
  hierarchy: CatalogueData["hierarchy"];
  onClose: () => void;
  onCreated: (sku: { productId: string; name: string }) => void;
}) {
  const toast = useToast();
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [tried, setTried] = React.useState<Set<number>>(new Set());

  /* Where it sits. */
  const [formulationId, setFormulationId] = React.useState("");
  const [formulationName, setFormulationName] = React.useState("");
  const [brandId, setBrandId] = React.useState("");
  const [brandName, setBrandName] = React.useState("");
  const [goodId, setGoodId] = React.useState("");
  const [goodLitres, setGoodLitres] = React.useState("");
  const [goodName, setGoodName] = React.useState("");
  const [goodNameTouched, setGoodNameTouched] = React.useState(false);

  /* Packing. */
  const [kind, setKind] = React.useState<PackingKind>("box");
  const [cansPerBox, setCansPerBox] = React.useState("6");
  const [canLitres, setCanLitres] = React.useState("");
  const [canLitresTouched, setCanLitresTouched] = React.useState(false);
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);

  /* Costs and codes. */
  const [packingCost, setPackingCost] = React.useState("");
  const [weight, setWeight] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [legacyId, setLegacyId] = React.useState("");
  const [aliasText, setAliasText] = React.useState("");
  const [active, setActive] = React.useState(true);

  const formulations = hierarchy.formulations.filter((f) => f.active);
  const newFormulation = formulationId === NEW;
  const brands = newFormulation ? [] : hierarchy.brands.filter((b) => b.active && b.formulationId === formulationId);
  const newBrand = brandId === NEW || newFormulation;
  const goods = newBrand ? [] : hierarchy.goods.filter((g) => g.active && g.brandId === brandId);
  const newGood = goodId === NEW || newBrand;

  const pickedFormulation = formulations.find((f) => f.id === formulationId);
  const pickedBrand = brands.find((b) => b.id === brandId);
  const pickedGood = goods.find((g) => g.id === goodId);

  const brandLabel = newBrand ? canonicalName(brandName) : (pickedBrand?.name ?? "");
  const goodMl = newGood ? scaled(goodLitres, 1000) : (pickedGood?.millilitres ?? null);
  const suggestedGood = brandLabel && goodMl && goodMl > 0 ? finishedGoodNameFor(brandLabel, goodMl) : "";
  const goodLabel = newGood ? (goodNameTouched ? canonicalName(goodName) : suggestedGood) : (pickedGood?.name ?? "");

  const perBox = kind === "box" ? (num(cansPerBox) ?? NaN) : 1;
  const mlPerCan = canLitresTouched ? scaled(canLitres, 1000) : goodMl;
  const packing = packingLabelFor(kind, Number.isFinite(perBox) ? perBox : 0);
  const suggestedName = goodLabel ? skuNameFor(goodLabel, packing) : "";
  const skuName = nameTouched ? name : suggestedName;

  const aliases = aliasText
    .split(/\n|,/)
    .map((a) => a.trim())
    .filter(Boolean);

  const draft: NewSkuDraft = {
    name: skuName,
    packingKind: kind,
    cansPerBox: perBox,
    millilitresPerCan: mlPerCan ?? NaN,
    packingCostPaise: kind === "loose" ? null : scaled(packingCost, 100),
    weightGrams: scaled(weight, 1000),
    sellingPricePaise: scaled(price, 100),
    externalCode: num(legacyId),
    aliases,
  };
  const problems = newSkuProblems(draft);

  /* Page one is about the levels, which `newSkuProblems` does not see. */
  const placeProblems: Record<string, string> = {};
  if (!formulationId) placeProblems.formulation = "Pick the formulation, or add one.";
  else if (newFormulation && canonicalName(formulationName).length < 2) placeProblems.formulation = "Name the new formulation.";
  if (!newFormulation && !brandId) placeProblems.brand = "Pick the brand line, or add one.";
  else if (newBrand && canonicalName(brandName).length < 2) placeProblems.brand = "Name the new brand line.";
  if (!newBrand && !goodId) placeProblems.good = "Pick the finished good, or add one.";
  else if (newGood && (goodMl == null || !Number.isFinite(goodMl) || goodMl < 1)) placeProblems.good = "Give the new finished good's size in litres.";
  else if (newGood && goodMl != null && goodMl > 250_000) placeProblems.good = "No container here holds more than 250 L.";
  else if (newGood && goodLabel.length < 3) placeProblems.good = "Name the new finished good.";

  function problemsOn(page: number): string[] {
    if (page === 0) return Object.values(placeProblems);
    return (Object.entries(problems) as Array<[keyof NewSkuDraft, string]>)
      .filter(([k]) => (STEP_OF[k] ?? 1) === page)
      .map(([, v]) => v);
  }
  const show = (page: number) => tried.has(page);
  const err = (page: number, msg: string | undefined) => (show(page) ? msg : undefined);

  function next() {
    setTried((t) => new Set(t).add(step));
    if (problemsOn(step).length === 0) setStep(step + 1);
  }

  async function save() {
    setTried(new Set([0, 1, 2]));
    for (let p = 0; p < 3; p++) {
      if (problemsOn(p).length) {
        setStep(p);
        return;
      }
    }
    const input: NewSkuInput = {
      formulation: newFormulation ? { name: formulationName } : { id: formulationId },
      brand: newBrand ? { name: brandName } : { id: brandId },
      good: newGood ? { millilitres: goodMl ?? 0, name: goodLabel } : { id: goodId },
      name: skuName,
      packingKind: kind,
      cansPerBox: perBox,
      millilitresPerCan: mlPerCan ?? 0,
      packingCostPaise: draft.packingCostPaise,
      weightGrams: draft.weightGrams,
      sellingPricePaise: draft.sellingPricePaise,
      externalCode: draft.externalCode,
      aliases,
      active,
    };
    setBusy(true);
    setServerError(null);
    try {
      const r = await createSku(input);
      if (!r.ok) {
        setServerError(r.error);
      } else if (r.data) {
        if (r.message) toast.push(r.message);
        onCreated(r.data);
      }
    } finally {
      setBusy(false);
    }
  }

  const sample = { millilitresPerCan: mlPerCan ?? null, cansPerBox: Number.isFinite(perBox) ? perBox : 1 };

  return (
    <Modal
      open
      onClose={onClose}
      width={780}
      title={
        <span className="block">
          <span className="block">Add a SKU</span>
          <span className="mt-0.5 block text-[13px] font-normal text-muted">
            One orderable product — a finished good in one packing.
          </span>
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={step === 0 ? onClose : () => setStep(step - 1)}>
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>
              Next
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy ? "Adding…" : "Add the SKU"}
            </Button>
          )}
        </>
      }
    >
      <ol className="mb-4 flex gap-1.5">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <button
              type="button"
              disabled={i > step}
              onClick={() => setStep(i)}
              className={cx(
                "w-full border-t-[3px] pt-1.5 text-left text-[12px]",
                i < step ? "cursor-pointer border-brand text-body" : i === step ? "border-brand font-medium text-ink" : "border-line text-muted",
              )}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Formulation"
              hint="The liquid. No customer hears its name."
              error={err(0, placeProblems.formulation)}
            >
              <Select
                value={formulationId}
                onChange={(e) => {
                  setFormulationId(e.target.value);
                  setBrandId(e.target.value === NEW ? NEW : "");
                  setGoodId("");
                }}
              >
                <option value="">Choose one</option>
                {formulations.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
                <option value={NEW}>+ A new formulation…</option>
              </Select>
            </Field>
            {newFormulation ? (
              <Field label="New formulation's name">
                <Input value={formulationName} placeholder="e.g. PU Thinner M18" onChange={(e) => setFormulationName(e.target.value)} />
              </Field>
            ) : (
              <div />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Brand line" hint="What the customer asks for." error={err(0, placeProblems.brand)}>
              <Select
                value={newFormulation ? NEW : brandId}
                disabled={!formulationId || newFormulation}
                onChange={(e) => {
                  setBrandId(e.target.value);
                  setGoodId(e.target.value === NEW ? NEW : "");
                }}
              >
                <option value="">{formulationId ? "Choose one" : "Pick the formulation first"}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                <option value={NEW}>+ A new brand line…</option>
              </Select>
            </Field>
            {newBrand ? (
              <Field label="New brand line's name">
                <Input value={brandName} placeholder="e.g. Mahek PU Thinner M18" onChange={(e) => setBrandName(e.target.value)} />
              </Field>
            ) : (
              <div />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Finished good" hint="The brand line in one size." error={err(0, placeProblems.good)}>
              <Select
                value={newBrand ? NEW : goodId}
                disabled={newBrand || !brandId}
                onChange={(e) => setGoodId(e.target.value)}
              >
                <option value="">{brandId ? "Choose one" : "Pick the brand line first"}</option>
                {goods.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {sizeLabel(g.millilitres)} · {g.skus} SKU{g.skus === 1 ? "" : "s"}
                  </option>
                ))}
                <option value={NEW}>+ A new size…</option>
              </Select>
            </Field>
            {newGood ? (
              <div className="grid grid-cols-[110px_1fr] gap-3">
                <Field label="Size (litres)">
                  <Input type="number" min={0} step="0.1" value={goodLitres} placeholder="5" onChange={(e) => setGoodLitres(e.target.value)} />
                </Field>
                <Field label="Its name" hint={goodNameTouched && suggestedGood ? `Suggested: ${suggestedGood}` : undefined}>
                  <Input
                    value={goodNameTouched ? goodName : suggestedGood}
                    placeholder="Brand - 5 Liter"
                    onChange={(e) => {
                      setGoodNameTouched(true);
                      setGoodName(e.target.value);
                    }}
                  />
                </Field>
              </div>
            ) : (
              <div />
            )}
          </div>

          {newFormulation || newBrand || newGood ? (
            <Callout tone="brand">
              <span className="text-[13px] text-ink">
                {listInWords(
                  [newFormulation && "formulation", newBrand && "brand line", newGood && "finished good"].filter(
                    (x): x is string => !!x,
                  ),
                )}{" "}
                will be added with the SKU, in the same save.
                {newFormulation ? " A new formulation counts as Other in the product mix until it is given a category." : ""}
              </span>
            </Callout>
          ) : null}
          {pickedFormulation && !newFormulation && brands.length === 0 ? (
            <p className="text-[13px] text-muted">{pickedFormulation.name} has no brand line yet — add one.</p>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="grid gap-4">
          <Field label="How it is packed" error={err(1, problems.cansPerBox)}>
            <span className="flex flex-wrap gap-5 pt-1">
              <Radio name="packing" checked={kind === "box"} onChange={() => setKind("box")} label="Cans in a box" />
              <Radio name="packing" checked={kind === "loose"} onChange={() => setKind("loose")} label="Loose — one can, no box" />
              <Radio name="packing" checked={kind === "drum"} onChange={() => setKind("drum")} label="Drum" />
            </span>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Cans per box" hint={kind === "box" ? undefined : "One container."}>
              <Input
                type="number"
                min={2}
                value={kind === "box" ? cansPerBox : "1"}
                disabled={kind !== "box"}
                invalid={show(1) && !!problems.cansPerBox}
                onChange={(e) => setCansPerBox(e.target.value)}
              />
            </Field>
            <Field
              label={kind === "drum" ? "Litres in the drum" : "Litres per can"}
              hint={canLitresTouched || goodMl == null ? undefined : "The finished good's size."}
              error={err(1, problems.millilitresPerCan)}
            >
              <Input
                type="number"
                min={0}
                step="0.1"
                value={canLitresTouched ? canLitres : goodMl ? String(goodMl / 1000) : ""}
                onChange={(e) => {
                  setCanLitresTouched(true);
                  setCanLitres(e.target.value);
                }}
              />
            </Field>
            <div className="pt-5 text-[13px] text-muted">
              {mlPerCan && Number.isFinite(mlPerCan) && kind === "box" && Number.isFinite(perBox)
                ? `Two boxes: ${describeQuantity(perBox * 2, sample)}`
                : kind === "box"
                  ? ""
                  : "Ordered and counted one at a time."}
            </div>
          </div>
          <Field
            label="SKU name"
            hint={
              nameTouched
                ? "The join key every order and bill line matches on. It cannot be changed after it is saved — only given other names."
                : "Suggested from the finished good and the packing. It cannot be changed after it is saved."
            }
            error={err(1, problems.name)}
          >
            <Input
              value={skuName}
              placeholder="Brand - 5 Liter (6 Can/Box)"
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
            />
          </Field>
          {nameTouched && suggestedName && canonicalName(name) !== suggestedName ? (
            <button
              type="button"
              className="-mt-2 w-fit cursor-pointer text-[13px] text-brand hover:underline"
              onClick={() => setNameTouched(false)}
            >
              Use the suggested name: {suggestedName}
            </button>
          ) : null}
        </div>
      ) : null}

      {step === 2 ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Field
              label={kind === "drum" ? "Drum cost (₹)" : "Packing cost (₹)"}
              hint={kind === "loose" ? "A loose can has no box." : "The empty box or drum. Not a selling price."}
              error={err(2, problems.packingCostPaise)}
            >
              <Input
                type="number"
                min={0}
                step="0.01"
                value={kind === "loose" ? "" : packingCost}
                disabled={kind === "loose"}
                onChange={(e) => setPackingCost(e.target.value)}
              />
            </Field>
            <Field
              label={`Weight (kg per ${kind === "box" ? "box" : kind === "drum" ? "drum" : "can"})`}
              hint="Transport, never pricing."
              error={err(2, problems.weightGrams)}
            >
              <Input type="number" min={0} step="0.01" value={weight} onChange={(e) => setWeight(e.target.value)} />
            </Field>
            <Field
              label="Selling price (₹ per can)"
              hint="Leave blank until a price source is confirmed."
              error={err(2, problems.sellingPricePaise)}
            >
              <Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field
              label="Legacy Product ID"
              hint="Only if the old system already sells it under a number."
              error={err(2, problems.externalCode)}
            >
              <Input type="number" min={1} value={legacyId} onChange={(e) => setLegacyId(e.target.value)} />
            </Field>
            <Field
              label="Other names"
              className="col-span-2"
              hint="Spellings an old order or a customer uses — one per line. Never offered on an order form."
              error={err(2, problems.aliases)}
            >
              <Textarea rows={3} value={aliasText} onChange={(e) => setAliasText(e.target.value)} />
            </Field>
          </div>
          <Checkbox
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            label="Offer it on the order form straight away"
          />
        </div>
      ) : null}

      {step === 3 ? (
        <div>
          <div className="rounded-[4px] border border-line">
            {(
              [
                ["Formulation", newFormulation ? `${canonicalName(formulationName)} (new)` : (pickedFormulation?.name ?? "—"), 0],
                ["Brand line", newBrand ? `${brandLabel} (new)` : brandLabel, 0],
                ["Finished good", `${goodLabel}${newGood ? " (new)" : ""}`, 0],
                ["SKU name", canonicalName(skuName), 1],
                [
                  "Packing",
                  `${packing}${mlPerCan ? ` · ${sizeLabel(mlPerCan)} ${kind === "drum" ? "drum" : "per can"}` : ""}${
                    kind === "box" && mlPerCan ? ` · ${sizeLabel(mlPerCan * perBox)} a box` : ""
                  }`,
                  1,
                ],
                [kind === "drum" ? "Drum cost" : "Packing cost", draft.packingCostPaise == null ? "—" : `₹${(draft.packingCostPaise / 100).toFixed(2)}`, 2],
                ["Weight", draft.weightGrams == null ? "—" : `${draft.weightGrams / 1000} kg per ${kind === "box" ? "box" : kind === "drum" ? "drum" : "can"}`, 2],
                ["Selling price", draft.sellingPricePaise == null ? "Not set" : `₹${(draft.sellingPricePaise / 100).toFixed(2)} per can`, 2],
                ["Legacy Product ID", draft.externalCode == null ? "None" : String(draft.externalCode), 2],
                ["Other names", aliases.length ? aliases.join(", ") : "None", 2],
                ["Order form", active ? "Offered straight away" : "Kept off until somebody puts it on", 2],
              ] as Array<[string, string, number]>
            ).map(([label, value, page], i) => (
              <div key={label} className={cx("flex items-baseline gap-4 px-3.5 py-2", i > 0 && "border-t border-divider")}>
                <span className="w-36 shrink-0 text-[12px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
                <span className="flex-1 text-sm break-words text-ink">{value}</span>
                <button type="button" className="cursor-pointer text-[13px] text-brand hover:underline" onClick={() => setStep(page)}>
                  Change
                </button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13px] text-muted">
            The name cannot be edited after this, because order and bill lines match on it. The can or drum the
            factory fills it into is set afterwards in ERP → Products.
          </p>
          {serverError ? (
            <div className="mt-3">
              <Callout tone="warn">
                <span className="text-sm text-ink">{serverError}</span>
              </Callout>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
