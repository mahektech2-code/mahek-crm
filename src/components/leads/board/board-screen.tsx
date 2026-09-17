"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { money, shortDate } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  AGE_BUCKETS,
  HEALTH_BUCKETS,
  NEXT_BUCKETS,
  POTENTIAL_BUCKETS,
  type FilterOption,
} from "@/lib/lead-filters";
import { SALES_TYPES, salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { BoardCard, LeadBoard } from "@/lib/services/lead-board-service";
import { AdvanceStage } from "../record/advance-stage";
import { LeadTabs } from "../lead-tabs";
import { Button, Empty, Pill, ScreenHeader, plural } from "@/components/console/parts";

/**
 * The same seven columns the Leads list can be narrowed by, in the same order.
 *
 * Declared once and iterated, exactly as the list declares them: the URL
 * parameter, the ticked state and "Clear filters" all walk this array, which is
 * what stops an eighth filter being added to the bar and quietly not cleared.
 */
const FILTER_COLUMNS = [
  "owner",
  "source",
  "potential",
  "stage",
  "next",
  "age",
  "health",
] as const;
type FilterColumn = (typeof FILTER_COLUMNS)[number];

/** The URL's word for the leads that carry no sales type. See `page.tsx`. */
const LEGACY = "legacy";

/**
 * A move somebody has begun by dragging, waiting on the advance flow.
 *
 * `from` is kept beside the card because it is how the panel knows the move
 * LANDED without holding any state about it: once the server action has written
 * and the router has refreshed, the same card comes back on a different rung,
 * and comparing the two is a derivation rather than an effect. Resetting state
 * in an effect when a prop changes is exactly what the React Compiler rules
 * here forbid, and this is the shape that does not need to.
 */
type Pending = { card: BoardCard; from: LeadStage; to: LeadStage };

/** A gesture the board will not turn into a move, and why. */
type Refusal = { name: string; says: string };

export function BoardScreen({
  workspace,
  board,
  typeKey,
  filters,
  options,
  canWork,
  canOverride,
  overrideAllowed,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  board: LeadBoard;
  /** Which ladder is drawn — a sales type, or `legacy`. */
  typeKey: string;
  filters: Record<FilterColumn, string[]>;
  options: {
    owners: Array<FilterOption & { count: number }>;
    sources: Array<FilterOption & { count: number }>;
    stages: Array<FilterOption & { count: number }>;
  };
  canWork: boolean;
  canOverride: boolean;
  /** `leads.allowManagerOverride`. Off means nobody may, however senior. */
  overrideAllowed: boolean;
}) {
  const router = useRouter();
  const search = useSearchParams();

  /* One place a filter is written to the URL, the same helper the list uses:
     any change to WHAT is being looked at drops the paging parameters the list
     leaves behind, so arriving here from a filtered table does not carry a page
     number onto a screen that has no pages. */
  const navigate = React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "" || v === null) next.delete(k);
        else next.set(k, String(v));
      }
      next.delete("page");
      next.delete("per");
      router.push(`?${next.toString()}`, { scroll: false });
    },
    [router, search],
  );

  const anyFilter = FILTER_COLUMNS.some((c) => filters[c].length > 0);

  const [dragging, setDragging] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);

  /** Every card on the board by id, so a drop can find what was dragged. */
  const byId = React.useMemo(() => {
    const map = new Map<string, BoardCard>();
    for (const column of board.columns) for (const card of column.cards) map.set(card.id, card);
    return map;
  }, [board]);

  /**
   * DRAGGING A CARD IS A STAGE MOVE AND IT GOES THROUGH THE GATE — so this
   * writes nothing. It opens the existing advance flow with the target rung
   * already filled in, and everything that happens after is
   * `AdvanceStage`/`advanceLeadStage`: the same §28 refusal, the same missing
   * list, the same reason code, the same override path recording what was still
   * standing. A board that moved a lead on the drop would be a SECOND DOOR onto
   * `advanceLeadStage` with none of the conditions attached, and it would be
   * the pleasant door — which is how a process people were meant to follow ends
   * up recorded as having been followed when it was not.
   *
   * A BOARD GESTURE IS ONE RUNG, and that is the other half of keeping one
   * door. The card already carries the verdict for the rung above it — the one
   * the tick on its face is drawn from — so a drop onto that column hands the
   * dialog a verdict the manager has already read. Any other column is refused
   * in words rather than silently ignored: skipping rungs, going back down and
   * marking a lead lost are all real moves and all of them want a reason field
   * this gesture has nowhere to put, so they are done on the lead's own record.
   * A drag that simply did nothing would read as a broken board.
   *
   * NO NEW DEPENDENCY WAS ADDED FOR ANY OF THIS. It is the browser's own
   * drag-and-drop, which costs nothing and needs no library — and because that
   * one is a mouse gesture with no keyboard or touch equivalent, every card
   * also carries a Move control that opens the identical flow. Two ways in, one
   * door.
   */
  function drop(to: LeadStage) {
    const card = dragging ? byId.get(dragging) : undefined;
    setDragging(null);
    if (!card) return;
    setRefusal(null);
    if (card.stage === to) return;

    if (card.next.noNextRung) {
      setRefusal({
        name: card.name,
        says: `${stageLabel(card.stage)} is the end of this ladder — there is no rung above it to move to.`,
      });
      return;
    }
    if (card.next.to !== to) {
      setRefusal({
        name: card.name,
        says: `A board move is one rung. ${stageLabel(card.stage)} goes to ${stageLabel(
          card.next.to,
        )} next — skipping a rung, going back down or marking it lost is done on the lead's own record, where the reason field is.`,
      });
      return;
    }
    setPending({ card, from: card.stage, to });
  }

  /* Did the move land? Derived from the board that came back after the refresh
     rather than remembered — the card is on a new rung or it is not. */
  const pendingNow = pending ? byId.get(pending.card.id) : undefined;
  const pendingMoved = Boolean(pending && pendingNow && pendingNow.stage !== pending.from);

  const drawn = board.columns.reduce((n, c) => n + c.cards.length, 0);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Stage board"
        subtitle="The same book as the list, drawn as columns per rung — the view for seeing where a book is bunching rather than which lead to open. Dragging a card does not move it: it opens the advance flow with the gate attached."
        actions={
          <Link
            href={leadHref(workspace, `leads?${search.toString()}`)}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Back to the list
          </Link>
        }
      />

      {/* THE LADDER IS A URL PARAMETER, unlike the list's funnel chips, which
          are local state. There the chip redraws four bars; here it redraws the
          whole screen against a different population, and that is a view worth
          sending to somebody. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {SALES_TYPES.map((t) => (
          <TypeChip
            key={t.code}
            on={typeKey === t.code}
            label={t.label}
            title={t.hint}
            onPick={() => navigate({ type: t.code })}
          />
        ))}
        <TypeChip
          on={typeKey === LEGACY}
          label="Original ladder"
          title="Leads raised before the funnel existed. They carry no sales type, nothing backfills one, and they climb the six rungs this product shipped with."
          onPick={() => navigate({ type: LEGACY })}
        />
      </div>

      <FilterBar
        filters={filters}
        options={options}
        navigate={navigate}
        anyFilter={anyFilter}
        onClear={() =>
          navigate(Object.fromEntries(FILTER_COLUMNS.map((c) => [c, undefined])))
        }
        total={board.total}
        listTotal={board.listTotal}
      />

      {pending ? (
        <PendingMove
          pending={pending}
          moved={pendingMoved}
          canWork={canWork}
          canOverride={canOverride}
          overrideAllowed={overrideAllowed}
          onClose={() => setPending(null)}
        />
      ) : null}

      {refusal ? (
        <div className="mb-3 flex items-start gap-3 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink">{refusal.name}</div>
            <div className="mt-0.5 text-[13px] text-pretty text-body">{refusal.says}</div>
          </div>
          <Button size="sm" tone="quiet" onClick={() => setRefusal(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {/* WHAT THE COLUMNS DO NOT SHOW, said rather than dropped. `lost` is on
          none of the three ladders and a PARKED lead is on none either — it
          displaced its own rung, which is the whole subject of the transitions
          screen. Omitting them silently would draw a book with the dead and the
          parked deleted from it, and the parked ones are what somebody opens a
          board to find. */}
      {board.offLadder.length ? (
        <div className="mb-3 rounded-[6px] border border-line bg-surface px-4 py-3">
          <div className="text-[13px] text-body">
            <span className="font-semibold text-ink">
              {plural(
                board.offLadder.reduce((n, o) => n + o.total, 0),
                "lead",
              )}{" "}
              on no rung of this ladder
            </span>
            {" — "}
            {board.offLadder
              .map((o) => `${stageLabel(o.stage)} ${o.total}`)
              .join(" · ")}
          </div>
          <p className="mt-1 mb-0 max-w-[720px] text-[12px] text-pretty text-muted">
            A lost lead has left every ladder, and a parked one has not — on hold
            takes the stage column, so the rung it was parked from lives only in
            its stage history. Open the lead and read its Transitions to find out
            what a reopen has to move it back to.
          </p>
        </div>
      ) : null}

      {board.total === 0 ? (
        <Empty
          title={anyFilter ? "Nothing matches those filters" : "Nothing on this ladder"}
          body={
            anyFilter
              ? `The filters are the list's own, so this is the same narrowing applied to ${salesTypeLabelFor(typeKey)}. Clear them, or pick another ladder — the three are different populations, not three views of one.`
              : `No lead in your book carries this sales type. Nothing backfills one, so every lead raised before the funnel existed is on the original ladder rather than this one.`
          }
        />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {board.columns.map((column) => (
            <Column workspace={workspace}
              key={column.stage}
              stage={column.stage}
              total={column.total}
              cards={column.cards}
              cap={board.cap}
              dragging={dragging}
              onDragOverColumn={() => setRefusal(null)}
              onDrop={() => drop(column.stage)}
              onDragStart={(id) => setDragging(id)}
              onDragEnd={() => setDragging(null)}
              onMove={(card) => {
                setRefusal(null);
                if (card.next.noNextRung) {
                  setRefusal({
                    name: card.name,
                    says: `${stageLabel(card.stage)} is the end of this ladder — there is no rung above it to move to.`,
                  });
                  return;
                }
                setPending({ card, from: card.stage, to: card.next.to });
              }}
            />
          ))}
        </div>
      )}

      <p className="mt-1 max-w-[860px] text-[12px] text-pretty text-muted">
        {drawn === board.total
          ? `Every one of ${plural(board.total, "lead")} on this ladder is drawn.`
          : `${drawn.toLocaleString("en-IN")} cards drawn of ${board.total.toLocaleString("en-IN")} — each column is capped at ${board.cap} and says its own true count in its header. The counts come from the database, not from what fits on the screen.`}{" "}
        The tick on a card is §28 for the rung above it: the gate engine&rsquo;s
        answer, evaluated on the server, and the same verdict the advance flow is
        handed — so the card and the refusal cannot disagree.
      </p>
    </div>
  );
}

