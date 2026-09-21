"use client";

/* ---------------------------------------------------------------------------
 * A WHOLE SHEET OF PRICES, PASTED.
 *
 * The office keeps these in a spreadsheet, and typing two hundred rates one
 * modal at a time is how a list gets half filled in and published anyway. A
 * paste is two columns — the product as it is spelled, and the price — and
 * the matching is shown BEFORE anything is written: every line that found a
 * SKU, every line that did not, and the count of each.
 *
 * AN UNMATCHED LINE IS SHOWN AND NOT DROPPED. A paste that quietly writes
 * eighteen of twenty rows is a list with two holes in it that nobody knows
 * about until a telecaller quotes from it; the ones that matched nothing are
 * listed with the text that was pasted, so somebody can fix the spelling or
 * add that row by hand.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Badge, Button, Field, Radio, Td, Textarea, Th, Tr } from "@/components/ui/primitives";
import type { PricingOptions } from "@/lib/price-list-views";
import { bulkSetRates } from "@/lib/actions/price-lists";
import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import { money, parseRupees } from "@/lib/format";

type Product = PricingOptions["products"][number];

type Line = {
  raw: string;
  text: string;
  pricePaise: number | null;
  product: Product | null;
};

/** The fold two spellings of one product are compared on. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function BulkRatesModal(props: {
  open: boolean;
  onClose: () => void;
  priceListId: string;
  gstBp: number;
  products: Product[];
}) {
  if (!props.open) return null;
  return <BulkRatesBody key={props.priceListId} {...props} />;
}

function BulkRatesBody({
  onClose,
  priceListId,
  gstBp,
  products,
}: {
  onClose: () => void;
  priceListId: string;
  gstBp: number;
  products: Product[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [text, setText] = React.useState("");
  const [basis, setBasis] = React.useState<"incl" | "ex">("incl");
  const [error, setError] = React.useState<string | null>(null);

  const byName = React.useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of products) map.set(fold(p.name), p);
    return map;
  }, [products]);

  const lines: Line[] = React.useMemo(() => {
    return text
      .split("\n")
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => {
        /* Tab first, because that is what a spreadsheet pastes. A run of two
           or more spaces is the fallback for text copied out of a PDF. */
        const parts = raw.includes("\t") ? raw.split("\t") : raw.split(/\s{2,}|,(?=[^,]*$)/);
        const priceText = (parts.length > 1 ? parts[parts.length - 1] : "").trim();
        const name = parts.slice(0, Math.max(1, parts.length - 1)).join(" ").trim();
        return {
          raw,
          text: name,
          pricePaise: parseRupees(priceText),
          product: byName.get(fold(name)) ?? null,
        };
      });
  }, [text, byName]);

  const matched = lines.filter((l) => l.product && l.pricePaise != null);
  const unmatched = lines.filter((l) => !l.product || l.pricePaise == null);

  async function save() {
    if (!matched.length) {
      setError("Nothing on this paste matched a product in the catalogue.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await run(
        bulkSetRates({
          priceListId,
          rates: matched.map((l) => ({
            productId: l.product!.id,
            ...(basis === "incl"
              ? { rateInclGstPaise: l.pricePaise! }
              : { rateExGstPaise: l.pricePaise! }),
          })),
        }),
      );
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setError(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title="Paste a sheet of prices"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !matched.length}
            title={!matched.length ? "Nothing here matches a product yet." : busy ? "Writing…" : undefined}
            onClick={save}
          >
            {busy ? "Writing…" : `Write ${matched.length} rate${matched.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field
          label="One line a product"
          error={error}
          hint="Product name, then the price — a tab between them, which is what a spreadsheet pastes."
        >
          <Textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Nano Thinner - 20 Liter (Loose)\t2,286\nMahek Universal Thinner - 5 Liter (06 Can/Box)\t748"}
          />
        </Field>

        <div className="flex items-center gap-5">
          <Radio
            name="bulk-basis"
            checked={basis === "incl"}
            onChange={() => setBasis("incl")}
            label="The prices pasted are GST inclusive"
          />
          <Radio
            name="bulk-basis"
            checked={basis === "ex"}
            onChange={() => setBasis("ex")}
            label="They are ex-GST"
          />
        </div>

        {lines.length ? (
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[13px] text-muted">
              <Badge tone="success">{matched.length} matched</Badge>
              {unmatched.length ? <Badge tone="warn">{unmatched.length} not matched</Badge> : null}
            </div>
            <div className="max-h-[260px] overflow-auto rounded-[4px] border border-line">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Pasted</Th>
                    <Th>Matched to</Th>
                    <Th align="right">Ex GST</Th>
                    <Th align="right">Inclusive</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const ex =
                      line.pricePaise == null
                        ? null
                        : basis === "incl"
                          ? exFromIncl(line.pricePaise, gstBp)
                          : line.pricePaise;
                    const incl =
                      line.pricePaise == null
                        ? null
                        : basis === "incl"
                          ? line.pricePaise
                          : inclFromEx(line.pricePaise, gstBp);
                    return (
                      <Tr key={`${line.raw}-${i}`}>
                        <Td className="max-w-[220px] truncate" title={line.raw}>
                          {line.text || line.raw}
                        </Td>
                        <Td className="max-w-[220px] truncate" title={line.product?.name}>
                          {line.product ? (
                            line.product.name
                          ) : (
                            <span className="text-muted">Nothing in the catalogue</span>
                          )}
                        </Td>
                        <Td align="right">{ex == null ? <span className="text-muted">No price read</span> : money(ex)}</Td>
                        <Td align="right">{incl == null ? "—" : money(incl)}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
