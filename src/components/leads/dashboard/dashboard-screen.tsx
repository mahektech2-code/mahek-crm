import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { ScreenHeader } from "@/components/console/parts";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import type { ManagerLeadBlock } from "@/lib/services/lead-dashboard-service";

/* ---------------------------------------------------------------------------
 * §8.2 — the sales manager's seven, drawn.
 *
 * Every figure here is a QUEUE and every tile is a DOOR. That is the whole
 * shape of the screen, and it is what separates it from the funnel screen one
 * tab along: the funnel counts what has happened, and this counts what is
 * sitting still waiting on somebody. A manager opening the workspace in the
 * morning is asking "what is stuck", not "how did we do", and before this
 * there was nowhere in either app that answered the first question — the
 * answer was seven separate screens, opened one at a time, with nothing ever
 * showing the whole of it. Seven visits to find out there was nothing to do is
 * how a manager stops making the trip.
 *
 * **THE TONE COMES OFF THE SERVICE AND IS NOT SECOND-GUESSED HERE.**
 * `lead-dashboard-service.ts` earns each one on the QUESTION rather than on
 * the size of the number, and says so beside every block — "expected in the
 * next seven days" is a plan and is deliberately not drawn as a problem,
 * however large it gets, because a strip that colours a forecast red teaches
 * people to ignore its colours. A second opinion about urgency typed into this
 * file would drift from that one inside a release, and the half that drifts is
 * always the half somebody is reading.
 *
 * **A ZERO IS DRAWN QUIET, and that is not a second opinion — it is the
 * absence of one.** Two of the seven carry a fixed tone, so a book with
 * nothing in negotiation would otherwise print a confident brand-coloured 0
 * beside six live queues, which reads as a figure worth looking at rather than
 * as an empty list. The tab strip beside this already follows the rule in its
 * own words: a count is drawn only where something is waiting. So an empty
 * block loses its colour and says "Nothing waiting" in place of its hint —
 * which is also the answer to "is this screen broken": a zero here is a
 * sentence, never a blank.
 *
 * **The href is workspace-relative and `leadHref` is what resolves it.**
 * Nothing in the funnel's screens spells an app's own segment any more — see
 * `lib/lead-workspace.ts` — so the same seven tiles land a telecaller inside
 * the CRM and a manager inside the Sales Dashboard without either file knowing
 * the other app exists.
 * ------------------------------------------------------------------------- */

/** The tile's skin per tone. Number colour and border only — no new card style. */
const SKIN: Record<ManagerLeadBlock["tone"], { border: string; value: string }> = {
  danger: { border: "border-danger-soft", value: "text-danger" },
  warn: { border: "border-warn-line", value: "text-warn-ink" },
  brand: { border: "border-line", value: "text-ink" },
  muted: { border: "border-line", value: "text-muted" },
};

export function DashboardScreen({
  workspace,
  blocks,
}: {
  workspace: LeadWorkspace;
  blocks: ManagerLeadBlock[];
}) {
  return (
    <>
      <ScreenHeader
        title="Lead dashboard"
        subtitle="Seven queues, each one work that is waiting on somebody. Every figure opens the list behind it — a number nobody can get behind is one they have to take on trust."
      />

      {/*
        One column on a phone and four on a desk. It is a grid rather than the
        console's own MetricRow because these are doors: a row of figures reads
        as one sentence about a day, and a tile somebody is meant to press has
        to look pressable and has to carry a line of prose under it saying what
        pressing it opens.
      */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {blocks.map((block) => {
          const empty = block.count === 0;
          const skin = SKIN[empty ? "muted" : block.tone];
          return (
            <Link
              key={block.id}
              href={leadHref(workspace, block.href)}
              className={cx(
                "block rounded-[6px] border bg-surface px-4 py-3.5 no-underline",
                "hover:border-line-strong hover:no-underline",
                skin.border,
              )}
            >
              <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                {block.label}
              </span>
              <span
                className={cx(
                  "mt-0.5 block text-[22px] leading-7 font-semibold tabular-nums",
                  skin.value,
                )}
              >
                {block.count}
              </span>
              <span className="mt-1 block text-xs leading-[17px] text-pretty text-muted">
                {empty ? "Nothing waiting." : block.hint}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
