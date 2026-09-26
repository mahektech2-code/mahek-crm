"use client";

import * as React from "react";
import Link from "next/link";
import { Badge, Card, SectionLabel, cx } from "@/components/ui/primitives";
import { shortDate } from "@/lib/format";
import { ladderFor } from "@/lib/engines/lead-ladder";
import {
  DESK_VIEW_LABEL,
  MAX_QUALIFICATION_CALLS,
  deskLadderSalesType,
  isWorking,
  type DeskView,
} from "@/lib/engines/lead-calling-desk";
import { LADDER_LABEL, dueLabel, rowBar, shortDay } from "@/lib/calling-desk-labels";
import { DESK_LIST_CAP, deskSummary, type DeskLeadRow } from "@/lib/calling-desk-summary";
import { CallMeter, DeskIcon, LeadStatusBadges, MetricStrip, PhaseBadge } from "./desk-parts";

/* ---------------------------------------------------------------------------
 * The Telecaller dashboard — Version 6, drawn from the real book.
 *
 * Header and greeting; the first strip of five; "The 3-call rule" strip of
 * eight; the twelve-rung lifecycle; and below them the lead list beside the two
 * side cards.
 *
 * PRESSING A FIGURE FILTERS THE LIST ON THIS SCREEN and goes nowhere: it does
 * not navigate and it does not scroll. The page holds every lead the desk may
 * see (a book of a few hundred, lean) and asks `deskSummary` — the same pure
 * function the server ran for the first paint — which is what keeps "a tile that
 * says 14 opens a list of 14" true after the filter changes. The view is written
 * to the address bar with `replaceState`, so a desk with "Call 2 pending" open
 * is still a link somebody can send, and Back does not walk through every tile
 * that was pressed.
 *
 * It decides nothing itself: the rule is `inView` in the engine.
 * ------------------------------------------------------------------------- */

function deskLine(r: DeskLeadRow): string {
  /* A closed lead's old next action is history, not an instruction. */
  if (r.phase === "lost") return `Closed · ${r.responsible ?? "—"}`;
  return `${r.nextAction || "—"} · ${r.responsible ?? "—"}`;
}

