"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { Button } from "@/components/ui/primitives";
import { Pill } from "@/components/console/parts";
import { CardGrid } from "@/components/ui/card-grid";
import { plural } from "@/components/console/words";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { daysBetween, shortDate } from "@/lib/format";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import { checklistFor, type GateVerdict } from "@/lib/engines/lead-gates";
import type { LeadRecord } from "@/lib/services/lead-console-service";
import type { ActionOwnerCandidate } from "@/lib/services/lead-actions-service";
import { NextActionModal } from "@/components/leads/actions/due-screen";
import { AdvanceStage } from "./advance-stage";
import { AnswerLink, ConvertButton } from "./convert-to-prospect";

/* ---------------------------------------------------------------------------
 * The lead record's frame, drawn the way the Leads frame draws everything
 * else: a card per question, the ladder across the top, and the actions that
 * change who or what the lead is behind one ⋯ menu.
 *
 * Nothing here decides anything. The verdicts, the next rung and the seats
 * all arrive from the server exactly as the old record received them; this
 * file only lays them out.
 * ------------------------------------------------------------------------- */

export function Card({
  title,
  action,
  label,
  className,
  children,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  /** The section's accessible name, where the title is not plain text. */
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      className={cx("rounded-[10px] border border-line bg-surface p-[18px]", className)}
    >
      {title || action ? (
        <div className="mb-3 flex items-center gap-2.5">
          {title ? (
            <h2 className="m-0 flex-1 text-[15px] leading-5 font-semibold text-ink">{title}</h2>
          ) : (
            <span className="flex-1" />
          )}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A label over a value, the shape every fact on the record takes. */
export function KV({
  k,
  v,
  tone,
  className,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  tone?: "warn" | "faint";
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="text-xs text-muted">{k}</div>
      <div
        className={cx(
          "mt-0.5 truncate text-sm font-medium",
          tone === "warn" ? "text-warn-ink" : tone === "faint" ? "text-faint" : "text-ink",
        )}
      >
        {v}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- ⋯ menu */

/**
 * The record's other actions, one menu.
 *
 * Every item is the SAME component the old header drew as a button — its
 * capability check, its disabled reason and its dialog all come with it. The
 * menu stays mounted while closed (hidden, not unmounted) because each item
 * owns its dialog's state: unmounting on close would take the dialog the item
 * just opened with it. The dialogs render into the body, so hiding the menu
 * never hides them.
 */
export function MoreMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function away(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-line bg-surface text-body hover:bg-canvas"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      <div
        role="menu"
        onClickCapture={(e) => {
          /* A press on an enabled item opens its dialog; the menu closes
             behind it. A disabled item keeps the menu open so its reason can
             be read on hover. */
          const b = (e.target as HTMLElement).closest("button");
          if (b && !b.disabled) setOpen(false);
        }}
        className={cx(
          "absolute top-full right-0 z-40 mt-1 min-w-[220px] flex-col rounded-[8px] border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(22,22,22,0.12)]",
          "[&_button]:!flex [&_button]:!h-9 [&_button]:!w-full [&_button]:!justify-start [&_button]:!rounded-[6px] [&_button]:!border-0 [&_button]:!bg-transparent [&_button]:!px-3 [&_button]:!text-[13px] [&_button]:!font-normal [&_button]:!text-body [&_button]:!shadow-none [&_button:not(:disabled):hover]:!bg-canvas",
          open ? "flex" : "hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** A destructive item: same row, red words. */
export function MenuDanger({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 border-t border-divider pt-1 [&_button]:!text-danger">{children}</div>
  );
}

/* ---------------------------------------------------------- the ladder */

/**
 * The whole climb as one row of bars — done and current in brand, the rest
 * grey. A parked lead stands off its ladder, so nothing is lit; the header's
 * On hold pill says so.
 */
export function LadderStepper({
  ladder,
  rung,
  parked,
  name,
}: {
  ladder: readonly LeadStage[];
  rung: number;
  parked: boolean;
  /** Which ladder this is, in words, for the hover and screen readers. */
  name: string;
}) {
  return (
    <ol
      aria-label={name}
      title={name}
      className="m-0 flex list-none gap-1.5 overflow-x-auto p-0 pb-0.5"
    >
      {ladder.map((stage, i) => {
        const past = !parked && rung >= 0 && i < rung;
        const here = !parked && i === rung;
        return (
          <li
            key={stage}
            aria-current={here ? "step" : undefined}
            className="flex min-w-[72px] flex-1 flex-col gap-1.5"
          >
            <span
              className={cx("h-1.5 rounded-full", past || here ? "bg-brand" : "bg-line")}
            />
            <span
              className={cx(
                "truncate text-[11.5px]",
                here ? "font-semibold text-ink" : past ? "text-body" : "text-faint",
              )}
              title={stageLabel(stage)}
            >
              {stageLabel(stage)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------- the next step */

/** "Today", "In 3 days", "2 days late". */
function dueWords(days: number): string {
  if (days === 0) return "Today";
  if (days > 0) return `In ${plural(days, "day")}`;
  return `${plural(-days, "day")} late`;
}

/**
 * §24 — the action, the day, the person and what they come back with. All
 * three of the first or none: a date with nobody against it is drawn as no
 * next step, the same rule the old band kept.
 */
export function NextStepCard({
  record,
  active,
  nowMs,
  day,
  candidates,
  requireNextAction,
  canWork,
}: {
  record: LeadRecord;
  /** False on a closed or parked lead, where owing nothing is correct. */
  active: boolean;
  nowMs: number;
  day: string;
  candidates: ActionOwnerCandidate[];
  requireNextAction: boolean;
  canWork: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const complete =
    Boolean(record.nextAction) &&
    Boolean(record.nextActionDate) &&
    Boolean(record.nextActionOwnerId);

  if (!complete && !active) return null;

  const days = complete
    ? daysBetween(calendarDate(new Date(nowMs), APP_TIMEZONE), record.nextActionDate!)
    : 0;
  const late = complete && days < 0;
  const missing = !complete;

  const change = (
    <Button
      size="sm"
      disabled={!canWork}
      title={canWork ? undefined : "Working a lead is the salesman's and the manager's."}
      onClick={() => setEditing(true)}
    >
      {missing ? "Set next step" : "Change"}
    </Button>
  );

  return (
    <>
      <section
        aria-label="Next step"
        className={cx(
          "flex flex-wrap items-center gap-3.5 rounded-[10px] border px-[18px] py-3.5",
          missing || late ? "border-[#f2c4c0] bg-[#fffafa]" : "border-line bg-surface",
        )}
      >
        {missing ? (
          <Pill tone="danger">No next step</Pill>
        ) : (
          <Pill tone={late ? "danger" : days === 0 ? "warn" : "neutral"}>{dueWords(days)}</Pill>
        )}
        <div className="min-w-[220px] flex-1">
          {missing ? (
            <div className="text-sm font-semibold text-ink">Nothing is owed by anybody</div>
          ) : (
            <>
              <div className="text-sm font-semibold text-ink">{record.nextAction}</div>
              <div className="text-xs text-muted">
                {shortDate(record.nextActionDate!)} · {record.nextActionOwnerName ?? "somebody"}
                {record.nextActionOutcome ? ` · Back with: ${record.nextActionOutcome}` : ""}
              </div>
            </>
          )}
        </div>
        {change}
      </section>
      <NextActionModal
        row={
          editing
            ? {
                customerId: record.customerId,
                name: record.name,
                companyName: record.companyName,
                city: record.city,
                salesType: record.salesType,
                stage: record.stage,
                action: record.nextAction,
                actionDate: record.nextActionDate,
                ownerId: record.nextActionOwnerId,
                ownerName: record.nextActionOwnerName,
                outcome: record.nextActionOutcome,
                salesmanId: record.salesmanId,
                salesmanName: record.salesmanName,
                leadManagerId: record.leadManagerId,
                leadManagerName: record.leadManagerName,
                stuckDays: record.stuckDays,
                quietDays: record.quietDays,
                overdueDays: late ? -days : 0,
                holdResumeDate: null,
                holdReason: null,
                holdReasonCode: null,
                parkedFrom: null,
              }
            : null
        }
        day={day}
        candidates={candidates}
        requireNextAction={requireNextAction}
        onClose={() => setEditing(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------ the gate */

/**
 * "To reach X" — what the next rung asks, ticked where it is met. The
 * checklist is `checklistFor`, the same list the gate refuses on; the ticks
 * are whatever the server's verdict did NOT name as missing. Conditions the
 * verdict adds beyond the list (the next action, a manager's review) are drawn
 * as missing in their own words.
 */
export function GateCard({
  record,
  base,
  verdict,
  nextRung,
  parked,
  canWork,
  canOverride,
  overrideAllowed,
  fixes,
}: {
  record: LeadRecord;
  base: string;
  verdict: GateVerdict;
  nextRung: LeadStage | null;
  parked: boolean;
  canWork: boolean;
  canOverride: boolean;
  overrideAllowed: boolean;
  /** Condition id → where it is answered. */
  fixes: Record<string, { label: string; tab: string }>;
}) {
  if (verdict.noNextRung) {
    return (
      <Card title={parked ? "On hold" : "Top of the ladder"}>
        <p className="m-0 text-sm text-body">
          {parked ? "Nothing moves until it comes off hold." : `${stageLabel(record.stage)} is the last stage.`}
        </p>
      </Card>
    );
  }

  const to = nextRung ?? verdict.to;
  const missingIds = new Set(verdict.missing.map((m) => m.id));
  const listed = checklistFor(record.salesType, record.stage);
  const done = listed.filter((c) => !missingIds.has(c.id));

  return (
    <Card
      label={`To reach ${stageLabel(to)}`}
      title={`To reach ${stageLabel(to)}`}
      action={
        verdict.open ? (
          <Pill tone="success">Ready</Pill>
        ) : (
          <Pill tone="warn">{verdict.missing.length} missing</Pill>
        )
      }
    >
      <ul className="m-0 list-none p-0">
        {done.map((c) => (
          <li key={c.id} className="flex items-center gap-2.5 border-t border-divider py-2">
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success-soft text-xs text-success">
              ✓
            </span>
            <span className="flex-1 text-sm text-ink">{c.says}</span>
            <span className="text-xs text-muted">Done</span>
          </li>
        ))}
        {verdict.missing.map((c) => {
          const fix = fixes[c.id];
          return (
            <li key={c.id} className="flex items-center gap-2.5 border-t border-divider py-2">
              <span className="h-5 w-5 flex-none rounded-full border border-warn-line bg-warn-soft" />
              <span className="flex-1 text-sm text-ink">{c.says}</span>
              {fix ? (
                <Link href={`${base}?tab=${fix.tab}`} className="text-xs whitespace-nowrap">
                  {fix.label}
                </Link>
              ) : to === "prospect" ? (
                <AnswerLink />
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {to === "prospect" ? <ConvertButton label="Convert to Prospect…" size="sm" /> : null}
        <AdvanceStage
          customerId={record.customerId}
          to={nextRung ?? null}
          verdict={verdict}
          canWork={canWork}
          canOverride={canOverride && Boolean(nextRung) && !verdict.open}
          overrideAllowed={overrideAllowed}
        />
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------- people */

export type PersonRow = {
  k: string;
  v: string | null;
  /** Shown where nobody holds the seat. */
  none?: string;
  /** Warn where an empty seat is a gap rather than a fact. */
  warnIfNone?: boolean;
  act?: React.ReactNode;
};

export function PeopleCard({ rows }: { rows: PersonRow[] }) {
  return (
    <Card title="People">
      <div>
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-center gap-2.5 border-t border-divider py-2 first:border-t-0"
          >
            <span className="w-[120px] flex-none text-xs text-muted">{r.k}</span>
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-sm",
                r.v ? "text-ink" : r.warnIfNone ? "text-warn-ink" : "text-muted",
              )}
            >
              {r.v ?? r.none ?? "Nobody"}
            </span>
            {r.act ? (
              <span className="flex-none [&_button]:!h-auto [&_button]:!border-0 [&_button]:!bg-transparent [&_button]:!p-0 [&_button]:!text-xs [&_button]:!font-normal [&_button]:!text-brand [&_button:disabled]:!text-faint [&_button:not(:disabled):hover]:!underline">
                {r.act}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------- calls */

export type CallBox = {
  n: number;
  state: string;
  tone: "success" | "danger" | "warn" | "neutral";
  sub: string;
  hot?: boolean;
};

export function CallsVisitsCard({
  calls,
  visits,
  action,
}: {
  calls: CallBox[];
  visits: { date: string | null; who: string | null }[];
  action?: React.ReactNode;
}) {
  const who = Array.from(new Set(visits.map((v) => v.who).filter(Boolean)));
  return (
    <Card title="Calls and visits" action={action}>
      {calls.length ? (
        <CardGrid min={150} gap="gap-2.5">
          {calls.map((c) => (
            <div
              key={c.n}
              className={cx(
                "rounded-[8px] border border-line p-3",
                c.hot ? "bg-[#fffafa]" : "bg-surface",
              )}
            >
              <div className="flex items-center gap-1.5">
                <strong className="flex-1 text-sm font-semibold text-ink">Call {c.n}</strong>
                <Pill tone={c.tone}>{c.state}</Pill>
              </div>
              <div className="mt-1.5 text-xs text-muted">{c.sub}</div>
            </div>
          ))}
        </CardGrid>
      ) : null}
      <div className={cx("text-xs text-muted", calls.length ? "mt-3" : "")}>
        {visits.length
          ? `Visits: ${visits
              .map((v) => (v.date ? shortDate(v.date) : "no check-in"))
              .join(", ")}${who.length ? ` · ${who.join(", ")}` : ""}`
          : "No visits"}
      </div>
    </Card>
  );
}
