import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { ScreenHeader } from "@/components/console/parts";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import type { LeadTileId } from "@/lib/lead-views";
import type { SharedFunnel } from "@/lib/engines/lead-funnel-shape";
import type {
  AttentionList,
  ManagerLeadBlock,
  RoleFocus,
} from "@/lib/services/lead-dashboard-service";
import { SharedBarFunnel } from "../funnel/shared-bar-funnel";
import { AttentionCard } from "./attention-card";
import { BookTiles } from "./book-tiles";
import { RoleFocusCard } from "./role-focus-card";

/* ---------------------------------------------------------------------------
 * §8.2 — the lead dashboard, drawn.
 *
 * FIVE ANSWERS IN THE ORDER SOMEBODY READS THEM. What is owed on a lead
 * today; what is waiting on the reader personally; the nine cuts of their own
 * book; for the two vantages that run a book rather than work one, the seven
 * queues across the whole funnel; and the shape of the pipeline. The personal
 * half is first deliberately — a manager opening this screen is still a person
 * with six calls owed, and a strip of team figures above their own work is how
 * a dashboard becomes a report.
 *
 * Every figure in the first four is a QUEUE and every tile is a DOOR. That is
 * most of the shape of the screen, and it is what separated it from the funnel
 * screen one tab along: the funnel counts what has happened, and these count
 * what is sitting still waiting on somebody. A manager opening the workspace
 * in the morning is asking "what is stuck", not "how did we do", and before
 * this there was nowhere in either app that answered the first question — the
 * answer was seven separate screens, opened one at a time, with nothing ever
 * showing the whole of it. Seven visits to find out there was nothing to do is
 * how a manager stops making the trip.
 *
 * **AND THEN THE SHAPE, which is the one thing here that is NOT a queue.** A
 * manager who only ever reads queues is told what is stuck and never where —
 * a book bunched on `sample_review` and a book bunched on `negotiation` are
 * two different problems and produce identical worklists. The funnel was built
 * and good and lived behind a sidebar row somebody had to know existed, so the
 * workspace's own home screen had no route to it at all. It is drawn last,
 * under the queues, because it is the question you ask once a week and they
 * are the ones you ask every morning.
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
 * `lib/lead-workspace.ts` — so the same tiles land a telecaller inside the CRM
 * and a manager inside the Sales Dashboard without either file knowing the
 * other app exists. NOTHING HERE BRANCHES ON THE WORKSPACE: what differs
 * between the two apps is where a link points, never what the screen says.
 * ------------------------------------------------------------------------- */

/** The tile's skin per tone. Number colour and border only — no new card style. */
const SKIN: Record<ManagerLeadBlock["tone"], { border: string; value: string }> = {
  danger: { border: "border-danger-soft", value: "text-danger" },
  warn: { border: "border-warn-line", value: "text-warn-ink" },
  brand: { border: "border-line", value: "text-ink" },
  muted: { border: "border-line", value: "text-muted" },
};

function ManagerStrip({
  workspace,
  blocks,
}: {
  workspace: LeadWorkspace;
  blocks: ManagerLeadBlock[];
}) {
  return (
    <div className="mt-6">
      <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Across the funnel
      </div>
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
    </div>
  );
}

export function DashboardScreen({
  workspace,
  blocks,
  attention,
  focus,
  tiles,
  pipeline,
}: {
  workspace: LeadWorkspace;
  /** Empty for anybody who is neither a sales manager nor management. */
  blocks: ManagerLeadBlock[];
  attention: AttentionList;
  focus: RoleFocus;
  /**
   * §8.2's nine, counted over the whole scoped book. Null where the reader was
   * not granted All Leads — every one of the nine is a door into it, and a
   * strip of nine counts off a screen somebody is refused is nine links that
   * bounce them off `requireModule`, which reads as a broken page rather than
   * as a grant they were never given.
   */
  tiles: Record<LeadTileId, number> | null;
  /** §8.3a's funnel. Null where Funnel & conversion was not granted, for the
      same reason and by the same rule. */
  pipeline: SharedFunnel | null;
}) {
  return (
    <>
      <ScreenHeader
        title="Lead dashboard"
        subtitle="What is owed today, what is waiting on you, and what is stuck across the funnel. Every figure opens the list behind it — a number nobody can get behind is one they have to take on trust."
      />

      {/*
        Two thirds and one third, and the focus card is the RIGHT RAIL the
        specification asks for. It stacks on a phone with the attention card
        first, because the order on a narrow screen is the order of urgency
        rather than the order of the columns.
      */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AttentionCard workspace={workspace} list={attention} />
        </div>
        <RoleFocusCard workspace={workspace} focus={focus} />
      </div>

      {/*
        THE NINE, UNDER THE READER'S OWN WORK AND ABOVE THE TEAM'S.

        They are cuts of a book rather than queues waiting on a decision, which
        is what makes them the strip EVERYBODY gets — three of the nine are the
        reader's own, and a salesman who is shown neither these nor the seven
        was being shown no summary of his book at all. `tile-strip.tsx` carries
        the argument for why they are these nine and not the seven below.

        Two of the figures restate what the card above already says, and that
        is a restatement rather than a second opinion: the Today and Overdue
        tiles resolve to `dueTodayWindow` and `overdueWindow`, which is exactly
        what `needsAttention` counts its own totals with. One clause, so they
        cannot say different numbers about one book — and a reader who has
        scrolled past the card still meets the figure on the way down.
      */}
      {tiles ? (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Your book
          </div>
          <BookTiles workspace={workspace} counts={tiles} />
        </div>
      ) : null}

      {blocks.length > 0 ? <ManagerStrip workspace={workspace} blocks={blocks} /> : null}

      {/*
        PIPELINE AT A GLANCE — the same funnel the funnel screen draws, compact.

        Not a second drawing of it: `SharedBarFunnel` takes a prop, and what
        the prop removes is the footnotes rather than any figure. Every bar,
        every count and every segment link is what `/leads/funnel` shows, off
        the same `funnelByRung` read shaped by the same pure engine — so a
        manager who reads a rung here and opens the screen cannot find a
        different number waiting for him.
      */}
      {pipeline ? (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Pipeline at a glance
          </div>
          <SharedBarFunnel workspace={workspace} funnel={pipeline} compact />
        </div>
      ) : null}
    </>
  );
}