function LeadRow({ r, base, day }: { r: DeskLeadRow; base: string; day: string }) {
  const due = dueLabel(r.phase, r.nextActionDate, day);
  const ladder = ladderFor(deskLadderSalesType(r.salesType));
  const suspect = isWorking(r.phase) || r.phase === "ready";
  const idx = r.ladderKey ? ladder.indexOf(r.ladderKey) : -1;
  return (
    <Link
      href={`${base}/${r.id}`}
      className="flex items-center gap-3 border-b border-divider px-4 py-3 text-body no-underline last:border-0 hover:bg-canvas hover:no-underline"
    >
      <span className={cx("w-1 flex-none self-stretch rounded", rowBar(r.phase, r.nextActionDate, day))} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{r.name}</span>
          <LeadStatusBadges salesType={r.salesType} phase={r.phase} priority={r.priority} />
        </span>
        <span className="block truncate text-[13px] text-muted">{deskLine(r)}</span>
      </span>
      <span className="hidden flex-none flex-col items-end gap-1 sm:flex">
        {!suspect ? (
          <>
            <span className="text-[12px] font-medium text-ink">
              {idx >= 0 ? `Stage ${idx + 1} / ${ladder.length} · ` : ""}
              {r.ladderKey ? LADDER_LABEL[r.ladderKey] : "—"}
            </span>
            <span className="text-[11px] text-muted">
              {r.callCount} Telecaller call{r.callCount === 1 ? "" : "s"}
            </span>
          </>
        ) : (
          <>
            <CallMeter phase={r.phase} outcomes={r.callOutcomes} />
            <span className="text-[11px] text-muted">
              {r.answered} / {r.required} required answers
            </span>
          </>
        )}
      </span>
      <span className="w-[92px] flex-none text-right">
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
      </span>
    </Link>
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
}) {
  const [view, setView] = React.useState<DeskView>(initialView);
  const desk = React.useMemo(() => deskSummary(all, view, day), [all, view, day]);
  const t = desk.tiles;

  const choose = (v: DeskView) => {
    setView(v);
    try {
      window.history.replaceState(null, "", v === "queue" ? base : `${base}?view=${v}`);
    } catch {
      /* the address bar is a courtesy; the list has already changed */
    }
  };
  const unowned = all.filter((r) => r.unassigned && r.phase !== "lost").length;
  const pipeline = () => {
    choose("all");
    document.getElementById("lead-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const rows = desk.rows.slice(0, DESK_LIST_CAP);
  const ready = desk.ready.slice(0, 8);
  const pending = desk.pending.slice(0, 8);

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <div className="flex items-center justify-between">
        <div className="text-[10.5px] font-semibold tracking-[0.06em] text-muted uppercase">
          Telecaller workspace
        </div>
      </div>

      {/* ------------------------------------------------------ header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 text-[28px] leading-[34px] font-semibold text-ink">{greeting}</h1>
          <p className="mt-1 mb-0 text-[13px] leading-[18px] text-muted">
            Online leads, handled entirely by phone and message — at most three calls each. Prospects
            are confirmed by the Sales Manager.
          </p>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <button
            type="button"
            onClick={pipeline}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
          >
            <DeskIcon name="chart" size={15} />
            View pipeline
          </button>
          <Link
            href={intakeHref}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:border-brand-hover hover:bg-brand-hover hover:text-white hover:no-underline"
          >
            <DeskIcon name="plus" size={15} />
            New lead
          </Link>
        </div>
      </div>

      {/* Leads nobody owns are on no telecaller's desk. Only somebody whose scope is wider than
          one book can see them at all, so this is drawn for exactly the people who can act on it. */}
      {unowned > 0 ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-[4px] border border-warn-line bg-warn-soft px-4 py-2.5 text-[13px] text-warn-ink">
          <span>
            <b>
              {unowned} {unowned === 1 ? "lead has" : "leads have"} no owner yet
            </b>{" "}
            and {unowned === 1 ? "is" : "are"} on no telecaller&rsquo;s desk.{" "}
            {canAssign ? "Open one and use Assign." : "Ask whoever manages the desk to assign them."}
          </span>
          <button
            type="button"
            onClick={() => choose("unassigned")}
            className="cursor-pointer rounded-[4px] border border-warn-line bg-surface px-2.5 py-1 text-[13px] font-medium text-warn-ink"
          >
            Show them
          </button>
        </div>
      ) : null}

      {/* --------------------------------------------- first strip of five */}
      <MetricStrip
        onSelect={choose}
        metrics={[
          { label: "Total leads", value: String(t.all), sub: "online, in your book", view: "all" },
          { label: "New online leads", value: String(t.new), sub: "not called yet", view: "new" },
          { label: "Calls due today", value: String(t.today), sub: "scheduled for today", view: "today" },
          { label: "Follow-ups due", value: String(t.followups), sub: "messages due today", view: "followups" },
          {
            label: "Overdue",
            value: String(t.overdue),
            tone: t.overdue ? "danger" : "ink",
            sub: "calls and follow-ups late",
            view: "overdue",
          },
        ]}
      />

      {/* ------------------------------------------------ the 3-call rule */}
      <SectionLabel>The 3-call rule — where every lead stands</SectionLabel>
      <div className="mt-1.5">
        <MetricStrip
          onSelect={choose}
          metrics={[
            { label: "Call 1 pending", value: String(t.call1), sub: "first call to make", view: "call1" },
            { label: "Call 2 pending", value: String(t.call2), sub: "one attempt used", view: "call2" },
            {
              label: "Call 3 pending",
              value: String(t.call3),
              tone: t.call3 ? "danger" : "ink",
              sub: "last attempt",
              view: "call3",
            },
            { label: "Ready for Prospect", value: String(t.ready), tone: "success", sub: "request conversion", view: "ready" },
            {
              label: "Awaiting verification",
              value: String(t.verify),
              tone: t.verify ? "warn" : "ink",
              sub: "with the Sales Manager",
              view: "verify",
            },
            {
              label: "Returned",
              value: String(t.returned),
              tone: t.returned ? "danger" : "ink",
              sub: "verification failed",
              view: "returned",
            },
            { label: "With Sales Manager", value: String(t.handed), sub: "requested or confirmed", view: "handed" },
            { label: "Lost", value: String(t.lost), sub: "closed", view: "lost" },
          ]}
        />
      </div>
      <p className="mt-0 mb-4 text-[13px] text-muted">
        Each lead gets at most {MAX_QUALIFICATION_CALLS} calls. Get every required answer within them and it is
        Ready for Prospect — then you <b>request</b> the conversion. The Sales Manager verifies what you
        collected; only then is it a Prospect. Run out of calls without the answers and it is Lost.
      </p>

      {/* ------------------------------------------------- the lifecycle */}
      <SectionLabel>Lifecycle — every lead, stage by stage</SectionLabel>
      <div className="mt-1.5">
        <Card className="mb-5 overflow-hidden">
          <div className="flex overflow-x-auto">
            {desk.lifecycle.map((c, i) => {
              const target = c.key as DeskView;
              const active = view === target;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => choose(target)}
                  title={`Show ${LADDER_LABEL[c.key].toLowerCase()}`}
                  className={cx(
                    "min-w-[92px] flex-1 cursor-pointer border-r border-divider px-3 py-3 text-left last:border-r-0 hover:bg-canvas",
                    active ? "bg-brand-soft" : "",
                  )}
                >
                  <div className="text-[10.5px] font-medium tracking-[0.04em] text-muted uppercase">
                    {i + 1}. {LADDER_LABEL[c.key]}
                  </div>
                  <div className="mt-0.5 text-[20px] leading-6 font-semibold text-ink">{c.count}</div>
                  <div className={cx("text-[11px]", c.waiting ? "font-medium text-warn-ink" : "text-muted")}>
                    {c.waiting
                      ? `+${c.waiting} awaiting verification`
                      : c.key === "suspect"
                        ? "calls in progress"
                        : c.key === "customer"
                          ? "won"
                          : " "}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      </div>

      {/* --------------------------------------------- list + side cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.7fr_1fr]">
        <div id="lead-list">
          <div className="flex items-center justify-between">
            <SectionLabel>{DESK_VIEW_LABEL[view]}</SectionLabel>
            {view !== "queue" ? (
              <button
                type="button"
                onClick={() => choose("queue")}
                className="cursor-pointer text-[12.5px] font-medium text-brand-hover hover:underline"
              >
                Back to today&rsquo;s work queue
              </button>
            ) : null}
          </div>
          <Card className="mt-1.5">
            {rows.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <div className="text-sm font-semibold text-ink">Nothing here</div>
                <div className="mt-1 text-[13px] text-muted">
                  {view === "queue"
                    ? "No calls or follow-ups are due. Every lead has its next step scheduled ahead."
                    : "No leads match this filter."}
                </div>
              </div>
            ) : (
              rows.map((r) => <LeadRow key={r.id} r={r} base={base} day={day} />)
            )}
          </Card>
          {desk.total > rows.length ? (
            <p className="mt-2 text-[12px] text-muted">
              Showing the first {rows.length} of {desk.total}. The figures above count every one.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <SectionLabel>Ready for Prospect</SectionLabel>
            <Card className="mt-1.5">
              {ready.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted">
                  Nothing ready yet. A lead lands here the moment its last required answer is in.
                </div>
              ) : (
                ready.map((r) => (
                  <Link
                    key={r.id}
                    href={`${base}/${r.id}`}
                    className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 text-body no-underline last:border-0 hover:bg-canvas hover:no-underline"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {r.callCount} call{r.callCount === 1 ? "" : "s"} used · {r.responsible ?? "—"}
                      </span>
                    </span>
                    <Badge tone="success" className="flex-none">
                      Request
                    </Badge>
                  </Link>
                ))
              )}
            </Card>
          </div>

          <div>
            <SectionLabel>Prospect requests with the Sales Manager</SectionLabel>
            <Card className="mt-1.5">
              {pending.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted">
                  No requests waiting. Once you request a Prospect it is tracked here until the Sales
                  Manager decides.
                </div>
              ) : (
                pending.map((r) => (
                  <Link
                    key={r.id}
                    href={`${base}/${r.id}`}
                    className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 text-body no-underline last:border-0 hover:bg-canvas hover:no-underline"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                      <span className="block truncate text-[12px] text-muted">
                        Requested {shortDay(r.requestedAt)}
                        {r.phase !== "returned" && r.responsible ? ` · ${r.responsible}` : ""}
                      </span>
                    </span>
                    <PhaseBadge phase={r.phase} />
                  </Link>
                ))
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
