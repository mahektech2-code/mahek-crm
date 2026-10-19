import Link from "next/link";
import { cx } from "@/components/ui/primitives";
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

/**
 * WHAT IS WAITING ON SOMEBODY, as one compact list rather than a wall of
 * tiles. Each row opens the screen whose rows are that count; the hint rides
 * on hover rather than under every number.
 */
function WaitingList({
  workspace,
  blocks,
}: {
  workspace: LeadWorkspace;
  blocks: ManagerLeadBlock[];
}) {
  return (
    <div className="rounded-[10px] border border-line bg-surface">
      <div className="border-b border-divider px-5 py-3.5 text-[15px] font-semibold text-ink">
        Waiting on you
      </div>
      <ul className="m-0 list-none p-0">
        {blocks.map((block) => {
          const empty = block.count === 0;
          const skin = SKIN[empty ? "muted" : block.tone];
          return (
            <li key={block.id} className="border-b border-divider last:border-b-0">
              <Link
                href={leadHref(workspace, block.href)}
                title={block.hint}
                className="flex items-center justify-between gap-3 px-5 py-2.5 text-ink no-underline hover:bg-canvas hover:text-ink hover:no-underline"
              >
                <span className="min-w-0 truncate text-sm">{block.label}</span>
                <span
                  className={cx("flex-none text-[15px] font-semibold tabular-nums", skin.value)}
                >
                  {block.count}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
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
      {tiles ? <BookTiles workspace={workspace} counts={tiles} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AttentionCard workspace={workspace} list={attention} />
        </div>
        <div className="flex flex-col gap-4">
          {blocks.length > 0 ? <WaitingList workspace={workspace} blocks={blocks} /> : null}
          <RoleFocusCard workspace={workspace} focus={focus} />
        </div>
      </div>

      {pipeline ? (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Pipeline
          </div>
          <SharedBarFunnel workspace={workspace} funnel={pipeline} compact />
        </div>
      ) : null}
    </>
  );
}
