"use client";

/* ---------------------------------------------------------------------------
 * ONE SKU'S PRICE ON ONE LIST.
 *
 * The figure is typed in whichever direction the person has it: the PDF prints
 * GST inclusive and the order sheet bills ex-GST, so both boxes are here and
 * the one nobody is typing in shows what the other comes to, muted, live. The
 * stored rate is ex-GST — `price-math.ts` has the whole argument — and this
 * modal is one of the two places a person can state either.
 *
 * A SLAB IS TWO BOUNDS AND NOT A SECOND PRODUCT. Blank on both is a flat price
 * that always applies, which is almost every row.
 *
 * `offered` off is the dash the printed sheet carries: the SKU is listed and
 * not for sale on this list. It is deliberately not the same as having no rate
 * — one says "we do not sell you this" and the other says nobody has priced
 * it — and the grid draws them differently.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Checkbox, Field, Input, MoneyInput } from "@/components/ui/primitives";
import type { PricingOptions, RateRow } from "@/lib/price-list-views";
import { removeRate, setRate } from "@/lib/actions/price-lists";
import { exFromIncl, inclFromEx, perLitrePaise } from "@/lib/engines/price-math";
import { money, parseRupees, rupeesFromPaise } from "@/lib/format";
import { cx } from "@/components/ui/primitives";

type Product = PricingOptions["products"][number];

export function RateModal(props: {
  open: boolean;
  onClose: () => void;
  priceListId: string;
  gstBp: number;
  products: Product[];
  /** The row being edited, or null to add one. */
  rate: RateRow | null;
  /** Pre-picked when the grid was clicked on an empty cell. */
  presetProductId?: string | null;
  readOnly?: boolean;
}) {
  if (!props.open) return null;
  return <RateBody key={props.rate?.id ?? props.presetProductId ?? "new"} {...props} />;
}