function salesTypeLabelFor(typeKey: string): string {
  const found = SALES_TYPES.find((t) => t.code === typeKey);
  return found ? salesTypeLabel(found.code) : "the original ladder";
}

/* ─────────────────────────────────────────────────────────────── a column */

function Column({
  workspace,
  stage,
  total,
  cards,
  cap,
  dragging,
  onDragOverColumn,
  onDrop,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  workspace: LeadWorkspace;
  stage: LeadStage;
  total: number;
  cards: BoardCard[];
  cap: number;
  dragging: string | null;
  onDragOverColumn: () => void;
  onDrop: () => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (card: BoardCard) => void;
}) {
  const [over, setOver] = React.useState(false);

  return (
    <section
      className={cx(
        "flex w-[264px] flex-none flex-col rounded-[6px] border bg-canvas",
        over && dragging ? "border-brand bg-brand-soft" : "border-line",
      )}
      onDragOver={(e) => {
        /* preventDefault is what makes a drop legal at all. It is called for
           every column rather than only the one rung a drop would be accepted
           on, because a column that refused the hover gives no way to SAY why —
           and a refusal somebody reads beats a gesture that silently fails. */
        if (!dragging) return;
        e.preventDefault();
        setOver(true);
        onDragOverColumn();
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop();
      }}
    >
      <header className="border-b border-line px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">
            {stageLabel(stage)}
          </span>
          {/* From SQL over the whole filtered population of this rung — never
              `cards.length`, which is the count that made the CRM's timeline
              print "Bill 34" against an account carrying 1,060. */}
          <span className="text-[15px] font-semibold text-ink tabular-nums">
            {total.toLocaleString("en-IN")}
          </span>
        </div>
        {total > cards.length ? (
          <div className="mt-0.5 text-[11px] text-muted">
            showing the first {cap} — a slice, ordered by what was promised soonest
          </div>
        ) : null}
      </header>

      <div className="flex min-h-[120px] flex-col gap-2 p-2">
        {cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-[12px] text-muted">Nothing on this rung</p>
        ) : (
          cards.map((card) => (
            <Card workspace={workspace}
              key={card.id}
              card={card}
              dragging={dragging === card.id}
              onDragStart={() => onDragStart(card.id)}
              onDragEnd={onDragEnd}
              onMove={() => onMove(card)}
            />
          ))
        )}
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────── a card */

function Card({
  workspace,
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  workspace: LeadWorkspace;
  card: BoardCard;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: () => void;
}) {
  const missing = card.next.missing.length;

  return (
    <article
      draggable
      onDragStart={(e) => {
        /* Something has to be on the transfer or Firefox will not start a drag.
           The board reads its own state rather than this payload — a drop
           handler that trusted `dataTransfer` would accept a drag begun in
           another tab. */
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cx(
        "cursor-grab rounded-[5px] border border-line bg-surface px-2.5 py-2 active:cursor-grabbing",
        dragging && "opacity-50",
      )}
    >
      <Link
        href={leadHref(workspace, `leads/${card.id}`)}
        className="block truncate text-[13px] font-medium text-ink no-underline hover:underline"
        title={card.companyName ?? card.name}
      >
        {card.name}
      </Link>

      <div className="mt-0.5 truncate text-[12px] text-muted">
        {/* City and owner on one line, with the gap said in words. A lead
            nobody holds is the row a manager most needs to see, so "Nobody" is
            printed rather than left blank — a blank reads as a missing value
            rather than as an answer. */}
        {card.city ?? "No city"} · {card.ownerName ?? "Nobody"}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {card.next.noNextRung ? (
          <Pill tone="neutral">Top of the ladder</Pill>
        ) : missing === 0 ? (
          <Pill tone="success">
            Ready for {stageLabel(card.next.to)}
          </Pill>
        ) : (
          <span title={card.next.missing.map((m) => m.says).join("; ")}>
            <Pill tone="warn">{plural(missing, "thing")} to do</Pill>
          </span>
        )}
        {card.potentialPaise ? (
          <span className="text-[11px] text-muted tabular-nums">
            {money(card.potentialPaise)}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        {/* §24's date. Muted where it is past, because it is the stored answer
            to "what happens next and when" rather than a live prediction — and
            a date already gone sitting in the same ink as a future one reads as
            a commitment somebody is still keeping. */}
        <span
          className={cx(
            "truncate text-[11px] tabular-nums",
            card.nextActionDate
              ? card.nextActionOverdue
                ? "text-muted line-through"
                : "text-body"
              : "text-muted",
          )}
          title={
            card.nextActionDate
              ? card.nextActionOverdue
                ? "The day somebody promised something, and it has gone past."
                : "What happens next, and when."
              : "Nothing is owed by anybody on this lead — which is the state §24 exists to prevent."
          }
        >
          {card.nextActionDate ? shortDate(card.nextActionDate) : "Nothing promised"}
        </span>

        {/* The keyboard and touch way in. HTML5 drag is a mouse gesture and has
            no equivalent on either, so the same flow is reachable without one —
            and it is the SAME flow, not a second one. */}
        <button
          type="button"
          onClick={onMove}
          className="flex-none cursor-pointer rounded-[3px] border border-line bg-surface px-1.5 py-0.5 text-[11px] text-muted hover:bg-canvas hover:text-body"
          title={
            card.next.noNextRung
              ? "There is no rung above this one."
              : `Open the advance flow for ${stageLabel(card.next.to)}. It writes nothing on its own — the gate is asked first.`
          }
        >
          Move
        </button>
      </div>
    </article>
  );
}

/* ──────────────────────────────────────────────── the move a drop began */

/**
 * The advance flow, pre-filled with what the gesture said.
 *
 * It renders `AdvanceStage` itself rather than reimplementing a move — that
 * component holds the two-buttons rule (moving a lead whose gate is open and
 * passing a shut one are different acts, recorded differently), the override
 * dialog that prints every missing condition rather than a count, and the
 * server action that asks §28 again before it writes.
 */
function PendingMove({
  pending,
  moved,
  canWork,
  canOverride,
  overrideAllowed,
  onClose,
}: {
  pending: Pending;
  moved: boolean;
  canWork: boolean;
  canOverride: boolean;
  overrideAllowed: boolean;
  onClose: () => void;
}) {
  return (
    <div className="mb-3 rounded-[6px] border border-brand bg-brand-soft px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">
            {pending.card.name} · {stageLabel(pending.from)} → {stageLabel(pending.to)}
          </div>
          <p className="mt-0.5 mb-0 max-w-[620px] text-[12px] text-pretty text-body">
            {moved
              ? "Moved. The board behind this has already redrawn."
              : "Nothing has been written. The gate is asked first, and a shut one is passed only with a reason that is recorded against whoever passed it."}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {moved ? null : (
            <AdvanceStage
              customerId={pending.card.id}
              to={pending.to}
              verdict={pending.card.next}
              canWork={canWork}
              canOverride={canOverride}
              overrideAllowed={overrideAllowed}
            />
          )}
          <Button size="sm" tone="quiet" onClick={onClose}>
            {moved ? "Dismiss" : "Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── the chrome above */

function TypeChip({
  on,
  label,
  title,
  onPick,
}: {
  on: boolean;
  label: string;
  title?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={title}
      aria-pressed={on}
      className={cx(
        "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
        on
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-muted hover:bg-canvas hover:text-body",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The list's filter bar, drawn over the board.
 *
 * It is a second rendering of one control rather than a second SET of controls:
 * the options, the bucket lists and the URL parameters are all the list's, so a
 * filter ticked here and the same filter ticked there narrow to the same rows.
 * The counts on the option labels are the list's too — counted over the
 * UNFILTERED book on purpose, so a dropdown's options do not disappear as you
 * tick boxes in the dropdown beside it.
 */
function FilterBar({
  filters,
  options,
  navigate,
  anyFilter,
  onClear,
  total,
  listTotal,
}: {
  filters: Record<FilterColumn, string[]>;
  options: {
    owners: Array<FilterOption & { count: number }>;
    sources: Array<FilterOption & { count: number }>;
    stages: Array<FilterOption & { count: number }>;
  };
  navigate: (patch: Record<string, string | number | undefined>) => void;
  anyFilter: boolean;
  onClear: () => void;
  total: number;
  listTotal: number;
}) {
  const pick = (column: FilterColumn) => (next: string[]) =>
    navigate({ [column]: next.join(",") || undefined });

  const withCounts = (rows: Array<FilterOption & { count: number }>) =>
    rows.map((r) => ({ value: r.value, label: `${r.label} (${r.count})` }));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <MultiSelect
        label="Owner"
        placeholder="All owners"
        options={withCounts(options.owners)}
        selected={filters.owner}
        onChange={pick("owner")}
        title="Who is working the lead. Nobody is a real answer and is offered as one."
      />
      <MultiSelect
        label="Source"
        placeholder="All sources"
        options={withCounts(options.sources)}
        selected={filters.source}
        onChange={pick("source")}
      />
      <MultiSelect
        label="Potential"
        placeholder="Any potential"
        options={[...POTENTIAL_BUCKETS]}
        selected={filters.potential}
        onChange={pick("potential")}
        title="Somebody's estimate of what the shop could spend in a month. Not estimated is not the same as nothing."
      />
      <MultiSelect
        label="Stage"
        placeholder="All stages"
        options={withCounts(options.stages)}
        selected={filters.stage}
        onChange={pick("stage")}
        title="Narrowing to a rung empties every column but that one. The board is the shape of the whole ladder, so this is usually the filter to leave alone."
      />
      <MultiSelect
        label="Next"
        placeholder="Any next step"
        options={[...NEXT_BUCKETS]}
        selected={filters.next}
        onChange={pick("next")}
        title="The follow-up somebody promised. None promised is the one worth looking at."
      />
      <MultiSelect
        label="Age"
        placeholder="Any age"
        options={[...AGE_BUCKETS]}
        selected={filters.age}
        onChange={pick("age")}
      />
      <MultiSelect
        label="Health"
        placeholder="Any health"
        options={[...HEALTH_BUCKETS]}
        selected={filters.health}
        onChange={pick("health")}
        title="What the health column says. A lead that has never ordered is in no band at all — that is an option rather than a gap."
      />

      {anyFilter ? (
        <button
          type="button"
          onClick={onClear}
          className="h-8.5 cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-muted hover:bg-canvas hover:text-body"
        >
          Clear filters
        </button>
      ) : null}

      <span className="flex-1" />
      {/* Both figures are this ladder's — the board is one sales type at a
          time, so "of 511" would be a total from a population the screen is not
          showing. */}
      <span className="text-[13px] text-muted">
        {anyFilter
          ? `${total.toLocaleString("en-IN")} of ${listTotal.toLocaleString("en-IN")} on this ladder`
          : `${listTotal.toLocaleString("en-IN")} ${listTotal === 1 ? "lead" : "leads"} on this ladder`}
      </span>
    </div>
  );
}
