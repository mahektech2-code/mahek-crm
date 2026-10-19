"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { money, shortDate } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import {
  LEAD_FILTER_COLUMNS,
  LeadFilterBar,
  type LeadFilterColumn,
  type LeadFilterOptions,
} from "@/components/leads/filter-bar";
import type { PlaceFilterOptions } from "@/lib/place-filters";
import { LEGACY_SALES_TYPE } from "@/lib/lead-filters";
import { SALES_TYPES, stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { BoardCard, LeadBoard } from "@/lib/services/lead-board-service";
import { AdvanceStage } from "../record/advance-stage";
import { Segmented } from "@/components/leads/segmented";
import { LeadTabs } from "../lead-tabs";
import { Button, Empty, Pill, plural } from "@/components/console/parts";

/**
 * THE LIST'S COLUMNS, LESS THE LADDER — because the ladder is what this screen
 * IS.
 *
 * Everything else is shared with the list down to the words, the bucket lists
 * and the panel: see `components/leads/filter-bar.tsx`. This used to be a
 * second copy of the whole bar, and the copy had already fallen two filters
 * behind — a narrowing offered on the list and absent here, with nothing on
 * either screen saying so.
 */
const FILTER_COLUMNS = LEAD_FILTER_COLUMNS.filter((c) => c !== "salesType");
type FilterColumn = LeadFilterColumn;

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
  places,
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
  options: LeadFilterOptions;
  /** State → city → area, counted over the leads list. See the Where picker. */
  places: PlaceFilterOptions;
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

  const offLadder = board.offLadder.filter((o) => o.total > 0);

  /* The list, narrowed to the same filters and ladder. A column's "+ N more"
     adds its own rung. */
  const listHref = (stage?: LeadStage) => {
    const next = new URLSearchParams(search.toString());
    next.delete("type");
    next.set("salesType", typeKey === LEGACY ? LEGACY_SALES_TYPE : typeKey);
    if (stage) next.set("stage", stage);
    return leadHref(workspace, `leads?${next.toString()}`);
  };

  const ladders = [
    ...SALES_TYPES.filter((t) => !t.retired || t.code === typeKey).map((t) => ({
      key: t.code as string,
      label: SHORT_TYPE[t.code] ?? t.label,
      title: t.hint,
    })),
    { key: LEGACY, label: "Original", title: "Leads raised before the funnel existed." },
  ];

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <Segmented
          label="Ladder"
          items={ladders.map((l) => ({
            key: l.key,
            label: l.label,
            title: l.title,
            on: typeKey === l.key,
            onPick: () => navigate({ type: l.key }),
          }))}
        />
        <LeadFilterBar
          className="min-w-0 flex-[1_1_320px]"
          columns={FILTER_COLUMNS}
          filters={filters}
          options={options}
          places={places}
          navigate={navigate}
          onClear={() =>
            navigate(Object.fromEntries(FILTER_COLUMNS.map((c) => [c, undefined])))
          }
          total={board.total}
          listTotal={board.listTotal}
          totalSuffix=" on this ladder"
        />
        {offLadder.length ? (
          <span className="text-[13px] text-muted">
            {offLadder.map((o) => `${stageLabel(o.stage)} ${o.total.toLocaleString("en-IN")}`).join(" · ")}
            {" — not on the board"}
          </span>
        ) : null}
        <Segmented
          label="Layout"
          items={[
            {
              key: "list",
              label: "List",
              on: false,
              href: leadHref(workspace, `leads?${search.toString()}`),
            },
            { key: "board", label: "Board", on: true },
          ]}
        />
      </div>

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

      {board.total === 0 ? (
        <Empty
          title={anyFilter ? "Nothing matches those filters" : "Nothing on this ladder"}
          body={anyFilter ? "Clear a filter or pick another ladder." : "Pick another ladder."}
        />
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-max items-start gap-3">
            {board.columns.map((column) => (
              <Column
                workspace={workspace}
                key={column.stage}
                stage={column.stage}
                total={column.total}
                cards={column.cards}
                moreHref={listHref(column.stage)}
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
        </div>
      )}
    </div>
  );
}

/** The ladder's word on the switch. */
const SHORT_TYPE: Partial<Record<string, string>> = {
  direct: "Direct",
  third_party: "Third-party",
  distributor: "Distributor",
};

/* ─────────────────────────────────────────────────────────────── a column */

function Column({
  workspace,
  stage,
  total,
  cards,
  moreHref,
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
  moreHref: string;
  dragging: string | null;
  onDragOverColumn: () => void;
  onDrop: () => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (card: BoardCard) => void;
}) {
  const [over, setOver] = React.useState(false);
  const more = total - cards.length;

  return (
    <section
      aria-label={stageLabel(stage)}
      className={cx(
        "flex w-[248px] flex-none flex-col gap-2 rounded-[10px] p-2.5",
        over && dragging ? "bg-brand-soft shadow-[inset_0_0_0_1px_var(--color-brand)]" : "bg-divider",
      )}
      onDragOver={(e) => {
        /* Every column accepts the hover, so a refused drop can say why. */
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
      <div className="flex items-center gap-2 px-1 pt-0.5 pb-1">
        <h2 className="m-0 min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {stageLabel(stage)}
        </h2>
        {/* The rung's true count, from SQL — never the cards drawn. */}
        <span className="h-[18px] min-w-5 rounded-[9px] bg-surface px-1.5 text-center text-[11px] leading-[18px] font-semibold text-body tabular-nums">
          {total.toLocaleString("en-IN")}
        </span>
      </div>

      {cards.map((card) => (
        <Card
          workspace={workspace}
          key={card.id}
          card={card}
          dragging={dragging === card.id}
          onDragStart={() => onDragStart(card.id)}
          onDragEnd={onDragEnd}
          onMove={() => onMove(card)}
        />
      ))}

      {more > 0 ? (
        <Link href={moreHref} className="px-1 py-0.5 text-[12px]">
          + {more.toLocaleString("en-IN")} more
        </Link>
      ) : null}
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
        /* Firefox will not start a drag with nothing on the transfer; the drop
           reads the board's own state, never this payload. */
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cx(
        "flex cursor-grab flex-col gap-2 rounded-[8px] border border-line bg-surface p-3 active:cursor-grabbing",
        dragging && "opacity-50",
      )}
    >
      <Link
        href={leadHref(workspace, `leads/${card.id}`)}
        className="truncate text-sm font-semibold text-ink no-underline hover:underline"
        title={card.companyName ?? card.name}
      >
        {card.name}
      </Link>

      <span className="truncate text-[12px] text-muted">
        {card.city ?? "No city"} · {card.ownerName ?? "Nobody"}
      </span>

      <div className="flex flex-wrap items-center gap-1.5">
        {card.next.noNextRung ? (
          <Pill tone="neutral">Top of the ladder</Pill>
        ) : missing === 0 ? (
          <Pill tone="success">Ready for {stageLabel(card.next.to)}</Pill>
        ) : (
          <span title={card.next.missing.map((m) => m.says).join("; ")}>
            <Pill tone="warn">{plural(missing, "thing")} to do</Pill>
          </span>
        )}
        <span className="text-[12px] text-body tabular-nums">
          {card.potentialPaise ? money(card.potentialPaise) : "—"}
        </span>
      </div>

      <div className="flex items-center gap-2 border-t border-divider pt-2">
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-[12px] tabular-nums",
            !card.nextActionDate || card.nextActionOverdue ? "text-danger" : "text-muted",
          )}
        >
          {card.nextActionDate
            ? `${shortDate(card.nextActionDate)}${card.nextActionOverdue ? " · late" : ""}`
            : "Nothing promised"}
        </span>
        {/* The keyboard and touch way into the same advance flow a drag opens. */}
        <button
          type="button"
          onClick={onMove}
          title={card.next.noNextRung ? "There is no rung above this one." : undefined}
          className="inline-flex h-7 flex-none cursor-pointer items-center rounded-[6px] border border-line bg-surface px-2.5 text-[12px] font-medium text-body hover:bg-canvas hover:text-ink"
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
          {moved ? <p className="mt-0.5 mb-0 text-[12px] text-body">Moved.</p> : null}
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

