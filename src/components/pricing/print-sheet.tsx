/* ---------------------------------------------------------------------------
 * THE PRICE LIST AS PAPER.
 *
 * The office has sent this sheet out for years, and what a customer is handed
 * has to go on looking like it — the letterhead, "PRICE LIST", the reference
 * and effective line, the grid of GST-inclusive figures, the numbered terms
 * and the signature. A screen that reprints it in the house design system
 * would be a different document, and the shop would treat it as one.
 *
 * The address block is taken VERBATIM from the sample the parser was written
 * against, because it is Mahek's own letterhead rather than something for a
 * screen to phrase. The figures are the list's own.
 *
 * IT IS A SERVER COMPONENT. Nothing here changes, so the only client is the
 * button that opens the print dialog, and that button is `print:hidden` —
 * a control drawn on the paper is the one thing a printed price list must not
 * carry.
 * ------------------------------------------------------------------------- */

import Link from "next/link";
import type { PriceListDetail } from "@/lib/price-list-views";
import { DELIVERY_BASIS_LABEL } from "@/lib/price-list-labels";
import { longDate, money } from "@/lib/format";
import { pctLabel } from "@/lib/engines/price-math";
import { PrintButton } from "@/components/pricing/print-button";

const ADDRESS = [
  "Off: Ashok Industrial Estate, Gala No 111, L.B.S. Marg, Bhandup (W), Mumbai-400078",
  "Factory: Pale MIDC, Plot M30, Ambernath, Thane | Email: info@mahekindia.com | Tel: 7208114573",
];

const FOOTER = "www.mahekmarketingindia.com | Mahek Marketing India — Quality Stand First Since 1995";

export function PrintSheet({ detail, backHref }: { detail: PriceListDetail; backHref: string }) {
  const list = detail.list;

  const header = [
    list.refNo ? `Ref. No. ${list.refNo}` : null,
    `Effective: ${longDate(list.effectiveFrom)}`,
    `GST ${pctLabel(list.gstBp)} ${list.taxBasis === "inclusive" ? "Inclusive" : "Extra"}`,
    list.deliveryBasis ? DELIVERY_BASIS_LABEL[list.deliveryBasis] : null,
  ]
    .filter((p): p is string => !!p)
    .join(" | ");

  /* The printed terms are the list's own paragraph, with the discounts said
     underneath in the same words the rest of the product uses — one sentence
     per term, from `discountTermSentence`, never retyped here. */
  const terms = (list.termsText ?? "").trim();

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
        <PrintButton />
      </div>

      <div className="sheet mx-auto max-w-[860px] rounded-[6px] border border-line bg-white p-10 text-[#161616] shadow-[0_8px_24px_rgba(22,22,22,0.08)]">
        <div className="text-center">
          <div className="text-[22px] font-bold tracking-[0.06em]">MAHEK MARKETING INDIA</div>
          {ADDRESS.map((line) => (
            <div key={line} className="text-[11px] text-[#3d4453]">
              {line}
            </div>
          ))}
          <div className="mt-4 text-[16px] font-semibold tracking-[0.18em]">PRICE LIST</div>
          <div className="mt-1 text-[12px] text-[#3d4453]">{header}</div>
        </div>

        <table className="mt-6 w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="border border-[#dde1e8] px-2 py-1.5 text-left font-semibold">Product</th>
              {detail.grid.columns.map((c) => (
                <th key={c.key} className="border border-[#dde1e8] px-2 py-1.5 text-right font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
            {detail.grid.columns.some((c) => c.cansPerBox) ? (
              <tr>
                <th className="border border-[#dde1e8] px-2 py-1 text-left font-normal text-[#6b7385]">
                  Pack size
                </th>
                {detail.grid.columns.map((c) => (
                  <th
                    key={c.key}
                    className="border border-[#dde1e8] px-2 py-1 text-right font-normal text-[#6b7385]"
                  >
                    {c.cansPerBox ? `${String(c.cansPerBox).padStart(2, "0")}/bx` : "—"}
                  </th>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {detail.grid.rows.map((row) => (
              <tr key={row.familyKey}>
                <td className="border border-[#dde1e8] px-2 py-1.5">{row.family}</td>
                {row.cells.map((cell) => (
                  <td key={cell.column.key} className="border border-[#dde1e8] px-2 py-1.5 text-right">
                    {cell.rate && cell.rate.offered ? money(cell.rate.rateInclGstPaise) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {terms || detail.discountTerms.length ? (
          <div className="mt-7">
            <div className="text-[13px] font-semibold tracking-[0.1em]">TERMS &amp; CONDITIONS</div>
            {terms ? (
              <div className="mt-1.5 text-[11.5px] leading-[1.6] whitespace-pre-wrap text-[#3d4453]">
                {terms}
              </div>
            ) : null}
            {detail.discountTerms.length ? (
              <ul className="mt-2 ml-4 list-disc text-[11.5px] leading-[1.6] text-[#3d4453]">
                {detail.discountTerms.map((t) => (
                  <li key={t.id}>{t.sentence}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="mt-8 text-[11.5px] text-[#3d4453]">
          <div>We strive to provide you the best service and look forward to your valuable order.</div>
          <div className="mt-5">For Mahek Marketing India</div>
          {list.signatory ? <div className="mt-6 font-semibold">{list.signatory}</div> : <div className="mt-8" />}
        </div>

        <div className="mt-7 border-t border-[#dde1e8] pt-2 text-center text-[10.5px] text-[#6b7385]">
          {FOOTER}
        </div>
      </div>
    </div>
  );
}
