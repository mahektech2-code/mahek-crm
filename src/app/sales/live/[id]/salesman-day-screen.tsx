"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays } from "@/lib/business-date";
import { accountTypeLabel } from "@/lib/account-types";
import { dwellStops } from "@/lib/engines/dwell";
import { tripColour } from "@/lib/engines/trail-trips";
import {
  buildDayTimeline,
  metresWords,
  minutesWords,
  type DayActivity,
  type TimelineItem,
} from "@/lib/engines/salesman-day";
import { money } from "@/lib/format";
import { activityLabel, locationReason } from "@/lib/mbos/activity-labels";
import type { ActivityPoint, TrackPoint } from "@/lib/services/sales-service";
import type {
  DayAct,
  DayOrder,
  DayPayment,
  SalesmanDayDetail,
} from "@/lib/services/salesman-day-service";
import { CustomerName } from "@/components/console/customer-name";
import { VISIT_OUTCOME_LABEL, label, plural } from "@/components/console/words";
import { cx } from "@/components/ui/primitives";
import { SalesIcon, type SalesIconName } from "@/components/console/icons";
import { avatarTone } from "../../avatar-tone";
import { CardGrid } from "@/components/ui/card-grid";
import { StreetMap } from "../street-map";
import { useLiveFeed } from "../use-live-feed";

/* ---------------------------------------------------------------------------
 * One salesman's day: his map on the left, everything he did on the right.
 *
 * THE MAP IS LIVE AND THE TIMELINE KEEPS UP WITH IT. The trail comes down the
 * same feed the Live map uses (`useLiveFeed`), narrowed to him, so his line
 * grows while the tab is open; the travel legs and the unexplained stops in the
 * timeline are worked out in the browser from that same trail by the same
 * engines that draw it. The visits, orders and other acts are the server's
 * read and are asked for again every minute on today — a new visit appears
 * without anybody reloading.
 *
 * NO SWITCHER. This page is opened in a tab of its own for one man; the way to
 * somebody else is to close it and pick them from the team.
 * ------------------------------------------------------------------------- */

const REFRESH_MS = 60_000;
const CLOCK_MS = 30_000;

type Options = {
  gapMetres: number;
  dwellRadiusMetres: number;
  dwellMinMinutes: number;
  tripBreakMinutes: number;
  staleAfterSeconds: number;
  pushSeconds: number;
  pollSeconds: number;
};

