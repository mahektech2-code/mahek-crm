import Link from "next/link";
import { Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { shortDate } from "@/lib/format";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import type { AttentionList } from "@/lib/services/lead-dashboard-service";

/* ---------------------------------------------------------------------------
 * §8.2 — "Needs your attention".
 *
 * Six lines, overdue first, each one a lead and the thing that is owed on it.
 * It is the first card on the screen because it is the only one that answers
 * "what do I do now" — the strip below it answers "what is stuck", which is a
 * question about other people, and the focus card beside it answers "what is
 * mine", which is a list rather than a next move.
 *
 * **A ROW IS A DOOR, like every figure on this screen.** It opens the lead's
 * own record rather than the list it came from: the reader has already chosen
 * this one by reading its name, and landing them on a list of forty to find it
 * again is the trip nobody makes twice.
 *
 * **IT SAYS WHAT IT IS SIX OF.** Both totals come from SQL, over the whole
 * scoped book, so "6 of 41 overdue" is a true sentence and the reader knows to
 * open the tab. A capped list that implies it is the whole is the mistake the
 * timeline's filter pills carry a paragraph about.
 *
 * **THE LATENESS IS DRAWN, NOT INFERRED FROM A ZERO.** `overdue` is its own
 * answer on the row — a lead falling today is not a lead nought days late —
 * and the two get different words and different tones, because "today" is work
 * with a day left in it and "nine days past" is work somebody has already
 * failed to do.
 * ------------------------------------------------------------------------- */

/**
 * A fortnight is where a promise stops being late and starts being abandoned.
 *
 * It is a READING AID and not a threshold: nothing is chased, escalated or
 * scored on it — the overdue tab draws the same two tones at the same figure —
 * so it is not `app_settings` material. It exists so the eye can find the
 * worst three rows without reading six numbers.
 */
const LONG_OVERDUE_DAYS = 14;

export function AttentionCard({
  workspace,
  list,
}: {
  workspace: LeadWorkspace;
  list: AttentionList;
}) {
  const { rows, overdueTotal, dueTodayTotal } = list;

  return (
    <div className="rounded-[6px] border border-line bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-divider px-5 py-3.5">
        <div className="min-w-0">
          <div className="text-lg leading-6 font-semibold text-ink">Needs your attention</div>
          <div className="mt-0.5 text-[13px] text-pretty text-muted">
            {overdueTotal + dueTodayTotal === 0
              ? "Nothing is owed on a lead today, and nothing has gone past its day."
              : `${plural(overdueTotal, "lead")} past the day somebody promised, ${dueTodayTotal} due today. The oldest are first.`}
          </div>
        </div>
        <Link
          href={leadHref(workspace, "leads/actions/overdue")}
          className="flex-none text-[13px] whitespace-nowrap"
        >
          All overdue
        </Link>
      </div>

      {rows.length === 0 ? (
        /* A sentence rather than a blank panel. An empty card with a heading
           over it reads as a screen that failed to load, and on this one the
           empty answer is the good news. */
        <div className="px-5 py-8 text-center text-[13px] text-muted">
          Nothing owed today and nothing overdue. Leads with nothing promised at all are their
          own tab — §24 calls that the state worth watching.
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((r) => (
            <li key={r.customerId} className="border-b border-divider last:border-b-0">
              <Link
                href={leadHref(workspace, `leads/${r.customerId}`)}
                className="flex items-baseline justify-between gap-4 px-5 py-2.5 no-underline hover:bg-canvas hover:no-underline"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] text-ink">{r.name}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {/* The ACTION, which is what §24 says a date alone cannot
                        carry. Where nobody wrote one down the row says so: a
                        lead due today with no action named is the most urgent
                        shape on this card, not a gap to leave blank. */}
                    {r.action ?? "No action written down"}
                    {r.ownerName ? ` · ${r.ownerName}` : " · nobody named"}
                  </span>
                </span>
                <span className="flex-none text-right">
                  {r.overdue ? (
                    <Pill tone={r.overdueDays >= LONG_OVERDUE_DAYS ? "danger" : "warn"}>
                      {plural(r.overdueDays, "day")} past
                    </Pill>
                  ) : (
                    <Pill tone="brand">Due today</Pill>
                  )}
                  <span className="mt-0.5 block text-[12px] text-muted">
                    {r.parkedBack
                      ? /* Nobody promised this one — a day arrived. It is on
                           the list because the read brings a park back on its
                           own resume date, and saying which kind of work it is
                           is the difference between a worklist and a pile. */
                        "Back off hold"
                      : `${stageLabel(r.stage)} · ${salesTypeLabel(r.salesType)}`}
                    {r.actionDate ? ` · ${shortDate(r.actionDate)}` : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
