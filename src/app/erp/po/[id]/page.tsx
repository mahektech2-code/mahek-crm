import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpLink } from "@/lib/erp/registry";
import { purchaseOrderViews } from "@/lib/erp/screens/purchase-flow";
import { poName, poLineFigures, poTotals } from "@/lib/erp/engines/purchase-flow";
import { fdLong, inr, inrRate, nf } from "@/lib/erp/ui";
import { SectionLabel, Td, Th, Tr } from "@/components/ui/primitives";
import { linkClass } from "../../_ui/look";
import { PrintButton } from "./print-button";
import { calendarDate } from "@/lib/business-date";

/**
 * The PURCHASE ORDER as the vendor receives it — printed, or saved as a PDF
 * from the browser's print dialog. Only an approved PO has one: a PO awaiting
 * approval is not an order anybody may send.
 *
 * THE RATES ARE ON THE PAPER ONLY FOR WHOEVER MAY SEE PURCHASE MONEY. It used
 * to refuse the page outright without that power — so a Production Head who
 * raised a PO from his own requisitions could not print the order he had just
 * made, and read "carries its rates" as the rates being missing. Without the
 * power the same paper prints with the item, the quantity, the vendor and the
 * delivery, and every money column is left off rather than drawn blank.
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
        {poName(p.po)} is {p.po.status.toLowerCase()} — a PO is printed once it is approved.{" "}
        <a href={back} className={linkClass("brand")}>
          Back to the PO
        </a>
      </div>
    );
  const money = ctx.powers.has("viewPurchaseMoney");
  const t = poTotals(p.lines, p.po.freightPaise);
  return (
    <div className="mx-auto grid w-full max-w-[860px] gap-4 p-6">
      <style>{`@media print { body * { visibility: hidden; } .po-paper, .po-paper * { visibility: visible; } .po-paper { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0 !important; } }`}</style>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={back} className={linkClass("brand", "text-sm")}>
          ← Back to {poName(p.po)}
        </a>
        <PrintButton />
      </div>
      {money ? null : (
        <p className="text-meta text-muted print:hidden">Printed without rates — purchase money is not on your account. Accounts print and share the copy with rates.</p>
      )}
      <article className="po-paper grid gap-5 rounded-card border border-line bg-white p-8 text-meta text-ink">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="text-lg font-semibold">Mahek Marketing India</div>
            <div className="text-body">Purchase order</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tracking-tight">{poName(p.po)}</div>
            <div className="text-body">Date {fdLong(p.po.poDate)}</div>
          </div>
        </header>
        <section className="grid grid-cols-2 gap-6">
          <div>
            <SectionLabel>Vendor</SectionLabel>
            <div className="mt-1 font-semibold">{p.supplier}</div>
            {p.supplierPhone ? <div className="text-body">{p.supplierPhone}</div> : null}
            {p.supplierEmail ? <div className="text-body">{p.supplierEmail}</div> : null}
          </div>
          <div>
            <SectionLabel>Deliver to</SectionLabel>
            <div className="mt-1 font-semibold">{p.godown}</div>
            <div className="text-body">By {fdLong(p.po.deliveryDate)}</div>
            <div className="text-body">Payment: {p.po.paymentTerms}</div>
          </div>
        </section>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-ink">
              <Th>#</Th>
              <Th>Item</Th>
              <Th align="right">Quantity</Th>
              {money ? (
                <>
                  <Th align="right">Rate</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">GST</Th>
                  <Th align="right">Total</Th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, i) => {
              const f = poLineFigures(l);
              return (
                <Tr key={l.id}>
                  <Td className="tabular-nums">{i + 1}</Td>
                  <Td className="font-medium whitespace-normal text-ink">{l.item}</Td>
                  <Td align="right" className="tabular-nums">
                    {nf(l.quantity)} {l.unit}
                  </Td>
                  {money ? (
                    <>
                      <Td align="right" className="tabular-nums">{inrRate(l.ratePaise)}</Td>
                      <Td align="right" className="tabular-nums">{inr(f.amountPaise)}</Td>
                      <Td align="right" className="tabular-nums">
                        {l.gstBp / 100}% · {inr(f.gstPaise)}
                      </Td>
                      <Td align="right" className="tabular-nums">{inr(f.totalPaise)}</Td>
                    </>
                  ) : null}
                </Tr>
              );
            })}
          </tbody>
        </table>
        {money ? (
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
        ) : null}
        {p.po.remarks ? (
          <section>
            <SectionLabel>Note</SectionLabel>
            <p className="mt-1 whitespace-pre-wrap">{p.po.remarks}</p>
          </section>
        ) : null}
        <footer className="flex items-end justify-between gap-6 border-t border-divider pt-4 text-body">
          <span>Please quote {poName(p.po)} on your invoice and delivery challan.</span>
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
