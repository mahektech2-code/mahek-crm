import Link from "next/link";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { moneyShort } from "@/lib/format";
import { salesTypeLabel, stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import {
  OPERATIONAL_STAGES,
  SHARED_TRACKS,
  sharedRungOrder,
  type SharedFunnel,
  type SharedRung,
  type TrackSegment,
} from "@/lib/engines/lead-funnel-shape";
import { Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * §8.3a — DIRECT AND THIRD-PARTY, IN ONE FUNNEL.
 *
 * They are drawn together because they are the same sale: a shop is found,
 * qualified, given a sample, argued with about price, and buys. What differs is
 * who holds the invoice at the end, which is a fact about the paperwork rather
 * than about the climb — so two funnels side by side would invite a reader to
 * compare two shapes that are shapes of one thing, and would halve the counts
 * that make either of them legible.
 *
 * Every bar is SPLIT rather than summed into one block, and that is what makes
 * each half clickable to a number somebody can verify. The list cannot yet be
 * narrowed by sales type — see the note on `segmentHref` — so a combined
 * segment would be a figure with no way to get behind it, which is the one
 * thing a headline on this screen must not be.
 *
 * A SERVER component with no state: every control is a link, like the rest of
 * this screen and for the same reason. A filtered view of a funnel rung is the
 * thing a manager sends somebody, and a view held in component state is
 * unsendable and makes the back button a lie. Nothing here reads the clock.
 *
 * ---------------------------------------------------------------------------
 * TWO SCREENS DRAW IT AND THERE IS STILL ONE FUNNEL. The dashboard asks for
 * `compact`, which is a prop and deliberately not a second component: two
 * funnels drawn from two readings is how two screens come to disagree about a
 * rung, and the disagreement would be invisible — both would be internally
 * consistent and only somebody holding the two side by side would ever see it.
 *
 * What `compact` takes away is EXPLANATION and never a figure. The medians,
 * the estimated potential, the operational pair and the off-ladder tail are
 * all sentences about why the picture is the shape it is, and a dashboard is
 * the wrong place to read a paragraph. Every BAR is drawn, every rung is
 * counted, and every segment still opens the list it counts — so the shape a
 * manager reads on the dashboard is the shape the funnel screen draws, with
 * the footnotes one click away rather than missing.
 * ------------------------------------------------------------------------- */

/**
 * Where a segment goes when it is clicked, and it opens EXACTLY what it counts.
 *
 * A rung is not a track. `leads?stage=suspect` answers with the direct,
 * third-party, distributor and legacy leads standing there all at once, which
 * is four populations under one number and not the one this bar is showing —
 * and a figure that opens a bigger list than it claims is worse than one that
 * does not open at all, because nobody checks the second and everybody stops
 * trusting the first.
 *
 * Both parameters are needed and neither is redundant. The list's base is the
 * funnel's own — `lead_stage is not null`, `lead_archived = false`, and
 * `leadsVisible(scope)` under the same `managerScope()` — and `leadFilterClause`
 * narrows on `lead_sales_type` and `lead_stage` exactly as `funnelByRung`
 * groups on them, so the two cannot answer differently about one segment.
 */
function segmentHref(
  workspace: LeadWorkspace,
  salesType: LeadSalesType,
  stage: LeadStage,
): string {
  return leadHref(workspace, `leads?salesType=${salesType}&stage=${stage}`);
}

const TRACK_TONE: Record<string, string> = {
  direct: "bg-brand",
  /* A second weight of the same hue rather than a second colour. The two are
     halves of one bar and a contrasting colour would read as two competing
     series on one chart, which is the opposite of what putting them in one
     funnel says. */
  third_party: "bg-brand/45",
};

export function SharedBarFunnel({
  workspace,
  funnel,
  compact = false,
}: {
  workspace: LeadWorkspace;
  funnel: SharedFunnel;
  /**
   * The dashboard's shape. Bars, counts and links exactly as the funnel screen
   * draws them; the footnotes that explain them replaced by the link to the
   * screen that carries them. See the note at the top of this file.
   */
  compact?: boolean;
}) {
  return (
    <section className="rounded-[6px] border border-line bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h3 className="text-sm font-semibold text-ink">Direct &amp; third-party</h3>
          <p className="mt-0.5 max-w-[620px] text-xs text-muted">
            {compact ? (
              <>
                One sale up one ladder, split by who holds the invoice. Every segment opens the
                list narrowed to exactly the leads it counts.
              </>
            ) : (
              <>
                One sale up one ladder, split by who holds the invoice —{" "}
                {sharedRungOrder().length} rungs, with{" "}
                {OPERATIONAL_STAGES.map((s) => stageLabel(s)).join(" and ").toLowerCase()} kept out
                and counted below. Every segment opens the list narrowed to exactly the leads it
                counts.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-none flex-wrap gap-1.5">
          {funnel.parked > 0 ? <Pill tone="warn">{funnel.parked} parked</Pill> : null}
          {funnel.lost > 0 ? <Pill tone="neutral">{funnel.lost} lost</Pill> : null}
        </div>
      </header>

      <Legend />

      <ol className="px-5 pb-4">
        {funnel.rungs.map((rung, i) => (
          <Bar
            key={rung.stage}
            workspace={workspace}
            rung={rung}
            index={i}
            widest={funnel.widest}
            compact={compact}
          />
        ))}
      </ol>

      {compact ? (
        /*
         * WHAT IS NOT ON THIS CARD, said rather than left out silently.
         *
         * `delivery` and `payment` are rungs leads really stand on, and the
         * off-ladder tail is a real population; both are counted on the funnel
         * screen and neither is drawn here. A card that quietly omitted them
         * would be a funnel whose bars do not add up to its own book, which is
         * the one thing this component's own footer exists to prevent — so the
         * omission carries the door to where the missing figures are.
         */
        <footer className="border-t border-line px-5 py-3 text-[11px] text-muted">
          <Link href={leadHref(workspace, "leads/funnel")} className="font-medium">
            Funnel &amp; conversion
          </Link>{" "}
          — how long the typical lead has stood on each rung, the{" "}
          {OPERATIONAL_STAGES.map((s) => stageLabel(s)).join(" and ").toLowerCase()} rungs kept out
          of this picture, the appointment ladder, and what became of the leads raised in a window.
        </footer>
      ) : (
        <Operational workspace={workspace} rungs={funnel.operational} />
      )}

      {!compact && funnel.offLadder.length > 0 ? (
        <footer className="border-t border-line bg-canvas px-5 py-3 text-[13px] text-body">
          <span className="font-medium text-ink">Not on either shop ladder: </span>
          {funnel.offLadder.map((r, i) => (
            <span key={`${r.stage}-${i}`}>
              {i > 0 ? ", " : ""}
              {stageLabel(r.stage)} ({r.count})
            </span>
          ))}
          <span className="text-muted">
            {" "}
            — a rung their sales type does not carry, which happens for as long as it takes
            somebody to change a lead&rsquo;s type. Said out loud rather than dropped: a funnel
            whose bars do not add up to its own total is one nobody trusts twice.
          </span>
        </footer>
      ) : null}
    </section>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-2 text-[11px] text-muted">
      {/* The tracks come from the engine rather than being retyped here: a list
          of sales types written into a screen is the usual way a legend comes
          to name a track the funnel is not drawing. */}
      {SHARED_TRACKS.map((t) => (
        <span key={t} className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-[2px] ${TRACK_TONE[t]}`} />
          {salesTypeLabel(t)}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-[2px] border border-dashed border-line" />
        Not a rung on that ladder
      </span>
    </div>
  );
}

/* --------------------------------------------------------------------- bar */

function Bar({
  workspace,
  rung,
  index,
  widest,
  compact,
}: {
  workspace: LeadWorkspace;
  rung: SharedRung;
  index: number;
  widest: number;
  /** Drops the line of footnotes under the bar, and nothing else. */
  compact: boolean;
}) {
  /* Measured against the FULLEST RUNG of this funnel rather than against the
     total. The question a funnel answers is where the book is bunching
     relative to itself, and scaling against a total draws every bar short. */
  const scale = (n: number) => (widest > 0 ? (n / widest) * 100 : 0);

  return (
    <li className="mt-2 first:mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[13px] text-body">
          <span className="mr-2 text-[11px] tabular-nums text-muted">{index + 1}</span>
          {stageLabel(rung.stage)}
        </span>
        <span className="flex-none text-[13px] tabular-nums text-ink">{rung.total}</span>
      </div>

      <div className="mt-1 flex h-2.5 w-full overflow-hidden rounded-[3px] bg-divider">
        {rung.segments.map((s) => (
          <Segment
            key={s.salesType}
            workspace={workspace}
            stage={rung.stage}
            segment={s}
            width={scale(s.count)}
          />
        ))}
      </div>

      {/* The footnotes: which track is which, the median and how many rows it
          was taken over, and somebody's estimate of what the rung is worth.
          Three sentences per rung over ten rungs is a paragraph, which is
          right on the screen whose job is to explain the shape and wrong on a
          card whose job is to show it. */}
      {compact ? null : (
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {rung.segments.map((s) => (
            <SegmentNote key={s.salesType} segment={s} />
          ))}
          {rung.potentialPaise > 0 ? (
            <span title="Somebody's estimate of what these are worth. Never a derived figure, and never comparable with a real order value.">
              {moneyShort(rung.potentialPaise)} estimated
            </span>
          ) : null}
        </div>
      )}
    </li>
  );
}

function Segment({
  workspace,
  stage,
  segment,
  width,
}: {
  workspace: LeadWorkspace;
  stage: LeadStage;
  segment: TrackSegment;
  width: number;
}) {
  if (segment.count === 0) return null;
  return (
    <Link
      href={segmentHref(workspace, segment.salesType, stage)}
      title={`Open the ${plural(segment.count, "lead")} standing on ${stageLabel(
        stage,
      )} as a ${salesTypeLabel(segment.salesType).toLowerCase()}`}
      style={{ width: `${width}%` }}
      className={`h-full ${TRACK_TONE[segment.salesType]} hover:opacity-80`}
    />
  );
}

/**
 * The count under the bar, in words, because the bar cannot say WHY a half is
 * missing.
 *
 * A third-party segment of zero on `sample_received` and one on `negotiation`
 * are the same number and opposite facts: §3C drops the first rung entirely,
 * and the second means nobody is standing there. The bar draws both as nothing
 * at all, so the distinction has to be made here or not at all.
 */
function SegmentNote({ segment }: { segment: TrackSegment }) {
  const label = salesTypeLabel(segment.salesType);
  if (!segment.carried) {
    return (
      <span className="italic" title="§3C drops this rung: the sample goes through the distributor, so the date we can stand behind is when it was reviewed rather than when it landed.">
        {label} — not a rung on that ladder
      </span>
    );
  }
  return (
    <span>
      {label} {segment.count}
      {/* The median carries how many rows it was taken over. A median of three
          rows out of forty is a median of three rows, and a bare "41 days"
          beside a count of forty reads as a statement about forty leads. */}
      {segment.medianDaysHere !== null ? (
        <span
          className="ml-1"
          title={`Median over the ${segment.dated} of ${segment.count} that carry a stage date`}
        >
          · {segment.medianDaysHere}d{segment.dated < segment.count ? ` (${segment.dated})` : ""}
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------- delivery & payment */

/**
 * WHY TWO RUNGS ARE NOT IN THE FUNNEL ABOVE, said on the screen rather than
 * only in a comment.
 *
 * `delivery` and `payment` are real rungs and leads really do stand on them.
 * What they are not is sales progress: where a lorry has got to and whether
 * accounts have seen the money are operational states of an order already won,
 * and drawn as funnel segments they read as two more places a sale can fall
 * out of. A manager looking for the rung his book gets stuck on would be handed
 * the position of a lorry as an answer.
 *
 * They are counted here rather than filtered away, because the next person to
 * read this screen will otherwise conclude they were forgotten — and because a
 * lead sitting on `payment` for six weeks is a real thing somebody should see,
 * on a line that says what kind of thing it is.
 */
function Operational({
  workspace,
  rungs,
}: {
  workspace: LeadWorkspace;
  rungs: SharedRung[];
}) {
  const total = rungs.reduce((n, r) => n + r.total, 0);
  if (total === 0) {
    return (
      <div className="border-t border-line px-5 py-2.5 text-[11px] text-muted">
        {rungs.map((r) => stageLabel(r.stage)).join(" and ")} are rungs on both ladders and are
        deliberately out of the funnel above — they are operational states of an order already won,
        not sales progress. Nobody is standing on either.
      </div>
    );
  }

  return (
    <div className="border-t border-line bg-canvas px-5 py-3">
      <p className="text-[11px] text-muted">
        Out of the funnel above, deliberately: these are operational states of an order already
        won, not sales progress. A funnel that drew them would report a lorry&rsquo;s position as a
        stage of the sale.
      </p>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-body">
        {rungs.map((r) => (
          <span key={r.stage}>
            <span className="text-muted">{stageLabel(r.stage)}</span>{" "}
            <span className="tabular-nums text-ink">{r.total}</span>
            {r.segments
              .filter((s) => s.count > 0)
              .map((s) => (
                <Link
                  key={s.salesType}
                  href={segmentHref(workspace, s.salesType, r.stage)}
                  className="ml-2 text-[11px] text-[#5223E0]"
                >
                  {salesTypeLabel(s.salesType)} {s.count}
                </Link>
              ))}
          </span>
        ))}
      </div>
    </div>
  );
}