function RateBody({
  onClose,
  priceListId,
  gstBp,
  products,
  rate,
  presetProductId,
  readOnly,
}: {
  onClose: () => void;
  priceListId: string;
  gstBp: number;
  products: Product[];
  rate: RateRow | null;
  presetProductId?: string | null;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const [productId, setProductId] = React.useState(rate?.productId ?? presetProductId ?? "");
  const [query, setQuery] = React.useState("");
  /* Which box the person is typing in. The other one is the derived figure,
     and deriving both from one another would fight the keystrokes. */
  const [side, setSide] = React.useState<"incl" | "ex">("incl");
  const [incl, setIncl] = React.useState(rate ? rupeesFromPaise(rate.rateInclGstPaise) : "");
  const [ex, setEx] = React.useState(rate ? rupeesFromPaise(rate.rateExGstPaise) : "");
  const [minCans, setMinCans] = React.useState(rate?.minCans != null ? String(rate.minCans) : "");
  const [maxCans, setMaxCans] = React.useState(rate?.maxCans != null ? String(rate.maxCans) : "");
  const [offered, setOffered] = React.useState(rate?.offered ?? true);

  const chosen = products.find((p) => p.id === productId) ?? null;

  const typedPaise = parseRupees(side === "incl" ? incl : ex);
  const exPaise = typedPaise == null ? null : side === "incl" ? exFromIncl(typedPaise, gstBp) : typedPaise;
  const inclPaise = typedPaise == null ? null : side === "incl" ? typedPaise : inclFromEx(typedPaise, gstBp);
  const perLitre =
    exPaise == null ? null : perLitrePaise(exPaise, chosen?.millilitresPerCan ?? rate?.millilitresPerCan ?? null);

  const hits = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 12);
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.brandName ?? "").toLowerCase().includes(q) ||
          (p.formulationName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [products, query]);

  async function save() {
    const next: Record<string, string> = {};
    if (!productId) next.productId = "Pick a product.";
    if (typedPaise == null || typedPaise <= 0) next.rate = "Type the price.";
    if (minCans && maxCans && Number(minCans) > Number(maxCans)) {
      next.maxCans = "The top of a slab cannot be below its bottom.";
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const r = await run(
        setRate({
          priceListId,
          productId,
          ...(side === "incl" ? { rateInclGstPaise: typedPaise } : { rateExGstPaise: typedPaise }),
          minCans: minCans.trim() ? Number(minCans) : null,
          maxCans: maxCans.trim() ? Number(maxCans) : null,
          offered,
        }),
      );
      if (r.ok) {
        onClose();
        router.refresh();
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!rate) return;
    setBusy(true);
    try {
      const r = await run(removeRate(rate.id));
      if (r.ok) {
        onClose();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={rate ? `Price for ${rate.productName}` : "Add a price"}
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {rate ? (
              <Button variant="danger" disabled={busy} onClick={remove} title={busy ? "Saving…" : "Take this price off the list"}>
                Remove
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={save} title={busy ? "Saving…" : undefined}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3.5">
        {rate || readOnly ? (
          <div>
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Product</span>
            <div className="text-sm text-ink">{chosen?.name ?? rate?.productName ?? "—"}</div>
            {(chosen?.formulationName ?? rate?.formulationName) ? (
              <div className="text-[13px] text-muted">{chosen?.formulationName ?? rate?.formulationName}</div>
            ) : null}
          </div>
        ) : (
          <Field label="Product" error={errors.productId ?? null} hint="Search the catalogue — the formulation is under the name.">
            <>
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Nano Thinner 20 Litre"
              />
              <div className="mt-1.5 max-h-[180px] overflow-y-auto rounded-[4px] border border-line">
                {hits.length ? (
                  hits.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProductId(p.id)}
                      className={cx(
                        "block w-full cursor-pointer border-b border-divider px-3 py-1.5 text-left last:border-0 hover:bg-canvas",
                        p.id === productId ? "bg-brand-soft" : null,
                      )}
                    >
                      <span className="block text-sm text-ink">{p.name}</span>
                      {p.formulationName ? (
                        <span className="block text-[12px] text-muted">{p.formulationName}</span>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-2 text-[13px] text-muted">Nothing in the catalogue matches that.</p>
                )}
              </div>
            </>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="GST inclusive"
            error={side === "incl" ? (errors.rate ?? null) : null}
            hint={side === "ex" && inclPaise != null ? `Works out to ${money(inclPaise)}` : undefined}
          >
            <MoneyInput
              value={side === "incl" ? incl : inclPaise != null ? rupeesFromPaise(inclPaise) : ""}
              readOnly={readOnly}
              onFocus={() => setSide("incl")}
              onChange={(e) => {
                setSide("incl");
                setIncl(e.target.value);
              }}
              placeholder="2,286"
            />
          </Field>
          <Field
            label="Ex GST"
            error={side === "ex" ? (errors.rate ?? null) : null}
            hint={side === "incl" && exPaise != null ? `Works out to ${money(exPaise)}` : undefined}
          >
            <MoneyInput
              value={side === "ex" ? ex : exPaise != null ? rupeesFromPaise(exPaise) : ""}
              readOnly={readOnly}
              onFocus={() => setSide("ex")}
              onChange={(e) => {
                setSide("ex");
                setEx(e.target.value);
              }}
              placeholder="1,937"
            />
          </Field>
        </div>

        {perLitre != null ? (
          <p className="text-[13px] text-muted">{money(perLitre)} a litre, for reading two pack sizes against each other.</p>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="From (cans)" error={errors.minCans ?? null} hint="Blank is a flat price.">
            <Input value={minCans} inputMode="numeric" readOnly={readOnly} onChange={(e) => setMinCans(e.target.value)} />
          </Field>
          <Field label="Up to (cans)" error={errors.maxCans ?? null} hint="Blank is no ceiling.">
            <Input value={maxCans} inputMode="numeric" readOnly={readOnly} onChange={(e) => setMaxCans(e.target.value)} />
          </Field>
        </div>

        <Checkbox
          checked={offered}
          disabled={readOnly}
          onChange={(e) => setOffered(e.target.checked)}
          label="Offered on this list — untick it to print a dash against this pack"
        />
      </div>
    </Modal>
  );
}