export function SalesmanDayScreen({
  day,
  isToday,
  today,
  detail,
  activity,
  olaMapsKey,
  olaKeysSpent,
  nowMs,
  options,
}: {
  day: string;
  isToday: boolean;
  today: string;
  detail: SalesmanDayDetail;
  activity: ActivityPoint[];
  olaMapsKey: string | null;
  olaKeysSpent: boolean;
  nowMs: number;
  options: Options;
}) {
  const router = useRouter();
  const id = detail.person.salesmanId;

  const { frame } = useLiveFeed({
    day,
    view: "today",
    isToday,
    initial: {
      rows: [detail.person],
      tracks: new Map([[id, detail.trail]]),
      activity,
      cursorMs: nowMs,
    },
    pushSeconds: options.pushSeconds,
    pollSeconds: options.pollSeconds,
  });

  /* The feed carries the whole team in scope; this page is one man. */
  const rows = React.useMemo(() => frame.rows.filter((r) => r.salesmanId === id), [frame.rows, id]);
  const person = rows[0] ?? detail.person;
  const trail: TrackPoint[] = React.useMemo(() => frame.tracks.get(id) ?? [], [frame.tracks, id]);
  const tracks = React.useMemo(() => new Map([[id, trail]]), [id, trail]);
  const marks = React.useMemo(() => frame.activity.filter((a) => a.salesmanId === id), [frame.activity, id]);
  const dwells = React.useMemo(
    () => new Map([[id, dwellStops(trail, options.dwellRadiusMetres, options.dwellMinMinutes)]]),
    [id, trail, options.dwellRadiusMetres, options.dwellMinMinutes],
  );

  const [clockMs, setClockMs] = React.useState(nowMs);
  React.useEffect(() => {
    if (!isToday) return;
    const tick = setInterval(() => setClockMs(Date.now()), CLOCK_MS);
    const refresh = setInterval(() => router.refresh(), REFRESH_MS);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [isToday, router]);

  const [fullscreen, setFullscreen] = React.useState(false);

  const visitsById = React.useMemo(() => new Map(detail.visits.map((v) => [v.id, v])), [detail.visits]);
  const ordersById = React.useMemo(() => new Map(detail.orders.map((o) => [o.id, o])), [detail.orders]);
  const paymentsById = React.useMemo(() => new Map(detail.payments.map((p) => [p.id, p])), [detail.payments]);
  const actsById = React.useMemo(
    () => new Map(detail.acts.map((a) => [`${a.entityType}:${a.entityId}`, a])),
    [detail.acts],
  );

  const { items, summary } = React.useMemo(() => {
    const sessions = (detail.attendance?.sessions ?? [])
      .filter((s) => s.inAt)
      .map((s) => ({ inAt: new Date(s.inAt!), outAt: s.outAt ? new Date(s.outAt) : null }));
    /* A row written before sessions existed carries only the two marks. */
    if (!sessions.length && detail.attendance?.checkInAt) {
      sessions.push({
        inAt: new Date(detail.attendance.checkInAt),
        outAt: detail.attendance.checkOutAt ? new Date(detail.attendance.checkOutAt) : null,
      });
    }
    const acts: DayActivity[] = [
      ...detail.orders.map((o) => ({ entityType: "order", entityId: o.id, at: new Date(o.at) })),
      ...detail.payments.map((p) => ({ entityType: "payment", entityId: p.id, at: new Date(p.at) })),
      ...detail.acts.map((a) => ({ entityType: a.entityType, entityId: a.entityId, at: new Date(a.at) })),
    ];
    return buildDayTimeline(
      {
        sessions,
        autoClosed: Boolean(detail.attendance?.autoCheckedOut),
        trail,
        visits: detail.visits
          .filter((v) => v.checkInAt)
          .map((v) => ({
            id: v.id,
            at: new Date(v.checkInAt!),
            endAt: v.checkOutAt ? new Date(v.checkOutAt) : null,
          })),
        activities: acts,
      },
      options,
      clockMs,
    );
  }, [detail, trail, options, clockMs]);

  const customers = detail.visits.filter((v) => v.customerKind !== "lead" || v.customerThirdParty).length;
  const leads = detail.visits.length - customers;
  const orderValue = detail.orders.reduce((n, o) => n + o.totalPaise, 0);
  const collected = detail.payments
    .filter((p) => p.status !== "rejected")
    .reduce((n, p) => n + p.amountPaise, 0);
  const planned = detail.plan?.stops ?? [];
  const walked = planned.filter((s) => s.status === "visited").length;

  const status = !person.active
    ? { word: "Account closed", tone: "muted" as const }
    : person.onLeave
      ? { word: "On leave", tone: "muted" as const }
      : !summary.firstInAt
        ? { word: isToday ? "Not started" : "Did not punch in", tone: "danger" as const }
        : summary.open
          ? { word: isToday ? "Out now" : "Never punched out", tone: isToday ? ("good" as const) : ("warn" as const) }
          : { word: `Finished ${clock(summary.lastOutAt)}`, tone: "muted" as const };

  const base = `/sales/live/${id}`;
  const [show, setShow] = React.useState<Group>("all");
  const groupCounts = countGroups(items);
  const shown = show === "all" ? items : items.filter((i) => groupOf(i) === show);

  return (
    <div className="flex h-full min-h-[700px] flex-col gap-4 px-6 pt-5 pb-5">
      {/* ------------------------------------------------------------ header */}
      <div className="flex flex-none flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            className={cx(
              "relative flex size-12 flex-none items-center justify-center rounded-full text-[15px] font-semibold ring-4 ring-surface shadow-[0_0_0_1px_var(--color-line)]",
              avatarTone(person.salesmanName),
            )}
          >
            {person.initials}
            {status.tone === "good" ? (
              <span className="absolute right-0 bottom-0 block size-3 rounded-full bg-success ring-2 ring-surface" />
            ) : null}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[22px] leading-7 font-semibold tracking-[-0.01em] text-heading">
                {person.salesmanName}
              </h1>
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium",
                  status.tone === "good"
                    ? "bg-success-soft text-success"
                    : status.tone === "danger"
                      ? "bg-danger-soft text-danger"
                      : status.tone === "warn"
                        ? "bg-warn-soft text-warn-ink"
                        : "bg-canvas text-muted",
                )}
              >
                <span className="block size-1.5 rounded-full bg-current" />
                {status.word}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <Meta icon="pin">{person.seenAt ? `Last position ${clock(person.seenAt)}` : "No position yet"}</Meta>
              {person.batteryPercent != null ? (
                <Meta
                  icon="spark"
                  title={person.deviceStateAt ? `Read at ${clock(person.deviceStateAt)}` : undefined}
                  tone={person.batteryPercent <= 15 && !person.batteryCharging ? "danger" : undefined}
                >
                  Battery {person.batteryPercent}%{person.batteryCharging ? " · charging" : ""}
                </Meta>
              ) : null}
              {person.appVersion ? <Meta icon="grid">App {person.appVersion}</Meta> : null}
              {detail.plan?.city ? <Meta icon="route">{detail.plan.city}</Meta> : null}
            </div>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <div className="inline-flex h-9 items-stretch overflow-hidden rounded-[8px] border border-line bg-surface text-[13px] shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            <Link
              href={`${base}?day=${addDays(day, -1)}`}
              className="inline-flex w-9 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
              title="The day before"
              aria-label="The day before"
            >
              <SalesIcon name="chevron" size={16} className="rotate-180" />
            </Link>
            <span className="inline-flex min-w-[120px] items-center justify-center gap-1.5 border-x border-line px-3 font-medium whitespace-nowrap text-ink">
              <SalesIcon name="cal" size={15} className="text-muted" />
              {isToday ? "Today" : longDay(day)}
            </span>
            {isToday ? (
              <span className="inline-flex w-9 items-center justify-center text-line-strong" aria-hidden>
                <SalesIcon name="chevron" size={16} />
              </span>
            ) : (
              <Link
                href={day >= addDays(today, -1) ? base : `${base}?day=${addDays(day, 1)}`}
                className="inline-flex w-9 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
                title="The day after"
                aria-label="The day after"
              >
                <SalesIcon name="chevron" size={16} />
              </Link>
            )}
          </div>
          {!isToday ? (
            <Link href={base} className={BUTTON}>
              Today
            </Link>
          ) : null}
          <Link href={`/sales/journeys?tab=visits&salesman=${id}&day=${day}`} className={BUTTON}>
            <SalesIcon name="list" size={16} />
            Visit log
          </Link>
        </div>
      </div>

      {/* ------------------------------------------------------------- figures */}
      <CardGrid
        min={112}
        gap="gap-0"
        className="flex-none overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
      >
        <Stat
          icon="clock"
          label="Started"
          value={summary.firstInAt ? clock(summary.firstInAt) : "—"}
          foot={
            !summary.firstInAt
              ? undefined
              : summary.open
                ? "Still out"
                : summary.lastOutAt
                  ? `Finished ${clock(summary.lastOutAt)}`
                  : undefined
          }
        />
        <Stat
          icon="target"
          label="Worked"
          value={summary.firstInAt ? minutesWords(summary.workedMinutes) : "—"}
          foot={summary.visitMinutes ? `${minutesWords(summary.visitMinutes)} in shops` : undefined}
        />
        <Stat
          icon="route"
          label="Distance"
          value={metresWords(summary.metres)}
          foot={
            summary.trips
              ? `${plural(summary.trips, "trip")} · ${minutesWords(summary.travelMinutes)} moving`
              : undefined
          }
        />
        <Stat
          icon="visit"
          label="Visits"
          value={String(summary.visits)}
          foot={summary.visits ? `${customers} customer · ${leads} lead` : undefined}
        />
        <Stat
          icon="order"
          label="Orders"
          value={String(detail.orders.length)}
          foot={orderValue ? money(orderValue) : undefined}
        />
        <Stat icon="money" label="Collected" value={collected ? money(collected) : "—"} />
        <Stat
          icon="pin"
          label="Idle stops"
          value={String(summary.stops)}
          foot={summary.stops ? minutesWords(summary.stopMinutes) : undefined}
          tone={summary.stops ? "warn" : undefined}
        />
        <Stat
          icon="list"
          label="Route"
          value={planned.length ? `${walked}/${planned.length}` : "—"}
          foot={detail.plan?.city ?? undefined}
        />
      </CardGrid>

      {/* ---------------------------------------------------- map + timeline */}
      <div
        className={
          fullscreen
            ? "fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)_clamp(360px,30%,460px)] grid-rows-[minmax(0,1fr)] gap-4 bg-canvas p-4"
            : "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_clamp(360px,34%,460px)] grid-rows-[minmax(0,1fr)] gap-4"
        }
      >
        <StreetMap
          day={day}
          rows={rows.length ? rows : [detail.person]}
          tracks={tracks}
          activity={marks}
          dwells={dwells}
          gapMetres={options.gapMetres}
          dwellRadiusMetres={options.dwellRadiusMetres}
          tripBreakMinutes={options.tripBreakMinutes}
          staleAfterSeconds={options.staleAfterSeconds}
          view="today"
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((on) => !on)}
          selectedId={id}
          apiKey={olaMapsKey}
          keysSpent={olaKeysSpent}
        />

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <header className="flex-none border-b border-line px-4 pt-3 pb-2.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold text-heading">Timeline</h2>
              <span className="rounded-full bg-canvas px-2 py-0.5 text-[12px] font-medium text-muted tabular-nums">
                {plural(items.length, "entry", "entries")}
              </span>
            </div>
            {items.length ? (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {GROUPS.filter((g) => g.key === "all" || groupCounts[g.key] > 0).map((g) => {
                  const on = show === g.key;
                  return (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => setShow(g.key)}
                      className={cx(
                        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors",
                        on
                          ? "border-brand bg-brand-soft text-brand-hover"
                          : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink",
                      )}
                    >
                      {g.label}
                      <span className="tabular-nums opacity-70">
                        {g.key === "all" ? items.length : groupCounts[g.key]}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {detail.plan ? <PlanCard plan={detail.plan} /> : null}
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-canvas text-faint">
                  <SalesIcon name="clock" size={20} />
                </span>
                <p className="text-[13px] text-muted">
                  {isToday ? "Nothing recorded yet today." : "Nothing was recorded that day."}
                </p>
              </div>
            ) : (
              <ol className="px-4 pt-4 pb-2">
                {shown.map((item, i) => (
                  <Entry
                    key={`${item.kind}:${item.at.getTime()}:${i}`}
                    item={item}
                    last={i === shown.length - 1}
                    detail={detail}
                    visitsById={visitsById}
                    ordersById={ordersById}
                    paymentsById={paymentsById}
                    actsById={actsById}
                  />
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the parts */

const BUTTON =
  "inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-medium text-body no-underline shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:bg-canvas hover:no-underline";

/** The timeline's filter: one group per question a manager reads it with. */
type Group = "all" | "visits" | "moving" | "money" | "other";
const GROUPS: { key: Group; label: string }[] = [
  { key: "all", label: "All" },
  { key: "visits", label: "Visits" },
  { key: "moving", label: "Travel & stops" },
  { key: "money", label: "Orders & money" },
  { key: "other", label: "Other" },
];

function groupOf(item: TimelineItem): Exclude<Group, "all"> {
  switch (item.kind) {
    case "visit":
      return "visits";
    case "travel":
    case "stop":
      return "moving";
    case "activity":
      return item.entityType === "order" || item.entityType === "payment" ? "money" : "other";
    default:
      return "other";
  }
}

function countGroups(items: TimelineItem[]): Record<Exclude<Group, "all">, number> {
  const n = { visits: 0, moving: 0, money: 0, other: 0 };
  for (const i of items) n[groupOf(i)] += 1;
  return n;
}

function Meta({
  icon,
  children,
  title,
  tone,
}: {
  icon: SalesIconName;
  children: React.ReactNode;
  title?: string;
  tone?: "danger";
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-[6px] border border-line bg-surface px-2 py-0.5",
        tone === "danger" ? "text-danger" : "text-muted",
      )}
    >
      <SalesIcon name={icon} size={13} />
      {children}
    </span>
  );
}

function Stat({
  icon,
  label,
  value,
  foot,
  tone,
}: {
  icon: SalesIconName;
  label: string;
  value: string;
  foot?: string;
  tone?: "warn";
}) {
  return (
    /* A divider on the right of each figure rather than a gap in a grey
       background, so a row that wraps at a narrow width leaves no grey hole. */
    <div className="min-w-0 px-3.5 py-3 shadow-[inset_-1px_0_0_var(--color-divider)]" title={foot ? `${label}: ${value} — ${foot}` : undefined}>
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
        <SalesIcon name={icon} size={14} className={tone === "warn" ? "text-warn-ink" : "text-faint"} />
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cx(
          "mt-1 truncate text-[20px] leading-7 font-semibold tracking-[-0.01em] tabular-nums",
          tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {value}
      </div>
      <div className="truncate text-[12px] text-muted">{foot ?? "\u00a0"}</div>
    </div>
  );
}

function PlanCard({ plan }: { plan: NonNullable<SalesmanDayDetail["plan"]> }) {
  const walked = plan.stops.filter((s) => s.status === "visited").length;
  const pct = plan.stops.length ? Math.round((walked / plan.stops.length) * 100) : 0;
  return (
    <details className="group/plan mx-4 mt-3 rounded-[8px] border border-line bg-[#F9FAFB] text-[13px]">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="flex size-7 flex-none items-center justify-center rounded-[6px] bg-brand-soft text-brand">
          <SalesIcon name="route" size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink">
            Planned route{plan.city ? ` · ${plan.city}` : ""}
          </span>
          <span className="mt-1 flex items-center gap-2 text-[12px] text-muted">
            {plan.stops.length ? (
              <>
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-divider">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </span>
                {walked} of {plan.stops.length} shops visited
              </>
            ) : (
              "No shops picked"
            )}
          </span>
        </span>
        <SalesIcon name="chevron" size={16} className="text-faint transition-transform group-open/plan:rotate-90" />
      </summary>
      {plan.stops.length ? (
        <ol className="space-y-1.5 border-t border-line px-3 py-2.5">
          {plan.stops.map((s, i) => (
            <li key={`${s.customerId}:${i}`} className="flex items-center gap-2">
              <span className="w-4 flex-none text-right text-[11px] text-faint tabular-nums">{i + 1}</span>
              <span
                className={cx(
                  "block size-2 flex-none rounded-full",
                  s.status === "visited" ? "bg-success" : s.status === "skipped" ? "bg-warn" : "bg-line-strong",
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                <CustomerName id={s.customerId} name={s.customerName} />
              </span>
              <span className="flex-none text-[12px] text-muted">
                {s.status === "visited" && s.actualVisitAt
                  ? clock(s.actualVisitAt)
                  : s.status === "skipped"
                    ? `skipped${s.skipReason ? ` — ${s.skipReason}` : ""}`
                    : s.status}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}

function Entry({
  item,
  last,
  detail,
  visitsById,
  ordersById,
  paymentsById,
  actsById,
}: {
  item: TimelineItem;
  last: boolean;
  detail: SalesmanDayDetail;
  visitsById: Map<string, SalesmanDayDetail["visits"][number]>;
  ordersById: Map<string, DayOrder>;
  paymentsById: Map<string, DayPayment>;
  actsById: Map<string, DayAct>;
}) {
  const body = describe(item, detail, visitsById, ordersById, paymentsById, actsById);
  const tone = TONE[body.tone];
  return (
    <li className="relative grid grid-cols-[40px_28px_minmax(0,1fr)] gap-x-2.5 pb-4">
      <span className="pt-1.5 text-right text-[12px] font-medium text-muted tabular-nums">{body.time}</span>
      <span className="relative flex justify-center">
        {!last ? <span className="absolute top-8 -bottom-4 left-1/2 w-px -translate-x-1/2 bg-divider" aria-hidden /> : null}
        <span
          className={cx("relative flex size-7 items-center justify-center rounded-full ring-4 ring-surface", tone)}
          style={body.colour ? { background: `${body.colour}1F`, color: body.colour } : undefined}
        >
          <SalesIcon name={body.icon} size={14} />
        </span>
      </span>
      <div className="min-w-0 pt-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 text-[13px] leading-5 font-medium text-ink">{body.title}</span>
          {body.span ? <span className="flex-none text-[11px] text-faint tabular-nums">{body.span}</span> : null}
        </div>
        {body.content ? (
          <div
            className={cx(
              "mt-1 text-[12px] leading-[18px] text-body",
              body.card ? "rounded-[8px] border border-line bg-[#F9FAFB] px-3 py-2" : "",
            )}
          >
            {body.content}
          </div>
        ) : null}
      </div>
    </li>
  );
}

const TONE = {
  punch: "bg-brand-soft text-brand",
  visit: "bg-success-soft text-success",
  stop: "bg-warn-soft text-warn-ink",
  order: "bg-info-soft text-info",
  money: "bg-success-soft text-success",
  other: "bg-canvas text-muted",
  bad: "bg-danger-soft text-danger",
  trip: "",
} as const;

type Described = {
  title: React.ReactNode;
  /** The moment, on the left of the line. */
  time: string;
  /** Where it ran to, for the things that last. */
  span?: string;
  icon: SalesIconName;
  tone: keyof typeof TONE;
  /** A trip's own colour, so the timeline and the map agree on it. */
  colour?: string;
  content?: React.ReactNode;
  /** Drawn as a card — a visit is several facts, not a line. */
  card?: boolean;
};

const ACT_ICON: Record<string, SalesIconName> = {
  sample: "sample",
  task: "task",
  lead: "spark",
  complaint: "shield",
  customer: "people",
  expense: "receipt",
  leave: "cal",
};

function describe(
  item: TimelineItem,
  detail: SalesmanDayDetail,
  visitsById: Map<string, SalesmanDayDetail["visits"][number]>,
  ordersById: Map<string, DayOrder>,
  paymentsById: Map<string, DayPayment>,
  actsById: Map<string, DayAct>,
): Described {
  const a = detail.attendance;
  switch (item.kind) {
    case "punch_in":
      return {
        title: item.session === 1 ? "Punched in — day started" : `Punched in again (session ${item.session})`,
        time: clock(item.at),
        icon: "clock",
        tone: "punch",
        content:
          item.session === 1 && a ? (
            <>
              {a.checkInAddress ? <div>{a.checkInAddress}</div> : null}
              {a.withinGeofence === false ? (
                <div className="text-warn-ink">
                  Outside the permitted radius
                  {a.geofenceDistanceM != null ? ` — ${metresWords(a.geofenceDistanceM)} away` : ""}
                  {a.regularisationReason ? ` · “${a.regularisationReason}”` : ""}
                </div>
              ) : null}
              {a.vehicle ? (
                <div>
                  Travelling by {a.vehicle}
                  {a.odometerStartKm != null ? ` · meter ${a.odometerStartKm.toLocaleString("en-IN")} km` : ""}
                </div>
              ) : null}
            </>
          ) : undefined,
      };
    case "punch_out":
      return {
        title: item.auto ? "Day closed automatically" : "Punched out",
        time: clock(item.at),
        icon: "signOut",
        tone: item.auto ? "bad" : "punch",
        content: (
          <>
            {item.auto ? <div className="text-warn-ink">He did not punch out; the nightly job closed the day.</div> : null}
            {a?.checkOutAddress && item.session === (a.sessions.length || 1) ? <div>{a.checkOutAddress}</div> : null}
            {a?.odometerEndKm != null && a.odometerStartKm != null && item.session === (a.sessions.length || 1) ? (
              <div>
                Meter {a.odometerEndKm.toLocaleString("en-IN")} km ·{" "}
                {(a.odometerEndKm - a.odometerStartKm).toLocaleString("en-IN")} km on the meter today
              </div>
            ) : null}
          </>
        ),
      };
    case "travel":
      return {
        title: `Travelled ${metresWords(item.metres)}`,
        time: clock(item.at),
        span: `to ${clock(item.endAt)}`,
        icon: "route",
        tone: "trip",
        colour: tripColour(item.index),
        content: <span className="text-muted">Trip {item.index} · {minutesWords(item.minutes)} on the move</span>,
      };
    case "stop":
      return {
        title: `Stopped ${minutesWords(item.minutes)} — no visit recorded`,
        time: clock(item.at),
        span: `to ${clock(item.endAt)}`,
        icon: "pin",
        tone: "stop",
        content: (
          <a
            href={`https://www.google.com/maps?q=${item.lat},${item.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px]"
          >
            See where
          </a>
        ),
      };
    case "visit": {
      const v = visitsById.get(item.visitId);
      if (!v) return { title: `Visit ${item.number}`, time: clock(item.at), icon: "visit", tone: "visit" };
      const minutes = v.durationSeconds
        ? v.durationSeconds / 60
        : v.checkOutAt && v.checkInAt
          ? (new Date(v.checkOutAt).getTime() - new Date(v.checkInAt).getTime()) / 60_000
          : null;
      return {
        title: (
          <span>
            <span className="text-muted">Visit {item.number} · </span>
            <CustomerName id={v.customerId} name={v.customerName} />
          </span>
        ),
        time: clock(v.checkInAt),
        span: v.checkOutAt ? `to ${clock(v.checkOutAt)}` : "still inside",
        icon: "visit",
        tone: v.verified ? "visit" : "stop",
        card: true,
        content: (
          <div className="space-y-0.5">
            <div className="text-muted">
              {[
                accountTypeLabel({ kind: v.customerKind, thirdParty: v.customerThirdParty }),
                v.customerCity,
                minutes != null ? `${minutesWords(minutes)} inside` : null,
                v.wasPlanned ? "planned" : "off the plan",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div className="font-medium text-ink">
              {label(VISIT_OUTCOME_LABEL, v.outcome)}
              {Number(v.orderValuePaise) ? ` · order ${money(v.orderValuePaise)}` : ""}
              {v.tookPayment ? " · took payment" : ""}
              {v.gaveSample ? " · sample" : ""}
              {v.raisedComplaint ? " · complaint" : ""}
            </div>
            {!v.verified ? (
              <div className="text-warn-ink">
                Unverified{v.unverifiedReason ? ` — ${v.unverifiedReason}` : ""}
                {v.checkInOverrideReason ? ` · “${v.checkInOverrideReason}”` : ""}
              </div>
            ) : v.distanceFromShopM != null ? (
              <div className="text-muted">{metresWords(v.distanceFromShopM)} from the shop&rsquo;s pin</div>
            ) : null}
            {!v.wasPlanned && v.deviationReason ? <div className="text-muted">Why off the plan: {v.deviationReason}</div> : null}
            {v.notes ? <div className="line-clamp-3 whitespace-pre-line">“{v.notes}”</div> : null}
            {v.competitors.length ? (
              <div className="text-muted">
                Competitors: {v.competitors.map((c) => c.competitorName).join(", ")}
              </div>
            ) : null}
            {v.nextFollowUpDate ? <div className="text-muted">Next follow-up {v.nextFollowUpDate}</div> : null}
            {v.shopPhotoId || v.custPhotoId || v.voiceNoteId ? (
              <div className="flex flex-wrap gap-x-3">
                {v.shopPhotoId ? <FileLink id={v.shopPhotoId} label="Shop photo" /> : null}
                {v.custPhotoId ? <FileLink id={v.custPhotoId} label="Customer photo" /> : null}
                {v.voiceNoteId ? <FileLink id={v.voiceNoteId} label="Voice note" /> : null}
              </div>
            ) : null}
          </div>
        ),
      };
    }
    case "activity": {
      if (item.entityType === "order") {
        const o = ordersById.get(item.entityId);
        return {
          title: (
            <span>
              Order {o?.totalPaise ? money(o.totalPaise) : ""}
              {o?.customerName ? (
                <>
                  {" "}
                  · <CustomerName id={o.customerId} name={o.customerName} />
                </>
              ) : null}
            </span>
          ),
          time: clock(item.at),
          icon: "order",
          tone: "order",
          content: o ? (
            <span className="text-muted">
              {o.lines ? `${plural(o.lines, "line")} · ` : ""}
              {o.status.replace(/_/g, " ")}
            </span>
          ) : undefined,
        };
      }
      if (item.entityType === "payment") {
        const p = paymentsById.get(item.entityId);
        return {
          title: (
            <span>
              Collected {p ? money(p.amountPaise) : ""}
              {p?.customerName ? (
                <>
                  {" "}
                  · <CustomerName id={p.customerId} name={p.customerName} />
                </>
              ) : null}
            </span>
          ),
          time: clock(item.at),
          icon: "money",
          tone: "money",
          content: p ? (
            <span className="text-muted">
              {p.mode ?? "—"} · {p.status === "reported" ? "not yet confirmed by accounts" : p.status}
            </span>
          ) : undefined,
        };
      }
      const act = actsById.get(`${item.entityType}:${item.entityId}`);
      return {
        title: (
          <span>
            {activityLabel(item.entityType)}
            {act?.customerName ? (
              <>
                {" "}
                · <CustomerName id={act.customerId} name={act.customerName} />
              </>
            ) : null}
          </span>
        ),
        time: clock(item.at),
        icon: ACT_ICON[item.entityType] ?? "spark",
        tone: "other",
        content:
          act && (act.detail || act.status || act.noFixReason) ? (
            <div className="space-y-0.5 text-muted">
              {act.detail ? <div className="first-letter:uppercase">{act.detail}</div> : null}
              {act.status ? <div>{act.status.replace(/_/g, " ")}</div> : null}
              {act.lat == null && act.noFixReason ? <div>{locationReason(act.noFixReason)}</div> : null}
            </div>
          ) : undefined,
      };
    }
  }
}

function FileLink({ id, label: text }: { id: string; label: string }) {
  return (
    <a href={`/api/attachments/${id}`} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

/** `09:32` in Asia/Kolkata — named, because this renders on a UTC server too. */
function clock(at: Date | string | null | undefined): string {
  if (!at) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

function longDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${day}T06:00:00+05:30`));
}
