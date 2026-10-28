"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { OutsideLeadHub } from "@/components/leads/hub/hub-context";
import { shortDate } from "@/lib/format";
import { ladderFor } from "@/lib/engines/lead-ladder";
import {
  DESK_VIEW_LABEL,
  deskLadderSalesType,
  isWorking,
  type DeskPhase,
  type DeskView,
} from "@/lib/engines/lead-calling-desk";
import {
  LADDER_LABEL,
  PHASE_LABEL,
  PHASE_TONE,
  dueLabel,
  isCreatedToday,
  rowBar,
} from "@/lib/calling-desk-labels";
import { DESK_LIST_CAP, LADDER, deskSummary, type DeskLeadRow } from "@/lib/calling-desk-summary";
import type { LeadSalesType } from "@/lib/lead-labels";
import {
  PBadge,
  PCard,
  PEmpty,
  PPage,
  PPageHead,
  PSectionLabel,
  pbtn,
  type PTone,
} from "@/components/sales-lead-pipeline/proto/ui";
import { CallMeter, DeskIcon } from "./desk-parts";

/* ---------------------------------------------------------------------------
 * The Telecaller dashboard — drawn in the Sales Manager desk's design language.
 *
 * One strip of eight tiles (All leads · Suspect · Verify prospect · Qualification
 * review · Sample · Order confirmation · Overdue · Nurture task), one strip of
 * three (Call 1 · Call 2 · Call 3), and below them ONE flat list of leads — the
 * stage is a badge on the row rather than a section header.
 *
 * PRESSING A TILE FILTERS THE LIST ON THIS SCREEN and goes nowhere: it does not
 * navigate and it does not scroll. The page holds every lead the desk may see
 * (a book of a few hundred, lean) and asks `deskSummary` — the same pure
 * function the server ran for the first paint — which is what keeps "a tile that
 * says 14 opens a list of 14" true after the filter changes. The view is written
 * to the address bar with `replaceState`, so a desk with "Call 2" open is still a
 * link somebody can send, and Back does not walk through every tile pressed.
 *
 * EVERY VIEW THE OLD STRIPS OFFERED IS STILL REACHABLE. The two strips of thirteen
 * were reduced to the eleven tiles above; the rest — Today's work queue, New
 * online leads, Calls due today, Follow-ups, Ready for Prospect, Awaiting
 * verification, Returned, With the Sales Manager, Lost, and each lifecycle
 * stage — are in the stage / status select beside the search box.
 *
 * It decides nothing itself: the rule is `inView` in the engine. The Nurture task
 * tile links to the nurture schedule and shows a figure only where the page that
 * mounts this passes one.
 * ------------------------------------------------------------------------- */

const SHADOW = "shadow-[0_1px_2px_rgba(22,22,22,0.06)]";

/** Views offered in the select beside the search box that have no tile of their own. */
const STATUS_VIEWS: DeskView[] = [
  "queue",
  "new",
  "today",
  "followups",
  "ready",
  "requested",
  "followup",
  "returned",
  "handed",
  "lost",
];

function salesTypeBadge(salesType: LeadSalesType | null): { tone: PTone; label: string } {
  if (salesType === "direct") return { tone: "neutral", label: "Direct" };
  if (salesType === "third_party") return { tone: "brand", label: "Third Party Customer" };
  if (salesType === "distributor") return { tone: "neutral", label: "Distributor" };
  return { tone: "muted", label: "Not Decided" };
}

/** After the manager has been asked, the three-call meter is still the honest picture of the lead. */
function showsCallMeter(phase: DeskPhase): boolean {
  return (
    isWorking(phase) ||
    phase === "ready" ||
    phase === "exhausted" ||
    phase === "requested" ||
    phase === "followup" ||
    phase === "returned"
  );
}

function deskLine(r: DeskLeadRow): string {
  /* A closed lead's old next action is history, not an instruction. */
  if (r.phase === "lost") return `Closed · ${r.responsible ?? "—"}`;
  return `${r.nextAction || "—"} · ${r.responsible ?? "—"}`;
}

