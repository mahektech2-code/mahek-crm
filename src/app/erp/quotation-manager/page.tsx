import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreen } from "@/lib/erp/registry";
import { quoteManagerOf, quotePurchaseChoices, quoteSheet } from "@/lib/erp/quotes";
import { parseQuoteDate } from "@/lib/erp/engines/quotes";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { QuoteGrid } from "./grid";

/**
 * THE QUOTATION MANAGER. The purchase desk's rate sheet — a row per party per
 * date, a column per thing quoted — kept as a grid in which every row, every
 * column and every cell is edited in place. The period and the party search
 * are in the URL; everything else is the grid's.
 */
export const dynamic = "force-dynamic";

const SCREEN = erpScreen("quoteManager")!;

function monthsBack(today: string, n: number): string {
  const [y, m] = today.split("-").map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}

export default async function ErpQuotationManager({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("quoteManager")) redirect("/erp");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const today = calendarDate(new Date(nowMs()));
  const all = str("from") === "all";
  const from = all ? null : (parseQuoteDate(str("from")) ?? monthsBack(today, 6));
  const to = parseQuoteDate(str("to"));
  const q = str("q").trim().slice(0, 100);
  const [sheet, choices] = await Promise.all([quoteSheet({ from, to, q }), quotePurchaseChoices(ctx)]);

  return (
    <div className="px-6 pt-6 pb-10">
      <QuoteGrid
        title={SCREEN.label}
        sub={SCREEN.sub}
        key={`${from}|${to}|${q}`}
        sheet={sheet}
        choices={choices}
        today={today}
        filter={{ from, to, q, all }}
        sixMonths={monthsBack(today, 6)}
        threeMonths={monthsBack(today, 3)}
        readOnly={!!ctx.viewingAs}
        canReady={quoteManagerOf(ctx)}
        me={ctx.actor.name}
      />
    </div>
  );
}
