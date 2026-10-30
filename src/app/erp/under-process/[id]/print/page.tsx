import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { planPrint, planView } from "@/lib/erp/production-plan";
import { categorySpec, PLAN_CATEGORIES, printMarks } from "@/lib/erp/engines/production-plan";
import { erpPlanHref } from "@/lib/erp/trace-links";
import { fdLong, nf } from "@/lib/erp/ui";
import { stamp } from "@/lib/format";
import { cx, Td, Th } from "@/components/ui/primitives";
import { linkClass } from "../../../_ui/look";
import { PrintButton } from "../../../po/[id]/print-button";

/**
 * THE SHEET THE FLOOR IS HANDED — one print of a daily plan, on A5. It is
 * drawn from the print's own snapshot, so reprinting Print 2 tomorrow gives
 * the sheet that was handed out, not today's plan. From the second print of a
 * day, what is new or edited since the print before is underlined and starred,
 * and what was removed is listed once in a box, so the floor knows to stop it.
 */
export const dynamic = "force-dynamic";

export default async function PlanPrint({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await erpContext();
  if (!ctx.screens.has("underProcess")) redirect("/erp");
  const plan = await planView(id);
  if (!plan) notFound();
  const n = Number(typeof sp.n === "string" ? sp.n : plan.prints.length);
  const print = Number.isInteger(n) && n > 0 ? await planPrint(id, n) : null;
  if (!print)
    return (
      <div className="p-6 text-sm text-body">
        This plan has not been printed yet.{" "}
        <a href={erpPlanHref(id)} className={linkClass()}>
          Back to the plan
        </a>
      </div>
    );
  const { rows, removed } = printMarks(print.current.lines, print.previous?.lines ?? null);
  const marked = rows.some((r) => r.mark) || removed.length > 0;

  return (
    <div className="mx-auto grid w-full max-w-[640px] gap-4 p-6">
      <style>{`@page { size: A5 portrait; margin: 8mm 8mm 12mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; } } @media print { body * { visibility: hidden; } .plan-paper, .plan-paper * { visibility: visible; } .plan-paper { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0 !important; box-shadow: none !important; padding: 0 !important; } .plan-paper u { text-decoration-thickness: 1.5px; } } .plan-paper th { background: white !important; color: black !important; border-bottom: 1px solid black !important; }`}</style>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={erpPlanHref(id)} className={linkClass("brand", "text-sm")}>
          ← Back to PLAN-{plan.planNo}
        </a>
        <PrintButton />
      </div>
      <p className="text-meta text-muted print:hidden">
        A5 portrait. Print {print.current.printNo} of {plan.prints.length}
        {print.current.printNo < plan.prints.length ? " — an earlier sheet, exactly as it was handed out." : "."}
      </p>

      <article className="plan-paper grid gap-3 border border-line bg-white p-6 text-meta text-ink shadow-pop">
        <header className="flex items-start justify-between gap-4 border-b-2 border-ink pb-2">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- a print page: the plain image prints where next/image may lazy-load */}
            <img src="/brand/mahek-logo.png" alt="Mahek" className="h-10 w-auto" />
            <div>
              <div className="text-base font-bold">MAHEK – DAILY PRODUCTION PLAN</div>
              <div className="text-body">Mahek Marketing India</div>
            </div>
          </div>
          <div className="text-right leading-5">
            <div>
              Plan <b>PLAN-{plan.planNo}</b>
            </div>
            <div>
              Date <b>{fdLong(plan.planDate)}</b>
            </div>
            <div>Created by {plan.createdBy ?? "—"}</div>
            <div className="mt-1 inline-block border border-ink px-1.5 font-bold">
              PRINT {print.current.printNo} · {stamp(print.current.printedAt)}
            </div>
          </div>
        </header>

        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-ink">
              <Th className="static bg-white px-1 text-ink">Sr.</Th>
              <Th className="static w-[13%] bg-white px-1 text-ink">Category</Th>
              <Th className="static w-[34%] bg-white px-1 text-ink">Product</Th>
              <Th className="static bg-white px-1 text-ink">Size</Th>
              <Th align="right" className="static bg-white px-1 text-ink">
                Qty
              </Th>
              <Th className="static bg-white px-1 text-ink">Unit</Th>
              <Th className="static bg-white px-1 text-ink">Remarks</Th>
            </tr>
          </thead>
          <tbody>
            {PLAN_CATEGORIES.map((c) => {
              const mine = rows.filter((r) => r.category === c.key);
              if (!mine.length) return null;
              return [
                <tr key={`h-${c.key}`} className="bg-canvas">
                  <Td colSpan={7} className="px-1 py-1 text-2xs font-bold">
                    {c.label}
                  </Td>
                </tr>,
                ...mine.map((r) => {
                  const U = ({ children }: { children: React.ReactNode }) => (r.mark ? <u>{children}</u> : <>{children}</>);
                  return (
                    <tr key={r.id} className="border-b border-divider align-top">
                      <Td className={cx("px-1 py-1 tabular-nums", r.mark && "font-bold")}>
                        {r.sr}
                        {r.mark ? "★" : ""}
                      </Td>
                      <Td className="px-1 py-1">
                        <U>{categorySpec(r.category)?.short ?? r.category}</U>
                      </Td>
                      <Td className="px-1 py-1 whitespace-normal">
                        <U>{r.productName}</U>
                      </Td>
                      <Td className="px-1 py-1">
                        <U>{r.size ?? "—"}</U>
                      </Td>
                      <Td align="right" className="px-1 py-1 font-bold tabular-nums">
                        <U>{nf(r.quantity)}</U>
                      </Td>
                      <Td className="px-1 py-1">
                        <U>{r.unit}</U>
                      </Td>
                      <Td className="px-1 py-1 whitespace-normal">
                        <U>{[r.remarks, r.was != null ? `was ${nf(r.was)}` : null].filter(Boolean).join(" · ")}</U>
                      </Td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>

        {removed.length ? (
          <div className="border border-dashed border-ink px-2 py-1.5">
            <b>Removed since Print {print.previous?.printNo}:</b> {removed.map((r) => `${r.productName}${r.size ? " " + r.size : ""} · ${nf(r.quantity)} ${r.unit}`).join("; ")}. Do not make these.
          </div>
        ) : null}

        <footer className="mt-2 flex justify-between gap-4 border-t border-divider pt-1.5 text-2xs text-muted">
          <span>{marked && print.previous ? `★ underlined = new or changed since Print ${print.previous.printNo} (${stamp(print.previous.printedAt)})` : `Printed ${stamp(print.current.printedAt)}`}</span>
        </footer>
      </article>
    </div>
  );
}
