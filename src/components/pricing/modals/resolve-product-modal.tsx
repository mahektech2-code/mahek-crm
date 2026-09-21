"use client";

/* ---------------------------------------------------------------------------
 * WHICH SKU THIS CELL MEANT.
 *
 * The parser matches what it can and holds the rest, and this is where a
 * person answers the ones it held. Three things it does that a bare product
 * picker would not:
 *
 *   IT SHOWS WHAT THE PAPER SAID. The raw product text, the pack text and the
 *   price as printed sit above the candidates, because the whole question is
 *   whether "NANO THINR 20L" is our Nano Thinner 20 Litre, and an answer given
 *   without the words in front of you is a guess.
 *
 *   IT FILTERS TO THE PACK SIZE, AND SAYS SO. A grid column IS a pack size, so
 *   the candidates worth reading are that size — with every size one toggle
 *   away, because the parser reads the size off the same paper it read the
 *   name off and can be wrong about both.
 *
 *   IT OFFERS TO DO THE WHOLE ROW. One product across six pack columns is one
 *   decision, not six, and answering it six times is how a reviewer gives up
 *   half way. Remembering the spelling is the other half: `product_aliases` is
 *   what stops next month's list asking the same question.
 *
 * Skipping is a real answer and sits beside the others. A cell that names
 * something we do not sell has to be recordable as exactly that; left
 * unanswered it reads as work outstanding for ever.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Checkbox, Input, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { resolveParseRow } from "@/lib/actions/price-lists";
import { MATCH_STATUS_LABEL, MATCH_STATUS_TONE } from "@/lib/price-list-labels";
import type { ParseRowView, PricingOptions } from "@/lib/price-list-views";
import { money } from "@/lib/format";

type Product = PricingOptions["products"][number];

export function ResolveProductModal({
  open,
  onClose,
  cell,
  products,
}: {
  open: boolean;
  onClose: () => void;
  cell: ParseRowView | null;
  products: Product[];
}) {
  if (!open || !cell) return null;
  return <Body key={cell.id} onClose={onClose} cell={cell} products={products} />;
}

function Body({
  onClose,
  cell,
  products,
}: {
  onClose: () => void;
  cell: ParseRowView;
  products: Product[];
}) {
  const router = useRouter();
  const { run } = useToast();
  const [chosen, setChosen] = React.useState<string | null>(cell.matchedProductId);
  const [query, setQuery] = React.useState("");
  const [everySize, setEverySize] = React.useState(cell.millilitres === null);
  const [applyToRow, setApplyToRow] = React.useState(true);
  const [learnAlias, setLearnAlias] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const candidateIds = new Set(cell.candidates.map((c) => c.productId));

  const searchable = React.useMemo(() => {
    const term = query.trim().toLowerCase();
    return products.filter((p) => {
      if (!everySize && cell.millilitres !== null && p.millilitresPerCan !== cell.millilitres) return false;
      if (!term) return p.active;
      return (
        p.name.toLowerCase().includes(term) ||
        (p.formulationName ?? "").toLowerCase().includes(term) ||
        (p.brandName ?? "").toLowerCase().includes(term)
      );
    });
  }, [products, query, everySize, cell.millilitres]);

  const byId = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  async function save(productId: string | null) {
    setBusy(true);
    try {
      const result = await run(
        resolveParseRow({
          rowId: cell.id,
          productId,
          applyToRow: productId ? applyToRow : false,
          learnAlias: productId ? learnAlias : false,
        }),
      );
      if (result.ok) {
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
      title="Which product is this?"
      width={620}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            title="Record that this cell names nothing we sell."
            onClick={() => void save(null)}
          >
            Skip this cell
          </Button>
          <Button
            variant="primary"
            disabled={busy || !chosen}
            title={chosen ? undefined : "Pick a product first."}
            onClick={() => void save(chosen)}
          >
            {busy ? "Saving…" : "Use this product"}
          </Button>
        </>
      }
    >
      {/* ------------------------------------------------ what the paper said */}
      <div className="mb-4 rounded-[4px] border border-line bg-canvas px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          As the document has it
        </div>
        <div className="mt-1 text-sm font-medium text-ink">{cell.rawProductText}</div>
        <div className="mt-0.5 text-[13px] text-muted">
          {[
            cell.rawPackText,
            cell.rawPriceText,
            cell.rateInclGstPaise !== null ? `${money(cell.rateInclGstPaise)} incl. GST` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "No pack or price was read off this cell."}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Badge tone={MATCH_STATUS_TONE[cell.matchStatus]}>{MATCH_STATUS_LABEL[cell.matchStatus]}</Badge>
          {cell.problem ? <span className="text-[11px] text-muted">{cell.problem}</span> : null}
        </div>
      </div>

      {/* ----------------------------------------------------- the candidates */}
      {cell.candidates.length ? (
        <div className="mb-4">
          <div className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            What the parser thought
          </div>
          <div className="space-y-1.5">
            {cell.candidates.map((candidate) => (
              <label
                key={candidate.productId}
                className={cx(
                  "flex cursor-pointer items-center gap-3 rounded-[4px] border px-3 py-2",
                  chosen === candidate.productId ? "border-brand bg-brand-soft" : "border-line bg-surface",
                )}
              >
                <input
                  type="radio"
                  name="candidate"
                  className="h-[15px] w-[15px] accent-[#6835FB]"
                  checked={chosen === candidate.productId}
                  onChange={() => setChosen(candidate.productId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">
                    {byId.get(candidate.productId)?.name ?? candidate.name}
                  </span>
                  <span className="block text-[11px] text-muted">
                    {byId.get(candidate.productId)?.formulationName ?? "—"}
                  </span>
                </span>
                <span className="flex w-[110px] flex-none items-center gap-2">
                  <span className="block h-1.5 flex-1 overflow-hidden rounded-[3px] bg-divider">
                    <span
                      className="block h-full rounded-[3px] bg-brand"
                      style={{ width: `${Math.round(Math.max(0, Math.min(1, candidate.score)) * 100)}%` }}
                    />
                  </span>
                  <span className="w-8 text-right text-[11px] text-muted">
                    {Math.round(Math.max(0, Math.min(1, candidate.score)) * 100)}%
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- the search */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Or find it yourself
        </div>
        {cell.millilitres !== null ? (
          <Checkbox
            label="Show every pack size"
            checked={everySize}
            onChange={(e) => setEverySize(e.target.checked)}
          />
        ) : null}
      </div>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by SKU, brand or formulation"
      />

      <div className="mt-2 max-h-[220px] overflow-y-auto rounded-[4px] border border-line">
        {searchable.length === 0 ? (
          <div className="px-3 py-6 text-center text-[13px] text-muted">
            {query.trim()
              ? "Nothing in the catalogue matches that."
              : cell.millilitres !== null && !everySize
                ? "No active SKU is sold in that pack size. Show every size to look wider."
                : "No active SKUs to offer."}
          </div>
        ) : (
          searchable.slice(0, 120).map((product) => (
            <label
              key={product.id}
              className={cx(
                "flex cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 last:border-0",
                chosen === product.id ? "bg-brand-soft" : "hover:bg-canvas",
              )}
            >
              <input
                type="radio"
                name="product"
                className="h-[15px] w-[15px] accent-[#6835FB]"
                checked={chosen === product.id}
                onChange={() => setChosen(product.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{product.name}</span>
                <span className="block text-[11px] text-muted">
                  {[product.formulationName, product.packing].filter(Boolean).join(" · ") || "—"}
                </span>
              </span>
              {candidateIds.has(product.id) ? <Badge tone="brand">Suggested</Badge> : null}
              {!product.active ? <Badge tone="muted">Retired</Badge> : null}
            </label>
          ))
        )}
      </div>

      <div className="mt-4 space-y-2 border-t border-divider pt-3">
        <Checkbox
          label="Apply to the whole row (the same product in its other pack sizes)"
          checked={applyToRow}
          onChange={(e) => setApplyToRow(e.target.checked)}
        />
        <Checkbox
          label="Remember this name for next time"
          checked={learnAlias}
          onChange={(e) => setLearnAlias(e.target.checked)}
        />
      </div>
    </Modal>
  );
}
