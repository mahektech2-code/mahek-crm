import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { planPrint, planView } from "@/lib/erp/production-plan";
import { PLAN_CATEGORIES, printMarks } from "@/lib/erp/engines/production-plan";
import { erpPlanHref } from "@/lib/erp/trace-links";
import { fdLong, nf } from "@/lib/erp/ui";
import { clock, stampDate } from "@/lib/format";
import { calendarDate } from "@/lib/business-date";
import { Td, Th } from "@/components/ui/primitives";
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
  /* A sheet printed on a later day than the one it plans says so, or it reads as a fresh sheet for that day. */
  const printedLate = calendarDate(new Date(print.current.printedAt)) !== plan.planDate;
  const weekday = WEEKDAYS[new Date(`${plan.planDate}T00:00:00Z`).getUTCDay()] ?? "";
  const factsLine = `PLAN-${plan.planNo} · ${plan.godown ?? "All godowns"} · ${rows.length} ${rows.length === 1 ? "line" : "lines"} · Print ${print.current.printNo}`;
  const printedLine = `Created by ${plan.createdBy ?? "—"} · Printed ${stampDate(print.current.printedAt)}, ${clock(new Date(print.current.printedAt))}`;
  /* Said only when there is something to explain: a star on a reprint. A first print, or a reprint with nothing changed, says nothing. */
  const changeLine = print.previous && marked ? `★ underlined = changed since Print ${print.previous.printNo}` : null;
  const runningHead = `PLAN-${plan.planNo} · ${fdLong(plan.planDate)} · Print ${print.current.printNo}`;

  return (
    <div className="mx-auto grid w-full max-w-[640px] gap-4 p-6">
      <style>{sheetCss({ runningHead, footLines: [factsLine, printedLine] })}</style>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={erpPlanHref(id)} className={linkClass("brand", "text-sm")}>
          ← Back to PLAN-{plan.planNo}
        </a>
        <PrintButton />
      </div>
      <p className="text-meta text-muted print:hidden">
        A5 portrait, margins Default. Print {print.current.printNo} of {plan.prints.length}
        {print.current.printNo < plan.prints.length ? " — an earlier sheet, exactly as it was handed out." : "."}
      </p>

      <article className="pp-paper pp-sheet">
        <header className="pp-hd">
          {/* eslint-disable-next-line @next/next/no-img-element -- a print page: the plain image prints where next/image may lazy-load */}
          <img src="/brand/mahek-logo.png" alt="Mahek" className="pp-logo" />
          <div>
            <div className="pp-ttl">Daily Production Plan</div>
            <div className="pp-co">Mahek Marketing India</div>
          </div>
          <div className="pp-when">
            <div className="pp-date">{fdLong(plan.planDate)}</div>
            <div className="pp-day">{weekday}</div>
          </div>
        </header>

        {printedLate ? <div className="pp-late">Printed on {stampDate(print.current.printedAt)}, not on the plan&apos;s day</div> : null}

        <table className="pp-table">
          <colgroup>
            <col style={{ width: "6%" }} />
            <col style={{ width: "50%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "11%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <Th className="pp-n">#</Th>
              <Th>Product</Th>
              <Th className="pp-r">Qty</Th>
              <Th>Unit</Th>
              <Th>Remarks</Th>
            </tr>
          </thead>
          <tbody>
            {PLAN_CATEGORIES.map((c) => {
              const mine = rows.filter((r) => r.category === c.key);
              if (!mine.length) return null;
              return [
                <tr key={`h-${c.key}`} className="pp-cat">
                  <Td colSpan={5}>
                    {c.label}
                    <span>{categoryTotals(mine)}</span>
                  </Td>
                </tr>,
                ...mine.map((r) => {
                  const U = ({ children }: { children: React.ReactNode }) => (r.mark ? <u>{children}</u> : <>{children}</>);
                  const remark = [r.remarks, r.was != null ? `was ${nf(r.was)}` : null].filter(Boolean).join(" · ");
                  return (
                    <tr key={r.id} className={r.mark ? "pp-chg" : undefined}>
                      <Td className="pp-n">{r.sr}</Td>
                      <Td>
                        {r.mark ? "★ " : ""}
                        <U>{r.productName}</U>
                      </Td>
                      <Td className="pp-qty">
                        <U>{nf(r.quantity)}</U>
                      </Td>
                      <Td>
                        <U>{r.unit}</U>
                      </Td>
                      <Td className="pp-rem">{remark ? <U>{remark}</U> : null}</Td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>

        {removed.length ? (
          <div className="pp-removed">
            <b>Removed since Print {print.previous?.printNo}:</b> {removed.map((r) => `${r.productName} · ${nf(r.quantity)} ${r.unit}`).join("; ")}. Do not make these.
          </div>
        ) : null}

        {changeLine ? <footer className="pp-ft">{changeLine}</footer> : <div className="pp-ft" />}
        {/* On paper this line and the page number sit in the page's own bottom margin, on every page. */}
        <div className="pp-ft2 print:hidden">
          <div>{factsLine}</div>
          <div>{printedLine}</div>
        </div>
      </article>
    </div>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "8 lines · 32 cans", "4 lines · 11 boxes, 6 cans" — what one section of the sheet adds up to. */
function categoryTotals(lines: { quantity: number; unit: string }[]): string {
  const by = new Map<string, number>();
  for (const l of lines) by.set(l.unit.toLowerCase(), (by.get(l.unit.toLowerCase()) ?? 0) + l.quantity);
  const sums = [...by].map(([u, q]) => `${nf(q)} ${u}`).join(", ");
  return `${lines.length} ${lines.length === 1 ? "line" : "lines"}${sums ? ` · ${sums}` : ""}`;
}

/** A CSS string: what is printed in a page-margin box is plain text, so quotes and backslashes are escaped. */
function cssText(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

/**
 * The sheet's own styles. It is paper, so it is drawn in millimetres and
 * points, and it reads in black on white whatever the screen's theme: the
 * section band and the blue are the only colour, and the sheet stays legible
 * when "Background graphics" is off and the band does not print.
 *
 * The page's own margin holds 10 mm on the sides and top and 12 mm at the
 * bottom, where the page number and who printed it repeat on every page; the
 * second page and after carry the plan, date and print at the top. Choose
 * "Default" margins in the print dialog — "None" overrides all of this. A row
 * never splits across pages, and a section heading never ends a page.
 */
function sheetCss({ runningHead, footLines }: { runningHead: string; footLines: string[] }): string {
  const ink = "rgb(20 20 20)";
  /* Everything printed is pure black, and every line at least 1pt: grey text and hairline rules print faint on the floor's printers. Size and weight carry the hierarchy. */
  const rule = "rgb(0 0 0)";
  const soft = "rgb(0 0 0)";
  const faint = "rgb(0 0 0)";
  const hair = "rgb(218 218 218)";
  const band = "rgb(238 240 247)";
  const blue = "rgb(31 47 179)";
  return `
@page { size: A5 portrait; margin: 10mm 10mm 12mm;
  @bottom-left { content: ${footLines.map(cssText).join(' "\\A" ')}; white-space: pre; font: 6.5pt/1.5 sans-serif; color: ${soft}; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 6.5pt sans-serif; color: ${soft}; }
  @top-left { content: ${cssText(runningHead)}; font: 7pt sans-serif; color: ${soft}; } }
@page :first { @top-left { content: none; } }
@media print {
  body * { visibility: hidden; }
  .pp-paper, .pp-paper * { visibility: visible; }
  .pp-paper { position: absolute; inset: 0 auto auto 0; width: 100%; box-shadow: none !important; padding: 0 !important; min-height: 0 !important; }
}
.pp-paper { background: white; color: ${ink}; box-shadow: 0 1px 2px rgb(0 0 0 / .2), 0 10px 28px rgb(0 0 0 / .14); padding: 10mm 10mm 9mm; min-height: 210mm; font-size: 8.4pt; line-height: 1.3; display: flex; flex-direction: column; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pp-hd { display: grid; grid-template-columns: auto 1fr auto; gap: 3mm; align-items: center; padding-bottom: 2.5mm; margin-bottom: 3mm; border-bottom: 2pt solid ${rule}; }
.pp-logo { width: 15mm; height: 15mm; display: block; }
.pp-ttl { font-weight: 700; font-size: 14pt; line-height: 1.1; text-transform: uppercase; }
.pp-co { color: ${soft}; font-size: 8pt; margin-top: 0.6mm; }
.pp-when { text-align: right; }
.pp-date { font-weight: 700; font-size: 12.5pt; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pp-day { color: ${soft}; font-size: 7.8pt; }
.pp-late { font-size: 7pt; font-weight: 700; margin: -1mm 0 2mm; }
html body .pp-sheet .pp-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
html body .pp-sheet .pp-table th { position: static; border-radius: 0 !important; height: auto; line-height: 1.3; white-space: normal; text-align: left; font-size: 6.3pt; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; color: ${soft}; padding: 0 1mm 1.2mm; border-bottom: 1.25pt solid ${rule}; background: white; }
html body .pp-sheet .pp-table td { height: auto; color: ${ink}; font-size: 8.4pt; line-height: 1.3; white-space: normal; padding: 1.6mm 1mm; border-bottom: 1pt solid ${rule}; vertical-align: top; overflow-wrap: anywhere; }
html body .pp-sheet .pp-table tr { break-inside: avoid; }
html body .pp-sheet .pp-table .pp-n { text-align: center; color: ${faint}; font-variant-numeric: tabular-nums; font-size: 7.2pt; }
html body .pp-sheet .pp-table .pp-r { text-align: right; }
html body .pp-sheet .pp-table .pp-qty { text-align: right; font-weight: 600; font-size: 9.8pt; line-height: 1.1; font-variant-numeric: tabular-nums; }
html body .pp-sheet .pp-table .pp-rem { font-size: 7.4pt; }
html body .pp-sheet .pp-table tr.pp-cat td { background: ${band}; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; font-size: 7.4pt; padding: 1.3mm 1.5mm; border-bottom: 1.25pt solid ${rule}; color: ${blue}; }
html body .pp-sheet .pp-table tr.pp-cat { break-after: avoid; }
html body .pp-sheet .pp-table tr.pp-cat span { font-weight: 500; color: ${soft}; margin-left: 2mm; text-transform: none; letter-spacing: 0; }
html body .pp-sheet .pp-table tr.pp-chg u { text-decoration-thickness: 1.5px; }
.pp-removed { margin-top: 3mm; border: 1pt dashed ${rule}; padding: 1.6mm 2mm; font-size: 7.4pt; break-inside: avoid; }
.pp-ft { margin-top: auto; padding-top: 3mm; font-size: 6.6pt; color: ${soft}; }
.pp-ft2 { font-size: 6pt; color: ${faint}; margin-top: 0.6mm; border-top: 1px solid ${hair}; padding-top: 1.5mm; }
`;
}
