import { dwellStops } from "./dwell";
import { splitTrailIntoTrips, trailMetres, type TripPoint } from "./trail-trips";

/* ---------------------------------------------------------------------------
 * ONE SALESMAN'S DAY, AS A TIMELINE — what he did, in the order he did it.
 *
 * The Live map answers "where is the team"; this answers "what did THIS man do
 * today", which a manager asks one person at a time and wants in one place:
 * when he punched in, every leg he travelled and how far, every shop he walked
 * into and what came of it, every stop the trail shows that no visit explains,
 * every order, payment, lead, sample and complaint he recorded, and when he
 * stopped.
 *
 * PURE, like every engine: it takes what the services read and the thresholds
 * the Live map already uses, and performs no I/O. It is a REARRANGEMENT of
 * facts other code records — nothing here is a figure of its own. The travel
 * legs are `splitTrailIntoTrips` and the stops are `dwellStops`, the same two
 * functions that colour and mark the map, so the list and the map beside it
 * cannot disagree about where he stopped or how far he went.
 *
 * A STOP THAT A VISIT EXPLAINS IS NOT LISTED TWICE. The trail stands still
 * inside every shop, so a dwell overlapping a visit is the visit, seen by the
 * GPS; only a stop no visit accounts for is shown — which is exactly the stop a
 * manager wants to ask about.
 * ------------------------------------------------------------------------- */

export type DaySession = { inAt: Date; outAt: Date | null };

export type DayVisit = {
  id: string;
  at: Date;
  endAt: Date | null;
};

export type DayActivity = {
  /** `order`, `payment`, `lead`, … — see `lib/mbos/activity-labels.ts`. */
  entityType: string;
  entityId: string;
  at: Date;
};

export type TimelineItem =
  | { kind: "punch_in"; at: Date; session: number }
  | { kind: "punch_out"; at: Date; session: number; auto: boolean }
  | {
      kind: "travel";
      at: Date;
      endAt: Date;
      index: number;
      metres: number;
      minutes: number;
    }
  | { kind: "stop"; at: Date; endAt: Date; minutes: number; lat: number; lng: number }
  | { kind: "visit"; at: Date; endAt: Date | null; visitId: string; number: number }
  | { kind: "activity"; at: Date; entityType: string; entityId: string };

export type DayOptions = {
  gapMetres: number;
  dwellRadiusMetres: number;
  dwellMinMinutes: number;
  tripBreakMinutes: number;
};

export type DaySummary = {
  firstInAt: Date | null;
  lastOutAt: Date | null;
  /** Still punched in — the last session has no end. */
  open: boolean;
  /** Minutes inside punched-in sessions; an open session runs to `nowMs`. */
  workedMinutes: number;
  metres: number;
  travelMinutes: number;
  visitMinutes: number;
  /** Stops no visit explains, and how long they came to. */
  stops: number;
  stopMinutes: number;
  visits: number;
  trips: number;
};

/** A dwell within this many minutes of a visit belongs to it. */
const VISIT_SLACK_MS = 5 * 60_000;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * The day, in order.
 *
 * `nowMs` is the clock the caller read — an open visit or session runs to it —
 * because an engine that read the clock would answer differently on every
 * render.
 */
export function buildDayTimeline(
  input: {
    sessions: DaySession[];
    autoClosed: boolean;
    trail: TripPoint[];
    visits: DayVisit[];
    activities: DayActivity[];
  },
  options: DayOptions,
  nowMs: number,
): { items: TimelineItem[]; summary: DaySummary } {
  const items: TimelineItem[] = [];

  const sessions = [...input.sessions].sort((a, b) => a.inAt.getTime() - b.inAt.getTime());
  sessions.forEach((s, i) => {
    items.push({ kind: "punch_in", at: s.inAt, session: i + 1 });
    if (s.outAt) {
      items.push({
        kind: "punch_out",
        at: s.outAt,
        session: i + 1,
        auto: input.autoClosed && i === sessions.length - 1,
      });
    }
  });

  const visits = [...input.visits].sort((a, b) => a.at.getTime() - b.at.getTime());
  visits.forEach((v, i) =>
    items.push({ kind: "visit", at: v.at, endAt: v.endAt, visitId: v.id, number: i + 1 }),
  );

  const trail = [...input.trail].sort((a, b) => a.at.getTime() - b.at.getTime());
  const trips = splitTrailIntoTrips(trail, {
    gapMetres: options.gapMetres,
    dwellRadiusMetres: options.dwellRadiusMetres,
    tripBreakMinutes: options.tripBreakMinutes,
  });
  for (const t of trips) {
    items.push({
      kind: "travel",
      at: t.startAt,
      endAt: t.endAt,
      index: t.index,
      metres: t.metres,
      minutes: (t.endAt.getTime() - t.startAt.getTime()) / 60_000,
    });
  }

  const windows = visits.map((v) => [
    v.at.getTime() - VISIT_SLACK_MS,
    (v.endAt?.getTime() ?? v.at.getTime()) + VISIT_SLACK_MS,
  ]);
  const stops = dwellStops(trail, options.dwellRadiusMetres, options.dwellMinMinutes).filter(
    (d) => !windows.some(([s, e]) => overlaps(d.startAt.getTime(), d.endAt.getTime(), s, e)),
  );
  for (const d of stops) {
    items.push({ kind: "stop", at: d.startAt, endAt: d.endAt, minutes: d.minutes, lat: d.lat, lng: d.lng });
  }

  for (const a of input.activities) {
    if (a.entityType === "visit" || a.entityType === "attendance") continue;
    items.push({ kind: "activity", at: a.at, entityType: a.entityType, entityId: a.entityId });
  }

  /* Time order; at one instant a punch-in comes first and a punch-out last, so
     a day never reads as work done before it started. */
  const weight: Record<TimelineItem["kind"], number> = {
    punch_in: 0,
    travel: 1,
    stop: 2,
    visit: 3,
    activity: 4,
    punch_out: 5,
  };
  items.sort((a, b) => a.at.getTime() - b.at.getTime() || weight[a.kind] - weight[b.kind]);

  const last = sessions[sessions.length - 1];
  const open = Boolean(last && !last.outAt);
  const workedMinutes = sessions.reduce(
    (n, s) => n + Math.max(0, ((s.outAt?.getTime() ?? nowMs) - s.inAt.getTime()) / 60_000),
    0,
  );
  const visitMinutes = visits.reduce(
    (n, v) => n + (v.endAt ? Math.max(0, (v.endAt.getTime() - v.at.getTime()) / 60_000) : 0),
    0,
  );

  return {
    items,
    summary: {
      firstInAt: sessions[0]?.inAt ?? null,
      lastOutAt: open ? null : (last?.outAt ?? null),
      open,
      workedMinutes,
      metres: trailMetres(trail),
      travelMinutes: trips.reduce((n, t) => n + (t.endAt.getTime() - t.startAt.getTime()) / 60_000, 0),
      visitMinutes,
      stops: stops.length,
      stopMinutes: stops.reduce((n, s) => n + s.minutes, 0),
      visits: visits.length,
      trips: trips.length,
    },
  };
}

/** `95` → `1 h 35 min`; `12` → `12 min`. */
export function minutesWords(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** `1234` → `1.2 km`; `640` → `640 m`. */
export function metresWords(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}