function LeadRow({ r, base, day }: { r: DeskLeadRow; base: string; day: string }) {
  const due = dueLabel(r.phase, r.nextActionDate, day);
  const ladder = ladderFor(deskLadderSalesType(r.salesType));
  const meter = showsCallMeter(r.phase);
  const idx = r.ladderKey ? ladder.indexOf(r.ladderKey) : -1;
  const type = salesTypeBadge(r.salesType);
  const priority: PTone | null =
    r.priority === "high" ? "danger" : r.priority === "medium" ? "warn" : r.priority ? "neutral" : null;
  return (
    <Link
      href={`${base}/${r.id}`}
      className="flex items-center gap-3 border-b border-divider px-4 py-3 text-body no-underline last:border-0 hover:bg-canvas hover:no-underline"
    >
      <span className={cx("w-1 flex-none self-stretch rounded", rowBar(r.phase, r.nextActionDate, day))} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{r.name}</span>
          <PBadge tone={type.tone}>{type.label}</PBadge>
          {r.ladderKey ? <PBadge tone="brand">{LADDER_LABEL[r.ladderKey]}</PBadge> : null}
          {r.ladderKey && LADDER_LABEL[r.ladderKey] === PHASE_LABEL[r.phase] ? null : (
            <PBadge tone={PHASE_TONE[r.phase] as PTone}>{PHASE_LABEL[r.phase]}</PBadge>
          )}
          {r.priority && priority ? (
            <PBadge tone={priority}>{r.priority === "high" ? "High" : r.priority === "medium" ? "Medium" : "Low"}</PBadge>
          ) : null}
          {isCreatedToday(r.createdAt, day) ? <PBadge tone="brand">Created today</PBadge> : null}
        </span>
        <span className="block truncate text-[13px] text-muted">
          {r.city ? `${r.city} · ` : ""}
          {deskLine(r)}
        </span>
      </span>
      <span className="hidden w-[170px] flex-none text-[12px] text-muted md:block">
        <span className="block text-[10.5px] tracking-[0.05em] uppercase">Calls</span>
        {meter ? (
          <>
            <CallMeter phase={r.phase} outcomes={r.callOutcomes} />
            <span className="block">
              {r.answered} / {r.needed} needed for Prospect
            </span>
          </>
        ) : (
          <>
            <span className="block truncate font-medium text-ink">
              {idx >= 0 ? `Stage ${idx + 1} / ${ladder.length} · ` : ""}
              {r.ladderKey ? LADDER_LABEL[r.ladderKey] : "—"}
            </span>
            <span className="block">
              {r.callCount} Telecaller call{r.callCount === 1 ? "" : "s"}
            </span>
          </>
        )}
      </span>
      <span className="w-[104px] flex-none text-right">
        {r.phase === "ready" ? (
          <span className={pbtn("primary", true)}>Request</span>
        ) : (
          <>
            <span
              className={cx(
                "block text-[13px] leading-tight font-semibold",
                due.tone === "success" && "text-success",
                due.tone === "warn" && "text-warn-ink",
                due.tone === "danger" && "text-danger",
                due.tone === "muted" && "text-muted",
                due.tone === "body" && "text-body",
              )}
            >
              {due.text}
            </span>
            {due.sub ? <span className="block text-[11px] text-muted">{shortDate(due.sub)}</span> : null}
          </>
        )}
      </span>
    </Link>
  );
}

type Tile = {
  key: string;
  label: string;
  value: string;
  sub: string;
  tone?: "danger" | "warn";
  view?: DeskView;
  href?: string;
};

