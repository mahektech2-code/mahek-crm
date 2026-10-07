import Link from "next/link";
import { money } from "@/lib/format";
import type { VisitRow } from "@/lib/services/sales-service";
import { VISIT_OUTCOME_LABEL, label, plural } from "@/components/console/words";
import { cx } from "@/components/ui/primitives";

/**
 * One salesman's visits for the day, under his map.
 *
 * Drawn only when the Live map is focused on one person — Today's cards open
 * it that way — because "where did he go" and "what did he do there" are one
 * question, and answering the second on another screen means two tabs per man.
 *
 * Oldest first, numbered, so the strip reads in the same order as the day the
 * map draws. A row says the time, the shop, what came of it and how long it
 * took; everything else about a visit is on the Visit log, one link away.
 */
export function VisitsStrip({ visits, isToday }: { visits: VisitRow[]; isToday: boolean }) {
  const inOrder = [...visits].reverse();
  const orders = visits.reduce((n, v) => n + Number(v.orderValuePaise || 0), 0);
  const first = visits[0];

  return (
    <section className="flex-none overflow-hidden rounded-[6px] border border-line bg-surface">
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[14px] font-semibold text-ink">
            {isToday ? "Visits today" : "Visits that day"}
          </h2>
          <span className="text-[12px] text-muted">
            {plural(visits.length, "visit")}
            {orders ? ` · ${money(orders)} in orders` : ""}
          </span>
        </div>
        {first ? (
          <Link
            href={`/sales/journeys?tab=visits&salesman=${first.salesmanId}&day=${first.day}`}
            className="text-[12px]"
          >
            Visit log
          </Link>
        ) : null}
      </header>

      {inOrder.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted">No visits recorded.</p>
      ) : (
        <ol className="flex gap-2 overflow-x-auto p-3">
          {inOrder.map((v, i) => (
            <li
              key={v.id}
              className={cx(
                "w-[220px] flex-none rounded-[4px] border px-3 py-2",
                v.verified ? "border-line" : "border-warn/50 bg-warn-soft/40",
              )}
              title={v.verified ? undefined : (v.unverifiedReason ?? "Could not be verified")}
            >
              <div className="flex items-center gap-2 text-[12px] text-muted tabular-nums">
                <span className="flex size-5 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                  {i + 1}
                </span>
                {v.checkInAt ? clock(v.checkInAt) : "—"}
                {v.durationSeconds ? ` · ${Math.max(1, Math.round(v.durationSeconds / 60))} min` : ""}
                {!v.wasPlanned ? <span className="ml-auto text-warn-ink">off plan</span> : null}
              </div>
              <div className="mt-1 truncate text-[13px] font-medium text-ink" title={v.customerName}>
                {v.customerName}
              </div>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-body">{label(VISIT_OUTCOME_LABEL, v.outcome)}</span>
                {Number(v.orderValuePaise) ? (
                  <span className="flex-none font-medium text-ink tabular-nums">
                    {money(v.orderValuePaise)}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** `09:32`, in Asia/Kolkata — the server renders this and the server is UTC. */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
