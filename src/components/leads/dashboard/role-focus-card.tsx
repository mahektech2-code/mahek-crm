import Link from "next/link";
import { Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { vantageLabel } from "@/lib/lead-vantage";
import type { LeadAction } from "@/lib/engines/lead-role-action";
import type { RoleFocus } from "@/lib/services/lead-dashboard-service";

/* ---------------------------------------------------------------------------
 * §8.2 — the role focus card, whose CONTENT CHANGES ENTIRELY BY ROLE.
 *
 * Management reads a queue of leads waiting on an approval; the back office
 * reads its operational queue; everybody else reads their own leads with their
 * own action against each. Those are not three cards — they are one list,
 * because the thing that differs between them is the SENTENCE each row
 * carries, and `roleAction` is the one function that decides sentences. Three
 * cards would be three readings of the ladder, and the half that drifts is
 * always the half somebody is reading.
 *
 * **IT BELIEVES `isOnQueueFor` RATHER THAN ASKING AGAIN.** Membership is
 * resolved in `leadsForRole` out of `vantagesFor` and the engine, and nothing
 * here adds a condition — no stage check, no "hide the muted ones", no second
 * opinion about whose work a lead is. A dashboard that narrowed differently
 * from the list's own "For you" column would be telling somebody about work
 * the list does not show them.
 *
 * **THE TONE IS THE ENGINE'S ANSWER AND IS NOT RE-EARNED HERE.** `brand`,
 * `warn` and `danger` get the house pill; `muted` deliberately does not — a
 * pill is the weight this console gives something worth noticing, and
 * "Nothing operational pending" drawn at that weight reads as a task. The list
 * is built of actionable rows, so a muted row cannot arrive; the arm exists so
 * that if one ever does it is drawn as the absence of a task rather than as a
 * fourth colour nobody chose. It is the same mapping the leads list makes, for
 * the same reason, and neither invents a value: several callers elsewhere in
 * this codebase write `warning` where the value is `warn` and are silently
 * drawn as ordinary.
 * ------------------------------------------------------------------------- */

function ActionPill({ action }: { action: LeadAction }) {
  if (action.tone === "muted") {
    return <span className="text-[12px] text-muted">{action.label}</span>;
  }
  return <Pill tone={action.tone}>{action.label}</Pill>;
}

/**
 * What the card is a list OF, in the reader's own words.
 *
 * Named off the vantages that actually put rows on it rather than off the
 * reader's hats: somebody who is a sales manager and the named back office
 * person on two shops is doing two jobs on this card, and a heading naming one
 * of them would make the other two rows look like a mistake. Where the list is
 * empty there is no vantage to name, and the card says the honest thing
 * instead.
 */
function heading(focus: RoleFocus): string {
  if (focus.byVantage.length === 0) return "Your queue";
  if (focus.byVantage.length === 1) return `Yours, as the ${vantageLabel(focus.byVantage[0].vantage).toLowerCase()}`;
  return "Yours, across the jobs you hold";
}

export function RoleFocusCard({
  workspace,
  focus,
}: {
  workspace: LeadWorkspace;
  focus: RoleFocus;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-5 py-3.5">
        <div className="text-lg leading-6 font-semibold text-ink">{heading(focus)}</div>
        <div className="mt-0.5 text-[13px] text-pretty text-muted">
          {focus.total === 0
            ? "Nothing on the book is waiting on you."
            : `${plural(focus.total, "lead")} waiting on you. Each says what it wants.`}
        </div>
        {/* WHICH JOB PUT THEM THERE, where more than one did. Two people are
            being asked for two different things by one reader, and a single
            total says nothing about that. */}
        {focus.byVantage.length > 1 ? (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
            {focus.byVantage.map((v) => (
              <span key={v.vantage}>
                {vantageLabel(v.vantage)} {v.count}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {focus.rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-[13px] text-pretty text-muted">
          {/* Two different emptinesses, and they are not the same news. A book
              with nothing of yours in it is a quiet morning; a reader with no
              job on any lead is somebody whose apps give them the funnel to
              read and no part in it, which is a thing to go and ask about. */}
          {focus.bookTotal === 0
            ? "There are no active leads in your book yet."
            : "None of these leads is waiting on you. The full list says what each one reads as to the people it is waiting on."}
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {focus.rows.map((r) => (
            <li key={r.customerId} className="border-b border-divider last:border-b-0">
              <Link
                href={leadHref(workspace, `leads/${r.customerId}`)}
                className="block px-5 py-2.5 no-underline hover:bg-canvas hover:no-underline"
                title={`As the ${vantageLabel(r.vantage).toLowerCase()}. ${r.action.label}.`}
              >
                <span className="block truncate text-[14px] text-ink">{r.name}</span>
                <span className="mt-1 flex items-baseline gap-2">
                  <ActionPill action={r.action} />
                  <span className="truncate text-[12px] text-muted">
                    {stageLabel(r.stage)} · {salesTypeLabel(r.salesType)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-divider px-5 py-2.5 text-[12px] text-muted">
        <Link href={leadHref(workspace, "leads")} className="text-[12px]">
          Open the full list
        </Link>
        {/* SAYS WHAT IT IS A SLICE OF. Two of the five vantages are held by a
            seat on the row, so "is this mine" is arithmetic per lead and the
            answer is worked out over a page of the book rather than asked of
            the database. A card that did not say so would read as a statement
            about the whole book. */}
        {focus.capped ? (
          <span className="ml-2">
            read off the {focus.scanned} leads promised soonest, of {focus.bookTotal}
          </span>
        ) : null}
      </div>
    </div>
  );
}