function TileCell({
  tile,
  active,
  onPick,
  className,
}: {
  tile: Tile;
  active: boolean;
  onPick: (v: DeskView) => void;
  className?: string;
}) {
  const body = (
    <>
      <div className="text-[10.5px] leading-[1.3] font-[650] tracking-[0.05em] text-muted uppercase">{tile.label}</div>
      <div
        className={cx(
          "mt-[3px] font-mono text-[23px] leading-7 font-[650]",
          tile.tone === "danger" ? "text-danger" : tile.tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {tile.value}
      </div>
      <div className="mt-px text-[11.5px] leading-[1.3] text-muted">{tile.sub}</div>
    </>
  );
  /* The dividers are the grid's own 1px gap, so a strip that wraps onto a second row still has
     clean lines between every tile instead of a border missing where a row ends. */
  const cell = cx(
    "px-[18px] py-3.5 text-left hover:bg-canvas",
    active ? "bg-brand-soft" : "bg-surface",
    className,
  );
  if (tile.href) {
    return (
      <Link href={tile.href} className={cx(cell, "block no-underline hover:no-underline")}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => tile.view && onPick(tile.view)} aria-pressed={active} className={cell}>
      {body}
    </button>
  );
}

export function Dashboard({
  all,
  day,
  initialView,
  greeting,
  base,
  intakeHref,
  canAssign,
  nurtureDue = null,
  nurtureHref = null,
}: {
  /** Every lead in the desk's book, lean. The tiles, the list and both cards are computed from these. */
  all: DeskLeadRow[];
  /** The business day, resolved on the server — a client may not read the clock while rendering. */
  day: string;
  initialView: DeskView;
  /** "Good morning, Priya" — resolved on the server, for the same reason. */
  greeting: string;
  /** `/crm/leads/calling-desk`, so no link here need spell it. */
  base: string;
  intakeHref: string;
  /** Whether this person may hand a lead to somebody, so the banner says how. */
  canAssign: boolean;
  /** A figure for the Nurture task tile, where the page has one; null draws "—" and a link to the schedule. */
  nurtureDue?: number | null;
  /** Where the Nurture task tile goes — the nurture schedule. */
  nurtureHref?: string | null;
}) {
  const [view, setView] = React.useState<DeskView>(initialView);
  const desk = React.useMemo(() => deskSummary(all, view, day), [all, view, day]);
  const t = desk.tiles;

  const choose = (v: DeskView) => {
    setView(v);
    try {
      window.history.replaceState(null, "", v === "all" ? base : `${base}?view=${v}`);
    } catch {
      /* the address bar is a courtesy; the list has already changed */
    }
  };
  const unowned = all.filter((r) => r.unassigned && r.phase !== "lost").length;

  /*
   * SEARCH, OVER `all` AND NOT OVER A TILE.
   *
   * `all` is the whole of the desk's own book — already narrowed by the same
   * `scopedToUsers(scopedUserIds(resolveScope().scope))` clause every tile
   * trusts — so filtering it client-side can never show a lead outside scope:
   * there is nothing here to show beyond what the server already sent. No new
   * query, no new round trip. While a search is typed it stands in for the
   * tile entirely — the whole point is finding a lead you already know exists,
   * wherever it happens to sit — and clearing it returns to whichever tile was
   * selected before.
   */
  const [query, setQuery] = React.useState("");
  const digitsOnly = (s: string) => s.replace(/\D/g, "");
  const q = query.trim().toLowerCase();
  const qDigits = digitsOnly(query);
  const searching = q.length > 0;
  const searchResults = React.useMemo(() => {
    if (!searching) return [];
    return all.filter((r) => {
      if (r.name.toLowerCase().includes(q)) return true;
      if (r.contactPerson && r.contactPerson.toLowerCase().includes(q)) return true;
      if (qDigits && r.phone && digitsOnly(r.phone).includes(qDigits)) return true;
      return false;
    });
  }, [all, q, qDigits, searching]);

  const rows = (searching ? searchResults : desk.rows).slice(0, DESK_LIST_CAP);

  const primary: Tile[] = [
    { key: "all", label: "All leads", value: String(t.all), sub: "in your book", view: "all" },
    {
      key: "suspect",
      label: "Suspect",
      value: String(t.suspect),
      sub: "at Suspect stage",
      tone: t.suspect ? "warn" : undefined,
      view: "suspect",
    },
    {
      key: "verify",
      label: "Verify prospect",
      value: String(t.verify),
      sub: "with the Sales Manager",
      tone: t.verify ? "warn" : undefined,
      view: "verify",
    },
    {
      key: "qualification",
      label: "Qualification review",
      value: String(t.qualification),
      sub: "in qualification",
      tone: t.qualification ? "warn" : undefined,
      view: "qualification",
    },
    {
      key: "sample",
      label: "Sample",
      value: String(t.sample),
      sub: "at sample / trial",
      tone: t.sample ? "warn" : undefined,
      view: "sample",
    },
    {
      key: "orders",
      label: "Order confirmation",
      value: String(t.orders),
      sub: "first order onward",
      tone: t.orders ? "warn" : undefined,
      view: "orders",
    },
    {
      key: "overdue",
      label: "Overdue",
      value: String(t.overdue),
      sub: "next action passed",
      tone: t.overdue ? "danger" : undefined,
      view: "overdue",
    },
    {
      key: "nurture",
      label: "Nurture task",
      value: nurtureDue === null ? "—" : String(nurtureDue),
      sub: nurtureDue === null ? "open the schedule" : "assigned to you",
      tone: nurtureDue ? "warn" : undefined,
      href: nurtureHref ?? undefined,
    },
  ];
  const calls: Tile[] = [
    { key: "call1", label: "Call 1", value: String(t.call1), sub: "first call to make", tone: t.call1 ? "warn" : undefined, view: "call1" },
    { key: "call2", label: "Call 2", value: String(t.call2), sub: "one attempt used", tone: t.call2 ? "warn" : undefined, view: "call2" },
    { key: "call3", label: "Call 3", value: String(t.call3), sub: "last attempt", tone: t.call3 ? "danger" : undefined, view: "call3" },
  ];

  const heading = searching
    ? `Search results for “${query.trim()}”`
    : view === "all"
      ? "Leads"
      : DESK_VIEW_LABEL[view];
  const shownTotal = searching ? searchResults.length : desk.total;
  const selectValue = LADDER.includes(view as never) || STATUS_VIEWS.includes(view) ? view : "";
  const callView = view === "call1" || view === "call2" || view === "call3";

  return (
    <PPage>
      <PPageHead
        eyebrow="Telecaller desk"
        title={greeting}
        sub="Your online leads. Open a lead to make its call, send a message, or put it forward as a Prospect — at most three calls each."
        actions={
          <>
            <button type="button" onClick={() => choose("all")} className={pbtn("secondary")}>
              <DeskIcon name="chart" size={15} />
              Show all my leads
            </button>
            <OutsideLeadHub>
              <Link href={intakeHref} className={cx(pbtn("primary"), "no-underline hover:text-white hover:no-underline")}>
                <DeskIcon name="plus" size={15} />
                New lead
              </Link>
            </OutsideLeadHub>
          </>
        }
      />

      {/* Leads nobody owns are on no telecaller's desk. Only somebody whose scope is wider than
          one book can see them at all, so this is drawn for exactly the people who can act on it. */}
      {unowned > 0 ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warn-line bg-warn-soft px-4 py-2.5 text-[13px] text-warn-ink">
          <span>
            <b>
              {unowned} {unowned === 1 ? "lead has" : "leads have"} no owner yet
            </b>{" "}
            and {unowned === 1 ? "is" : "are"} on no telecaller&rsquo;s desk.{" "}
            {canAssign ? "Open one and use Assign." : "Ask whoever manages the desk to assign them."}
          </span>
          <button type="button" onClick={() => choose("unassigned")} className={pbtn("ghost", true)}>
            Show them
          </button>
        </div>
      ) : null}

      {/* ------------------------------------------------------ row 1 */}
      <div
        className={cx(
          "mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-divider sm:grid-cols-4 xl:grid-cols-8",
          SHADOW,
        )}
      >
        {primary.map((tile) => (
          <TileCell key={tile.key} tile={tile} active={tile.view === view} onPick={choose} />
        ))}
      </div>

      {/* ------------------------------------------------------ row 2 */}
      <div className={cx("mb-4 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-divider sm:grid-cols-3", SHADOW)}>
        {calls.map((tile) => (
          <TileCell key={tile.key} tile={tile} active={tile.view === view} onPick={choose} />
        ))}
      </div>

      {callView ? (
        <p className="mb-3 text-[12.5px] text-muted">
          Call a lead as often as it takes. Get every answer a Prospect needs and it is
          Ready for Prospect — then you <b>request</b> the conversion. The Sales Manager verifies what you collected; only then
          is it a Prospect. A lead is only Lost by a decision, never because calls ran out.
        </p>
      ) : null}

      {/* ------------------------------------------------------ toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <PSectionLabel className="mr-auto mb-0">
          {heading} · {shownTotal}
        </PSectionLabel>
        {searching ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="cursor-pointer text-[12.5px] font-medium text-brand-hover hover:underline"
          >
            Clear search
          </button>
        ) : view !== "all" ? (
          <button
            type="button"
            onClick={() => choose("all")}
            className="cursor-pointer text-[12.5px] font-medium text-brand-hover hover:underline"
          >
            Show all leads
          </button>
        ) : null}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, contact, phone…"
          aria-label="Search your leads by business name, contact or phone"
          className="h-8 w-[280px] max-w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand"
        />
        <select
          value={selectValue}
          onChange={(e) => choose((e.target.value || "all") as DeskView)}
          aria-label="Filter by stage or status"
          className="h-8 rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink"
        >
          <option value="">All stages</option>
          <optgroup label="Stage">
            {LADDER.map((k) => (
              <option key={k} value={k}>
                {k === "suspect" ? "Suspect (calls, requests, returns)" : LADDER_LABEL[k]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Status">
            {STATUS_VIEWS.map((v) => (
              <option key={v} value={v}>
                {DESK_VIEW_LABEL[v]}
                {` (${t[v]})`}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {/* ------------------------------------------------------ list */}
      <PCard className="overflow-hidden">
        {rows.length === 0 ? (
          <PEmpty
            title="Nothing here"
            body={
              searching
                ? "No lead in your book matches that — try a shorter name or just the digits of the phone number."
                : view === "queue"
                  ? "No calls or follow-ups are due. Every lead has its next step scheduled ahead."
                  : "No leads match this filter."
            }
          />
        ) : (
          rows.map((r) => <LeadRow key={r.id} r={r} base={base} day={day} />)
        )}
      </PCard>
      {shownTotal > rows.length ? (
        <p className="mt-2 text-[12px] text-muted">
          Showing the first {rows.length} of {shownTotal}.
          {searching ? "" : " The figures above count every one."}
        </p>
      ) : null}
    </PPage>
  );
}
