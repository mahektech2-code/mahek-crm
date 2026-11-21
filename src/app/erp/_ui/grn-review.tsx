"use client";

import { Callout, Td, Th, Tr } from "@/components/ui/primitives";
import type { GrnReviewModel, ReviewBlock, ReviewRow } from "@/lib/erp/engines/grn-review";
import { LinkButton } from "./look";

/**
 * The navy band every ERP table head wears (`gridHeadClass` in look.tsx), laid over the shared `Th`.
 * `Th` draws its own light heading, and a utility the caller adds does not beat one it already carries,
 * so each is important: the band wins on this table and the shared `Th` stays as it is.
 */
const NAVY_HEAD = "border-ink! bg-ink! py-2.5! text-2xs! font-bold! text-white!";

/* ---------------------------------------------------------------------------
 * THE GOODS RECEIPT, READ BACK BEFORE IT IS SAVED. Read-only: nothing here
 * writes, and a mistake is put right on the step it came from, which each
 * section's Change goes back to. What it says is `grnReview`'s: the same three
 * sections for every way into a receipt.
 *
 * It is drawn the way the order's review is (`CompactReview`): a dark-header
 * table for what is listed, a labelled box for each fact, and an amber notice
 * for what needs reading twice.
 * ------------------------------------------------------------------------- */

export type GrnReviewGoTo = {
  /** Where the items are changed. */
  items?: () => void;
  /** Where the PO is changed; absent when the PO is fixed for this receipt. */
  orders?: () => void;
  /** Where each item's receipt details are changed. */
  lines?: () => void;
  /** Where the delivery is changed. */
  delivery?: () => void;
};

/** A receipt row that is a sentence about the PO, not a figure: drawn as a notice under its item. */
const NOTICE_LABELS = new Set(["Against the PO"]);

function Heading({ title, onChange }: { title: string; onChange?: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="text-sm font-semibold text-ink">{title}</span>
      {onChange ? (
        <LinkButton className="text-meta" onClick={onChange}>
          Change
        </LinkButton>
      ) : null}
    </div>
  );
}

/** A fact in a box, as the order's review draws one: its name above, its value inside. */
function Facts({ rows }: { rows: ReviewRow[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-3">
      {rows.map((r) => (
        <div key={r.label} className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">{r.label}</span>
          <span className="rounded-control border border-line bg-surface px-3 py-2 text-sm break-words whitespace-pre-line text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** One row per item, one column per fact the section lists; the dark header is the table's own. */
function Listing({ blocks, empty }: { blocks: ReviewBlock[]; empty: string }) {
  if (!blocks.length) return <div className="text-meta text-muted">{empty}</div>;
  const cols: string[] = [];
  for (const b of blocks) for (const r of b.rows) if (!cols.includes(r.label)) cols.push(r.label);
  const right = (c: string) => /^(Pending|Quantity)/.test(c);
  return (
    /* A list wider than the dialog scrolls inside its own frame, so nothing is cut off. */
    <div className="max-w-full overflow-x-auto rounded-card border border-line">
      <table className="w-full">
        <thead>
          <tr>
            {cols.map((c) => (
              <Th key={c} align={right(c) ? "right" : "left"} className={NAVY_HEAD}>
                {c}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {blocks.map((b, i) => (
            <Tr key={i}>
              {cols.map((c) => (
                <Td key={c} align={right(c) ? "right" : "left"} className="text-ink tabular-nums">
                  {b.rows.find((r) => r.label === c)?.value ?? "—"}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GrnReview({ model, go }: { model: GrnReviewModel; go?: GrnReviewGoTo }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
      <section className="min-w-0">
        <Heading title="Item received" onChange={go?.items} />
        <Listing blocks={model.items} empty="No item yet." />
      </section>

      <section className="min-w-0">
        <Heading title="Purchase order" onChange={go?.orders} />
        <Listing blocks={model.orders} empty="No purchase order yet." />
      </section>

      <section className="min-w-0">
        <Heading title="Receipt details" onChange={go?.lines} />
        {model.lines.length ? (
          <div className="grid gap-5">
            {model.lines.map((b, i) => {
              const notices = b.rows.filter((r) => NOTICE_LABELS.has(r.label) && r.value !== "—");
              const facts = b.rows.filter((r) => !NOTICE_LABELS.has(r.label));
              return (
                <div key={i} className="grid min-w-0 gap-2.5">
                  <div className="text-sm font-semibold text-ink">{b.title}</div>
                  <Facts rows={facts} />
                  {notices.map((n) => (
                    <Callout key={n.label} tone="warn" className="mb-0 text-sm font-medium text-warn-ink">
                      {n.value}
                    </Callout>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-meta text-muted">No item yet.</div>
        )}
      </section>

      {model.delivery.length ? (
        <section className="min-w-0">
          <Heading title="The delivery" onChange={go?.delivery} />
          <Facts rows={model.delivery} />
        </section>
      ) : null}
    </div>
  );
}
