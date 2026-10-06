import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpLink } from "@/lib/erp/registry";
import { purchaseOrderViews } from "@/lib/erp/screens/purchase-flow";
import { poLabel, poLineFigures, poTotals } from "@/lib/erp/engines/purchase-flow";
import { fdLong, inr, inrRate, nf } from "@/lib/erp/ui";
import { PrintButton } from "./print-button";
import { calendarDate } from "@/lib/business-date";

/**
 * The PURCHASE ORDER as the vendor receives it — printed, or saved as a PDF
 * from the browser's print dialog. Only an approved PO has one: a PO awaiting
 * approval is not an order anybody may send. Rates are on the paper because
 * the paper goes to the vendor, so it needs the purchase-money power to open.
 */
export default async function PurchaseOrderPrint({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await erpContext();
  if (!ctx.screens.has("purchaseOrders")) redirect("/erp");
  const [p] = await purchaseOrderViews({ ids: [id] });
  if (!p) notFound();
  const back = erpLink("purchaseOrders", { open: p.po.id });
  if (!p.po.approvedAt || p.po.status === "Rejected" || p.po.status === "Pending approval")
    return (
      <div className="p-6 text-sm text-body">
        {poLabel(p.po.poNumber)} is {p.po.status.toLowerCase()} — a PO is printed once it is approved.{" "}
        <a href={back} className="text-[#5223E0] underline">
          Back to the PO
        </a>
      </div>
    );
  if (!ctx.powers.has("viewPurchaseMoney"))
    return (
      <div className="p-6 text-sm text-body">
        The printed PO carries its rates, and purchase money is not on your account.{" "}
        <a href={back} className="text-[#5223E0] underline">
          Back to the PO
        </a>
      </div>
    );
  const t = poTotals(p.lines, p.po.freightPaise);
  return (
    <div className="mx-auto grid w-full max-w-[860px] gap-4 p-6">
      <style>{`@media print { body * { visibility: hidden; } .po-paper, .po-paper * { visibility: visible; } .po-paper { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0 !important; } }`}</style>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={back} className="text-sm text-[#5223E0] hover:underline">
          ← Back to {poLabel(p.po.poNumber)}
        </a>
        <PrintButton />
      </div>
      <article className="po-paper grid gap-5 rounded-[6px] border border-line bg-white p-8 text-[13px] text-ink">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="text-lg font-semibold">Mahek Marketing India</div>
            <div className="text-body">Purchase order</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tracking-tight">{poLabel(p.po.poNumber)}</div>
            <div className="text-body">Date {fdLong(p.po.poDate)}</div>
          </div>
        </header>
        <section className="grid grid-cols-2 gap-6">
          <div>
            <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Vendor</div>
            <div className="mt-1 font-semibold">{p.supplier}</div>
            {p.supplierPhone ? <div className="text-body">{p.supplierPhone}</div> : null}
            {p.supplierEmail ? <div className="text-body">{p.supplierEmail}</div> : null}
          </div>
          <div>
            <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Deliver to</div>
            <div className="mt-1 font-semibold">{p.godown}</div>
            <div className="text-body">By {fdLong(p.po.deliveryDate)}</div>
            <div className="text-body">Payment: {p.po.paymentTerms}</div>
          </div>
        </section>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-ink text-left text-xs uppercase">
              <th className="py-2 pr-2 font-medium">#</th>
              <th className="py-2 pr-2 font-medium">Item</th>
              <th className="py-2 pr-2 text-right font-medium">Quantity</th>
              <th className="py-2 pr-2 text-right font-medium">Rate</th>
              <th className="py-2 pr-2 text-right font-medium">Amount</th>
              <th className="py-2 pr-2 text-right font-medium">GST</th>
              <th className="py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, i) => {
              const f = poLineFigures(l);
              return (
                <tr key={l.id} className="border-b border-divider">
                  <td className="py-2 pr-2">{i + 1}</td>
                  <td className="py-2 pr-2 font-medium">{l.item}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {nf(l.quantity)} {l.unit}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{inrRate(l.ratePaise)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{inr(f.amountPaise)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {l.gstBp / 100}% · {inr(f.gstPaise)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{inr(f.totalPaise)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <section className="ml-auto grid w-72 gap-1 tabular-nums">
          <div className="flex justify-between">
            <span className="text-body">Amount</span>
            <span>{inr(t.amountPaise)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-body">GST</span>
            <span>{inr(t.gstPaise)}</span>
          </div>
          {t.freightPaise ? (
            <div className="flex justify-between">
              <span className="text-body">Freight</span>
              <span>{inr(t.freightPaise)}</span>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-ink pt-1 text-base font-semibold">
            <span>Total</span>
            <span>{inr(t.totalPaise)}</span>
          </div>
        </section>
        {p.po.remarks ? (
          <section>
            <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Note</div>
            <p className="mt-1 whitespace-pre-wrap">{p.po.remarks}</p>
          </section>
        ) : null}
        <footer className="flex items-end justify-between gap-6 border-t border-divider pt-4 text-body">
          <span>Please quote {poLabel(p.po.poNumber)} on your invoice and delivery challan.</span>
          <span className="text-right">
            Approved{p.approver ? ` by ${p.approver}` : ""}
            <br />
            {p.po.approvedAt ? fdLong(calendarDate(p.po.approvedAt)) : ""}
          </span>
        </footer>
      </article>
    </div>
  );
}
