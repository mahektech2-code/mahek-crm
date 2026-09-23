/* ---------------------------------------------------------------------------
 * THE PRICE LIST AS PAPER, in the browser.
 *
 * The office has sent this sheet out for years, and what a customer is handed
 * has to go on looking like it — the letterhead, "PRICE LIST", the reference
 * and effective line, the grid of figures, the numbered terms and the
 * signature. It is drawn from the same `PriceSheet` the PDF is drawn from
 * (`lib/price-sheet.ts`), so the header line, the pack labels, the printed
 * row names and every figure are the same function's output on both, and the
 * two copies of one list cannot disagree.
 *
 * IT IS A SERVER COMPONENT. Nothing here changes, so the only clients are the
 * buttons, and they are `print:hidden` — a control drawn on the paper is the
 * one thing a printed price list must not carry.
 * ------------------------------------------------------------------------- */

import Link from "next/link";
import { LETTERHEAD, headerLine, printedClauses, printedPrice, type PriceSheet } from "@/lib/price-sheet";
import { PrintButton } from "@/components/pricing/print-button";

export function PrintSheet({ sheet, listId, backHref }: { sheet: PriceSheet; listId: string; backHref: string }) {
  const clauses = printedClauses(sheet);

  return (
    <div className="bg-canvas px-6 py-6 print:bg-white print:p-0">
      <style>{`
        @media print {
          @page { margin: 14mm; }
          body { background: #fff; }
          .sheet { box-shadow: none !important; border: 0 !important; padding: 0 !important; }
        }
      `}</style>

      <div className="mx-auto mb-4 flex max-w-[860px] items-center justify-between gap-3 print:hidden">
        <Link href={backHref} className="text-[13px] text-brand hover:underline">
          ← Back to the list
        </Link>
        <div className="flex items-center gap-2">
          <a
            href={`/api/price-lists/${listId}/pdf?download=1`}
            className="inline-flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
          >
            Download PDF
          </a>
          <PrintButton />
        </div>
      </div>

      <div className="sheet mx-auto max-w-[860px] rounded-[6px] border border-line bg-white p-10 text-[#161616] shadow-[0_8px_24px_rgba(22,22,22,0.08)]">
        <div className="text-center">
          <div className="text-[22px] font-bold tracking-[0.06em]">{LETTERHEAD.company}</div>
          {LETTERHEAD.address.map((line) => (
            <div key={line} className="text-[11px] text-[#3d4453]">
              {line}
            </div>
          ))}
          <div className="mx-auto mt-2 h-[2px] w-full bg-[#b81c1c]" />
          <div className="mt-4 text-[16px] font-semibold tracking-[0.18em]">PRICE LIST</div>
          <div className="mt-1 text-[12px] text-[#3d4453]">{headerLine(sheet)}</div>
        </div>

        <table className="mt-6 w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-[#eef0f4]">
              <th className="border border-[#dde1e8] px-2 py-1.5 text-left font-semibold">Product</th>
              {sheet.columns.map((c) => (
                <th key={c.key} className="border border-[#dde1e8] px-2 py-1.5 text-right font-semibold">
                  {c.sizeLabel}
                </th>
              ))}
            </tr>
            <tr className="bg-[#eef0f4]">
              <th className="border border-[#dde1e8] px-2 py-1 text-left font-normal text-[#6b7385]">Pack Size</th>
              {sheet.columns.map((c) => (
                <th key={c.key} className="border border-[#dde1e8] px-2 py-1 text-right font-normal text-[#6b7385]">
                  {c.packLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, i) => (
              <tr key={row.key} className={i % 2 ? "bg-[#f9fafb]" : undefined}>
                <td className="border border-[#dde1e8] px-2 py-1.5">{row.label}</td>
                {sheet.columns.map((c) => (
                  <td key={c.key} className="border border-[#dde1e8] px-2 py-1.5 text-right tabular-nums">
                    {printedPrice(row.cells[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {clauses.length ? (
          <div className="mt-7">
            <div className="text-[13px] font-semibold tracking-[0.1em]">TERMS &amp; CONDITIONS</div>
            <ol className="mt-1.5 space-y-0.5 text-[11.5px] leading-[1.6] text-[#3d4453]">
              {clauses.map((c, i) => (
                <li key={i}>
                  {i + 1}. {c}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="mt-8 text-[11.5px] text-[#3d4453]">
          <div>{LETTERHEAD.closing}</div>
          <div className="mt-5">{LETTERHEAD.signOff}</div>
          {sheet.signatory ? <div className="mt-6 font-semibold text-[#161616]">{sheet.signatory}</div> : <div className="mt-8" />}
          {sheet.signatoryTitle ? <div>{sheet.signatoryTitle}</div> : null}
        </div>

        <div className="mt-7 border-t border-[#dde1e8] pt-2 text-center text-[10.5px] text-[#6b7385]">{LETTERHEAD.footer}</div>
      </div>
    </div>
  );
}
